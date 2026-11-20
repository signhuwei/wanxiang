//! Kimi Code 会话采集（S2B，见 docs/specs/agents/kimi-code.md「会话、增量和生命周期」、
//! `contracts/edge-ws.md`「多 Agent 接入（v0.12/v0.13）」）。字段形状对照
//! `edge/onexd/tests/fixtures/kimi-wire/observed-1.5.synthetic.jsonl`（wire 协议 1.5 的合成
//! 结构样本，126 行，来源 SIMA，详见同目录 `README.json`）核对，不是按规格文字猜的。
//!
//! 原生记录是 `$KIMI_CODE_HOME/sessions/.../session_<uuid>/agents/<agent>/wire.jsonl`（每个
//! Agent——主 Agent 和子 Agent——各一份）。只有 `metadata.protocol_version` 为 `"1.5"` 才按
//! 本模块的字段读；不是就记 gap，不能按 1.5 的字段去猜别的版本。
//!
//! 公开发言和工具事件只来自两种记录：
//! - `agent.message.appended`：真实路径是 `message.message.{role,content}`（不是
//!   `message.{role,content}`，外面还包一层 `message`/`meta`）。`role` 为 `user`/`assistant`
//!   生成发言；`tool` 是压缩/重放产生的副本（和 `context.append_loop_event` 的 `tool.result`
//!   重复），静默跳过；`system` 若 `meta.public` 为 true 生成系统可见发言，否则是私有注入，
//!   静默跳过（v0.13「系统注入不算发言」）。`content: []` 且 `toolCalls` 非空的 assistant 行
//!   是工具调用的另一种表示（和 `context.append_loop_event` 的 `tool.call` 重复），没有可回流
//!   文本，静默跳过，不生成空发言。
//! - `context.append_loop_event`：`event.type` 为 `tool.call` 读
//!   `toolCallId`/`name`/`args`/`uuid`；为 `tool.result` 读
//!   `toolCallId`/`result.{output,note,isError}`/`parentUuid`；`step.begin`/`step.end`/
//!   `content.part` 是循环内部记录，静默跳过。
//! - `context.apply_compaction`：生成 `compact`，带 `summary`。
//!
//! 已知忽略清单（IGNORED_TOP_LEVEL_TYPES）：已识别、明确不生成事件也不记 gap 的顶层记录类型，
//! 对照 wire 1.5 合成样本列出的全部 26 种非对话类型（`metadata` 单独处理协议校验，不在清单里）。
//! 列表外的未知 `type` 一律记 `gap`，不猜测（v0.13「已知忽略清单」要求清单在代码里显式列出并
//! 有测试，见下方测试）。
//!
//! 工具结果的多重表示：真实原因是 `agent.message.appended` 会重放 `role:"tool"` 和
//! `content:[]+toolCalls` 两种工具的影子记录，和 `context.append_loop_event` 的
//! `tool.call`/`tool.result` 是同一件事的两种表示；按记录形状跳过影子记录就够了（上面已经
//! 列出），不需要按 ID 维护一个随会话无限增长的已见集合。`context.append_loop_event` 本身
//! 对同一个 `toolCallId` 只各发一次 `tool.call`/`tool.result`，不需要去重。
//!
//! payload 公共字段（v0.13）：`uuid` 取原生记录 ID（消息用 `meta.userMessageId` 或
//! `meta.messageId`，工具调用用 `event.uuid`，工具结果用 `event.parentUuid`；没有就填 null），
//! `parentUuid` 同理；`sidechain` 只有子 Agent（`agent_id` 非空）为 true；`agent_id` 主会话
//! 为 null、子 Agent 填原生子 Agent 目录名。`at` 用记录自带的 `time`（毫秒，wire 1.5 的原生
//! 时间戳），不是采集时刻——重启补采时如果用采集时刻，整段历史会被标成同一时刻。
//!
//! 增量：和 `capture.rs` 一样，游标是 `(inode, offset)`，按字节偏移读到最后一个完整换行，
//! 半行留到下次；文件变短或 inode 变了记 gap 后从头重读（截断/替换后的内容是全新的一段，不会
//! 和已接受的事件重复，不需要额外去重状态）。事件和游标在 outbox 同一事务提交。
//!
//! 安全：`agents/<agent>` 目录本身和 `wire.jsonl` 都要求是普通目录/文件，不跟随符号链接；
//! 只接受受管会话目录所有者创建的文件（同 `capture.rs` 的 `owned_by_same_principal`）。
//!
//! 受管启动层负责验证原生会话的目录、身份和 cwd，并派生 OneX 会话 ID。

use std::path::{Path, PathBuf};
use std::sync::Arc;

use anyhow::{Context, Result};
use serde_json::{Value, json};

use crate::outbox::Outbox;

/// 单行上限，超过记 gap 跳过
const MAX_LINE: usize = 16 * 1024 * 1024;
/// tool_result 输出上限
const MAX_OUTPUT: usize = 64 * 1024;
const READ_CHUNK: u64 = MAX_LINE as u64 + 1;

/// wire 1.5 合成样本（`observed-1.5.synthetic.jsonl`）里出现的全部非对话顶层记录类型：
/// 运行时/身份绑定、权限、轮次生命周期、历史重放、压缩前后记账、LLM 请求与用量、提示生命周期、
/// 交互（审批）请求。这些都是已识别、明确不生成会话事件的记录，不是未知形状。
/// `metadata` 不在这里——它单独处理协议版本校验（见 `Capture::line`）。
const IGNORED_TOP_LEVEL_TYPES: &[&str] = &[
    "runtime.set_binding",
    "profile.bind",
    "permission.set_mode",
    "permission.record_approval_result",
    "turn.prompt",
    "turn.steer",
    "turn.ended",
    "context.append_message",
    "full_compaction.begin",
    "full_compaction.complete",
    "agent.turn.started",
    "agent.turn.ended",
    "plugin.session_start",
    "changeNotifier.snapshot",
    "llm.request",
    "llm.tools_snapshot",
    "usage.record",
    "token_counting.measured",
    "token_counting.rebased",
    "token_counting.turn_recorded",
    "prompt.completed",
    "prompt.steered",
    "interaction.request",
    "interaction.resolved",
];

/// `context.append_loop_event` 里已识别、不生成事件的循环内部记录类型。
const IGNORED_LOOP_EVENT_TYPES: &[&str] = &["step.begin", "step.end", "content.part"];

#[derive(Debug, Clone)]
pub struct Session {
    pub session_id: String,
    /// `KIMI_CODE_HOME` 下的 `sessions/.../session_<uuid>` 目录
    pub session_dir: PathBuf,
    pub agent_version: Option<String>,
    pub model: String,
    pub cwd: PathBuf,
}

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
        let key = format!("kimi-code:{}", s.session_id);
        Self { s, outbox, key }
    }

    /// 主 Agent 和已发现的子 Agent 各一份 wire.jsonl：`agents/<agent>/wire.jsonl`。
    /// `agents/<agent>` 本身不能是符号链接——只检查最后一级的 `wire.jsonl` 不够，员工可以把
    /// `agents/x` 整个指向自己任意目录，让目录内任何名叫 `wire.jsonl` 的文件被读取回流。
    fn files(&self) -> Vec<(String, PathBuf)> {
        let dir = self.s.session_dir.join("agents");
        if !std::fs::symlink_metadata(&dir).is_ok_and(|meta| meta.is_dir()) {
            return Vec::new();
        }
        let Ok(entries) = std::fs::read_dir(&dir) else { return Vec::new() };
        let mut out: Vec<(String, PathBuf)> = entries
            .flatten()
            .filter_map(|e| {
                let name = e.file_name().to_string_lossy().into_owned();
                let agent_dir = e.path();
                let meta = std::fs::symlink_metadata(&agent_dir).ok()?;
                if !meta.is_dir() {
                    return None;
                }
                let wire = agent_dir.join("wire.jsonl");
                std::fs::symlink_metadata(&wire).is_ok_and(|meta| meta.is_file()).then_some((name, wire))
            })
            .collect();
        out.sort_by(|a, b| a.0.cmp(&b.0));
        out
    }

    fn base(&self, kind: &str, payload: Value, at_ms: Option<i64>, offset: Option<u64>) -> Value {
        json!({"session_id": self.s.session_id, "kind": kind,
            "at": at_ms.map(crate::pricing::format_ms), "source_offset": offset, "payload": payload})
    }

    /// 读一次新增内容（所有已发现的 Agent 子目录）。首次调用时补发 session_start。
    pub fn pass(&self) -> Result<Pass> {
        let mut cur = self.outbox.cursor(&self.key)?.unwrap_or(json!({"started": false, "files": {}}));
        let mut events = Vec::new();
        if cur["started"] != true {
            let cwd_hash = sha256_hex(self.s.cwd.to_string_lossy().as_bytes());
            events.push(self.base(
                "session_start",
                json!({"agent": "kimi-code", "agent_version": self.s.agent_version, "cwd_hash": cwd_hash,
                    "model": self.s.model, "uuid": null, "parentUuid": null, "sidechain": false, "agent_id": null}),
                None,
                None,
            ));
            cur["started"] = true.into();
        }
        if cur["files"].is_null() {
            cur["files"] = json!({});
        }
        for (agent_id, path) in self.files() {
            let is_main = agent_id == "main";
            let agent_tag: Option<&str> = if is_main { None } else { Some(agent_id.as_str()) };
            let mut file_cur = cur["files"][&agent_id].clone();
            if file_cur.is_null() {
                file_cur = json!({"ino": null, "offset": 0, "protocol": null});
            }
            self.read_file(&path, agent_tag, &mut file_cur, &mut events)?;
            cur["files"][&agent_id] = file_cur;
        }
        let n = events.len();
        if n > 0 {
            cur["ended"] = false.into();
        }
        if n > 0 || cur != self.outbox.cursor(&self.key)?.unwrap_or(Value::Null) {
            self.outbox.append_events_with_cursor(events, &self.key, &cur)?;
        }
        Ok(Pass { events: n })
    }

    fn read_file(&self, path: &Path, agent_id: Option<&str>, cur: &mut Value, events: &mut Vec<Value>) -> Result<()> {
        let meta = std::fs::symlink_metadata(path)?;
        if !meta.file_type().is_file() || !owned_by_same_principal(path, &self.s.session_dir)? {
            if cur["refused"] != true {
                events.push(self.gap(agent_id, "not_regular_file", None, 0));
                cur["refused"] = true.into();
            }
            return Ok(());
        }
        let mut offset = cur["offset"].as_u64().unwrap_or(0);
        let identity = file_identity(path, &meta)?;
        if cur["ino"].as_u64().is_some_and(|i| i != identity) {
            events.push(self.gap(agent_id, "file_replaced", None, offset));
            offset = 0;
            cur["protocol"] = Value::Null;
        } else if meta.len() < offset {
            events.push(self.gap(agent_id, "file_truncated", None, offset));
            offset = 0;
            cur["protocol"] = Value::Null;
        }
        cur["ino"] = identity.into();
        if meta.len() == offset {
            cur["offset"] = offset.into();
            return Ok(());
        }
        let buf = read_range(path, offset, READ_CHUNK.min(meta.len() - offset))?;
        let mut pos = 0;
        while let Some(nl) = buf[pos..].iter().position(|&b| b == b'\n') {
            let line = &buf[pos..pos + nl];
            self.line(line, agent_id, offset + pos as u64, cur, events);
            pos += nl + 1;
        }
        if pos == 0 && buf.len() > MAX_LINE {
            events.push(self.gap(agent_id, "line_too_large", None, offset));
            match find_newline(path, offset + buf.len() as u64)? {
                Some(next) => pos = (next + 1 - offset) as usize,
                None => pos = buf.len(),
            }
        }
        cur["offset"] = (offset + pos as u64).into();
        Ok(())
    }

    fn gap(&self, agent_id: Option<&str>, reason: &str, at_ms: Option<i64>, offset: u64) -> Value {
        let mut p = self.common(&Value::Null, agent_id);
        p["reason"] = reason.into();
        p["offset"] = offset.into();
        self.base("gap", p, at_ms, Some(offset))
    }

    /// 所有会话事件 payload 的公共字段（v0.13）：`uuid`/`parentUuid` 取原生记录给的 id，
    /// 没有就 null；`sidechain` 只有子 Agent（`agent_id` 非空）为 true；`agent_id` 主会话为
    /// null、子 Agent 填原生子 Agent 目录名。调用方传入已经从具体记录形状里取出的 id/parent_id。
    fn common(&self, ids: &Value, agent_id: Option<&str>) -> Value {
        json!({
            "uuid": ids["uuid"],
            "parentUuid": ids["parentUuid"],
            "sidechain": agent_id.is_some(),
            "agent_id": agent_id,
        })
    }

    /// 记录自带的原生时间（毫秒），没有就 None（调用方把 `at` 留空，不用采集时刻顶替）。
    fn record_time(v: &Value) -> Option<i64> {
        v["time"].as_i64()
    }

    fn line(&self, raw: &[u8], agent_id: Option<&str>, offset: u64, cur: &mut Value, out: &mut Vec<Value>) {
        if raw.iter().all(u8::is_ascii_whitespace) {
            return;
        }
        if raw.len() > MAX_LINE {
            out.push(self.gap(agent_id, "line_too_large", None, offset));
            return;
        }
        let Ok(v) = serde_json::from_slice::<Value>(raw) else {
            out.push(self.gap(agent_id, "bad_json", None, offset));
            return;
        };
        let Some(ty) = v["type"].as_str() else {
            out.push(self.gap(agent_id, "no_type", Self::record_time(&v), offset));
            return;
        };
        if ty == "metadata" {
            let proto = v["protocol_version"].clone();
            cur["protocol"] = proto.clone();
            if proto != "1.5" {
                out.push(self.gap(
                    agent_id,
                    &format!("protocol:{}", truncate(&proto.to_string(), 40)),
                    Self::record_time(&v),
                    offset,
                ));
            }
            return;
        }
        // 已经见过非 1.5 协议声明的文件：后续记录的字段形状不可信，一律记 gap，不按 1.5 猜。
        if cur["protocol"].is_string() && cur["protocol"] != "1.5" {
            out.push(self.gap(agent_id, "protocol_unsupported", Self::record_time(&v), offset));
            return;
        }
        if IGNORED_TOP_LEVEL_TYPES.contains(&ty) {
            return;
        }
        match ty {
            "agent.message.appended" => self.message(&v, agent_id, offset, out),
            "context.append_loop_event" => self.loop_event(&v, agent_id, offset, out),
            "context.apply_compaction" => {
                let mut p = self.common(&Value::Null, agent_id);
                p["summary"] = v["summary"].clone();
                out.push(self.base("compact", p, Self::record_time(&v), Some(offset)));
            }
            other => out.push(self.gap(
                agent_id,
                &format!("unknown_type:{}", truncate(other, 40)),
                Self::record_time(&v),
                offset,
            )),
        }
    }

    fn message(&self, v: &Value, agent_id: Option<&str>, offset: u64, out: &mut Vec<Value>) {
        let at = Self::record_time(v);
        let message = &v["message"]["message"];
        let meta = &v["message"]["meta"];
        let role = message["role"].as_str().unwrap_or("");
        let kind = match role {
            "user" => "user_message",
            "assistant" => "assistant_message",
            // 压缩/重放产生的工具结果副本：和 context.append_loop_event 的 tool.result 是
            // 同一件事的另一种表示，静默跳过，不是未知角色。
            "tool" => return,
            // meta.public 为 true 是用户可见的系统提示；其余 system 注入（developer 指令、
            // environment_context 等）不是发言，不生成事件（v0.13「系统注入不算发言」）。
            "system" if meta["public"] == true => "system_message",
            "system" => return,
            other => {
                out.push(self.gap(agent_id, &format!("unknown_role:{}", truncate(other, 40)), at, offset));
                return;
            }
        };
        let (content, unsupported) = public_text(&message["content"]);
        if unsupported {
            out.push(self.gap(agent_id, "message_block_unsupported", at, offset));
        }
        // 没有可回流文本就不生成发言：这既覆盖 content 为空、toolCalls 非空的 assistant 行
        // （工具调用的另一种表示，和 context.append_loop_event 的 tool.call 重复），也覆盖
        // 任何其他真正空文本的情况——不强行造一条内容为空字符串的发言。
        if content.is_empty() {
            return;
        }
        let record_id =
            meta["userMessageId"].as_str().or_else(|| meta["messageId"].as_str()).or_else(|| message["id"].as_str());
        let mut p = self.common(&json!({"uuid": record_id}), agent_id);
        p["content"] = content.into();
        if role == "assistant" {
            p["model"] = meta["model"]["model"].clone();
        }
        out.push(self.base(kind, p, at, Some(offset)));
    }

    fn loop_event(&self, v: &Value, agent_id: Option<&str>, offset: u64, out: &mut Vec<Value>) {
        let at = Self::record_time(v);
        let ev = &v["event"];
        let ety = ev["type"].as_str().unwrap_or("");
        if IGNORED_LOOP_EVENT_TYPES.contains(&ety) {
            return;
        }
        let Some(call_id) = ev["toolCallId"].as_str() else {
            out.push(self.gap(agent_id, &format!("loop_event_no_tool_call_id:{}", truncate(ety, 40)), at, offset));
            return;
        };
        match ety {
            "tool.call" => {
                let Some(name) = ev["name"].as_str().filter(|n| !n.is_empty()) else {
                    out.push(self.gap(agent_id, "tool_call_no_name", at, offset));
                    return;
                };
                let mut p = self.common(&json!({"uuid": ev["uuid"]}), agent_id);
                p["tool_call_id"] = call_id.into();
                p["tool"] = name.into();
                p["input"] = ev["args"].clone();
                out.push(self.base("tool_call", p, at, Some(offset)));
            }
            "tool.result" => {
                let result = &ev["result"];
                let Some(output_value) = result.get("output") else {
                    out.push(self.gap(agent_id, "tool_result_no_output", at, offset));
                    return;
                };
                let (output, truncated) = tool_output(output_value);
                let mut p = self.common(&json!({"uuid": ev["parentUuid"]}), agent_id);
                p["tool_call_id"] = call_id.into();
                p["output"] = output.into();
                if let Some(note) = result["note"].as_str().filter(|n| !n.is_empty()) {
                    p["note"] = note.into();
                }
                if truncated {
                    p["truncated"] = true.into();
                }
                if let Some(err) = result["isError"].as_bool().or_else(|| result["is_error"].as_bool()) {
                    if err {
                        p["is_error"] = true.into();
                    }
                }
                out.push(self.base("tool_result", p, at, Some(offset)));
            }
            other => out.push(self.gap(agent_id, &format!("loop_event:{}", truncate(other, 40)), at, offset)),
        }
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
            None,
        );
        self.outbox.append_events_with_cursor(vec![ev], &self.key, &cur)
    }
}

/// 公开文本块：字符串直接当一段文本；数组按 Agent 消息块扫描，只认 `{"type":"text","text":...}`，
/// 其余块（如未来的图片、thinking）算不支持，返回 `unsupported=true`，调用方据此记 gap——
/// 不在这里静默吞掉，和已知的 `role:"tool"`/空 `content`+`toolCalls` 跳过是两种不同情况。
fn public_text(value: &Value) -> (String, bool) {
    if let Some(s) = value.as_str() {
        return (s.to_string(), false);
    }
    let Some(blocks) = value.as_array() else {
        return (String::new(), true);
    };
    let mut texts = Vec::new();
    let mut unsupported = false;
    for b in blocks {
        match b["type"].as_str() {
            Some("text") => texts.push(b["text"].as_str().unwrap_or("").to_string()),
            _ => unsupported = true,
        }
    }
    (texts.join("\n"), unsupported)
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

fn sha256_hex(data: &[u8]) -> String {
    use sha2::{Digest, Sha256};
    Sha256::digest(data).iter().map(|x| format!("{x:02x}")).collect()
}

fn read_range(path: &Path, offset: u64, len: u64) -> Result<Vec<u8>> {
    use std::io::{Read, Seek, SeekFrom};
    let mut f = std::fs::File::open(path).with_context(|| format!("open {}", path.display()))?;
    f.seek(SeekFrom::Start(offset))?;
    let mut buf = Vec::with_capacity(len as usize);
    f.take(len).read_to_end(&mut buf)?;
    Ok(buf)
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

#[cfg(unix)]
fn file_identity(_path: &Path, meta: &std::fs::Metadata) -> Result<u64> {
    use std::os::unix::fs::MetadataExt;
    Ok(meta.ino())
}

#[cfg(windows)]
fn file_identity(path: &Path, _meta: &std::fs::Metadata) -> Result<u64> {
    use std::os::windows::io::AsRawHandle;
    use windows_sys::Win32::Storage::FileSystem::{BY_HANDLE_FILE_INFORMATION, GetFileInformationByHandle};
    let f = std::fs::File::open(path).with_context(|| format!("open {}", path.display()))?;
    let mut info: BY_HANDLE_FILE_INFORMATION = unsafe { std::mem::zeroed() };
    // SAFETY: 和 `capture.rs::file_identity` 同样的前提：`f` 句柄在调用期间保持有效，`info`
    // 是栈上足够大小的缓冲区，系统只在成功时写入它。
    let ok = unsafe { GetFileInformationByHandle(f.as_raw_handle(), &mut info) };
    anyhow::ensure!(ok != 0, "GetFileInformationByHandle failed for {}", path.display());
    Ok(((info.nFileIndexHigh as u64) << 32) | info.nFileIndexLow as u64)
}

#[cfg(unix)]
fn owned_by_same_principal(path: &Path, reference_dir: &Path) -> Result<bool> {
    use std::os::unix::fs::MetadataExt;
    let owner = std::fs::metadata(reference_dir)?.uid();
    Ok(std::fs::symlink_metadata(path)?.uid() == owner)
}

#[cfg(windows)]
fn owned_by_same_principal(path: &Path, reference_dir: &Path) -> Result<bool> {
    let a = windows_owner_sid(path)?;
    let b = windows_owner_sid(reference_dir)?;
    Ok(a == b)
}

#[cfg(windows)]
fn windows_owner_sid(path: &Path) -> Result<String> {
    use std::ffi::OsStr;
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Foundation::LocalFree;
    use windows_sys::Win32::Security::Authorization::{ConvertSidToStringSidW, GetNamedSecurityInfoW, SE_FILE_OBJECT};
    use windows_sys::Win32::Security::{OWNER_SECURITY_INFORMATION, PSID};
    let wide: Vec<u16> = OsStr::new(path).encode_wide().chain(Some(0)).collect();
    let mut owner: PSID = std::ptr::null_mut();
    let mut sd: *mut std::ffi::c_void = std::ptr::null_mut();
    // SAFETY: 和 `capture.rs::windows_owner_sid` 同样的前提，见那里的注释。
    let status = unsafe {
        GetNamedSecurityInfoW(
            wide.as_ptr(),
            SE_FILE_OBJECT,
            OWNER_SECURITY_INFORMATION,
            &mut owner,
            std::ptr::null_mut(),
            std::ptr::null_mut(),
            std::ptr::null_mut(),
            &mut sd,
        )
    };
    anyhow::ensure!(status == 0, "GetNamedSecurityInfoW failed for {} (status {status})", path.display());
    let result = (|| -> Result<String> {
        let mut sid_str: *mut u16 = std::ptr::null_mut();
        let ok = unsafe { ConvertSidToStringSidW(owner, &mut sid_str) };
        anyhow::ensure!(ok != 0, "ConvertSidToStringSidW failed");
        let len = unsafe {
            let mut n = 0usize;
            while *sid_str.add(n) != 0 {
                n += 1;
            }
            n
        };
        let s = unsafe { String::from_utf16_lossy(std::slice::from_raw_parts(sid_str, len)) };
        unsafe { LocalFree(sid_str as *mut std::ffi::c_void) };
        Ok(s)
    })();
    unsafe { LocalFree(sd) };
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    struct Env {
        _dir: tempfile::TempDir,
        session_dir: PathBuf,
        outbox: Arc<Outbox>,
        cap: Capture,
    }

    fn env() -> Env {
        let dir = tempfile::tempdir().unwrap();
        let session_dir = dir.path().join("kimi/sessions/session_abc");
        std::fs::create_dir_all(session_dir.join("agents/main")).unwrap();
        let outbox = Arc::new(Outbox::open(&dir.path().join("o.sqlite")).unwrap());
        let s = Session {
            session_id: "abc".into(),
            session_dir: session_dir.clone(),
            agent_version: Some("2.2.0".into()),
            model: "synthetic-model".into(),
            cwd: "/synthetic/work".into(),
        };
        Env { cap: Capture::new(s, outbox.clone()), outbox, session_dir, _dir: dir }
    }

    impl Env {
        fn wire(&self, agent: &str) -> PathBuf {
            let dir = self.session_dir.join("agents").join(agent);
            std::fs::create_dir_all(&dir).unwrap();
            dir.join("wire.jsonl")
        }
        fn write(&self, agent: &str, s: &str) {
            let mut f = std::fs::OpenOptions::new().create(true).append(true).open(self.wire(agent)).unwrap();
            f.write_all(s.as_bytes()).unwrap();
        }
        fn line(&self, agent: &str, v: Value) {
            self.write(agent, &format!("{v}\n"));
        }
        fn events(&self) -> Vec<Value> {
            self.outbox.pending(0, 1000).unwrap().into_iter().map(|r| r.item).collect()
        }
        fn kinds(&self) -> Vec<String> {
            self.events().iter().map(|e| e["kind"].as_str().unwrap().to_string()).collect()
        }
    }

    const METADATA_1_5: &str = r#"{"type":"metadata","protocol_version":"1.5","created_at":1}"#;

    fn user_msg(id: &str, text: &str) -> Value {
        json!({"type":"agent.message.appended","time":1,
            "message":{"message":{"role":"user","content":[{"type":"text","text":text}]},
                "meta":{"userMessageId":id}}})
    }

    fn assistant_msg(id: &str, text: &str) -> Value {
        json!({"type":"agent.message.appended","time":1,
            "message":{"message":{"role":"assistant","content":[{"type":"text","text":text}],"toolCalls":[]},
                "meta":{"messageId":id,"model":{"provider":"p","model":"m"}}}})
    }

    fn tool_call(uuid: &str, call_id: &str, name: &str) -> Value {
        json!({"type":"context.append_loop_event","time":1,
            "event":{"type":"tool.call","uuid":uuid,"toolCallId":call_id,"name":name,"args":{}}})
    }

    fn tool_result(parent_uuid: &str, call_id: &str, output: &str) -> Value {
        json!({"type":"context.append_loop_event","time":1,
            "event":{"type":"tool.result","parentUuid":parent_uuid,"toolCallId":call_id,"result":{"output":output}}})
    }

    /// 真实 wire 1.5 合成样本（126 行，`tests/fixtures/kimi-wire/observed-1.5.synthetic.jsonl`，
    /// 来源 SIMA，详见同目录 README.json）：期望恰好 4 条用户发言、3 条助手发言、8 条工具调用、
    /// 8 条工具结果、1 条压缩、0 条 gap。这是验收用的端到端样本，不是自己编的字段。
    #[test]
    fn real_wire_1_5_sample_matches_expected_canonical_counts() {
        let e = env();
        let fixture = std::fs::read_to_string(
            Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/kimi-wire/observed-1.5.synthetic.jsonl"),
        )
        .unwrap();
        e.write("main", &fixture);
        e.cap.pass().unwrap();
        let ev = e.events();
        let count = |k: &str| ev.iter().filter(|e| e["kind"] == k).count();
        let gaps: Vec<_> =
            ev.iter().filter(|e| e["kind"] == "gap").map(|e| e["payload"]["reason"].as_str().unwrap()).collect();
        assert_eq!(gaps, Vec::<&str>::new(), "unexpected gaps: {gaps:?}");
        assert_eq!(count("user_message"), 4);
        assert_eq!(count("assistant_message"), 3);
        assert_eq!(count("tool_call"), 8);
        assert_eq!(count("tool_result"), 8);
        assert_eq!(count("compact"), 1);
        assert_eq!(count("session_start"), 1);
        // 压缩摘要应该能读到（合成样本第 84 行的 context.apply_compaction 带 summary）。
        let compact = ev.iter().find(|e| e["kind"] == "compact").unwrap();
        assert_eq!(compact["payload"]["summary"], "SYNTHETIC_3be053e9e8eb");
        // 助手发言带 model；没有任何一条发言的内容是空字符串（shadow 行不该漏网）。
        for e in &ev {
            if e["kind"] == "assistant_message" || e["kind"] == "user_message" {
                assert_ne!(e["payload"]["content"], "");
            }
        }
    }

    #[test]
    fn compaction_without_readable_summary_generates_compact_with_null_summary() {
        let e = env();
        e.line("main", METADATA_1_5.parse().unwrap());
        e.line("main", json!({"type":"context.apply_compaction","time":1})); // 没有 summary 字段
        e.cap.pass().unwrap();
        let ev = e.events();
        assert_eq!(e.kinds(), ["session_start", "compact"]);
        assert_eq!(ev[1]["payload"]["summary"], Value::Null);
    }

    /// v0.13「已知忽略清单」：已知顶层类型逐个覆盖，列表内不生成事件也不记 gap。
    #[test]
    fn known_ignore_list_covers_observed_top_level_types() {
        let e = env();
        e.line("main", METADATA_1_5.parse().unwrap());
        for ty in IGNORED_TOP_LEVEL_TYPES {
            e.line("main", json!({"type": ty, "time": 1}));
        }
        e.cap.pass().unwrap();
        assert_eq!(e.kinds(), ["session_start"]);
        // 2.3.0 的回环验证另观察到 changeNotifier.snapshot。
        assert_eq!(IGNORED_TOP_LEVEL_TYPES.len(), 24);
    }

    /// `context.append_loop_event` 内部的 step.begin/step.end/content.part 同样是已知忽略。
    #[test]
    fn known_ignore_list_covers_loop_internal_events() {
        let e = env();
        e.line("main", METADATA_1_5.parse().unwrap());
        for ty in IGNORED_LOOP_EVENT_TYPES {
            e.line("main", json!({"type":"context.append_loop_event","time":1,"event":{"type": ty}}));
        }
        e.cap.pass().unwrap();
        assert_eq!(e.kinds(), ["session_start"]);
    }

    #[test]
    fn role_tool_shadow_and_empty_tool_calls_shadow_are_skipped_without_gap() {
        let e = env();
        e.line("main", METADATA_1_5.parse().unwrap());
        e.line(
            "main",
            json!({"type":"agent.message.appended","time":1,
                "message":{"message":{"role":"tool","content":[{"type":"text","text":"x"}],"toolCallId":"c1"},"meta":{}}}),
        );
        e.line(
            "main",
            json!({"type":"agent.message.appended","time":1,
                "message":{"message":{"role":"assistant","content":[],"toolCalls":[{"id":"c1"}]},"meta":{}}}),
        );
        e.cap.pass().unwrap();
        assert_eq!(e.kinds(), ["session_start"]);
    }

    #[test]
    fn private_system_injection_is_skipped_but_public_system_message_is_kept() {
        let e = env();
        e.line("main", METADATA_1_5.parse().unwrap());
        e.line(
            "main",
            json!({"type":"agent.message.appended","time":1,
                "message":{"message":{"role":"system","content":[{"type":"text","text":"private"}]},"meta":{"public":false}}}),
        );
        e.line(
            "main",
            json!({"type":"agent.message.appended","time":1,
                "message":{"message":{"role":"system","content":[{"type":"text","text":"visible"}]},"meta":{"public":true}}}),
        );
        e.cap.pass().unwrap();
        assert_eq!(e.kinds(), ["session_start", "system_message"]);
        assert_eq!(e.events()[1]["payload"]["content"], "visible");
    }

    #[test]
    fn unsupported_protocol_version_generates_gap_and_subsequent_records_are_rejected() {
        let e = env();
        e.line("main", json!({"type":"metadata","protocol_version":"1.4","created_at":1}));
        e.line("main", user_msg("u1", "hi"));
        e.cap.pass().unwrap();
        let ev = e.events();
        assert_eq!(ev.iter().map(|e| e["kind"].as_str().unwrap()).collect::<Vec<_>>(), ["session_start", "gap", "gap"]);
        assert_eq!(ev[1]["payload"]["reason"], "protocol:\"1.4\"");
        assert_eq!(ev[2]["payload"]["reason"], "protocol_unsupported");
    }

    #[test]
    fn missing_metadata_type_is_unknown_and_other_unknown_types_become_gap() {
        let e = env();
        e.write("main", "{not json\n");
        e.line("main", METADATA_1_5.parse().unwrap());
        e.line("main", json!({"type":"brand.new.record","time":1}));
        e.line("main", json!({"type":"agent.message.appended","time":1,"message":{"message":{"role":"operator"}}}));
        e.line(
            "main",
            json!({"type":"context.append_loop_event","time":1,"event":{"type":"tool.cancel","toolCallId":"c1"}}),
        );
        e.line("main", json!({"type":"context.append_loop_event","time":1,"event":{"type":"tool.call"}})); // 无 toolCallId
        e.cap.pass().unwrap();
        let ev = e.events();
        let reasons: Vec<&str> = ev[1..].iter().map(|e| e["payload"]["reason"].as_str().unwrap()).collect();
        assert_eq!(
            reasons,
            [
                "bad_json",
                "unknown_type:brand.new.record",
                "unknown_role:operator",
                "loop_event:tool.cancel",
                "loop_event_no_tool_call_id:tool.call",
            ]
        );
        assert!(ev[1..].iter().all(|e| e["kind"] == "gap"));
    }

    /// 8 条真实调用/结果（对不同 call_id）应该全部被采集，不需要按 ID 去重——真实多重表示
    /// 是跨记录类型（role:tool、空 content+toolCalls），不是同类型内部重复。
    #[test]
    fn eight_distinct_tool_calls_and_results_are_all_captured() {
        let e = env();
        e.line("main", METADATA_1_5.parse().unwrap());
        for i in 0..8 {
            e.line("main", tool_call(&format!("u{i}"), &format!("c{i}"), "Bash"));
        }
        for i in 0..8 {
            e.line("main", tool_result(&format!("u{i}"), &format!("c{i}"), "ok"));
        }
        e.cap.pass().unwrap();
        let ev = e.events();
        assert_eq!(ev.iter().filter(|e| e["kind"] == "tool_call").count(), 8);
        assert_eq!(ev.iter().filter(|e| e["kind"] == "tool_result").count(), 8);
    }

    #[test]
    fn different_agents_reuse_call_id_without_collision() {
        let e = env();
        e.line("main", METADATA_1_5.parse().unwrap());
        e.line("sub-1", METADATA_1_5.parse().unwrap());
        e.line("main", tool_call("u1", "shared", "Bash"));
        e.line("sub-1", tool_call("u2", "shared", "Read"));
        e.line("main", tool_result("u1", "shared", "main output"));
        e.line("sub-1", tool_result("u2", "shared", "sub output"));
        e.cap.pass().unwrap();
        let ev = e.events();
        let calls: Vec<_> = ev.iter().filter(|e| e["kind"] == "tool_call").collect();
        assert_eq!(calls.len(), 2);
        let results: Vec<_> = ev.iter().filter(|e| e["kind"] == "tool_result").collect();
        assert_eq!(results.len(), 2);
        assert!(calls.iter().any(|e| e["payload"]["agent_id"] == Value::Null && e["payload"]["tool"] == "Bash"));
        assert!(calls.iter().any(|e| e["payload"]["agent_id"] == "sub-1" && e["payload"]["tool"] == "Read"));
        assert!(
            results.iter().any(|e| e["payload"]["agent_id"] == Value::Null && e["payload"]["output"] == "main output")
        );
        assert!(results.iter().any(|e| e["payload"]["agent_id"] == "sub-1" && e["payload"]["output"] == "sub output"));
        // 子 Agent 的事件 sidechain 为 true，主 Agent 为 false。
        assert!(calls.iter().any(|e| e["payload"]["agent_id"] == "sub-1" && e["payload"]["sidechain"] == true));
        assert!(calls.iter().any(|e| e["payload"]["agent_id"] == Value::Null && e["payload"]["sidechain"] == false));
    }

    #[test]
    fn common_payload_fields_map_native_ids() {
        let e = env();
        e.line("main", METADATA_1_5.parse().unwrap());
        e.line("main", user_msg("m1", "一"));
        e.line("main", assistant_msg("m2", "好的"));
        e.line("main", tool_call("u1", "c1", "Bash"));
        e.line("main", tool_result("u1", "c1", "ok"));
        e.cap.pass().unwrap();
        let ev = e.events();
        let msg = ev.iter().find(|e| e["kind"] == "user_message").unwrap();
        assert_eq!(msg["payload"]["uuid"], "m1");
        assert_eq!(msg["payload"]["parentUuid"], Value::Null);
        let assistant = ev.iter().find(|e| e["kind"] == "assistant_message").unwrap();
        assert_eq!(assistant["payload"]["uuid"], "m2");
        assert_eq!(assistant["payload"]["model"], "m");
        let call = ev.iter().find(|e| e["kind"] == "tool_call").unwrap();
        assert_eq!(call["payload"]["uuid"], "u1");
        let result = ev.iter().find(|e| e["kind"] == "tool_result").unwrap();
        assert_eq!(result["payload"]["uuid"], "u1"); // parentUuid of tool.result maps to uuid
    }

    #[test]
    fn tool_result_note_and_is_error_are_preserved() {
        let e = env();
        e.line("main", METADATA_1_5.parse().unwrap());
        e.line(
            "main",
            json!({"type":"context.append_loop_event","time":1,
                "event":{"type":"tool.result","parentUuid":"u1","toolCallId":"c1",
                    "result":{"output":"out","note":"a note","isError":true}}}),
        );
        e.cap.pass().unwrap();
        let ev = e.events();
        let result = ev.iter().find(|e| e["kind"] == "tool_result").unwrap();
        assert_eq!(result["payload"]["note"], "a note");
        assert_eq!(result["payload"]["is_error"], true);
    }

    #[test]
    fn native_time_is_used_not_capture_time() {
        let e = env();
        e.line("main", METADATA_1_5.parse().unwrap());
        e.line("main", user_msg("m1", "一"));
        e.cap.pass().unwrap();
        let ev = e.events();
        let msg = ev.iter().find(|e| e["kind"] == "user_message").unwrap();
        // user_msg() 的 "time":1 毫秒，format_ms(1) 的年份显然是 1970，和 now_ms() 的当前年份不同。
        assert!(msg["at"].as_str().unwrap().starts_with("1970-"));
    }

    #[test]
    fn partial_line_waits_and_offsets_are_byte_positions() {
        let e = env();
        let metadata_len = METADATA_1_5.len() as u64 + 1;
        e.line("main", METADATA_1_5.parse().unwrap());
        e.line("main", user_msg("m1", "一"));
        let first_len = std::fs::metadata(e.wire("main")).unwrap().len();
        let l2 = user_msg("m2", "二").to_string();
        e.write("main", &l2[..10]);
        e.cap.pass().unwrap();
        assert_eq!(e.kinds(), ["session_start", "user_message"]);
        e.write("main", &format!("{}\n", &l2[10..]));
        e.cap.pass().unwrap();
        let ev = e.events();
        assert_eq!(ev[2]["payload"]["content"], "二");
        assert_eq!(
            (ev[1]["source_offset"].as_u64(), ev[2]["source_offset"].as_u64()),
            (Some(metadata_len), Some(first_len))
        );
    }

    #[test]
    fn truncation_and_replacement_restart_with_gap() {
        let e = env();
        e.line("main", METADATA_1_5.parse().unwrap());
        e.line("main", user_msg("m1", "一"));
        e.line("main", user_msg("m2", "二"));
        e.cap.pass().unwrap();
        std::fs::write(e.wire("main"), format!("{}\n{}\n", METADATA_1_5, user_msg("m3", "三"))).unwrap();
        e.cap.pass().unwrap();
        let tmp = e.wire("main").with_extension("new");
        std::fs::write(&tmp, format!("{}\n{}\n", METADATA_1_5, user_msg("m4", "四"))).unwrap();
        std::fs::rename(&tmp, e.wire("main")).unwrap();
        e.cap.pass().unwrap();
        let ev = e.events();
        let k: Vec<(&str, Option<&str>)> = ev
            .iter()
            .map(|e| {
                (e["kind"].as_str().unwrap(), e["payload"]["reason"].as_str().or(e["payload"]["content"].as_str()))
            })
            .collect();
        assert_eq!(
            k,
            [
                ("session_start", None),
                ("user_message", Some("一")),
                ("user_message", Some("二")),
                ("gap", Some("file_truncated")),
                ("user_message", Some("三")),
                ("gap", Some("file_replaced")),
                ("user_message", Some("四")),
            ]
        );
    }

    #[test]
    fn no_file_yet_still_starts_session() {
        let e = env();
        std::fs::remove_dir_all(e.session_dir.join("agents/main")).unwrap();
        assert_eq!(e.cap.pass().unwrap().events, 1);
        assert_eq!(e.cap.pass().unwrap().events, 0);
        assert_eq!(e.kinds(), ["session_start"]);
    }

    #[test]
    fn cursor_survives_restart_and_end_is_sent_once() {
        let e = env();
        e.line("main", METADATA_1_5.parse().unwrap());
        e.line("main", user_msg("m1", "一"));
        e.cap.pass().unwrap();
        let cap = Capture::new(e.cap.s.clone(), e.outbox.clone());
        e.line("main", user_msg("m2", "二"));
        cap.end(Some(0)).unwrap();
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

    /// `agents/<agent>` 目录本身是符号链接时不跟随，不读取里面的 wire.jsonl。
    #[cfg(unix)]
    #[test]
    fn symlinked_agent_directory_is_not_followed() {
        let e = env();
        let outside = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(outside.path().join("evil")).unwrap();
        std::fs::write(outside.path().join("evil/wire.jsonl"), format!("{}\n", user_msg("m1", "泄露"))).unwrap();
        std::os::unix::fs::symlink(outside.path().join("evil"), e.session_dir.join("agents/linked")).unwrap();
        e.cap.pass().unwrap();
        let all = serde_json::to_string(&e.events()).unwrap();
        assert!(!all.contains("泄露"));
    }
}
