//! onex：onexd 的命令行。
//!
//! ```text
//! onex login <邮箱或手机号> [--invite <邀请码>] [--tenant <租户名或 id>] [--server <https://...>] [--name <设备名>]
//! onex status
//! onex token <device_token>    调试用：直接交给 onexd 一个已有的 device_token
//! onex shutdown
//! ```

mod login;

use std::io::{BufRead, Write};
use std::path::PathBuf;

use anyhow::{Context, Result, bail};
use onex_core::ipc::{Request, SOCKET_NAME};
use serde_json::Value;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::net::UnixStream;

const USAGE: &str = "usage:
  onex login <邮箱或手机号> [--invite <邀请码>] [--tenant <租户>] [--server <地址>] [--name <设备名>]
  onex status
  onex token <device_token>
  onex shutdown";

#[tokio::main(flavor = "current_thread")]
async fn main() -> Result<()> {
    let args: Vec<String> = std::env::args().skip(1).collect();
    match args.first().map(String::as_str) {
        Some("login") => cmd_login(&args[1..]).await,
        Some("status") if args.len() == 1 => print_reply(call(&Request::Status).await?),
        Some("token") if args.len() == 2 => print_reply(call(&Request::Login { token: args[1].clone() }).await?),
        Some("shutdown") if args.len() == 1 => print_reply(call(&Request::Shutdown).await?),
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
    let a = login::LoginArgs { server, target, invite, tenant, device_name, public_key };
    let r = login::login(&a, &mut prompt).await?;

    let reply = call(&Request::Login { token: r.device_token }).await?;
    if reply["ok"] != Value::Bool(true) {
        return print_reply(reply);
    }
    println!(
        "已登录租户「{}」，设备 {} 已注册。onexd 正在连接 Server，可用 onex status 查看。",
        r.tenant_name, r.device_id
    );
    Ok(())
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

async fn call(req: &Request) -> Result<Value> {
    let path = socket_path()?;
    let stream =
        UnixStream::connect(&path).await.with_context(|| format!("connect {} (is onexd running?)", path.display()))?;
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
    let home = match std::env::var_os("ONEX_HOME") {
        Some(h) => PathBuf::from(h),
        None => {
            PathBuf::from(std::env::var_os("HOME").context("HOME not set")?).join("Library/Application Support/OneX")
        }
    };
    Ok(home.join(SOCKET_NAME))
}
