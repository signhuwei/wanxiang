//! Anthropic Messages → OpenAI Chat Completions → Anthropic 的转换（S1-E1b）。
//!
//! 只做 Claude Code 用得到的子集：system、文本、图片（base64 和 URL）、普通函数工具及其结果、
//! tool_choice、stop_sequences、max_tokens、temperature、top_p。thinking 不跨协议回放；
//! server tools 和 document 明确拒绝，不静默丢掉。
//! 规则和用例见 `docs/specs/magpie/protocol-conversion.md`、`anthropic-to-chat-test-cases.md`。

use bytes::Bytes;
use serde_json::{Map, Value, json};
use tracing::warn;

use crate::id;
use crate::sse::Event;

/// base_url 以 `/v1` 结尾时直接接 `/chat/completions`，否则补上 `/v1`，避免出现两个 `/v1`。
// CONTRACT-PENDING: 契约没写 openai_chat 的 base_url 带不带 /v1，两种都接受。
pub fn chat_url(base: &str) -> String {
    let b = base.trim_end_matches('/');
    if b.ends_with("/v1") { format!("{b}/chat/completions") } else { format!("{b}/v1/chat/completions") }
}

// ---- 请求 ----

pub fn build_request(req: &Value, upstream_model: &str, stream: bool) -> Result<Value, String> {
    let mut out = Map::new();
    out.insert("model".into(), upstream_model.into());
    let mut msgs = Vec::new();
    if let Some(s) = req.get("system") {
        let t = text_of(s, "system")?;
        if !t.is_empty() {
            msgs.push(json!({"role": "system", "content": t}));
        }
    }
    // 上一条 assistant 里 tool_use 的顺序，tool 消息按它排，按 ID 配对
    let mut tool_order: Vec<String> = Vec::new();
    for m in req.get("messages").and_then(Value::as_array).ok_or("请求缺少 messages 数组。")? {
        match m.get("role").and_then(Value::as_str).unwrap_or("") {
            "user" => user_message(m.get("content"), &tool_order, &mut msgs)?,
            "assistant" => tool_order = assistant_message(m.get("content"), &mut msgs)?,
            other => return Err(format!("不支持的消息角色 {other:?}。")),
        }
    }
    out.insert("messages".into(), msgs.into());
    if let Some(n) = req.get("max_tokens") {
        out.insert("max_tokens".into(), n.clone());
    }
    if let Some(s) = req.get("stop_sequences").filter(|s| s.as_array().is_some_and(|a| !a.is_empty())) {
        out.insert("stop".into(), s.clone());
    }
    for k in ["temperature", "top_p"] {
        if let Some(v) = req.get(k) {
            out.insert(k.into(), v.clone());
        }
    }
    if stream {
        out.insert("stream".into(), true.into());
        out.insert("stream_options".into(), json!({"include_usage": true}));
    }
    // Chat 不允许只有 tool_choice 没有 tools
    if let Some(tools) = req.get("tools").and_then(Value::as_array).filter(|t| !t.is_empty()) {
        out.insert("tools".into(), tools.iter().map(tool_def).collect::<Result<Vec<_>, _>>()?.into());
        if let Some(tc) = req.get("tool_choice") {
            tool_choice(tc, &mut out)?;
        }
    }
    Ok(Value::Object(out))
}

/// system 或 tool_result 的内容：字符串，或 text 块数组。
fn text_of(v: &Value, what: &str) -> Result<String, String> {
    match v {
        Value::String(s) => Ok(s.clone()),
        Value::Array(blocks) => {
            let mut parts = Vec::new();
            for b in blocks {
                match b.get("type").and_then(Value::as_str) {
                    Some("text") => parts.push(b.get("text").and_then(Value::as_str).unwrap_or("").to_string()),
                    Some("image") if what == "tool_result" => {
                        parts.push("[OneX：工具结果中的图片无法转发给这个模型]".into())
                    }
                    other => return Err(unsupported(other.unwrap_or("?"), what)),
                }
            }
            Ok(parts.join("\n\n"))
        }
        Value::Null => Ok(String::new()),
        _ => Err(format!("{what} 的格式无效。")),
    }
}

fn unsupported(ty: &str, what: &str) -> String {
    format!("OneX 把请求转换到 OpenAI 接口时不支持 {what} 里的 {ty} 内容，请换用 Anthropic 接口的模型。")
}

fn user_message(content: Option<&Value>, tool_order: &[String], msgs: &mut Vec<Value>) -> Result<(), String> {
    let blocks = match content {
        Some(Value::String(s)) => {
            msgs.push(json!({"role": "user", "content": s}));
            return Ok(());
        }
        Some(Value::Array(b)) => b,
        _ => return Err("user 消息缺少 content。".into()),
    };
    let mut results = Vec::new();
    let mut parts = Vec::new();
    for b in blocks {
        match b.get("type").and_then(Value::as_str).unwrap_or("") {
            "tool_result" => {
                let id = orig_id(b.get("tool_use_id").and_then(Value::as_str).unwrap_or(""));
                let text = text_of(b.get("content").unwrap_or(&Value::Null), "tool_result")?;
                results.push((id, text));
            }
            "text" => parts.push(json!({"type": "text", "text": b.get("text").cloned().unwrap_or_default()})),
            "image" => parts.push(image_part(b)?),
            other => return Err(unsupported(other, "user 消息")),
        }
    }
    // 按上一轮调用的顺序排，不认识的 ID 保持原顺序放最后
    results.sort_by_key(|(id, _)| tool_order.iter().position(|o| o == id).unwrap_or(usize::MAX));
    for (id, text) in results {
        msgs.push(json!({"role": "tool", "tool_call_id": id, "content": text}));
    }
    if !parts.is_empty() {
        let content = match parts.as_slice() {
            [p] if p["type"] == "text" => p["text"].clone(),
            _ => parts.into(),
        };
        msgs.push(json!({"role": "user", "content": content}));
    }
    Ok(())
}

fn image_part(b: &Value) -> Result<Value, String> {
    let src = &b["source"];
    let url = match src.get("type").and_then(Value::as_str) {
        Some("base64") => format!(
            "data:{};base64,{}",
            src.get("media_type").and_then(Value::as_str).unwrap_or("image/png"),
            src.get("data").and_then(Value::as_str).unwrap_or("")
        ),
        Some("url") => src.get("url").and_then(Value::as_str).unwrap_or("").to_string(),
        other => return Err(unsupported(&format!("image/{}", other.unwrap_or("?")), "user 消息")),
    };
    Ok(json!({"type": "image_url", "image_url": {"url": url}}))
}

/// 返回这条消息里 tool_use 的原始 ID 顺序。
fn assistant_message(content: Option<&Value>, msgs: &mut Vec<Value>) -> Result<Vec<String>, String> {
    let blocks = match content {
        Some(Value::String(s)) => {
            msgs.push(json!({"role": "assistant", "content": s}));
            return Ok(Vec::new());
        }
        Some(Value::Array(b)) => b,
        _ => return Err("assistant 消息缺少 content。".into()),
    };
    let mut text = Vec::new();
    let mut calls = Vec::new();
    let mut order = Vec::new();
    for b in blocks {
        match b.get("type").and_then(Value::as_str).unwrap_or("") {
            "text" => text.push(b.get("text").and_then(Value::as_str).unwrap_or("").to_string()),
            "tool_use" => {
                let id = orig_id(b.get("id").and_then(Value::as_str).unwrap_or(""));
                let args = serde_json::to_string(b.get("input").unwrap_or(&json!({}))).unwrap();
                calls.push(json!({"id": id, "type": "function",
                    "function": {"name": b.get("name").cloned().unwrap_or_default(), "arguments": args}}));
                order.push(id);
            }
            // 推理内容和签名属于签发它的上游，不跨协议回放
            "thinking" | "redacted_thinking" => {}
            other => return Err(unsupported(other, "assistant 消息")),
        }
    }
    let text = text.join("");
    let mut m = json!({"role": "assistant", "content": if text.is_empty() && !calls.is_empty() { Value::Null } else { text.into() }});
    if !calls.is_empty() {
        m["tool_calls"] = calls.into();
    }
    msgs.push(m);
    Ok(order)
}

fn tool_def(t: &Value) -> Result<Value, String> {
    let name = t.get("name").and_then(Value::as_str).unwrap_or("");
    if let Some(ty) = t.get("type").and_then(Value::as_str).filter(|ty| *ty != "custom") {
        return Err(format!(
            "OneX 把请求转换到 OpenAI 接口时不支持服务端工具 {name}（{ty}），请换用 Anthropic 接口的模型。"
        ));
    }
    let mut f =
        json!({"name": name, "parameters": t.get("input_schema").cloned().unwrap_or(json!({"type": "object"}))});
    if let Some(d) = t.get("description") {
        f["description"] = d.clone();
    }
    Ok(json!({"type": "function", "function": f}))
}

fn tool_choice(tc: &Value, out: &mut Map<String, Value>) -> Result<(), String> {
    let v = match tc.get("type").and_then(Value::as_str) {
        Some("auto") => json!("auto"),
        Some("any") => json!("required"),
        Some("none") => json!("none"),
        Some("tool") => json!({"type": "function", "function": {"name": tc.get("name").cloned().unwrap_or_default()}}),
        other => return Err(format!("不支持的 tool_choice {other:?}。")),
    };
    out.insert("tool_choice".into(), v);
    if tc.get("disable_parallel_tool_use").and_then(Value::as_bool) == Some(true) {
        out.insert("parallel_tool_calls".into(), false.into());
    }
    Ok(())
}

// ---- 工具 ID ----

const ID_PREFIX: &str = "oxe_";

/// Anthropic 要求工具 ID 只含字母、数字、`_`、`-`。不合规的上游 ID 用十六进制包一层，回传时再解开。
pub fn safe_id(id: &str) -> String {
    let ok = !id.is_empty() && id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-');
    if ok && !id.starts_with(ID_PREFIX) {
        return id.to_string();
    }
    let mut s = String::from(ID_PREFIX);
    for b in id.bytes() {
        s.push_str(&format!("{b:02x}"));
    }
    s
}

pub fn orig_id(id: &str) -> String {
    let Some(h) = id.strip_prefix(ID_PREFIX) else { return id.to_string() };
    let bytes: Option<Vec<u8>> =
        (0..h.len()).step_by(2).map(|i| h.get(i..i + 2).and_then(|x| u8::from_str_radix(x, 16).ok())).collect();
    bytes.filter(|_| h.len() % 2 == 0).and_then(|b| String::from_utf8(b).ok()).unwrap_or_else(|| id.to_string())
}

// ---- 响应 ----

/// Chat usage → Anthropic usage。按 OpenAI 口径，prompt_tokens 含缓存读写，扣掉后才是 input_tokens；
/// reasoning_tokens 已含在 completion_tokens 里，只作明细。
// CONTRACT-PENDING: 不同厂商口径不同，等 Provider 配置声明口径后再按路由区分。
pub fn anthropic_usage(u: &Value) -> Value {
    let n = |p: &str| u.pointer(p).and_then(Value::as_u64).unwrap_or(0);
    let (prompt, cached, write) = (
        n("/prompt_tokens"),
        n("/prompt_tokens_details/cached_tokens"),
        n("/prompt_tokens_details/cache_write_tokens"),
    );
    let mut o = json!({
        "input_tokens": prompt.saturating_sub(cached + write),
        "output_tokens": n("/completion_tokens"),
        "cache_read_input_tokens": cached,
        "cache_creation_input_tokens": write,
    });
    let reasoning = n("/completion_tokens_details/reasoning_tokens");
    if reasoning > 0 {
        o["output_tokens_details"] = json!({"thinking_tokens": reasoning});
    }
    o
}

fn stop_reason(finish: &str) -> &'static str {
    match finish {
        "length" => "max_tokens",
        "tool_calls" | "function_call" => "tool_use",
        "content_filter" => "refusal",
        _ => "end_turn",
    }
}

/// 非流式 Chat 响应 → Anthropic message。返回 (message, 是否有 usage)。
pub fn response_to_anthropic(v: &Value, client_model: &str) -> Result<(Value, bool), String> {
    if let Some(e) = v.get("error") {
        return Err(error_message(e));
    }
    let choices = v.get("choices").and_then(Value::as_array).ok_or("上游响应缺少 choices。")?;
    let c =
        choices.iter().find(|c| index_of(c.get("index")) == Some(0)).or(choices.first()).ok_or("上游响应没有内容。")?;
    let msg = &c["message"];
    let mut content = Vec::new();
    if let Some(t) = msg.get("content").and_then(Value::as_str).filter(|t| !t.is_empty()) {
        content.push(json!({"type": "text", "text": t}));
    }
    for tc in msg.get("tool_calls").and_then(Value::as_array).into_iter().flatten() {
        let args = tc.pointer("/function/arguments").and_then(Value::as_str).unwrap_or("{}");
        let input: Value = serde_json::from_str(if args.is_empty() { "{}" } else { args })
            .map_err(|_| "上游返回的工具参数不是有效 JSON。".to_string())?;
        content.push(json!({"type": "tool_use", "id": safe_id(tc.get("id").and_then(Value::as_str).unwrap_or("")),
            "name": tc.pointer("/function/name").cloned().unwrap_or_default(), "input": input}));
    }
    let finish = c.get("finish_reason").and_then(Value::as_str).unwrap_or("stop");
    let usage = v.get("usage").filter(|u| u.is_object());
    let m = json!({
        "id": id::new("msg"),
        "type": "message",
        "role": "assistant",
        "model": client_model,
        "content": content,
        "stop_reason": stop_reason(finish),
        "stop_sequence": null,
        "usage": usage.map(anthropic_usage).unwrap_or(json!({"input_tokens": 0, "output_tokens": 0})),
    });
    Ok((m, usage.is_some()))
}

fn error_message(e: &Value) -> String {
    let m = match e {
        Value::String(s) => s.clone(),
        _ => e.get("message").and_then(Value::as_str).unwrap_or("").to_string(),
    };
    m.chars().take(500).collect()
}

/// 流开始前的上游 HTTP 错误 → (Anthropic error.type, message)。
pub fn error_to_anthropic(status: u16, body: &[u8]) -> (&'static str, String) {
    let v: Value = serde_json::from_slice(body).unwrap_or(Value::Null);
    let e = v.get("error").unwrap_or(&v);
    let msg = error_message(e);
    let code = e.get("code").and_then(Value::as_str).unwrap_or("");
    // Claude Code 靠 "prompt is too long" 触发自动压缩
    let too_long = code == "context_length_exceeded" || msg.contains("maximum context length");
    if too_long {
        return ("invalid_request_error", format!("prompt is too long: {msg}"));
    }
    let kind = match status {
        400 | 422 => "invalid_request_error",
        401 => "authentication_error",
        403 => "permission_error",
        404 => "not_found_error",
        413 => "request_too_large",
        429 => "rate_limit_error",
        529 => "overloaded_error",
        _ => "api_error",
    };
    (kind, format!("上游模型服务返回错误（HTTP {status}）：{msg}"))
}

fn index_of(v: Option<&Value>) -> Option<u64> {
    match v? {
        Value::Number(n) => n.as_u64(),
        Value::String(s) => s.parse().ok(),
        _ => None,
    }
}

// ---- 流式 ----

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Step {
    Continue,
    /// 已输出 message_stop
    Done,
    /// 上游在流里报错，已输出 error 事件
    UpstreamError,
    /// 没有终态就结束了，调用方补 error 事件
    Truncated,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Open {
    Text(usize),
    Tool(usize),
}

struct Tool {
    key: u64,
    id: String,
    name: String,
    /// 还没输出的参数片段
    args: String,
    block: Option<usize>,
    closed: bool,
}

/// 把 Chat SSE 事件逐个译成 Anthropic SSE 事件。
///
/// 只跟一个 choice：第一个带正文、工具或结束原因的 choice，之后不带 index 的片段也算它的。
/// 第一个工具直接流式输出；它打开期间出现的其他工具先缓冲，等结束时依次输出，保证每个块的参数不混。
/// 收到 finish_reason 后关闭所有块，等尾部 usage 和 `[DONE]` 再发 message_delta 和 message_stop。
pub struct StreamTranslator {
    model: String,
    started: bool,
    choice: Option<u64>,
    next_block: usize,
    open: Option<Open>,
    tools: Vec<Tool>,
    finish: Option<String>,
    usage: Option<Value>,
    /// 在 finish_reason 之后收到过 usage，才算最终用量
    usage_final: bool,
    done: bool,
}

impl StreamTranslator {
    pub fn new(client_model: &str) -> Self {
        Self {
            model: client_model.to_string(),
            started: false,
            choice: None,
            next_block: 0,
            open: None,
            tools: Vec::new(),
            finish: None,
            usage: None,
            usage_final: false,
            done: false,
        }
    }

    pub fn usage_final(&self) -> bool {
        self.usage_final
    }

    pub fn push(&mut self, ev: &Event, out: &mut Vec<Event>) -> Step {
        if self.done {
            return Step::Done;
        }
        let data = ev.data.trim();
        if data == "[DONE]" {
            return self.finish_stream(out);
        }
        let Ok(v) = serde_json::from_str::<Value>(data) else {
            warn!(len = data.len(), "unparsable chat stream frame");
            return Step::Continue;
        };
        if let Some(e) = v.get("error") {
            self.ensure_started(out);
            self.close_all(out);
            out.push(error_event("api_error", &format!("上游模型服务报错：{}", error_message(e))));
            self.done = true;
            return Step::UpstreamError;
        }
        for c in v.get("choices").and_then(Value::as_array).into_iter().flatten() {
            self.choice_delta(c, out);
        }
        if let Some(u) = v.get("usage").filter(|u| u.is_object()) {
            self.usage = Some(u.clone());
            self.usage_final = self.finish.is_some();
            self.ensure_started(out);
        }
        Step::Continue
    }

    /// 上游连接结束。见过 finish_reason 就算正常结束（有的上游不发 `[DONE]`）。
    pub fn eof(&mut self, out: &mut Vec<Event>) -> Step {
        if self.done {
            return Step::Done;
        }
        if self.finish.is_some() { self.finish_stream(out) } else { Step::Truncated }
    }

    /// 中途中断：关闭已打开的块，调用方随后发 error 事件。
    pub fn abort(&mut self, out: &mut Vec<Event>) {
        if self.started && !self.done {
            self.close_all(out);
        }
        self.done = true;
    }

    fn finish_stream(&mut self, out: &mut Vec<Event>) -> Step {
        let Some(finish) = self.finish.clone() else { return Step::Truncated };
        self.ensure_started(out);
        self.close_all(out);
        let usage = self.usage.as_ref().map(anthropic_usage).unwrap_or(json!({"output_tokens": 0}));
        out.push(event(
            "message_delta",
            json!({"type": "message_delta", "delta": {"stop_reason": stop_reason(&finish), "stop_sequence": null}, "usage": usage}),
        ));
        out.push(event("message_stop", json!({"type": "message_stop"})));
        self.done = true;
        Step::Done
    }

    fn ensure_started(&mut self, out: &mut Vec<Event>) {
        if self.started {
            return;
        }
        self.started = true;
        let input = self.usage.as_ref().map(|u| anthropic_usage(u)["input_tokens"].clone()).unwrap_or(json!(0));
        out.push(event(
            "message_start",
            json!({"type": "message_start", "message": {"id": id::new("msg"), "type": "message", "role": "assistant",
                "model": self.model, "content": [], "stop_reason": null, "stop_sequence": null,
                "usage": {"input_tokens": input, "output_tokens": 0}}}),
        ));
    }

    fn choice_delta(&mut self, c: &Value, out: &mut Vec<Event>) {
        let idx = index_of(c.get("index"));
        let d = c.get("delta").unwrap_or(&Value::Null);
        let text = d.get("content").and_then(Value::as_str).filter(|s| !s.is_empty());
        let calls = d.get("tool_calls").and_then(Value::as_array).filter(|a| !a.is_empty());
        let finish = c.get("finish_reason").and_then(Value::as_str);
        let substantive = text.is_some() || calls.is_some() || finish.is_some();
        match (self.choice, idx) {
            (None, _) if !substantive => return,
            (None, i) => self.choice = Some(i.unwrap_or(0)),
            (Some(ch), Some(i)) if ch != i => return,
            _ => {}
        }
        self.ensure_started(out);
        if let Some(t) = text {
            self.text(t, out);
        }
        for tc in calls.into_iter().flatten() {
            self.tool_delta(tc, out);
        }
        if let Some(f) = finish {
            self.finish = Some(f.to_string());
            self.close_all(out);
        }
    }

    fn text(&mut self, t: &str, out: &mut Vec<Event>) {
        let i = match self.open {
            Some(Open::Text(i)) => i,
            _ => {
                self.close(out);
                let i = self.alloc();
                out.push(event(
                    "content_block_start",
                    json!({"type": "content_block_start", "index": i, "content_block": {"type": "text", "text": ""}}),
                ));
                self.open = Some(Open::Text(i));
                i
            }
        };
        out.push(event(
            "content_block_delta",
            json!({"type": "content_block_delta", "index": i, "delta": {"type": "text_delta", "text": t}}),
        ));
    }

    fn tool_delta(&mut self, tc: &Value, out: &mut Vec<Event>) {
        let key = index_of(tc.get("index")).unwrap_or(0);
        let pos = match self.tools.iter().position(|t| t.key == key) {
            Some(p) => p,
            None => {
                let id = tc.get("id").and_then(Value::as_str).filter(|s| !s.is_empty());
                self.tools.push(Tool {
                    key,
                    id: id.map(str::to_owned).unwrap_or_else(|| id::new("call")),
                    name: String::new(),
                    args: String::new(),
                    block: None,
                    closed: false,
                });
                self.tools.len() - 1
            }
        };
        let frag = tc.pointer("/function/arguments").and_then(Value::as_str).unwrap_or("");
        let name = tc.pointer("/function/name").and_then(Value::as_str).unwrap_or("");
        let t = &mut self.tools[pos];
        if t.name.is_empty() && !name.is_empty() {
            t.name = name.to_string();
        }
        if t.closed {
            warn!(tool = %t.name, "chat tool fragment after its block was closed; dropped");
            return;
        }
        t.args.push_str(frag);
        if t.block.is_none() && !t.name.is_empty() && !matches!(self.open, Some(Open::Tool(_))) {
            self.close(out);
            self.open_tool(pos, out);
        }
        if self.open == Some(Open::Tool(pos)) {
            self.emit_args(pos, out);
        }
    }

    fn open_tool(&mut self, pos: usize, out: &mut Vec<Event>) {
        let i = self.alloc();
        let t = &mut self.tools[pos];
        t.block = Some(i);
        out.push(event(
            "content_block_start",
            json!({"type": "content_block_start", "index": i,
                "content_block": {"type": "tool_use", "id": safe_id(&t.id), "name": t.name, "input": {}}}),
        ));
        self.open = Some(Open::Tool(pos));
    }

    fn emit_args(&mut self, pos: usize, out: &mut Vec<Event>) {
        let t = &mut self.tools[pos];
        if t.args.is_empty() {
            return;
        }
        let s = std::mem::take(&mut t.args);
        out.push(event(
            "content_block_delta",
            json!({"type": "content_block_delta", "index": t.block, "delta": {"type": "input_json_delta", "partial_json": s}}),
        ));
    }

    fn close(&mut self, out: &mut Vec<Event>) {
        let i = match self.open.take() {
            None => return,
            Some(Open::Text(i)) => i,
            Some(Open::Tool(pos)) => {
                self.tools[pos].closed = true;
                self.tools[pos].block.unwrap()
            }
        };
        out.push(event("content_block_stop", json!({"type": "content_block_stop", "index": i})));
    }

    /// 关闭当前块，再依次输出缓冲着的工具。
    fn close_all(&mut self, out: &mut Vec<Event>) {
        self.close(out);
        for pos in 0..self.tools.len() {
            if self.tools[pos].block.is_none() {
                if self.tools[pos].name.is_empty() {
                    warn!("chat tool call without a name; dropped");
                    continue;
                }
                self.open_tool(pos, out);
                self.emit_args(pos, out);
                self.close(out);
            }
        }
    }

    fn alloc(&mut self) -> usize {
        self.next_block += 1;
        self.next_block - 1
    }
}

fn event(name: &str, data: Value) -> Event {
    Event { event: Some(name.into()), data: data.to_string() }
}

fn error_event(kind: &str, message: &str) -> Event {
    event("error", json!({"type": "error", "error": {"type": kind, "message": message}}))
}

pub fn encode(evs: &[Event]) -> Bytes {
    let mut s = String::new();
    for e in evs {
        s.push_str("event: ");
        s.push_str(e.event.as_deref().unwrap_or("message"));
        s.push_str("\ndata: ");
        s.push_str(&e.data);
        s.push_str("\n\n");
    }
    Bytes::from(s)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn url_join() {
        assert_eq!(chat_url("http://h:1/v1"), "http://h:1/v1/chat/completions");
        assert_eq!(chat_url("http://h:1/v1/"), "http://h:1/v1/chat/completions");
        assert_eq!(chat_url("https://api.x.com"), "https://api.x.com/v1/chat/completions");
    }

    #[test]
    fn ids_roundtrip() {
        assert_eq!(safe_id("call_1"), "call_1");
        let s = safe_id("tool:1#x");
        assert!(s.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-'));
        assert_eq!(orig_id(&s), "tool:1#x");
        assert_eq!(orig_id("call_1"), "call_1");
        // 本身以前缀开头的合法 ID 也包一层，免得被误解开
        assert_eq!(orig_id(&safe_id("oxe_41")), "oxe_41");
        assert_eq!(orig_id("oxe_zz"), "oxe_zz");
    }

    #[test]
    fn request_basics() {
        let r = build_request(
            &json!({"model":"local-m","max_tokens":64,"stream":true,"system":[{"type":"text","text":"be brief","cache_control":{"type":"ephemeral"}}],
                "stop_sequences":["END"],"temperature":0.2,"top_k":5,"metadata":{"user_id":"u"},
                "messages":[{"role":"user","content":"hello"}]}),
            "wire-m",
            true,
        )
        .unwrap();
        assert_eq!(
            r,
            json!({"model":"wire-m","messages":[{"role":"system","content":"be brief"},{"role":"user","content":"hello"}],
                "max_tokens":64,"stop":["END"],"temperature":0.2,"stream":true,"stream_options":{"include_usage":true}})
        );
    }

    #[test]
    fn tool_choice_mapping_and_rejections() {
        let base = |tc: Value| {
            build_request(
                &json!({"max_tokens":1,"messages":[],"tools":[{"name":"f","input_schema":{"type":"object"}}],"tool_choice":tc}),
                "m",
                false,
            )
            .unwrap()
        };
        assert_eq!(base(json!({"type":"auto"}))["tool_choice"], "auto");
        assert_eq!(base(json!({"type":"any"}))["tool_choice"], "required");
        assert_eq!(base(json!({"type":"none"}))["tool_choice"], "none");
        let r = base(json!({"type":"tool","name":"f","disable_parallel_tool_use":true}));
        assert_eq!(r["tool_choice"], json!({"type":"function","function":{"name":"f"}}));
        assert_eq!(r["parallel_tool_calls"], false);
        assert_eq!(r["tools"][0], json!({"type":"function","function":{"name":"f","parameters":{"type":"object"}}}));

        let e = build_request(
            &json!({"messages":[],"tools":[{"type":"web_search_20250305","name":"web_search"}]}),
            "m",
            false,
        );
        assert!(e.unwrap_err().contains("web_search"));
        let e = build_request(
            &json!({"messages":[{"role":"user","content":[{"type":"document","source":{}}]}]}),
            "m",
            false,
        );
        assert!(e.unwrap_err().contains("document"));
    }

    #[test]
    fn images_and_thinking() {
        let r = build_request(
            &json!({"messages":[
                {"role":"user","content":[{"type":"text","text":"see"},{"type":"image","source":{"type":"base64","media_type":"image/jpeg","data":"AAA"}}]},
                {"role":"assistant","content":[{"type":"thinking","thinking":"hmm","signature":"sig"},{"type":"text","text":"ok"}]}]}),
            "m",
            false,
        )
        .unwrap();
        assert_eq!(
            r["messages"][0]["content"][1],
            json!({"type":"image_url","image_url":{"url":"data:image/jpeg;base64,AAA"}})
        );
        assert_eq!(r["messages"][1], json!({"role":"assistant","content":"ok"}));
        assert!(!r.to_string().contains("sig"));
    }

    #[test]
    fn usage_mapping() {
        let u = anthropic_usage(&json!({"prompt_tokens":1000,"completion_tokens":120,
            "prompt_tokens_details":{"cached_tokens":700,"cache_write_tokens":100},"completion_tokens_details":{"reasoning_tokens":100}}));
        assert_eq!(
            u,
            json!({"input_tokens":200,"output_tokens":120,"cache_read_input_tokens":700,"cache_creation_input_tokens":100,
                "output_tokens_details":{"thinking_tokens":100}})
        );
    }

    #[test]
    fn errors() {
        let (k, m) = error_to_anthropic(
            400,
            br#"{"error":{"code":"context_length_exceeded","message":"Input exceeds the context limit"}}"#,
        );
        assert_eq!(k, "invalid_request_error");
        assert!(m.starts_with("prompt is too long: "));
        // vLLM 的写法
        let (_, m) = error_to_anthropic(
            400,
            br#"{"object":"error","message":"This model's maximum context length is 32768 tokens.","type":"BadRequestError","code":400}"#,
        );
        assert!(m.starts_with("prompt is too long"));
        assert_eq!(error_to_anthropic(429, b"{}").0, "rate_limit_error");
        assert_eq!(error_to_anthropic(503, b"not json").0, "api_error");
    }
}
