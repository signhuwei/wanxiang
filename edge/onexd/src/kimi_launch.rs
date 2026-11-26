//! 受管启动 Kimi Code（S2B，见 docs/specs/agents/kimi-code.md「配置、环境与协议」）。
//!
//! 每次启动使用独立的 KIMI_CODE_HOME。原生 CLI 从该目录读取 config.toml，
//! 启动结束及 daemon 重启时删除配置，保留会话记录。

use std::collections::{BTreeMap, BTreeSet};
use std::path::Path;

use anyhow::{Result, anyhow, bail};
use onex_core::ws::ModelLimits;

use crate::id;
use crate::kimi_config;
use crate::launch::{Launch, Request};

#[path = "kimi_history.rs"]
mod history;
pub(crate) use history::{
    KimiHistory, RestoredHistory, prune_unmodified_restored_sessions, restored_history, restored_history_floor,
};

/// 从员工环境里只带过来这些（终端和区域设置），其余一律不继承。和 `launch.rs::PASS_ENV`
/// 是同一份名单，但那边是私有常量，这个文件故意不依赖 `launch.rs` 内部细节（governor 合并
/// `869bcdf` 时不用改这个文件），所以在这里单独放一份；两边各自维护不是问题，这组变量
/// （终端、区域设置）本身就是平台相关的静态事实，不会出现「各改各的」的漂移风险。
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

#[cfg(unix)]
fn client_env_get<'a>(env: &'a BTreeMap<String, String>, key: &str) -> Option<&'a String> {
    env.get(key)
}

#[cfg(windows)]
fn client_env_get<'a>(env: &'a BTreeMap<String, String>, key: &str) -> Option<&'a String> {
    env.iter().find(|(k, _)| k.eq_ignore_ascii_case(key)).map(|(_, v)| v)
}

/// Kimi requires a context size for models supplied by older servers without model limits.
const DEFAULT_MAX_CONTEXT_SIZE: u64 = 32_000;

/// Kimi Code 的准备逻辑。调用前应已经做过 `r.program`/`r.cwd` 的公共校验
/// （和 `launch::prepare` 对 Claude Code 的顺序一致），这里只做 Kimi Code 特有的部分。
pub fn prepare_kimi_code(r: &Request) -> Result<Launch> {
    prepare_kimi_code_with_history(r, true)
}

pub(crate) fn prepare_kimi_code_with_history(r: &Request, include_history: bool) -> Result<Launch> {
    prepare_kimi_code_with_model_choices(r, include_history, &[], &BTreeMap::new())
}

pub(crate) fn prepare_kimi_code_with_model_choices(
    r: &Request,
    include_history: bool,
    model_choices: &[String],
    limits_by_alias: &BTreeMap<String, ModelLimits>,
) -> Result<Launch> {
    if !r.program.is_absolute() {
        bail!("agent executable path must be absolute: {}", r.program.display());
    }
    if !r.cwd.is_absolute() || !r.cwd.is_dir() {
        bail!("working directory not found: {}", r.cwd.display());
    }

    let launch_id = id::new("lch");
    let profiles = r.home.join("agents/kimi-code/profiles");
    let ns = profiles.join(&launch_id);
    let config_dir = ns.join("kimi");
    let user_home = ns.join("home");
    let tmp = ns.join("tmp");
    let skills = ns.join("skills");
    for d in [&ns, &config_dir, &user_home, &tmp, &skills] {
        private_dir(d)?;
    }

    if include_history {
        history::restore(r.home, &profiles, &config_dir, r.cwd)?;
    }

    let session_id = uuid_v4();
    let run_dir = r.home.join("run").join(&launch_id);
    private_dir(&r.home.join("run"))?;
    private_dir(&run_dir)?;

    let default_model_id = if model_choices.is_empty() { "onex" } else { r.model };
    let mut seen = BTreeSet::new();
    let models: Vec<_> = std::iter::once(r.model)
        .chain(model_choices.iter().map(String::as_str))
        .filter(|alias| seen.insert(*alias))
        .map(|alias| {
            let limits = limits_by_alias.get(alias);
            kimi_config::ModelSpec {
                id: if alias == r.model { default_model_id } else { alias }.into(),
                model: alias.into(),
                max_context_size: limits.map_or(DEFAULT_MAX_CONTEXT_SIZE, |limits| limits.context_window.get()),
                max_output_size: limits.and_then(|limits| limits.max_output_tokens.map(|limit| limit.get())),
                capabilities: vec!["tool_use".into()],
            }
        })
        .collect();
    let config_req = kimi_config::Request {
        provider_id: "onex",
        router_addr: r.router_addr,
        local_token: r.local_token,
        models: &models,
        default_model_id,
    };
    let config_text = kimi_config::render(&config_req).map_err(|e| anyhow!("render kimi config.toml: {e}"))?;
    let config_path = config_dir.join("config.toml");
    write_private(&config_path, config_text.as_bytes())?;

    let mut env = BTreeMap::new();
    for k in PASS_ENV {
        if let Some(v) = client_env_get(r.client_env, k) {
            env.insert(k.to_string(), v.clone());
        }
    }
    let path = client_env_get(r.client_env, "PATH").cloned().unwrap_or_else(|| "/usr/bin:/bin:/usr/sbin:/sbin".into());
    env.insert("PATH".into(), path);
    env.insert("HOME".into(), user_home.to_string_lossy().into_owned());
    env.insert("KIMI_CODE_HOME".into(), config_dir.to_string_lossy().into_owned());
    env.insert("TMPDIR".into(), format!("{}/", tmp.to_string_lossy()));
    for (key, dir) in [("XDG_CONFIG_HOME", "config"), ("XDG_DATA_HOME", "data"), ("XDG_CACHE_HOME", "cache")] {
        env.insert(key.to_owned(), user_home.join(dir).to_string_lossy().into_owned());
    }
    #[cfg(windows)]
    for k in ["USERPROFILE", "APPDATA", "LOCALAPPDATA"] {
        env.insert(k.into(), user_home.to_string_lossy().into_owned());
    }
    #[cfg(windows)]
    for k in ["TMP", "TEMP"] {
        env.insert(k.into(), tmp.to_string_lossy().into_owned());
    }
    // 本机 router 不走代理；Unix 大小写代理均清空，绕过回环代理（spec「配置、环境与协议」）。
    for k in ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "all_proxy"] {
        env.remove(k);
    }
    env.insert("NO_PROXY".into(), "localhost,127.0.0.1".into());
    env.insert("no_proxy".into(), "localhost,127.0.0.1".into());
    env.insert("KIMI_CODE_NO_AUTO_UPDATE".into(), "1".into());
    env.insert("KIMI_CLI_NO_AUTO_UPDATE".into(), "1".into());
    #[cfg(target_os = "macos")]
    env.insert("KIMI_CODE_WATCH".into(), "0".into());

    // 显式技能目录只包含受管资源。原生配置及参数仍由目标制品验收。
    let args =
        vec!["--model".into(), default_model_id.into(), "--skills-dir".into(), skills.to_string_lossy().into_owned()];
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

#[cfg(unix)]
fn private_dir(d: &Path) -> Result<()> {
    use std::os::unix::fs::PermissionsExt;
    std::fs::create_dir_all(d)?;
    std::fs::set_permissions(d, std::fs::Permissions::from_mode(0o700))?;
    Ok(())
}

#[cfg(windows)]
fn private_dir(d: &Path) -> Result<()> {
    std::fs::create_dir_all(d)?;
    Ok(())
}

/// 同目录临时写、fsync 后原子替换（spec「配置、环境与协议」：OneX 应按 launch 私有权限
/// 同目录临时写、fsync 后原子发布），不是先删除再 `create_new`——那种写法在中间短暂窗口里
/// 文件不存在，和「原子发布」的要求不符。
#[cfg(unix)]
fn write_private(path: &Path, data: &[u8]) -> Result<()> {
    use std::io::Write as _;
    use std::os::unix::fs::OpenOptionsExt;
    let tmp = path.with_extension(format!("{}.tmp", id::new("t")));
    let mut f = std::fs::OpenOptions::new().write(true).create_new(true).mode(0o600).open(&tmp)?;
    f.write_all(data)?;
    f.sync_all()?;
    std::fs::rename(&tmp, path).inspect_err(|_| {
        let _ = std::fs::remove_file(&tmp);
    })?;
    Ok(())
}

#[cfg(windows)]
fn write_private(path: &Path, data: &[u8]) -> Result<()> {
    use std::io::Write as _;
    let tmp = path.with_extension(format!("{}.tmp", id::new("t")));
    let mut f = std::fs::OpenOptions::new().write(true).create_new(true).open(&tmp)?;
    f.write_all(data)?;
    f.sync_all()?;
    std::fs::rename(&tmp, path).inspect_err(|_| {
        let _ = std::fs::remove_file(&tmp);
    })?;
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

    #[test]
    fn per_launch_model_menu_uses_signed_aliases_and_limits() {
        let home = tempfile::tempdir().unwrap();
        let cwd = tempfile::tempdir().unwrap();
        let program = std::env::current_exe().unwrap();
        let env = BTreeMap::new();
        let request = Request {
            agent: "kimi-code",
            home: home.path(),
            router_addr: "127.0.0.1:4567",
            local_token: "fixture-token",
            model: "Qwen3.8-27B",
            program: &program,
            cwd: cwd.path(),
            client_env: &env,
        };
        let choices = ["provider/flash-v1.2".into(), "Qwen3.8-27B".into(), "provider/flash-v1.2".into()];
        let limits = BTreeMap::from([(
            "provider/flash-v1.2".into(),
            ModelLimits {
                context_window: 262_144_u64.try_into().unwrap(),
                max_output_tokens: Some(8192_u64.try_into().unwrap()),
            },
        )]);
        let launch = prepare_kimi_code_with_model_choices(&request, false, &choices, &limits).unwrap();
        let config = std::fs::read_to_string(launch.config_dir.join("config.toml")).unwrap();
        assert_eq!(&launch.args[..2], &["--model", "Qwen3.8-27B"]);
        assert!(config.contains("default_model = \"Qwen3.8-27B\""));
        assert_eq!(config.matches("[models.\"Qwen3.8-27B\"]").count(), 1);
        assert!(config.contains("max_context_size = 32000"));
        assert_eq!(config.matches("[models.\"provider/flash-v1.2\"]").count(), 1);
        assert!(config.contains(concat!(
            "[models.\"provider/flash-v1.2\"]\nprovider = \"onex\"\nmodel = \"provider/flash-v1.2\"\n",
            "max_context_size = 262144\nmax_output_size = 8192\n"
        )));

        let legacy = prepare_kimi_code_with_history(&request, false).unwrap();
        let config = std::fs::read_to_string(legacy.config_dir.join("config.toml")).unwrap();
        assert_eq!(&legacy.args[..2], &["--model", "onex"]);
        assert!(config.contains("[models.onex]"));
        assert_eq!(config.matches("[models.").count(), 1);
    }

    #[cfg(unix)]
    fn client_env() -> BTreeMap<String, String> {
        [
            ("PATH", "/opt/homebrew/bin:/usr/bin"),
            ("TERM", "xterm-256color"),
            ("HOME", "/Users/someone"),
            ("ANTHROPIC_AUTH_TOKEN", "personal"),
            ("HTTPS_PROXY", "http://corp:3128"),
            ("AWS_PROFILE", "x"),
        ]
        .into_iter()
        .map(|(k, v)| (k.to_string(), v.to_string()))
        .collect()
    }

    #[cfg(unix)]
    #[test]
    fn prepares_isolated_kimi_code_launch() {
        let home = tempfile::tempdir().unwrap();
        let cwd = tempfile::tempdir().unwrap();
        let env = client_env();
        let r = Request {
            agent: "kimi-code",
            home: home.path(),
            router_addr: "127.0.0.1:4567",
            local_token: "0123456789abcdef0123456789abcdef",
            model: "Qwen3.8-27B",
            program: Path::new("/usr/local/bin/kimi"),
            cwd: cwd.path(),
            client_env: &env,
        };
        let l = prepare_kimi_code(&r).unwrap();
        let ns = home.path().join("agents/kimi-code/profiles").join(&l.launch_id);
        assert_eq!(l.env["HOME"], ns.join("home").to_string_lossy());
        assert_eq!(l.env["KIMI_CODE_HOME"], ns.join("kimi").to_string_lossy());
        assert_eq!(l.config_dir, ns.join("kimi"));
        // 个人认证、代理、云后端一概不带；本机 router 的本机令牌不进 Agent 自己的环境变量,
        // 只写进 config.toml（Kimi Code 不支持 `api_key_env`，spec「配置、环境与协议」）。
        for k in ["ANTHROPIC_AUTH_TOKEN", "HTTPS_PROXY", "AWS_PROFILE"] {
            assert!(!l.env.contains_key(k), "{k}");
        }
        assert_eq!(l.env["KIMI_CODE_NO_AUTO_UPDATE"], "1");
        assert_eq!(l.env["KIMI_CLI_NO_AUTO_UPDATE"], "1");
        assert_eq!(l.env["NO_PROXY"], "localhost,127.0.0.1");

        let config_path = l.config_dir.join("config.toml");
        assert!(!l.args.iter().any(|arg| arg == "--config"));
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(std::fs::metadata(&config_path).unwrap().permissions().mode() & 0o777, 0o600);
        }
        let text = std::fs::read_to_string(&config_path).unwrap();
        assert!(text.contains("http://127.0.0.1:4567"));
        assert!(!text.contains("/v1"));
        assert!(text.contains("0123456789abcdef0123456789abcdef"));
        assert!(text.contains("Qwen3.8-27B"));

        std::fs::write(l.config_dir.join("history.json"), b"conversation").unwrap();
        // 删除认证配置后仍能收尾和补采。
        crate::launch::finish(home.path(), &l.launch_id).unwrap();
        assert!(!config_path.exists());
        assert!(!l.run_dir.exists());
        assert!(l.config_dir.join("history.json").is_file());
        let stale = prepare_kimi_code(&r).unwrap();
        crate::launch::clean_stale(home.path());
        assert!(!stale.config_dir.join("config.toml").exists());
        assert!(!stale.run_dir.exists());
        for path in files_under(&ns) {
            let bytes = std::fs::read(&path).unwrap();
            assert!(
                !contains_subslice(&bytes, b"0123456789abcdef0123456789abcdef"),
                "token leaked into {}",
                path.display()
            );
        }
    }

    #[cfg(unix)]
    #[test]
    fn rejects_relative_program_and_missing_cwd() {
        let home = tempfile::tempdir().unwrap();
        let env = BTreeMap::new();
        let base = Request {
            agent: "kimi-code",
            home: home.path(),
            router_addr: "127.0.0.1:1",
            local_token: "t",
            model: "m",
            program: Path::new("kimi"),
            cwd: Path::new("/"),
            client_env: &env,
        };
        assert!(prepare_kimi_code(&base).is_err());
        let r = Request { program: Path::new("/bin/kimi"), cwd: Path::new("/no/such/dir"), ..base };
        assert!(prepare_kimi_code(&r).is_err());
    }

    /// 递归列出目录下的所有普通文件（测试用，只在这个很小的私有目录树上跑，不考虑符号链接
    /// 循环等一般递归遍历要防的问题）。
    fn files_under(dir: &Path) -> Vec<std::path::PathBuf> {
        let mut out = Vec::new();
        let Ok(entries) = std::fs::read_dir(dir) else { return out };
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_dir() {
                out.extend(files_under(&path));
            } else if path.is_file() {
                out.push(path);
            }
        }
        out
    }

    fn contains_subslice(haystack: &[u8], needle: &[u8]) -> bool {
        haystack.windows(needle.len()).any(|w| w == needle)
    }
}
