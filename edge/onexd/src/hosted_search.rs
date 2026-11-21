//! A first-party stdio MCP transport for searches authorized and settled by OneX Server.

use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::time::Duration;

use anyhow::{Result, ensure};
use futures_util::StreamExt;
use onex_core::ipc::Request;
use onex_core::ws::SearchTool;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};

const MAX_LINE: u64 = 64 * 1024;
const MAX_REPLY: usize = 512 * 1024;
const PROTOCOL: &str = "2025-06-18";

#[derive(Deserialize, Serialize)]
pub(crate) struct McpConfig {
    pub socket: PathBuf,
    pub launch_id: String,
    pub capability: String,
    pub release_id: String,
    pub name: String,
}

pub(crate) fn valid_tools(tools: &[SearchTool]) -> bool {
    let mut ids = HashSet::new();
    tools.len() <= 64
        && tools.iter().all(|tool| {
            tool.id.strip_prefix("tool_").is_some_and(|id| {
                id.len() == 26 && id.bytes().all(|b| b"0123456789ABCDEFGHJKMNPQRSTVWXYZ".contains(&b))
            }) && ids.insert(&tool.id)
                && !tool.name.is_empty()
                && tool.name.len() <= 48
                && tool.name.as_bytes()[0] != b'-'
                && tool.name.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
                && !tool.agents.is_empty()
                && tool.agents.len() <= 3
                && tool.agents.iter().all(|agent| matches!(agent.as_str(), "claude-code" | "codex" | "kimi-code"))
        })
}

pub(crate) fn select<'a>(
    config: &'a crate::state::ConfigSnapshot,
    agent: &'a str,
) -> impl Iterator<Item = &'a SearchTool> {
    config
        .policy
        .iter()
        .flat_map(|policy| &policy.search_tools)
        .filter(move |release| release.agents.iter().any(|name| name == agent))
}

pub(crate) fn input_valid(query: &str, limit: u8) -> bool {
    !query.trim().is_empty() && query.encode_utf16().count() <= 2000 && (1..=20).contains(&limit)
}

async fn ipc_search(config: &McpConfig, query: &str, limit: u8, call_key: String) -> Result<Value> {
    let stream = onex_core::transport::connect(&config.socket).await?;
    let (reader, mut writer) = stream.into_split();
    let command = Request::HostedSearch {
        launch_id: config.launch_id.clone(),
        capability: config.capability.clone(),
        release_id: config.release_id.clone(),
        query: query.to_owned(),
        limit,
        call_key,
    };
    let mut request = serde_json::to_vec(&command)?;
    request.push(b'\n');
    writer.write_all(&request).await?;
    let mut reply = Vec::new();
    BufReader::new(reader).take(MAX_REPLY as u64 + 1).read_until(b'\n', &mut reply).await?;
    ensure!(reply.ends_with(b"\n") && reply.len() <= MAX_REPLY, "invalid hosted search reply");
    Ok(serde_json::from_slice(&reply)?)
}

fn tool_error(text: &str) -> Value {
    json!({"isError":true,"content":[{"type":"text","text":text}]})
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct SearchInput {
    query: String,
    #[serde(default = "default_limit")]
    limit: u8,
}

fn default_limit() -> u8 {
    5
}

async fn tool_call(config: &McpConfig, options: &Value, call_key: String) -> Value {
    if options["name"] != "search" {
        return tool_error("无此受管搜索工具。");
    }
    let Ok(input) = serde_json::from_value::<SearchInput>(options["arguments"].clone()) else {
        return tool_error("请提供查询词和有效的结果数量。");
    };
    if !input_valid(&input.query, input.limit) {
        return tool_error("查询词须为 1 至 2000 个字符，结果数量须在 1 至 20 之间。");
    }
    match tokio::time::timeout(Duration::from_secs(20), ipc_search(config, &input.query, input.limit, call_key)).await {
        Ok(Ok(value)) if value["ok"] == true && value["results"].is_array() => {
            json!({"content":[{"type":"text","text":value["results"].to_string()}]})
        }
        Ok(Ok(value)) if value["ok"] == true => {
            json!({"content":[{"type":"text","text":json!({"receipt":value["receipt"]}).to_string()}]})
        }
        Ok(Ok(value)) => tool_error(value["error"]["message"].as_str().unwrap_or("搜索未完成。")),
        _ => tool_error("未能确认搜索结果。请勿自动重试这笔调用。"),
    }
}

pub async fn stdio(path: &Path) -> Result<()> {
    let config: McpConfig = serde_json::from_slice(&std::fs::read(path)?)?;
    serve_stdio(&config, BufReader::new(tokio::io::stdin()), tokio::io::stdout()).await
}

pub(crate) async fn serve_stdio(
    config: &McpConfig,
    mut reader: impl tokio::io::AsyncBufRead + Unpin,
    mut writer: impl tokio::io::AsyncWrite + Unpin,
) -> Result<()> {
    let nonce = crate::id::token();
    let mut line = Vec::new();
    loop {
        line.clear();
        if (&mut reader).take(MAX_LINE + 1).read_until(b'\n', &mut line).await? == 0 {
            return Ok(());
        }
        ensure!(line.ends_with(b"\n") && line.len() <= MAX_LINE as usize, "oversized MCP message");
        let request = serde_json::from_slice::<Value>(&line);
        let reply = match request {
            Err(_) => json!({"jsonrpc":"2.0","id":null,"error":{"code":-32700,"message":"Parse error"}}),
            Ok(request) => {
                let Some(id) = request.get("id") else { continue };
                let method = request["method"].as_str();
                let result = match method {
                    Some("initialize") => {
                        let offered = request["params"]["protocolVersion"].as_str();
                        let version = offered
                            .filter(|v| matches!(*v, "2024-11-05" | "2025-03-26" | PROTOCOL))
                            .unwrap_or(PROTOCOL);
                        json!({"protocolVersion":version,"capabilities":{"tools":{}},
                            "serverInfo":{"name":"OneX Hosted Search","version":env!("CARGO_PKG_VERSION")}})
                    }
                    Some("ping") => json!({}),
                    Some("tools/list") => json!({"tools":[{"name":"search",
                        "description":format!("通过 OneX 使用受管搜索服务 {}。成功的搜索按次扣费。", config.name),
                        "inputSchema":{"type":"object","properties":{
                            "query":{"type":"string","minLength":1,"maxLength":2000},
                            "limit":{"type":"integer","minimum":1,"maximum":20,"default":5}},
                            "required":["query"],"additionalProperties":false}}]}),
                    Some("tools/call") => {
                        let mut hash = Sha256::new();
                        hash.update(nonce.as_bytes());
                        hash.update(id.to_string().as_bytes());
                        let call_key = crate::capture::hex(&hash.finalize());
                        tool_call(config, &request["params"], call_key).await
                    }
                    _ => Value::Null,
                };
                if result.is_null() {
                    json!({"jsonrpc":"2.0","id":id,"error":{"code":-32601,"message":"Method not found"}})
                } else {
                    json!({"jsonrpc":"2.0","id":id,"result":result})
                }
            }
        };
        let mut bytes = serde_json::to_vec(&reply)?;
        bytes.push(b'\n');
        writer.write_all(&bytes).await?;
        writer.flush().await?;
    }
}

pub(crate) async fn forward(
    client: &reqwest::Client,
    origin: &str,
    device_token: &str,
    release: &str,
    key: &str,
    session: &str,
    query: &str,
    limit: u8,
) -> Result<(reqwest::StatusCode, Value)> {
    let response = client
        .post(format!("{origin}/v1/edge/tool-search/{release}"))
        .bearer_auth(device_token)
        .header("Idempotency-Key", key)
        .timeout(Duration::from_secs(14))
        .json(&json!({"session_id":session,"query":query,"limit":limit}))
        .send()
        .await?;
    let status = response.status();
    let mut bytes = Vec::new();
    let mut stream = response.bytes_stream();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk?;
        ensure!(bytes.len() + chunk.len() <= MAX_REPLY, "oversized hosted search response");
        bytes.extend_from_slice(&chunk);
    }
    Ok((status, serde_json::from_slice(&bytes)?))
}
