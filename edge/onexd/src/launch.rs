//! 受管启动 Claude Code（S1-E4 最小版，见 docs/specs/agents/claude-code.md §2、§3）。
//!
//! onexd 只准备：受管目录、本次策略文件、参数和完整环境；由 `onex run` 在员工终端里前台启动，
//! 这样 TUI 直接拿到终端。MVP 不做下载、校验和 resume，用 PATH 里的 `claude`，记录版本。
//!
//! 目录：持久命名空间 `N = <home>/agents/claude-code`（`claude/`、`home/`、`tmp/`），
//! 本次目录 `R = <home>/run/<launch_id>`（`settings.json`，含本机令牌，0600，结束时删除）。
//! 个人的 `~/.claude` 不读不写。

use std::collections::BTreeMap;
use std::io::Write;
use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
use std::path::{Path, PathBuf};

use anyhow::{Context, Result, bail};
use serde_json::{Value, json};

use crate::id;

/// 从员工环境里只带过来这些（终端和区域设置），其余一律不继承。
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

#[derive(Debug, Clone)]
pub struct Request<'a> {
    pub home: &'a Path,
    /// `127.0.0.1:<port>`
    pub router_addr: &'a str,
    pub local_token: &'a str,
    /// 获准模型别名（config.routes 里的 model）
    pub model: &'a str,
    /// claude 可执行文件的绝对路径
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

pub fn prepare(r: &Request) -> Result<Launch> {
    if !r.program.is_absolute() {
        bail!("claude path must be absolute: {}", r.program.display());
    }
    if !r.cwd.is_absolute() || !r.cwd.is_dir() {
        bail!("working directory not found: {}", r.cwd.display());
    }
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

    let mut env = BTreeMap::new();
    for k in PASS_ENV {
        if let Some(v) = r.client_env.get(*k) {
            env.insert(k.to_string(), v.clone());
        }
    }
    let path = r.client_env.get("PATH").cloned().unwrap_or_else(|| "/usr/bin:/bin:/usr/sbin:/sbin".into());
    let set = |env: &mut BTreeMap<String, String>, k: &str, v: &str| {
        env.insert(k.into(), v.into());
    };
    set(&mut env, "PATH", &path);
    set(&mut env, "HOME", &user_home.to_string_lossy());
    set(&mut env, "CLAUDE_CONFIG_DIR", &config_dir.to_string_lossy());
    set(&mut env, "TMPDIR", &format!("{}/", tmp.to_string_lossy()));
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

/// 结束一次启动：删除本次策略文件（含本机令牌）。
pub fn finish(home: &Path, launch_id: &str) -> Result<()> {
    if launch_id.is_empty() || launch_id.contains(['/', '.']) {
        bail!("bad launch id");
    }
    let dir = home.join("run").join(launch_id);
    match std::fs::remove_dir_all(&dir) {
        Err(e) if e.kind() != std::io::ErrorKind::NotFound => {
            Err(e).with_context(|| format!("remove {}", dir.display()))
        }
        _ => Ok(()),
    }
}

/// daemon 启动时清理上次残留的本次目录：旧的本机令牌已失效，留着也没用。
pub fn clean_stale(home: &Path) {
    let _ = std::fs::remove_dir_all(home.join("run"));
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

fn private_dir(d: &Path) -> Result<()> {
    std::fs::create_dir_all(d).with_context(|| format!("create {}", d.display()))?;
    std::fs::set_permissions(d, std::fs::Permissions::from_mode(0o700))?;
    Ok(())
}

fn write_private(path: &Path, data: &[u8]) -> Result<()> {
    let _ = std::fs::remove_file(path);
    let mut f = std::fs::OpenOptions::new().write(true).create_new(true).mode(0o600).open(path)?;
    f.write_all(data)?;
    f.sync_all()?;
    Ok(())
}

fn uuid_v4() -> String {
    let mut b: [u8; 16] = rand::random();
    b[6] = (b[6] & 0x0f) | 0x40;
    b[8] = (b[8] & 0x3f) | 0x80;
    let h: String = b.iter().map(|x| format!("{x:02x}")).collect();
    format!("{}-{}-{}-{}-{}", &h[0..8], &h[8..12], &h[12..16], &h[16..20], &h[20..32])
}

#[cfg(test)]
mod tests {
    use super::*;

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

    #[test]
    fn prepares_isolated_launch() {
        let home = tempfile::tempdir().unwrap();
        let cwd = tempfile::tempdir().unwrap();
        let env = client_env();
        let r = Request {
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
        assert_eq!(std::fs::metadata(&settings_path).unwrap().permissions().mode() & 0o777, 0o600);
        let s: Value = serde_json::from_slice(&std::fs::read(&settings_path).unwrap()).unwrap();
        assert_eq!(s["env"]["ANTHROPIC_API_KEY"], "0123456789abcdef0123456789abcdef");
        assert_eq!(s["model"], "Qwen3.8-27B");

        let cj: Value = serde_json::from_slice(&std::fs::read(ns.join("claude/.claude.json")).unwrap()).unwrap();
        assert_eq!(cj["hasCompletedOnboarding"], true);
        // 本机令牌的末 20 个字符
        assert_eq!(cj["customApiKeyResponses"]["approved"], json!(["cdef0123456789abcdef"]));

        finish(home.path(), &l.launch_id).unwrap();
        assert!(!l.run_dir.exists());
        assert!(finish(home.path(), "../x").is_err());
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

    #[test]
    fn rejects_relative_program_and_missing_cwd() {
        let home = tempfile::tempdir().unwrap();
        let env = BTreeMap::new();
        let base = Request {
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
}
