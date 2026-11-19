//! 会话采集（S1-E3 最小版）：只读 Claude Code 主会话的 jsonl，转成会话事件写进 outbox。
//!
//! 事件：`session_start`、`user_message`、`assistant_message`、`tool_call`、`tool_result`、`session_end`，
//! 读不懂的一律 `gap`。子 Agent 文件、压缩、图片 MVP 不处理：压缩摘要行和图片块记 gap。
//! 不回流 thinking、签名，以及 `api-request*` 等非对话行（版本白名单里已知的非对话行直接跳过，不记 gap）。
//!
//! 增量：游标 `(inode, offset)`，从 offset 读到最后一个换行，半行留到下次。事件和游标在 outbox 的同一个事务里提交。
//! 文件变短或 inode 变了，记 gap 后从头重读。

use std::os::unix::fs::MetadataExt;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use anyhow::{Context, Result};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use tokio_util::sync::CancellationToken;
use tracing::{info, warn};

use crate::outbox::{Outbox, now_ms};
use crate::pricing::format_ms;

/// 单行上限，超过记 gap 跳过
const MAX_LINE: usize = 16 * 1024 * 1024;
/// tool_result 输出上限
const MAX_OUTPUT: usize = 64 * 1024;
/// 每次最多读这么多字节：比单行上限多一个字节，读满还没有换行就是超长行
const READ_CHUNK: u64 = MAX_LINE as u64 + 1;

/// 2.1.311 样本中见到的非对话行（coord/samples/claude-code-2.1.311-transcript-shape.md），跳过不记 gap。
/// `system` 也先跳过：MVP 不处理 away_summary 等公开记录。
const IGNORED_TYPES: &[&str] = &[
    "custom-title",
    "ai-title",
    "agent-name",
    "mode",
    "permission-mode",
    "atis-latch",
    "last-prompt",
    "tools-used",
    "queue-operation",
    "file-history-snapshot",
    "file-history-delta",
    "api-request-shape",
    "api-request-blob",
    "api-request",
    "attachment",
    "system",
];

#[derive(Debug, Clone)]
pub struct Session {
    pub session_id: String,
    pub config_dir: PathBuf,
    pub agent_version: Option<String>,
    pub model: String,
    pub cwd: PathBuf,
}

/// 一次读取的结果（测试用）
#[derive(Debug, Default, PartialEq)]
pub struct Pass {
    pub events: usize,
}

pub struct Capture {
    s: Session,
    outbox: Arc<Outbox>,
    key: String,
}

impl Capture {
    pub fn new(s: Session, outbox: Arc<Outbox>) -> Self {
        let key = format!("claude-code:{}", s.session_id);
        Self { s, outbox, key }
    }

    fn file(&self) -> Option<PathBuf> {
        // 不自己推算项目目录的转义规则，在 projects/*/ 下找
        let name = format!("{}.jsonl", self.s.session_id);
        std::fs::read_dir(self.s.config_dir.join("projects"))
            .ok()?
            .flatten()
            .map(|e| e.path().join(&name))
            .find(|p| p.is_file())
    }

    fn base(&self, kind: &str, payload: Value, offset: Option<u64>) -> Value {
        json!({"session_id": self.s.session_id, "kind": kind, "at": format_ms(now_ms()),
            "source_offset": offset, "payload": payload})
    }

    /// 读一次新增内容。首次调用时补发 session_start。
    pub fn pass(&self) -> Result<Pass> {
        let mut cur = self.outbox.cursor(&self.key)?.unwrap_or(json!({"started": false, "ino": null, "offset": 0}));
        let mut events = Vec::new();
        if cur["started"] != true {
            let cwd_hash = hex(&Sha256::digest(self.s.cwd.to_string_lossy().as_bytes()));
            events.push(self.base(
                "session_start",
                json!({"agent": "claude-code", "agent_version": self.s.agent_version, "cwd_hash": cwd_hash,
                    "model": self.s.model, "uuid": null, "parentUuid": null, "sidechain": false, "agent_id": null}),
                None,
            ));
            cur["started"] = true.into();
        }
        if let Some(path) = self.file() {
            self.read_file(&path, &mut cur, &mut events)?;
        }
        let n = events.len();
        if n > 0 || cur != self.outbox.cursor(&self.key)?.unwrap_or(Value::Null) {
            self.outbox.append_events_with_cursor(events, &self.key, &cur)?;
        }
        Ok(Pass { events: n })
    }

    fn read_file(&self, path: &Path, cur: &mut Value, events: &mut Vec<Value>) -> Result<()> {
        let meta = std::fs::symlink_metadata(path)?;
        // 只读普通文件，拒绝符号链接和别人的文件（受管配置目录由 onexd 自己创建，以它的所有者为准）
        let owner = std::fs::metadata(&self.s.config_dir)?.uid();
        if !meta.file_type().is_file() || meta.uid() != owner {
            if cur["refused"] != true {
                events.push(self.gap("not_regular_file", 0));
                cur["refused"] = true.into();
            }
            return Ok(());
        }
        let mut offset = cur["offset"].as_u64().unwrap_or(0);
        if cur["ino"].as_u64().is_some_and(|i| i != meta.ino()) {
            events.push(self.gap("file_replaced", offset));
            offset = 0;
        } else if meta.len() < offset {
            events.push(self.gap("file_truncated", offset));
            offset = 0;
        }
        cur["ino"] = meta.ino().into();
        if meta.len() == offset {
            cur["offset"] = offset.into();
            return Ok(());
        }
        let buf = read_range(path, offset, READ_CHUNK.min(meta.len() - offset))?;
        let mut pos = 0;
        while let Some(nl) = buf[pos..].iter().position(|&b| b == b'\n') {
            let line = &buf[pos..pos + nl];
            self.line(line, offset + pos as u64, events);
            pos += nl + 1;
        }
        // 没有换行的半行：太长就跳过，否则留到下次
        if pos == 0 && buf.len() > MAX_LINE {
            events.push(self.gap("line_too_large", offset));
            // 跳到下一个换行之后
            match find_newline(path, offset + buf.len() as u64)? {
                Some(next) => pos = (next + 1 - offset) as usize,
                None => pos = buf.len(),
            }
        }
        cur["offset"] = (offset + pos as u64).into();
        Ok(())
    }

    fn gap(&self, reason: &str, offset: u64) -> Value {
        self.base(
            "gap",
            json!({"reason": reason, "offset": offset, "uuid": null, "parentUuid": null, "sidechain": false, "agent_id": null}),
            Some(offset),
        )
    }

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
        if IGNORED_TYPES.contains(&ty) {
            return;
        }
        if !matches!(ty, "user" | "assistant") {
            out.push(self.gap(&format!("unknown_type:{}", truncate(ty, 40)), offset));
            return;
        }
        if v["sessionId"].as_str() != Some(self.s.session_id.as_str()) {
            out.push(self.gap("session_mismatch", offset));
            return;
        }
        // MVP 只处理主会话；压缩摘要和子 Agent 记 gap
        if v["isSidechain"] == true {
            out.push(self.gap("sidechain", offset));
            return;
        }
        if v["isCompactSummary"] == true {
            out.push(self.gap("compact", offset));
            return;
        }
        // 系统注入的 user 行（isMeta）不是用户输入，不回流
        if ty == "user" && v["isMeta"] == true {
            return;
        }
        let common = |mut p: Value| {
            p["uuid"] = v["uuid"].clone();
            p["parentUuid"] = v["parentUuid"].clone();
            p["sidechain"] = false.into();
            p["agent_id"] = Value::Null;
            p
        };
        let msg = &v["message"];
        let blocks: Vec<Value> = match &msg["content"] {
            Value::String(s) => vec![json!({"type": "text", "text": s})],
            Value::Array(a) => a.clone(),
            _ => {
                out.push(self.gap("no_content", offset));
                return;
            }
        };
        let mut texts = Vec::new();
        let flush = |texts: &mut Vec<String>, out: &mut Vec<Value>| {
            if texts.is_empty() {
                return;
            }
            let content = std::mem::take(texts).join("\n");
            let p = if ty == "user" {
                json!({"content": content})
            } else {
                json!({"content": content, "model": msg["model"], "stop_reason": msg["stop_reason"]})
            };
            let kind = if ty == "user" { "user_message" } else { "assistant_message" };
            out.push(self.base(kind, common(p), Some(offset)));
        };
        for b in &blocks {
            match (ty, b["type"].as_str().unwrap_or("")) {
                (_, "text") => texts.push(b["text"].as_str().unwrap_or("").to_string()),
                ("assistant", "thinking" | "redacted_thinking") => {}
                ("assistant", "tool_use") => {
                    flush(&mut texts, out);
                    let p = json!({"tool_call_id": b["id"], "tool": b["name"], "input": b["input"]});
                    out.push(self.base("tool_call", common(p), Some(offset)));
                }
                ("user", "tool_result") => {
                    flush(&mut texts, out);
                    let (output, truncated) = tool_output(&b["content"]);
                    let mut p = json!({"tool_call_id": b["tool_use_id"], "output": output});
                    if truncated {
                        p["truncated"] = true.into();
                    }
                    if b["is_error"] == true {
                        p["is_error"] = true.into();
                    }
                    out.push(self.base("tool_result", common(p), Some(offset)));
                }
                (_, other) => {
                    flush(&mut texts, out);
                    out.push(self.gap(&format!("block:{}", truncate(other, 40)), offset));
                }
            }
        }
        flush(&mut texts, out);
    }

    /// 进程退出：收尾写，然后发 session_end。
    pub fn end(&self, exit_code: Option<i32>) -> Result<()> {
        self.pass()?;
        let cur = self.outbox.cursor(&self.key)?.unwrap_or(json!({}));
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

    /// 每秒读一次，直到 `stop`；然后收尾并发 session_end。
    pub async fn run(self, stop: CancellationToken, exit_code: Arc<std::sync::Mutex<Option<i32>>>) {
        let me = Arc::new(self);
        loop {
            let m = me.clone();
            match tokio::task::spawn_blocking(move || m.pass()).await {
                Ok(Ok(p)) if p.events > 0 => {
                    info!(session_id = %me.s.session_id, events = p.events, "session events captured")
                }
                Ok(Err(e)) => warn!(session_id = %me.s.session_id, error = %format!("{e:#}"), "session capture"),
                _ => {}
            }
            tokio::select! {
                _ = stop.cancelled() => break,
                _ = tokio::time::sleep(Duration::from_secs(1)) => {}
            }
        }
        // 尾写可能在进程退出后稍晚落盘
        tokio::time::sleep(Duration::from_millis(500)).await;
        let code = *exit_code.lock().unwrap();
        let m = me.clone();
        if let Ok(Err(e)) = tokio::task::spawn_blocking(move || m.end(code)).await {
            warn!(session_id = %me.s.session_id, error = %format!("{e:#}"), "session end");
        }
    }
}

fn tool_output(c: &Value) -> (String, bool) {
    let s = match c {
        Value::String(s) => s.clone(),
        Value::Array(a) => a
            .iter()
            .map(|b| match b["type"].as_str() {
                Some("text") => b["text"].as_str().unwrap_or("").to_string(),
                Some(t) => format!("[{t}]"),
                None => String::new(),
            })
            .collect::<Vec<_>>()
            .join("\n"),
        Value::Null => String::new(),
        other => other.to_string(),
    };
    if s.len() <= MAX_OUTPUT {
        return (s, false);
    }
    let mut end = MAX_OUTPUT;
    while !s.is_char_boundary(end) {
        end -= 1;
    }
    (s[..end].to_string(), true)
}

fn truncate(s: &str, n: usize) -> String {
    s.chars().take(n).collect()
}

fn hex(b: &[u8]) -> String {
    b.iter().map(|x| format!("{x:02x}")).collect()
}

fn read_range(path: &Path, offset: u64, len: u64) -> Result<Vec<u8>> {
    use std::io::{Read, Seek, SeekFrom};
    let mut f = std::fs::File::open(path).with_context(|| format!("open {}", path.display()))?;
    f.seek(SeekFrom::Start(offset))?;
    let mut buf = Vec::with_capacity(len as usize);
    f.take(len).read_to_end(&mut buf)?;
    Ok(buf)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    const SID: &str = "11111111-2222-4333-8444-555555555555";

    struct Env {
        _dir: tempfile::TempDir,
        file: PathBuf,
        outbox: Arc<Outbox>,
        cap: Capture,
    }

    fn env() -> Env {
        let dir = tempfile::tempdir().unwrap();
        let config_dir = dir.path().join("claude");
        let proj = config_dir.join("projects/-Users-x-proj");
        std::fs::create_dir_all(&proj).unwrap();
        let outbox = Arc::new(Outbox::open(&dir.path().join("o.sqlite")).unwrap());
        let s = Session {
            session_id: SID.into(),
            config_dir,
            agent_version: Some("2.1.311".into()),
            model: "Qwen3.8-27B".into(),
            cwd: "/Users/x/proj".into(),
        };
        Env { file: proj.join(format!("{SID}.jsonl")), cap: Capture::new(s, outbox.clone()), outbox, _dir: dir }
    }

    impl Env {
        fn write(&self, s: &str) {
            let mut f = std::fs::OpenOptions::new().create(true).append(true).open(&self.file).unwrap();
            f.write_all(s.as_bytes()).unwrap();
        }
        fn line(&self, v: Value) {
            self.write(&format!("{v}\n"));
        }
        fn events(&self) -> Vec<Value> {
            self.outbox.pending(0, 1000).unwrap().into_iter().map(|r| r.item).collect()
        }
        fn kinds(&self) -> Vec<String> {
            self.events().iter().map(|e| e["kind"].as_str().unwrap().to_string()).collect()
        }
    }

    fn user(uuid: &str, content: Value) -> Value {
        json!({"type":"user","uuid":uuid,"parentUuid":null,"sessionId":SID,"timestamp":"2026-11-19T08:00:00Z",
            "isSidechain":false,"message":{"role":"user","content":content}})
    }

    fn assistant(uuid: &str, content: Value) -> Value {
        json!({"type":"assistant","uuid":uuid,"parentUuid":"u1","sessionId":SID,"isSidechain":false,"requestRef":"r",
            "message":{"role":"assistant","model":"Qwen3.8-27B","stop_reason":"tool_use","content":content}})
    }

    #[test]
    fn five_kinds_from_main_session() {
        let e = env();
        e.line(json!({"type":"permission-mode","sessionId":SID,"permissionMode":"default"}));
        e.line(user("u1", json!("列出文件")));
        e.line(json!({"type":"user","uuid":"m1","sessionId":SID,"isMeta":true,"message":{"role":"user","content":"<system-reminder>x"}}));
        e.line(assistant(
            "a1",
            json!([{"type":"thinking","thinking":"secret thoughts","signature":"sig"},{"type":"text","text":"好的"},
                {"type":"tool_use","id":"toolu_1","name":"Bash","input":{"command":"ls"}}]),
        ));
        e.line(user(
            "u2",
            json!([{"type":"tool_result","tool_use_id":"toolu_1","content":[{"type":"text","text":"a.txt"}]}]),
        ));
        e.line(json!({"type":"api-request-blob","sessionId":SID,"body":"full request"}));
        e.cap.pass().unwrap();
        assert_eq!(e.kinds(), ["session_start", "user_message", "assistant_message", "tool_call", "tool_result"]);
        let ev = e.events();
        assert_eq!(ev[0]["payload"]["agent_version"], "2.1.311");
        assert_eq!(ev[0]["payload"]["cwd_hash"].as_str().unwrap().len(), 64);
        assert_eq!(ev[1]["payload"]["content"], "列出文件");
        assert_eq!(ev[1]["payload"]["uuid"], "u1");
        assert_eq!(ev[2]["payload"]["content"], "好的");
        assert_eq!(
            ev[3]["payload"],
            json!({"tool_call_id":"toolu_1","tool":"Bash","input":{"command":"ls"},
            "uuid":"a1","parentUuid":"u1","sidechain":false,"agent_id":null})
        );
        assert_eq!(ev[4]["payload"]["output"], "a.txt");
        assert_eq!(ev[4]["payload"]["tool_call_id"], "toolu_1");
        // thinking、签名、完整请求都不回流
        let all = serde_json::to_string(&ev).unwrap();
        assert!(!all.contains("secret thoughts") && !all.contains("sig") && !all.contains("full request"));
        // 再读一次没有新增
        assert_eq!(e.cap.pass().unwrap(), Pass { events: 0 });
        assert_eq!(e.events().len(), 5);
    }

    #[test]
    fn partial_line_waits_and_offsets_are_byte_positions() {
        let e = env();
        e.line(user("u1", json!("一")));
        let first_len = std::fs::metadata(&e.file).unwrap().len();
        let l2 = user("u2", json!("二")).to_string();
        e.write(&l2[..10]);
        e.cap.pass().unwrap();
        assert_eq!(e.kinds(), ["session_start", "user_message"]);
        e.write(&format!("{}\n", &l2[10..]));
        e.cap.pass().unwrap();
        let ev = e.events();
        assert_eq!(ev[2]["payload"]["content"], "二");
        assert_eq!((ev[1]["source_offset"].as_u64(), ev[2]["source_offset"].as_u64()), (Some(0), Some(first_len)));
    }

    #[test]
    fn unknown_bad_and_unsupported_become_gaps() {
        let e = env();
        e.write("{not json\n");
        e.line(json!({"type":"brand-new-type","sessionId":SID}));
        e.line(json!({"type":"user","uuid":"x","sessionId":"other","message":{"content":"hi"}}));
        e.line(json!({"type":"assistant","uuid":"s","sessionId":SID,"isSidechain":true,"message":{"content":[{"type":"text","text":"sub"}]}}));
        e.line(
            json!({"type":"user","uuid":"c","sessionId":SID,"isCompactSummary":true,"message":{"content":"summary"}}),
        );
        e.line(user(
            "img",
            json!([{"type":"image","source":{"type":"base64","media_type":"image/png","data":"AAAA"}}]),
        ));
        e.cap.pass().unwrap();
        let ev = e.events();
        let reasons: Vec<&str> = ev[1..].iter().map(|e| e["payload"]["reason"].as_str().unwrap()).collect();
        assert_eq!(
            reasons,
            ["bad_json", "unknown_type:brand-new-type", "session_mismatch", "sidechain", "compact", "block:image"]
        );
        assert!(ev[1..].iter().all(|e| e["kind"] == "gap"));
        assert!(!serde_json::to_string(&ev).unwrap().contains("AAAA"));
    }

    #[test]
    fn truncation_and_replacement_restart_with_gap() {
        let e = env();
        e.line(user("u1", json!("一")));
        e.line(user("u2", json!("二")));
        e.cap.pass().unwrap();
        // 截短：从头重读
        std::fs::write(&e.file, format!("{}\n", user("u3", json!("三")))).unwrap();
        e.cap.pass().unwrap();
        // 替换（新 inode）
        let tmp = e.file.with_extension("new");
        std::fs::write(&tmp, format!("{}\n", user("u4", json!("四")))).unwrap();
        std::fs::rename(&tmp, &e.file).unwrap();
        e.cap.pass().unwrap();
        let ev = e.events();
        let k: Vec<(&str, &str)> = ev
            .iter()
            .map(|e| {
                (
                    e["kind"].as_str().unwrap(),
                    e["payload"]["reason"].as_str().or(e["payload"]["content"].as_str()).unwrap_or(""),
                )
            })
            .collect();
        assert_eq!(
            k,
            [
                ("session_start", ""),
                ("user_message", "一"),
                ("user_message", "二"),
                ("gap", "file_truncated"),
                ("user_message", "三"),
                ("gap", "file_replaced"),
                ("user_message", "四")
            ]
        );
    }

    #[test]
    fn cursor_survives_restart_and_end_is_sent_once_with_tail() {
        let e = env();
        e.line(user("u1", json!("一")));
        e.cap.pass().unwrap();
        // 重启：新的 Capture 从游标继续，不重发 session_start
        let cap = Capture::new(e.cap.s.clone(), e.outbox.clone());
        e.line(user("u2", json!("二")));
        cap.end(Some(0)).unwrap();
        assert_eq!(e.kinds(), ["session_start", "user_message", "user_message", "session_end"]);
        assert_eq!(e.events()[3]["payload"]["reason"], "exited");
    }

    #[test]
    fn long_tool_output_is_truncated_on_char_boundary() {
        let (s, t) = tool_output(&json!("好".repeat(MAX_OUTPUT)));
        assert!(t && s.len() <= MAX_OUTPUT && s.chars().all(|c| c == '好'));
        assert_eq!(tool_output(&json!([{"type":"text","text":"a"},{"type":"image"}])), ("a\n[image]".into(), false));
    }

    #[test]
    fn no_file_yet_still_starts_session() {
        let e = env();
        assert_eq!(e.cap.pass().unwrap().events, 1);
        assert_eq!(e.cap.pass().unwrap().events, 0);
        assert_eq!(e.kinds(), ["session_start"]);
    }
}

fn find_newline(path: &Path, mut from: u64) -> Result<Option<u64>> {
    loop {
        let buf = read_range(path, from, 1024 * 1024)?;
        if buf.is_empty() {
            return Ok(None);
        }
        if let Some(i) = buf.iter().position(|&b| b == b'\n') {
            return Ok(Some(from + i as u64));
        }
        from += buf.len() as u64;
    }
}
