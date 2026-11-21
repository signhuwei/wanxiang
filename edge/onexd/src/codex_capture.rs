//! Codex 会话采集（S2，`contracts/edge-ws.md` 多 Agent 一节、`docs/specs/agents/codex.md`）。
//!
//! 每个已核验的 rollout 按原生 thread 派生 OneX 会话，增量以文件和字节偏移为游标。
//! UI 镜像和内部提示不回流，压缩记录只回流压缩事件。

use std::path::{Path, PathBuf};
use std::sync::Arc;

use anyhow::Result;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};

use crate::capture::Session;
use crate::outbox::Outbox;

/// 单行上限，超过记 gap 跳过（和 capture.rs 同一个量级：rollout 的工具输出理论上也可能很大）。
const MAX_LINE: usize = 16 * 1024 * 1024;
const READ_CHUNK: u64 = MAX_LINE as u64 + 1;

pub struct Capture {
    s: Session,
    outbox: Arc<Outbox>,
    key: String,
    path: PathBuf,
    agent: &'static str,
}

impl Capture {
    pub fn new(s: Session, path: PathBuf, outbox: Arc<Outbox>) -> Self {
        let key = format!("codex:{}", s.session_id);
        Self { s, path, outbox, key, agent: "codex" }
    }

    pub(crate) fn desktop(mut self) -> Self {
        self.agent = "codex-desktop";
        self
    }

    fn base(&self, kind: &str, payload: Value, offset: Option<u64>) -> Value {
        json!({"session_id": self.s.session_id, "kind": kind, "at": crate::pricing::format_ms(crate::outbox::now_ms()),
            "source_offset": offset, "payload": payload})
    }

    fn gap(&self, reason: &str, offset: u64) -> Value {
        self.base(
            "gap",
            json!({"reason": reason, "offset": offset, "uuid": null, "parentUuid": null, "sidechain": false, "agent_id": null}),
            Some(offset),
        )
    }

    pub fn pass(&self) -> Result<()> {
        let mut cur = self.outbox.cursor(&self.key)?.unwrap_or(json!({"started": false, "ino": null, "offset": 0}));
        let mut events = Vec::new();
        if cur["started"] != true {
            let cwd_hash = crate::capture::hex(&Sha256::digest(self.s.cwd.to_string_lossy().as_bytes()));
            events.push(self.base(
                "session_start",
                json!({"agent": self.agent, "agent_version": self.s.agent_version, "cwd_hash": cwd_hash,
                    "model": self.s.model, "uuid": null, "parentUuid": null, "sidechain": false, "agent_id": null}),
                None,
            ));
            cur["started"] = true.into();
        }
        self.read_file(&self.path, &mut cur, &mut events)?;
        if !events.is_empty() {
            cur["ended"] = false.into();
        }
        if !events.is_empty() || cur != self.outbox.cursor(&self.key)?.unwrap_or(Value::Null) {
            self.outbox.append_events_with_cursor(events, &self.key, &cur)?;
        }
        Ok(())
    }

    fn read_file(&self, path: &Path, cur: &mut Value, events: &mut Vec<Value>) -> Result<()> {
        let Ok(meta) = std::fs::symlink_metadata(path) else {
            // 绑定的文件暂时不存在（极少见：绑定和真正落盘之间的窗口），下次再试，不记 gap。
            return Ok(());
        };
        if !meta.file_type().is_file() || !crate::capture::owned_by_same_principal(path, &self.s.config_dir)? {
            if cur["refused"] != true {
                events.push(self.gap("not_regular_file", 0));
                cur["refused"] = true.into();
            }
            return Ok(());
        }
        let mut offset = cur["offset"].as_u64().unwrap_or(0);
        let identity = crate::capture::file_identity(path, &meta)?;
        if cur["ino"].as_u64().is_some_and(|i| i != identity) {
            events.push(self.gap("file_replaced", offset));
            offset = 0;
        } else if meta.len() < offset {
            events.push(self.gap("file_truncated", offset));
            offset = 0;
        }
        cur["ino"] = identity.into();
        if meta.len() == offset {
            cur["offset"] = offset.into();
            return Ok(());
        }
        let buf = crate::capture::read_range(path, offset, READ_CHUNK.min(meta.len() - offset))?;
        let mut pos = 0;
        while let Some(nl) = buf[pos..].iter().position(|&b| b == b'\n') {
            let line = &buf[pos..pos + nl];
            self.line(line, offset + pos as u64, events);
            pos += nl + 1;
        }
        if pos == 0 && buf.len() > MAX_LINE {
            events.push(self.gap("line_too_large", offset));
            match crate::capture::find_newline(path, offset + buf.len() as u64)? {
                Some(next) => pos = (next + 1 - offset) as usize,
                None => pos = buf.len(),
            }
        }
        cur["offset"] = (offset + pos as u64).into();
        Ok(())
    }
}

const IGNORED_RECORD_TYPES: &[&str] =
    &["session_meta", "turn_context", "event_msg", "world_state", "token_usage_record"];
const IGNORED_ITEM_TYPES: &[&str] = &["reasoning", "environment_context", "user_instructions", "ghost_snapshot"];

impl Capture {
    fn line(&self, raw: &[u8], offset: u64, out: &mut Vec<Value>) {
        if raw.iter().all(u8::is_ascii_whitespace) {
            return;
        }
        if raw.len() > MAX_LINE {
            out.push(self.gap("line_too_large", offset));
            return;
        }
        let Ok(v) = serde_json::from_slice::<Value>(raw) else {
            out.push(self.gap("bad_json", offset));
            return;
        };
        let ty = v["type"].as_str().unwrap_or("");
        let start = out.len();
        match ty {
            known if IGNORED_RECORD_TYPES.contains(&known) => {}
            "compacted" => {
                let summary = v["payload"]["summary"].as_str().filter(|s| !s.is_empty());
                out.push(self.base("compact", self.common(json!({"summary": summary}), &v["payload"]), Some(offset)));
            }
            "response_item" => self.response_item(&v["payload"], offset, out),
            other => out.push(self.gap(&format!("unknown_type:{}", crate::capture::truncate(other, 40)), offset)),
        }
        if let Some(timestamp) = v["timestamp"].as_str().and_then(crate::pricing::parse_ms) {
            for event in &mut out[start..] {
                event["at"] = json!(crate::pricing::format_ms(timestamp));
            }
        }
    }

    fn common(&self, mut p: Value, item: &Value) -> Value {
        p["uuid"] = item["id"].as_str().into();
        p["parentUuid"] = item["parent_id"].as_str().into();
        p["sidechain"] = false.into();
        // 子 Agent 的 rollout 采集 S2 不支持（codex.md 标 CODEX_SUBAGENT_CAPTURE_UNSUPPORTED），
        // 这里固定写 null，不是遗漏。
        p["agent_id"] = Value::Null;
        p
    }

    /// `response_item` 的 `payload` 本身就是一个 Responses API item，形状和 `responses.rs`
    /// 转换路径里处理的请求 item 是同一套（`message`/`function_call`/`function_call_output`），
    /// 额外还有原生 `custom_tool_call`/`custom_tool_call_output`（Codex 的自定义工具通道）。
    fn response_item(&self, item: &Value, offset: u64, out: &mut Vec<Value>) {
        let kind = item["type"].as_str().unwrap_or("");
        let call_id = item["call_id"].as_str().or_else(|| item["id"].as_str());
        match kind {
            known if IGNORED_ITEM_TYPES.contains(&known) => {}
            "message" => self.message_item(item, offset, out),
            "function_call" | "custom_tool_call" | "local_shell_call" => {
                let (name, input) = match kind {
                    "custom_tool_call" => (item["name"].as_str(), item["input"].clone()),
                    "local_shell_call" => (Some("local_shell"), item["action"].clone()),
                    _ => (item["name"].as_str(), parse_tool_args(item.get("arguments"))),
                };
                let (Some(call_id), Some(name)) = (call_id, name) else {
                    out.push(self.gap("tool_call_identity_missing", offset));
                    return;
                };
                let p = self.common(json!({"tool_call_id": call_id, "tool": name, "input": input}), item);
                out.push(self.base("tool_call", p, Some(offset)));
            }
            "function_call_output" | "custom_tool_call_output" | "local_shell_call_output" => {
                let Some(call_id) = call_id else {
                    out.push(self.gap("tool_result_identity_missing", offset));
                    return;
                };
                let (output, truncated) = crate::capture::tool_output(&function_call_output_content(item));
                let mut p = json!({"tool_call_id": call_id, "output": output});
                if truncated {
                    p["truncated"] = true.into();
                }
                out.push(self.base("tool_result", self.common(p, item), Some(offset)));
            }
            other => out.push(self.gap(&format!("response_item:{}", crate::capture::truncate(other, 40)), offset)),
        }
    }

    /// `message` item：`role` 是 `user` 或 `assistant`；`content` 是 `input_text`/`output_text`
    /// 块的数组（Codex 的 Responses item 没有 Anthropic 式的字符串简写）。非文本块
    /// （`input_image` 等）记缺口，不静默丢弃。
    fn message_item(&self, item: &Value, offset: u64, out: &mut Vec<Value>) {
        let role = item.get("role").and_then(Value::as_str).unwrap_or("");
        if matches!(role, "developer" | "system") {
            return;
        }
        if !matches!(role, "user" | "assistant") {
            out.push(self.gap(&format!("message_role:{}", crate::capture::truncate(role, 40)), offset));
            return;
        }
        let blocks = match item.get("content") {
            Some(Value::Array(a)) => a.clone(),
            Some(Value::String(s)) => vec![json!({"type": "input_text", "text": s})],
            _ => {
                out.push(self.gap("no_content", offset));
                return;
            }
        };
        let mut texts = Vec::new();
        for b in &blocks {
            match b.get("type").and_then(Value::as_str).unwrap_or("") {
                "input_text" | "output_text" => {
                    texts.push(b.get("text").and_then(Value::as_str).unwrap_or("").to_string())
                }
                other => out.push(self.gap(&format!("content_block:{}", crate::capture::truncate(other, 40)), offset)),
            }
        }
        let content = texts.join("\n");
        if content.trim().is_empty() || (role == "user" && is_injected_message(&content)) {
            return;
        }
        let kind = if role == "user" { "user_message" } else { "assistant_message" };
        let p = if role == "user" {
            json!({"content": content})
        } else {
            json!({"content": content, "model": self.s.model, "stop_reason": Value::Null})
        };
        out.push(self.base(kind, self.common(p, item), Some(offset)));
    }

    /// 进程退出：收尾写，然后发 session_end。
    pub fn end(&self, exit_code: Option<i32>) -> Result<()> {
        self.pass()?;
        let mut cur = self.outbox.cursor(&self.key)?.unwrap_or(json!({}));
        if cur["ended"] == true {
            return Ok(());
        }
        cur["ended"] = true.into();
        let reason = match exit_code {
            Some(0) => "exited".to_string(),
            Some(c) => format!("exit_code:{c}"),
            None => "unknown".to_string(),
        };
        let ev = self.base(
            "session_end",
            json!({"reason": reason, "uuid": null, "parentUuid": null, "sidechain": false, "agent_id": null}),
            None,
        );
        self.outbox.append_events_with_cursor(vec![ev], &self.key, &cur)
    }
}

fn is_injected_message(text: &str) -> bool {
    let text = text.trim();
    (text.starts_with("<environment_context>") && text.ends_with("</environment_context>"))
        || (text.starts_with("<user_instructions>") && text.ends_with("</user_instructions>"))
        || (text.starts_with("# AGENTS.md instructions for ")
            && text.contains("<INSTRUCTIONS>")
            && text.ends_with("</INSTRUCTIONS>"))
}

/// `function_call` 的 `arguments` 是一个 JSON 字符串（和 Chat/Responses 的函数参数编码一致），
/// 不是已经解析好的对象；解析失败时原样当字符串保留，不假装是个对象。
fn parse_tool_args(arguments: Option<&Value>) -> Value {
    let Some(s) = arguments.and_then(Value::as_str) else { return Value::Null };
    serde_json::from_str(s).unwrap_or_else(|_| json!(s))
}

/// `function_call_output` 的 `output` 可能是字符串，也可能是
/// `{"type":"function_call_output","output":"..."}` 之类的结构化包装；统一取出文本喂给
/// `tool_output`（它接受字符串或内容块数组）。
fn function_call_output_content(item: &Value) -> Value {
    match item.get("output") {
        Some(Value::String(s)) => json!(s),
        Some(Value::Object(o)) => {
            o.get("content").cloned().unwrap_or_else(|| json!(o.get("output").cloned().unwrap_or(Value::Null)))
        }
        other => other.cloned().unwrap_or(Value::Null),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_public_messages_survive_incremental_capture() {
        use std::io::Write;

        let home = tempfile::tempdir().unwrap();
        let outbox = Arc::new(Outbox::open(&home.path().join("outbox.sqlite")).unwrap());
        let path = home.path().join("rollout.jsonl");
        let mut file = std::fs::File::create(&path).unwrap();
        let record = |kind, payload| json!({"timestamp":"2026-11-20T01:00:00Z","type":kind,"payload":payload});
        let message = |role, text| json!({"type":"message","role":role,"content":[{"type":"input_text","text":text}]});
        for event in [
            record("response_item", message("developer", "private instruction")),
            record("response_item", message("user", "<environment_context>private details</environment_context>")),
            record("response_item", message("user", "public text")),
            record("event_msg", json!({"type":"user_message","message":"public text"})),
            record("world_state", json!({"data":"private workspace state"})),
            record("token_usage_record", json!({"data":"billing is reported by router"})),
            record("response_item", json!({"type":"reasoning","summary":[]})),
            record("compacted", json!({"message":"private snapshot","summary":"public summary"})),
        ] {
            writeln!(file, "{event}").unwrap();
        }
        let continued = record("response_item", message("user", "public text"));
        write!(file, "{continued}").unwrap();
        let session = Session {
            session_id: "test-session".into(),
            config_dir: home.path().into(),
            agent_version: None,
            model: "m".into(),
            cwd: home.path().into(),
        };
        let capture = Capture::new(session.clone(), path.clone(), outbox.clone());
        capture.pass().unwrap();
        assert_eq!(outbox.pending(0, 100).unwrap().len(), 3);
        writeln!(file).unwrap();
        let restarted = Capture::new(session, path, outbox.clone());
        restarted.end(Some(0)).unwrap();
        restarted.end(Some(0)).unwrap();
        let rows = outbox.pending(0, 100).unwrap();
        let kinds: Vec<&str> = rows.iter().map(|row| row.item["kind"].as_str().unwrap()).collect();
        assert_eq!(kinds, ["session_start", "user_message", "compact", "user_message", "session_end"]);
        assert_eq!(rows[2].item["payload"]["summary"], "public summary");
        assert_eq!(rows[1].item["payload"]["content"], rows[3].item["payload"]["content"]);
        assert_ne!(rows[1].item["source_offset"], rows[3].item["source_offset"]);
    }
}
