//! 受管启动 Agent（S1-E4 最小版，见 docs/specs/agents/claude-code.md §2、§3）。
//!
//! onexd 只准备：受管目录、本次策略文件、参数和完整环境；由 `onex run` 在员工终端里前台启动，
//! 这样 TUI 直接拿到终端。`prepare()` 按 `Request.agent` 分派到各 Agent 自己的准备函数——
//! 目录命名空间、配置文件格式、环境变量和启动参数都是 Agent 特定的，公共的只有「准备到
//! `<home>/run/<launch_id>` 这个本次目录、再由调用方前台起进程」这套骨架。目前只有 Claude Code
//! 实现（S2 起加 Codex、Kimi Code），MVP 不做下载、校验和 resume，用 PATH 里的 `claude`，记录版本。
//!
//! Claude Code 目录：持久命名空间 `N = <home>/agents/claude-code`（`claude/`、`home/`、`tmp/`），
//! 本次目录 `R = <home>/run/<launch_id>`（`settings.json`，含本机令牌，0600，结束时删除）。
//! 个人的 `~/.claude` 不读不写。

use std::collections::BTreeMap;
use std::io::Write;
use std::path::{Path, PathBuf};

use anyhow::{Context, Result, bail};
use serde_json::{Value, json};

use crate::id;

/// 从员工环境里只带过来这些（终端和区域设置），其余一律不继承。Windows 的终端和区域设置
/// 走不同的变量：`ComSpec`（cmd.exe 路径）、`SystemRoot`（部分工具会用来找系统 DLL）、
/// `PROMPT`（cmd 的提示符样式）、`WT_SESSION`/`WT_PROFILE_ID`（Windows Terminal 自报身份）、
/// `USERNAME`（Windows 下等价于 Unix 的 `USER`）。
#[cfg(unix)]
const PASS_ENV: &[&str] = &[
    "TERM",
    "COLORTERM",
    "TERM_PROGRAM",
    "TERM_PROGRAM_VERSION",
    "LANG",
    "LC_ALL",
    "LC_CTYPE",
    "USER",
    "LOGNAME",
    "SHELL",
];

#[cfg(windows)]
const PASS_ENV: &[&str] = &[
    "ComSpec",
    "SystemRoot",
    "PROMPT",
    "WT_SESSION",
    "WT_PROFILE_ID",
    "TERM_PROGRAM",
    "TERM_PROGRAM_VERSION",
    "USERNAME",
];

/// Windows 的进程环境块本身大小写不敏感，但调用方把它收进了普通 `BTreeMap<String, String>`
/// （`std::env::vars()` 在 Windows 上多半给出 `Path`、`USERPROFILE` 这类非全大写的键名，取决于
/// 创建这个进程的父进程/shell 怎么设的），精确字符串匹配会漏掉实际存在的变量。Unix 的环境变量
/// 本身大小写敏感，这里保持精确匹配，不改变既有行为。
#[cfg(unix)]
fn client_env_get<'a>(env: &'a BTreeMap<String, String>, key: &str) -> Option<&'a String> {
    env.get(key)
}

#[cfg(windows)]
fn client_env_get<'a>(env: &'a BTreeMap<String, String>, key: &str) -> Option<&'a String> {
    env.iter().find(|(k, _)| k.eq_ignore_ascii_case(key)).map(|(_, v)| v)
}

pub(crate) fn terminal_env(client: &BTreeMap<String, String>) -> BTreeMap<String, String> {
    let mut env = BTreeMap::new();
    for key in PASS_ENV {
        if let Some(value) = client_env_get(client, key) {
            env.insert((*key).into(), value.clone());
        }
    }
    let path = client_env_get(client, "PATH").cloned().unwrap_or_else(|| "/usr/bin:/bin:/usr/sbin:/sbin".into());
    env.insert("PATH".into(), path);
    env
}

#[derive(Debug, Clone)]
pub struct Request<'a> {
    /// `claude-code`、`codex`、`kimi-code`（`contracts/edge-ws.md` 多 Agent 一节的同一组名字）
    pub agent: &'a str,
    pub home: &'a Path,
    /// `127.0.0.1:<port>`
    pub router_addr: &'a str,
    pub local_token: &'a str,
    /// 获准模型别名（config.routes 里的 model）
    pub model: &'a str,
    /// Agent 可执行文件的绝对路径
    pub program: &'a Path,
    pub cwd: &'a Path,
    /// 员工终端的环境，只取 `PASS_ENV` 和 PATH
    pub client_env: &'a BTreeMap<String, String>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct Launch {
    pub launch_id: String,
    pub session_id: String,
    pub program: PathBuf,
    pub args: Vec<String>,
    /// 子进程的完整环境（调用方先清空再设置）
    pub env: BTreeMap<String, String>,
    pub cwd: PathBuf,
    pub config_dir: PathBuf,
    pub run_dir: PathBuf,
}

/// 按 `r.agent` 分派到各 Agent 自己的准备函数。新增 Agent 在这里加一个分支和一个
/// `prepare_<agent>` 函数，不改这个函数以外的公共骨架（`finish`/`clean_stale` 按 `launch_id`
/// 操作，和具体是哪个 Agent 无关）。
pub fn prepare(r: &Request) -> Result<Launch> {
    if !r.program.is_absolute() {
        bail!("agent executable path must be absolute: {}", r.program.display());
    }
    if !r.cwd.is_absolute() || !r.cwd.is_dir() {
        bail!("working directory not found: {}", r.cwd.display());
    }
    match r.agent {
        "claude-code" => prepare_claude_code(r),
        "codex" => crate::codex_launch::prepare(r),
        "kimi-code" => crate::kimi_launch::prepare_kimi_code(r),
        other => bail!("no managed launch preparer for agent {other}"),
    }
}

/// Claude Code 的准备逻辑（S1-E4 最小版）：不变，只是从通用 `prepare()` 里搬出来，
/// 调用前已经做过 program/cwd 的公共校验。
fn prepare_claude_code(r: &Request) -> Result<Launch> {
    let ns = r.home.join("agents/claude-code");
    let config_dir = ns.join("claude");
    let user_home = ns.join("home");
    let tmp = ns.join("tmp");
    for d in [&config_dir, &user_home, &tmp] {
        private_dir(d)?;
    }
    init_claude_json(&config_dir, r.local_token)?;

    let launch_id = id::new("lch");
    let session_id = uuid_v4();
    let run_dir = r.home.join("run").join(&launch_id);
    private_dir(&r.home.join("run"))?;
    private_dir(&run_dir)?;
    let base_url = format!("http://{}", r.router_addr);
    let settings = json!({
        "env": {"ANTHROPIC_BASE_URL": base_url, "ANTHROPIC_API_KEY": r.local_token},
        "model": r.model,
        "availableModels": [r.model],
    });
    let settings_path = run_dir.join("settings.json");
    write_private(&settings_path, serde_json::to_string_pretty(&settings)?.as_bytes())?;

    let mut env = terminal_env(r.client_env);
    let set = |env: &mut BTreeMap<String, String>, k: &str, v: &str| {
        env.insert(k.into(), v.into());
    };
    set(&mut env, "HOME", &user_home.to_string_lossy());
    set(&mut env, "CLAUDE_CONFIG_DIR", &config_dir.to_string_lossy());
    set(&mut env, "TMPDIR", &format!("{}/", tmp.to_string_lossy()));
    // Windows 等价的一组：Node（Claude Code 是 Node CLI）和大多数 Windows 工具链不看 `HOME`/
    // `TMPDIR`，而是 `USERPROFILE`（用户目录）、`APPDATA`/`LOCALAPPDATA`（配置/缓存根）、
    // `TMP`/`TEMP`（临时目录）。不批量覆盖这组变量，Claude Code 会退回解析真实用户的这些路径，
    // 等于完全绕开了这里刻意做的隔离（读写真实 `%USERPROFILE%\.claude` 等）。全部指到同一个
    // 沙箱目录树下：`USERPROFILE`/`APPDATA`/`LOCALAPPDATA` 都指 `user_home`（没有必要在沙箱内部
    // 再细分 Roaming/Local，Claude Code 不需要那层区分），`TMP`/`TEMP` 指 `tmp`。
    #[cfg(windows)]
    for k in ["USERPROFILE", "APPDATA", "LOCALAPPDATA"] {
        set(&mut env, k, &user_home.to_string_lossy());
    }
    #[cfg(windows)]
    for k in ["TMP", "TEMP"] {
        set(&mut env, k, &tmp.to_string_lossy());
    }
    set(&mut env, "ANTHROPIC_BASE_URL", &base_url);
    set(&mut env, "ANTHROPIC_API_KEY", r.local_token);
    for k in [
        "ANTHROPIC_MODEL",
        "ANTHROPIC_DEFAULT_OPUS_MODEL",
        "ANTHROPIC_DEFAULT_SONNET_MODEL",
        "ANTHROPIC_DEFAULT_HAIKU_MODEL",
        "ANTHROPIC_SMALL_FAST_MODEL",
        "CLAUDE_CODE_SUBAGENT_MODEL",
    ] {
        set(&mut env, k, r.model);
    }
    // 本机 router 不走代理
    set(&mut env, "NO_PROXY", "localhost,127.0.0.1");
    set(&mut env, "no_proxy", "localhost,127.0.0.1");
    for (k, v) in [
        ("DISABLE_AUTOUPDATER", "1"),
        ("CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC", "1"),
        ("CLAUDE_CODE_SUBPROCESS_ENV_SCRUB", "1"),
        // Chat 上游不支持 Anthropic 的 beta 和扩展思考
        ("CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS", "1"),
        ("MAX_THINKING_TOKENS", "0"),
    ] {
        set(&mut env, k, v);
    }

    let args = [
        "--session-id",
        &session_id,
        "--setting-sources",
        "",
        "--strict-mcp-config",
        "--mcp-config",
        r#"{"mcpServers":{}}"#,
        "--model",
        r.model,
        "--settings",
        &settings_path.to_string_lossy(),
    ]
    .iter()
    .map(|s| s.to_string())
    .collect();
    Ok(Launch {
        launch_id,
        session_id,
        program: r.program.to_path_buf(),
        args,
        env,
        cwd: r.cwd.to_path_buf(),
        config_dir,
        run_dir,
    })
}

/// 只接受本机生成的启动 ID，清除对应目录及其临时令牌。
pub fn finish(home: &Path, launch_id: &str) -> Result<()> {
    if !is_generated_launch_id(launch_id) {
        bail!("bad launch id");
    }
    let config = clean_launch_profile(home, "kimi-code", launch_id);
    let skills = clean_launch_profile(home, "codex", launch_id);
    let dir = home.join("run").join(launch_id);
    let runtime = match std::fs::remove_dir_all(&dir) {
        Err(e) if e.kind() != std::io::ErrorKind::NotFound => {
            Err(e).with_context(|| format!("remove {}", dir.display()))
        }
        _ => Ok(()),
    };
    config.and(skills).and(runtime)
}

fn profiles(home: &Path, agent: &str) -> Option<PathBuf> {
    let mut path = home.to_path_buf();
    for name in ["agents", agent, "profiles"] {
        path.push(name);
        if !std::fs::symlink_metadata(&path).is_ok_and(|meta| meta.is_dir()) {
            return None;
        }
    }
    Some(path)
}

fn clean_launch_profile(home: &Path, agent: &str, launch_id: &str) -> Result<()> {
    let Some(mut path) = profiles(home, agent) else { return Ok(()) };
    let (parents, entries): (&[&str], &[&str]) = match agent {
        "kimi-code" => (&["kimi"], &["config.toml", "mcp.json"]),
        "codex" if cfg!(windows) => (&["codex"], &["skills"]),
        "codex" => (&["home", ".agents"], &["skills"]),
        _ => return Ok(()),
    };
    for name in std::iter::once(launch_id).chain(parents.iter().copied()) {
        path.push(name);
        if !std::fs::symlink_metadata(&path).is_ok_and(|meta| meta.is_dir()) {
            return Ok(());
        }
    }
    for entry in entries {
        let target = path.join(entry);
        let removed = if agent == "codex" { std::fs::remove_dir_all(&target) } else { std::fs::remove_file(&target) };
        match removed {
            Err(error) if error.kind() != std::io::ErrorKind::NotFound => {
                return Err(error).with_context(|| format!("remove {}", target.display()));
            }
            _ => {}
        }
    }
    Ok(())
}

/// daemon 启动时清理上次残留的本次目录：旧的本机令牌已失效，留着也没用。
pub fn clean_stale(home: &Path) {
    let _ = std::fs::remove_dir_all(home.join("run"));
    for agent in ["kimi-code", "codex"] {
        if let Some(profiles) = profiles(home, agent)
            && let Ok(entries) = std::fs::read_dir(profiles)
        {
            for entry in entries.flatten() {
                let name = entry.file_name();
                if let Some(id) = name.to_str().filter(|id| is_generated_launch_id(id))
                    && let Err(error) = clean_launch_profile(home, agent, id)
                {
                    tracing::warn!(agent, %error, "could not remove stale launch tool or configuration");
                }
            }
        }
    }
}

/// 受管 `.claude.json`：跳过首次引导，并认可本次的本机令牌（Claude Code 对环境里的 API key 会先问一次）。
/// 只合并这几个键，其余原样保留；解析失败时不覆盖。
fn init_claude_json(config_dir: &Path, token: &str) -> Result<()> {
    let path = config_dir.join(".claude.json");
    let mut v: Value = match std::fs::read(&path) {
        Ok(b) => serde_json::from_slice(&b)
            .with_context(|| format!("{} is not valid JSON; not touching it", path.display()))?,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => json!({}),
        Err(e) => return Err(e).with_context(|| format!("read {}", path.display())),
    };
    let Some(o) = v.as_object_mut() else { bail!("{} is not a JSON object; not touching it", path.display()) };
    o.insert("hasCompletedOnboarding".into(), true.into());
    o.insert("installMethod".into(), "native".into());
    // Claude Code 按 key 的末 20 个字符记认可。本机令牌每次 daemon 启动都换，只保留当前这一个。
    let tail = &token[token.len().saturating_sub(20)..];
    o.insert("customApiKeyResponses".into(), json!({"approved": [tail], "rejected": []}));
    let tmp = config_dir.join(format!(".claude.json.{}.tmp", id::new("t")));
    write_private(&tmp, serde_json::to_string_pretty(&v)?.as_bytes())?;
    std::fs::rename(&tmp, &path).inspect_err(|_| {
        let _ = std::fs::remove_file(&tmp);
    })?;
    Ok(())
}

#[cfg(unix)]
pub(crate) fn private_dir(d: &Path) -> Result<()> {
    use std::os::unix::fs::PermissionsExt;
    std::fs::create_dir_all(d).with_context(|| format!("create {}", d.display()))?;
    std::fs::set_permissions(d, std::fs::Permissions::from_mode(0o700))?;
    Ok(())
}

/// Windows 没有权限位；目录继承 `ONEX_HOME`（`%LOCALAPPDATA%\OneX`）本身的 ACL，
/// 已经是当前用户私有，不需要额外收紧。
#[cfg(windows)]
pub(crate) fn private_dir(d: &Path) -> Result<()> {
    std::fs::create_dir_all(d).with_context(|| format!("create {}", d.display()))?;
    Ok(())
}

#[cfg(unix)]
pub(crate) fn write_private(path: &Path, data: &[u8]) -> Result<()> {
    use std::os::unix::fs::OpenOptionsExt;
    let _ = std::fs::remove_file(path);
    let mut f = std::fs::OpenOptions::new().write(true).create_new(true).mode(0o600).open(path)?;
    f.write_all(data)?;
    f.sync_all()?;
    Ok(())
}

#[cfg(windows)]
pub(crate) fn write_private(path: &Path, data: &[u8]) -> Result<()> {
    let _ = std::fs::remove_file(path);
    let mut f = std::fs::OpenOptions::new().write(true).create_new(true).open(path)?;
    f.write_all(data)?;
    f.sync_all()?;
    Ok(())
}

pub(crate) fn uuid_v4() -> String {
    let mut b: [u8; 16] = rand::random();
    b[6] = (b[6] & 0x0f) | 0x40;
    b[8] = (b[8] & 0x3f) | 0x80;
    let h: String = b.iter().map(|x| format!("{x:02x}")).collect();
    format!("{}-{}-{}-{}-{}", &h[0..8], &h[8..12], &h[12..16], &h[16..20], &h[20..32])
}

/// `id::new("lch")` 的形状：`lch_` 后面严格跟 26 个 Crockford base32 字符（大写字母和数字，
/// 不含 I、L、O、U）。白名单匹配，不是去掉已知危险字符——任何不是这个形状的输入都拒绝，
/// 不管它看起来像不像路径穿越。
fn is_generated_launch_id(s: &str) -> bool {
    const CROCKFORD: &[u8] = b"0123456789ABCDEFGHJKMNPQRSTVWXYZ";
    let Some(rest) = s.strip_prefix("lch_") else { return false };
    rest.len() == 26 && rest.bytes().all(|b| CROCKFORD.contains(&b))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(unix)]
    fn client_env() -> BTreeMap<String, String> {
        [
            ("PATH", "/opt/homebrew/bin:/usr/bin"),
            ("TERM", "xterm-256color"),
            ("HOME", "/Users/someone"),
            ("ANTHROPIC_AUTH_TOKEN", "personal"),
            ("HTTPS_PROXY", "http://corp:3128"),
            ("CLAUDE_CONFIG_DIR", "/Users/someone/.claude"),
            ("AWS_PROFILE", "x"),
        ]
        .into_iter()
        .map(|(k, v)| (k.to_string(), v.to_string()))
        .collect()
    }

    #[cfg(unix)]
    #[test]
    fn prepares_isolated_launch() {
        let home = tempfile::tempdir().unwrap();
        let cwd = tempfile::tempdir().unwrap();
        let env = client_env();
        let r = Request {
            agent: "claude-code",
            home: home.path(),
            router_addr: "127.0.0.1:4567",
            local_token: "0123456789abcdef0123456789abcdef",
            model: "Qwen3.8-27B",
            program: Path::new("/usr/local/bin/claude"),
            cwd: cwd.path(),
            client_env: &env,
        };
        let l = prepare(&r).unwrap();
        let ns = home.path().join("agents/claude-code");
        assert_eq!(l.env["HOME"], ns.join("home").to_string_lossy());
        assert_eq!(l.env["CLAUDE_CONFIG_DIR"], ns.join("claude").to_string_lossy());
        assert_eq!(l.env["ANTHROPIC_BASE_URL"], "http://127.0.0.1:4567");
        assert_eq!(l.env["ANTHROPIC_SMALL_FAST_MODEL"], "Qwen3.8-27B");
        assert_eq!((l.env["PATH"].as_str(), l.env["TERM"].as_str()), ("/opt/homebrew/bin:/usr/bin", "xterm-256color"));
        // 个人认证、代理、云后端一概不带
        for k in ["ANTHROPIC_AUTH_TOKEN", "HTTPS_PROXY", "AWS_PROFILE"] {
            assert!(!l.env.contains_key(k), "{k}");
        }
        assert_eq!(l.args[0..2], ["--session-id".to_string(), l.session_id.clone()]);
        assert_eq!(l.args[2..4], ["--setting-sources".to_string(), String::new()]);
        assert_eq!(l.session_id.len(), 36);
        assert_eq!(&l.session_id[14..15], "4");

        let settings_path = PathBuf::from(l.args.last().unwrap());
        assert_eq!(settings_path, l.run_dir.join("settings.json"));
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(std::fs::metadata(&settings_path).unwrap().permissions().mode() & 0o777, 0o600);
        }
        let s: Value = serde_json::from_slice(&std::fs::read(&settings_path).unwrap()).unwrap();
        assert_eq!(s["env"]["ANTHROPIC_API_KEY"], "0123456789abcdef0123456789abcdef");
        assert_eq!(s["model"], "Qwen3.8-27B");

        let cj: Value = serde_json::from_slice(&std::fs::read(ns.join("claude/.claude.json")).unwrap()).unwrap();
        assert_eq!(cj["hasCompletedOnboarding"], true);
        // 本机令牌的末 20 个字符
        assert_eq!(cj["customApiKeyResponses"]["approved"], json!(["cdef0123456789abcdef"]));

        finish(home.path(), &l.launch_id).unwrap();
        assert!(!l.run_dir.exists());
    }

    /// Windows 版 `prepares_isolated_launch`：路径和 `PASS_ENV` 都换成 Windows 的等价物
    /// （`ComSpec` 代替 `TERM`，`C:\...` 绝对路径），断言内容和 Unix 版对应一致；另外覆盖两个
    /// Windows 专属点：(1) `client_env` 用真实 Windows 大小写（`Path` 不是 `PATH`），验证
    /// `client_env_get` 的大小写不敏感查找确实生效，不是精确匹配漏判成"没设"；(2) 批量覆盖
    /// `USERPROFILE`/`APPDATA`/`LOCALAPPDATA`/`TMP`/`TEMP` 指到沙箱目录，不透出真实用户目录。
    #[cfg(windows)]
    #[test]
    fn prepares_isolated_launch() {
        let env: BTreeMap<String, String> = [
            ("Path", r"C:\Program Files\nodejs;C:\Windows\System32"),
            ("ComSpec", r"C:\Windows\System32\cmd.exe"),
            ("HOME", r"C:\Users\someone"),
            ("USERPROFILE", r"C:\Users\someone"),
            ("APPDATA", r"C:\Users\someone\AppData\Roaming"),
            ("LOCALAPPDATA", r"C:\Users\someone\AppData\Local"),
            ("TMP", r"C:\Users\someone\AppData\Local\Temp"),
            ("ANTHROPIC_AUTH_TOKEN", "personal"),
            ("HTTPS_PROXY", "http://corp:3128"),
            ("CLAUDE_CONFIG_DIR", r"C:\Users\someone\.claude"),
            ("AWS_PROFILE", "x"),
        ]
        .into_iter()
        .map(|(k, v)| (k.to_string(), v.to_string()))
        .collect();
        let home = tempfile::tempdir().unwrap();
        let cwd = tempfile::tempdir().unwrap();
        let r = Request {
            agent: "claude-code",
            home: home.path(),
            router_addr: "127.0.0.1:4567",
            local_token: "0123456789abcdef0123456789abcdef",
            model: "Qwen3.8-27B",
            program: Path::new(r"C:\Users\someone\AppData\Local\OneX\claude.exe"),
            cwd: cwd.path(),
            client_env: &env,
        };
        let l = prepare(&r).unwrap();
        let ns = home.path().join("agents/claude-code");
        assert_eq!(l.env["HOME"], ns.join("home").to_string_lossy());
        assert_eq!(l.env["CLAUDE_CONFIG_DIR"], ns.join("claude").to_string_lossy());
        assert_eq!(l.env["ANTHROPIC_BASE_URL"], "http://127.0.0.1:4567");
        assert_eq!(l.env["ANTHROPIC_SMALL_FAST_MODEL"], "Qwen3.8-27B");
        // 大小写不敏感查找：client_env 里是 "Path"，这里仍然要能取到它的值，不能因为我们自己
        // 写代码时查的是 "PATH" 就丢失。
        assert_eq!(
            (l.env["PATH"].as_str(), l.env["ComSpec"].as_str()),
            (r"C:\Program Files\nodejs;C:\Windows\System32", r"C:\Windows\System32\cmd.exe")
        );
        // 批量覆盖：都指向沙箱目录（ns/home、ns/tmp），不是 client_env 里真实用户的那几个值。
        for k in ["USERPROFILE", "APPDATA", "LOCALAPPDATA"] {
            assert_eq!(l.env[k], ns.join("home").to_string_lossy(), "{k}");
            assert_ne!(l.env[k], env[k]);
        }
        for k in ["TMP", "TEMP"] {
            assert_eq!(l.env[k], ns.join("tmp").to_string_lossy(), "{k}");
        }
        assert_ne!(l.env["TMP"], env["TMP"]);
        for k in ["ANTHROPIC_AUTH_TOKEN", "HTTPS_PROXY", "AWS_PROFILE"] {
            assert!(!l.env.contains_key(k), "{k}");
        }
        finish(home.path(), &l.launch_id).unwrap();
        assert!(!l.run_dir.exists());
    }

    #[test]
    fn claude_json_keeps_other_keys_and_refuses_bad_json() {
        let d = tempfile::tempdir().unwrap();
        std::fs::write(
            d.path().join(".claude.json"),
            r#"{"projects":{"/x":{}},"customApiKeyResponses":{"approved":["old"]}}"#,
        )
        .unwrap();
        init_claude_json(d.path(), "tok").unwrap();
        let v: Value = serde_json::from_slice(&std::fs::read(d.path().join(".claude.json")).unwrap()).unwrap();
        assert_eq!(v["projects"], json!({"/x":{}}));
        assert_eq!(v["customApiKeyResponses"]["approved"], json!(["tok"]));
        assert_eq!(v["hasCompletedOnboarding"], true);
        std::fs::write(d.path().join(".claude.json"), "{broken").unwrap();
        assert!(init_claude_json(d.path(), "tok").is_err());
        assert_eq!(std::fs::read(d.path().join(".claude.json")).unwrap(), b"{broken");
    }

    /// `finish()` 的 `launch_id` 来自 IPC（`LaunchDone` 请求），平台无关：白名单必须在两个平台上
    /// 都拒绝非生成形状的输入，尤其是只在 Windows 上成立的攻击形状（带盘符的绝对路径、裸反斜杠），
    /// 这些都不含 `/` 或 `.`，旧的黑名单实现挡不住，必须单独测，不能靠 `#[cfg(unix)]` 的启动测试
    /// 顺带盖到——那个测试在 Windows 上根本不会跑。
    #[test]
    fn finish_only_accepts_generated_launch_ids() {
        let home = tempfile::tempdir().unwrap();
        // 用真实生成器产出一个 id，而不是手写一个凭空数出来的固定长度字符串——长度数错一位
        // 这种测试自身的 bug 不会被发现，用生成器就不存在这个风险。
        let id = id::new("lch");
        std::fs::create_dir_all(home.path().join("run").join(&id)).unwrap();
        assert!(finish(home.path(), &id).is_ok());
        for bad in ["../x", r"C:\not-a-launch", r"\not-a-launch", "lch_tooshort", "lch_", "not-even-close", ""] {
            assert!(finish(home.path(), bad).is_err(), "{bad}");
        }
    }

    #[cfg(unix)]
    #[test]
    fn rejects_relative_program_and_missing_cwd() {
        let home = tempfile::tempdir().unwrap();
        let env = BTreeMap::new();
        let base = Request {
            agent: "claude-code",
            home: home.path(),
            router_addr: "127.0.0.1:1",
            local_token: "t",
            model: "m",
            program: Path::new("claude"),
            cwd: Path::new("/"),
            client_env: &env,
        };
        assert!(prepare(&base).is_err());
        let r = Request { program: Path::new("/bin/claude"), cwd: Path::new("/no/such/dir"), ..base };
        assert!(prepare(&r).is_err());
    }

    #[cfg(windows)]
    #[test]
    fn rejects_relative_program_and_missing_cwd() {
        let home = tempfile::tempdir().unwrap();
        let env = BTreeMap::new();
        let base = Request {
            agent: "claude-code",
            home: home.path(),
            router_addr: "127.0.0.1:1",
            local_token: "t",
            model: "m",
            program: Path::new("claude.exe"),
            cwd: Path::new(r"C:\"),
            client_env: &env,
        };
        assert!(prepare(&base).is_err());
        let r = Request { program: Path::new(r"C:\Windows\claude.exe"), cwd: Path::new(r"C:\no\such\dir"), ..base };
        assert!(prepare(&r).is_err());
    }

    /// 分派未覆盖的 agent 要明确报错，不能悄悄落到 Claude Code 的准备逻辑上。
    #[cfg(unix)]
    #[test]
    fn rejects_agent_without_a_preparer() {
        let home = tempfile::tempdir().unwrap();
        let cwd = tempfile::tempdir().unwrap();
        let env = BTreeMap::new();
        let r = Request {
            agent: "unknown-agent",
            home: home.path(),
            router_addr: "127.0.0.1:1",
            local_token: "t",
            model: "m",
            program: Path::new("/bin/codex"),
            cwd: cwd.path(),
            client_env: &env,
        };
        let err = prepare(&r).unwrap_err();
        assert!(format!("{err:#}").contains("no managed launch preparer"), "{err:#}");
    }
}
