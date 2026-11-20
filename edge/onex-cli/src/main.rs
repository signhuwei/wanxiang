//! onex：onexd 的命令行。
//!
//! ```text
//! onex login <邮箱或手机号> [--invite <邀请码>] [--tenant <租户名或 id>] [--server <https://...>] [--name <设备名>]
//! onex run <claude-code|codex|kimi-code> [--model <模型>] [--managed]   在当前目录启动指定 Agent
//!   不带 --managed：用 PATH 里已安装的可执行文件（claude-code → claude，codex → codex，kimi-code → kimi）
//!   带 --managed：由 onexd 按 Server 下发的发行目录自己选型、下载、校验、缓存后启动
//! onex status
//! onex token <device_token>    调试用：直接交给 onexd 一个已有的 device_token，不落 Keychain
//! onex logout    注销并让 onexd 退出；重新拉起后用新身份登录
//! onex shutdown
//! ```

mod login;

use std::collections::BTreeMap;
use std::io::{BufRead, Write};
use std::path::PathBuf;

use anyhow::{Context, Result, bail};
use onex_core::ipc::{Request, SOCKET_NAME};
use serde_json::Value;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};

/// `onex run` 支持的 agent，以及非 `--managed` 时去 PATH 里找的可执行文件名。
const AGENTS: &[(&str, &str)] = &[("claude-code", "claude"), ("codex", "codex"), ("kimi-code", "kimi")];

const USAGE: &str = "usage:
  onex login <邮箱或手机号> [--invite <邀请码>] [--tenant <租户>] [--server <地址>] [--name <设备名>]
  onex run <claude-code|codex|kimi-code> [--model <模型>] [--managed]
  onex status
  onex token <device_token>
  onex logout
  onex shutdown";

#[tokio::main(flavor = "current_thread")]
async fn main() -> Result<()> {
    let args: Vec<String> = std::env::args().skip(1).collect();
    match args.first().map(String::as_str) {
        Some("login") => cmd_login(&args[1..]).await,
        Some("status") if args.len() == 1 => print_reply(call(&Request::Status).await?),
        Some("token") if args.len() == 2 => {
            print_reply(call(&Request::Login { token: args[1].clone(), server: None, device_id: None }).await?)
        }
        Some("logout") if args.len() == 1 => print_reply(call(&Request::Logout).await?),
        Some("shutdown") if args.len() == 1 => print_reply(call(&Request::Shutdown).await?),
        Some("run") if args.len() >= 2 => cmd_run(&args[1], &args[2..]).await,
        _ => bail!("{USAGE}"),
    }
}

async fn cmd_login(args: &[String]) -> Result<()> {
    let mut target = None;
    let (mut invite, mut tenant, mut server, mut name) = (None, None, None, None);
    let mut it = args.iter();
    while let Some(a) = it.next() {
        let mut val = || it.next().cloned().with_context(|| format!("{a} 需要一个值\n{USAGE}"));
        match a.as_str() {
            "--invite" => invite = Some(val()?),
            "--tenant" => tenant = Some(val()?),
            "--server" => server = Some(val()?),
            "--name" => name = Some(val()?),
            s if !s.starts_with("--") && target.is_none() => target = Some(s.to_string()),
            _ => bail!("{USAGE}"),
        }
    }
    let target = target.context(USAGE)?;

    let info = call(&Request::DeviceInfo).await?;
    let public_key = info["public_key"].as_str().context("onexd did not return a public key")?.to_string();
    let server = match server.or_else(|| info["server_url"].as_str().map(str::to_owned)) {
        Some(s) => s,
        None => {
            bail!("onexd 没有配置 Server（ONEX_SERVER），请用 --server 指定，例如 --server http://192.168.3.211:8080")
        }
    };
    let device_name = name.unwrap_or_else(default_device_name);
    let a = login::LoginArgs { server: server.clone(), target, invite, tenant, device_name, public_key };
    let r = login::login(&a, &mut prompt).await?;

    let reply =
        call(&Request::Login { token: r.device_token, server: Some(server), device_id: Some(r.device_id.clone()) })
            .await?;
    if reply["ok"] != Value::Bool(true) {
        return print_reply(reply);
    }
    println!(
        "已登录租户「{}」，设备 {} 已注册。onexd 正在连接 Server，可用 onex status 查看。",
        r.tenant_name, r.device_id
    );
    println!("macOS 上设备身份已保存到系统 Keychain，onexd 重启后会自动恢复，不需要重新运行 onex login。");
    Ok(())
}

/// 未知 agent 时报错并列出可选项。
fn agent_binary(agent: &str) -> Result<&'static str> {
    AGENTS.iter().find(|(name, _)| *name == agent).map(|(_, bin)| *bin).with_context(|| {
        let names: Vec<&str> = AGENTS.iter().map(|(name, _)| *name).collect();
        format!("未知的 agent「{agent}」，可选：{}\n{USAGE}", names.join("、"))
    })
}

/// `onex run <agent>` 后面那部分参数：`--model <值>`、`--managed`，顺序和重复不限，未知参数报错。
fn parse_run_flags(args: &[String]) -> Result<(Option<String>, bool)> {
    let mut model = None;
    let mut managed = false;
    let mut it = args.iter();
    while let Some(a) = it.next() {
        match a.as_str() {
            "--model" => model = Some(it.next().cloned().with_context(|| format!("--model 需要一个值\n{USAGE}"))?),
            "--managed" => managed = true,
            _ => bail!("{USAGE}"),
        }
    }
    Ok((model, managed))
}

/// 默认用 PATH 里已安装的可执行文件（旧用法／调试）。`--managed` 时改由 onexd 按 Server 下发的发行目录
/// 自己选型、下载、校验、缓存后启动。环境完全按 onexd 给的来。
async fn cmd_run(agent: &str, args: &[String]) -> Result<()> {
    let binary = agent_binary(agent)?;
    let (model, managed) = parse_run_flags(args)?;
    let env: BTreeMap<String, String> = std::env::vars().collect();
    let (program, version) = if managed {
        (None, None)
    } else {
        // Windows 的环境变量名大小写不敏感，`std::env::vars()` 多半给出 `Path` 而不是全大写的
        // `PATH`；精确字符串匹配会漏掉它，见 onexd/src/launch.rs 的 client_env_get 同一个问题。
        let path = env_get(&env, "PATH");
        let program = find_on_path(binary, path.map(String::as_str).unwrap_or("")).with_context(|| {
            format!("PATH 里找不到 {binary}。请先安装对应的 Agent，或加 --managed 让 onexd 自动下载")
        })?;
        let version = std::process::Command::new(&program)
            .arg("--version")
            .env_clear()
            .env("PATH", path.cloned().unwrap_or_default())
            .output()
            .ok()
            .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string());
        (Some(program.to_string_lossy().into_owned()), version)
    };
    let cwd = std::env::current_dir()?;
    let req = Request::Launch {
        agent: agent.into(),
        program,
        cwd: cwd.to_string_lossy().into(),
        env,
        model,
        agent_version: version.clone(),
    };
    let l = call(&req).await?;
    if l["ok"] != Value::Bool(true) {
        return print_reply(l);
    }
    let launch_id = l["launch_id"].as_str().context("no launch_id")?.to_string();
    eprintln!(
        "OneX：用 {}{} 启动 {agent}，模型 {}，会话 {}",
        l["program"].as_str().unwrap_or("?"),
        version.map(|v| format!(" ({v})")).unwrap_or_default(),
        l["model"].as_str().unwrap_or(""),
        l["session_id"].as_str().unwrap_or("")
    );
    let mut cmd = std::process::Command::new(l["program"].as_str().context("no program")?);
    cmd.env_clear().current_dir(l["cwd"].as_str().context("no cwd")?);
    for a in l["args"].as_array().context("no args")? {
        cmd.arg(a.as_str().context("bad arg")?);
    }
    for (k, v) in l["env"].as_object().context("no env")? {
        cmd.env(k, v.as_str().context("bad env")?);
    }
    // Ctrl+C 交给前台的 Agent；这里只等它退出
    let status = cmd.status().with_context(|| format!("启动 {binary} 失败"));
    let code = status.as_ref().ok().and_then(|s| s.code());
    let done = call(&Request::LaunchDone { launch_id, exit_code: code }).await;
    let status = status?;
    if let Err(e) = done {
        eprintln!("OneX：通知 onexd 结束时出错：{e:#}");
    }
    std::process::exit(code.unwrap_or(if status.success() { 0 } else { 1 }));
}

/// Unix：`PATH` 按目录找 `name`，要求有可执行位。Windows 没有可执行位的概念，按 `PATHEXT`
/// 逐个后缀试（`claude` 在 Windows 上一般装成 `claude.cmd` 或 `claude.exe`），不带可执行位检查。
#[cfg(unix)]
fn find_on_path(name: &str, path: &str) -> Option<PathBuf> {
    use std::os::unix::fs::PermissionsExt;
    std::env::split_paths(path)
        .filter(|d| d.is_absolute())
        .map(|d| d.join(name))
        .find(|p| std::fs::metadata(p).is_ok_and(|m| m.is_file() && m.permissions().mode() & 0o111 != 0))
}

#[cfg(windows)]
fn find_on_path(name: &str, path: &str) -> Option<PathBuf> {
    let pathext = std::env::var("PATHEXT").unwrap_or_else(|_| ".COM;.EXE;.BAT;.CMD".into());
    let exts: Vec<&str> = pathext.split(';').filter(|e| !e.is_empty()).collect();
    std::env::split_paths(path)
        .filter(|d| d.is_absolute())
        .find_map(|d| exts.iter().map(|ext| d.join(format!("{name}{ext}"))).find(|p| p.is_file()))
}

/// Windows 环境变量名大小写不敏感，`std::env::vars()` 收进 `BTreeMap` 之后精确字符串匹配会漏掉
/// 实际存在但大小写不同的键（典型是 `Path` 而不是 `PATH`）。Unix 保持精确匹配，环境变量本身
/// 大小写敏感，不该把 `path` 和 `PATH` 当成同一个变量。
#[cfg(unix)]
fn env_get<'a>(env: &'a BTreeMap<String, String>, key: &str) -> Option<&'a String> {
    env.get(key)
}

#[cfg(windows)]
fn env_get<'a>(env: &'a BTreeMap<String, String>, key: &str) -> Option<&'a String> {
    env.iter().find(|(k, _)| k.eq_ignore_ascii_case(key)).map(|(_, v)| v)
}

fn prompt(p: &str) -> Result<String> {
    eprint!("{p}");
    std::io::stderr().flush()?;
    let mut s = String::new();
    if std::io::stdin().lock().read_line(&mut s)? == 0 {
        bail!("输入已结束");
    }
    Ok(s)
}

#[cfg(target_os = "macos")]
fn default_device_name() -> String {
    std::process::Command::new("scutil")
        .args(["--get", "ComputerName"])
        .output()
        .ok()
        .filter(|o| o.status.success())
        .and_then(|o| String::from_utf8(o.stdout).ok())
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "OneX Edge".into())
}

/// Windows 没有对应的 `scutil`；机器名就是 `COMPUTERNAME` 环境变量（登录会话一直有效）。
#[cfg(windows)]
fn default_device_name() -> String {
    std::env::var("COMPUTERNAME")
        .ok()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "OneX Edge".into())
}

async fn call(req: &Request) -> Result<Value> {
    let path = socket_path()?;
    let stream = onex_core::transport::connect(&path)
        .await
        .with_context(|| format!("connect {} (is onexd running?)", path.display()))?;
    let (r, mut w) = stream.into_split();
    let mut line = serde_json::to_string(req)?;
    line.push('\n');
    w.write_all(line.as_bytes()).await?;

    let mut reply = String::new();
    BufReader::new(r).read_line(&mut reply).await?;
    serde_json::from_str(&reply).context("bad reply from onexd")
}

fn print_reply(v: Value) -> Result<()> {
    println!("{}", serde_json::to_string_pretty(&v)?);
    if v["ok"] != Value::Bool(true) {
        std::process::exit(1);
    }
    Ok(())
}

fn socket_path() -> Result<PathBuf> {
    let home = onex_core::ipc::default_home().map_err(anyhow::Error::msg)?;
    Ok(home.join(SOCKET_NAME))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn each_known_agent_resolves_its_path_binary_name() {
        assert_eq!(agent_binary("claude-code").unwrap(), "claude");
        assert_eq!(agent_binary("codex").unwrap(), "codex");
        assert_eq!(agent_binary("kimi-code").unwrap(), "kimi");
    }

    #[test]
    fn an_unknown_agent_lists_the_valid_choices() {
        let err = agent_binary("gpt-pilot").unwrap_err().to_string();
        assert!(err.contains("gpt-pilot"), "{err}");
        assert!(err.contains("claude-code"), "{err}");
        assert!(err.contains("codex"), "{err}");
        assert!(err.contains("kimi-code"), "{err}");
    }

    fn args(items: &[&str]) -> Vec<String> {
        items.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn flags_parse_model_and_managed_in_either_order_and_default_to_unmanaged() {
        assert_eq!(parse_run_flags(&args(&[])).unwrap(), (None, false));
        assert_eq!(parse_run_flags(&args(&["--managed"])).unwrap(), (None, true));
        assert_eq!(
            parse_run_flags(&args(&["--model", "sonnet"])).unwrap(),
            (Some("sonnet".into()), false)
        );
        assert_eq!(
            parse_run_flags(&args(&["--managed", "--model", "sonnet"])).unwrap(),
            (Some("sonnet".into()), true)
        );
        assert_eq!(
            parse_run_flags(&args(&["--model", "sonnet", "--managed"])).unwrap(),
            (Some("sonnet".into()), true)
        );
    }

    #[test]
    fn a_missing_model_value_is_an_error() {
        assert!(parse_run_flags(&args(&["--model"])).is_err());
    }

    #[test]
    fn an_unknown_flag_is_an_error() {
        assert!(parse_run_flags(&args(&["--bogus"])).is_err());
    }

    /// `onex run` 不接受第二个位置参数（agent 名已经单独消费掉）；多出来的裸词按未知参数处理。
    #[test]
    fn a_stray_positional_argument_is_an_error() {
        assert!(parse_run_flags(&args(&["extra"])).is_err());
    }

    #[test]
    fn find_on_path_reports_nothing_for_an_agent_missing_from_an_empty_path() {
        // 真实命令不会放一个空 PATH；这里只验证"找不到"这条路径本身不会 panic 或误报找到。
        assert_eq!(find_on_path("claude", ""), None);
        assert_eq!(find_on_path("codex", ""), None);
        assert_eq!(find_on_path("kimi", ""), None);
    }

    #[cfg(unix)]
    #[test]
    fn find_on_path_finds_an_executable_file_and_skips_non_executable_or_directory_entries() {
        use std::fs;
        use std::os::unix::fs::PermissionsExt;
        let dir = std::env::temp_dir().join(format!("onex-cli-test-{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        let exe = dir.join("codex");
        fs::write(&exe, b"#!/bin/sh\n").unwrap();
        fs::set_permissions(&exe, fs::Permissions::from_mode(0o755)).unwrap();
        let not_exe = dir.join("kimi");
        fs::write(&not_exe, b"no shebang, no exec bit").unwrap();
        let found = find_on_path("codex", &dir.to_string_lossy());
        assert_eq!(found.as_deref(), Some(exe.as_path()));
        assert_eq!(find_on_path("kimi", &dir.to_string_lossy()), None);
        fs::remove_dir_all(&dir).unwrap();
    }
}
