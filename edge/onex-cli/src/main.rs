//! onex：onexd 的调试命令行。
//!
//! ```text
//! onex status
//! onex login <device_token>
//! onex shutdown
//! ```

use std::path::PathBuf;

use anyhow::{Context, Result, bail};
use onex_core::ipc::{Request, SOCKET_NAME};
use serde_json::Value;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::net::UnixStream;

#[tokio::main(flavor = "current_thread")]
async fn main() -> Result<()> {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let req = match args.iter().map(String::as_str).collect::<Vec<_>>().as_slice() {
        ["status"] => Request::Status,
        ["login", token] => Request::Login { token: token.to_string() },
        ["shutdown"] => Request::Shutdown,
        _ => bail!("usage: onex status | onex login <device_token> | onex shutdown"),
    };

    let path = socket_path()?;
    let stream =
        UnixStream::connect(&path).await.with_context(|| format!("connect {} (is onexd running?)", path.display()))?;
    let (r, mut w) = stream.into_split();
    let mut line = serde_json::to_string(&req)?;
    line.push('\n');
    w.write_all(line.as_bytes()).await?;

    let mut reply = String::new();
    BufReader::new(r).read_line(&mut reply).await?;
    let v: Value = serde_json::from_str(&reply).context("bad reply from onexd")?;
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
