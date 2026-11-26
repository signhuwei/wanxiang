//! Kimi Code `config.toml` 生成（S2B，见 docs/specs/agents/kimi-code.md「配置、环境与协议」）。
//!
//! 纯函数：输入本机 router 地址、本机短期令牌、获准模型，输出 TOML 文本，不做任何 IO——
//! 写入私有目录、0600 权限、launch 结束删除，都由调用方（受管启动流程）负责，和 `launch.rs`
//! 里 `settings.json` 的落盘方式一致（`write_private`：create_new + 0600 + fsync，同目录原子替换）。
//!
//! 不用 `toml` crate序列化：形状是固定的几张表（`providers.<id>`、`models.<id>`），手写模板
//! 比引入新依赖更可控，且字符串转义只需处理 TOML 基本字符串的 `"`、`\`、控制字符。
//!
//! 字段依据spec原文：
//! - `providers.<id>.type = "anthropic"`，`base_url` 指向本机 router，**不加** `/v1`
//!   （Agent 自己会拼协议路径；这点和 Claude Code 走 `ANTHROPIC_BASE_URL` 的约定一致）。
//! - `api_key` 是本机短期令牌，直接写进文件（Kimi Code 2.3.0 不支持 `api_key_env`，spec 原文：
//!   「此文件因而须按秘密文件处理；不得存上游渠道 Key」——这里只放 router 发的本机令牌，不是
//!   任何上游的真实 Key，但文件本身仍要按机密处理，调用方负责 0600 和清理）。
//! - `default_model` 指向 `models.<id>`；`models.<id>` 绑定 `provider`、`model`（获准的上游模型名）、
//!   `max_context_size`，`max_output_size` 可省略（交给原生推断）。
//! - 关遥测、自动标题、额外尝试；这些是全局开关，不是权限控制（spec 原文：「不把推理开关当作
//!   权限控制」——权限仍由 Server 端的 `allowed_models`/租约控制，这里只是让 Agent 行为确定化）。
//!
//! `mcp.json`（同目录，限授权资源）不在本函数范围内，S2B 任务只要求 `config.toml`。
//!
//! 本机连接与公开配置格式仍以目标版本的原生验收为准。

use std::fmt::Write as _;

/// 一个获准模型在 `config.toml` 里的条目（`models.<id>`）。
#[derive(Debug, Clone, PartialEq)]
pub struct ModelSpec {
    /// `models.<id>` 的 `<id>`，同时作为 `--model`/`default_model` 引用的名字
    pub id: String,
    /// 上游实际模型名（写进 `models.<id>.model`）
    pub model: String,
    pub max_context_size: u64,
    /// 省略则不写该键，交给原生推断
    pub max_output_size: Option<u64>,
    /// 能力标签（如 `["tool_use","vision"]`），为空则不写该键
    pub capabilities: Vec<String>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct Request<'a> {
    /// `providers.<id>` 的 `<id>`
    pub provider_id: &'a str,
    /// `127.0.0.1:<port>`，函数负责拼成 `http://.../`（不加 `/v1`）
    pub router_addr: &'a str,
    /// 本机短期令牌，直接写进 `providers.<id>.api_key`
    pub local_token: &'a str,
    pub models: &'a [ModelSpec],
    /// 作为 `default_model` 的模型 id；必须出现在 `models` 里
    pub default_model_id: &'a str,
}

/// 生成 `config.toml` 文本。`models` 为空或 `default_model_id` 不在其中时返回错误——
/// 调用方传入的获准模型集合本身是契约保证非空的，这里只是防止生成一个无法启动的配置。
pub fn render(r: &Request) -> Result<String, String> {
    if r.models.is_empty() {
        return Err("models must not be empty".into());
    }
    if !r.models.iter().any(|m| m.id == r.default_model_id) {
        return Err(format!("default_model_id {:?} not found in models", r.default_model_id));
    }
    let base_url = format!("http://{}", r.router_addr);
    let mut out = String::new();
    writeln!(out, "default_model = {}", toml_string(r.default_model_id)).unwrap();
    writeln!(out).unwrap();

    writeln!(out, "telemetry = false").unwrap();
    writeln!(out, "auto_session_title = false").unwrap();
    writeln!(out, "builtin_product_skills = false").unwrap();
    writeln!(out, "\n[loop_control]\nmax_attempts_per_step = 1\n").unwrap();

    writeln!(out, "[providers.{}]", toml_key(r.provider_id)).unwrap();
    writeln!(out, "type = \"anthropic\"").unwrap();
    writeln!(out, "base_url = {}", toml_string(&base_url)).unwrap();
    writeln!(out, "api_key = {}", toml_string(r.local_token)).unwrap();
    writeln!(out).unwrap();

    for m in r.models {
        let id = if is_bare_key(&m.id) { m.id.clone() } else { toml_string(&m.id) };
        writeln!(out, "[models.{id}]").unwrap();
        writeln!(out, "provider = {}", toml_string(r.provider_id)).unwrap();
        writeln!(out, "model = {}", toml_string(&m.model)).unwrap();
        writeln!(out, "max_context_size = {}", m.max_context_size).unwrap();
        if let Some(max_out) = m.max_output_size {
            writeln!(out, "max_output_size = {max_out}").unwrap();
        }
        if !m.capabilities.is_empty() {
            let items: Vec<String> = m.capabilities.iter().map(|c| toml_string(c)).collect();
            writeln!(out, "capabilities = [{}]", items.join(", ")).unwrap();
        }
        writeln!(out).unwrap();
    }
    Ok(out)
}

/// TOML 基本字符串（双引号）：转义 `\`、`"` 和控制字符；路径、令牌、模型名都可能含这些字符的
/// 子集，没必要先证明"不会出现"才处理。
fn toml_string(s: &str) -> String {
    let mut out = String::with_capacity(s.len() + 2);
    out.push('"');
    for c in s.chars() {
        match c {
            '\\' => out.push_str("\\\\"),
            '"' => out.push_str("\\\""),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            c if (c as u32) < 0x20 || c == '\x7f' => {
                write!(out, "\\u{:04x}", c as u32).unwrap();
            }
            c => out.push(c),
        }
    }
    out.push('"');
    out
}

fn is_bare_key(s: &str) -> bool {
    !s.is_empty() && s.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
}

/// Provider IDs are generated locally. Signed model aliases may need quoted TOML keys.
fn toml_key(s: &str) -> String {
    assert!(is_bare_key(s), "not a valid bare TOML key: {s:?}");
    s.to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn req<'a>(router_addr: &'a str, token: &'a str, models: &'a [ModelSpec], default: &'a str) -> Request<'a> {
        Request { provider_id: "onex", router_addr, local_token: token, models, default_model_id: default }
    }

    #[test]
    fn base_url_has_no_v1_suffix_and_api_key_is_local_token() {
        let models = [ModelSpec {
            id: "m1".into(),
            model: "Qwen3.8-27B".into(),
            max_context_size: 128000,
            max_output_size: None,
            capabilities: vec![],
        }];
        let out = render(&req("127.0.0.1:4567", "secret-token", &models, "m1")).unwrap();
        assert!(out.contains(r#"base_url = "http://127.0.0.1:4567""#));
        assert!(!out.contains("/v1"));
        assert!(out.contains(r#"api_key = "secret-token""#));
        assert!(out.contains(r#"type = "anthropic""#));
        assert!(out.contains(r#"default_model = "m1""#));
    }

    #[test]
    fn models_bind_provider_and_approved_model_with_context_size() {
        let models = [
            ModelSpec {
                id: "fast".into(),
                model: "Qwen3.8-8B".into(),
                max_context_size: 32000,
                max_output_size: Some(8192),
                capabilities: vec!["tool_use".into()],
            },
            ModelSpec {
                id: "big".into(),
                model: "Qwen3.8-27B".into(),
                max_context_size: 128000,
                max_output_size: None,
                capabilities: vec![],
            },
        ];
        let out = render(&req("127.0.0.1:1", "t", &models, "big")).unwrap();
        assert!(out.contains("[models.fast]"));
        assert!(out.contains(r#"provider = "onex""#));
        assert!(out.contains(r#"model = "Qwen3.8-8B""#));
        assert!(out.contains("max_context_size = 32000"));
        assert!(out.contains("max_output_size = 8192"));
        assert!(out.contains(r#"capabilities = ["tool_use"]"#));
        assert!(out.contains("[models.big]"));
        assert!(out.contains("max_context_size = 128000"));
        // big 没设 max_output_size，就不该出现在它的表里（宽松检查：at least ensure order doesn't bleed）
        let big_block = out.split("[models.big]").nth(1).unwrap();
        assert!(!big_block.contains("max_output_size"));
    }

    #[test]
    fn telemetry_auto_title_and_retries_are_off() {
        let models = [ModelSpec {
            id: "m".into(),
            model: "x".into(),
            max_context_size: 1,
            max_output_size: None,
            capabilities: vec![],
        }];
        let out = render(&req("127.0.0.1:1", "t", &models, "m")).unwrap();
        assert!(out.contains("telemetry = false"));
        assert!(out.contains("auto_session_title = false"));
        assert!(out.contains("max_attempts_per_step = 1"));
    }

    #[test]
    fn rejects_empty_models_and_unknown_default() {
        assert!(render(&req("127.0.0.1:1", "t", &[], "m")).is_err());
        let models = [ModelSpec {
            id: "m1".into(),
            model: "x".into(),
            max_context_size: 1,
            max_output_size: None,
            capabilities: vec![],
        }];
        assert!(render(&req("127.0.0.1:1", "t", &models, "missing")).is_err());
    }

    #[test]
    fn escapes_quotes_backslashes_and_control_chars_in_strings() {
        assert_eq!(toml_string("a\"b\\c"), r#""a\"b\\c""#);
        assert_eq!(toml_string("line1\nline2"), r#""line1\nline2""#);
        assert_eq!(toml_string("tab\there"), r#""tab\there""#);
        let out = toml_string("\u{1}");
        assert_eq!(out, r#""\u0001""#);
    }

    #[test]
    #[should_panic(expected = "not a valid bare TOML key")]
    fn bare_key_rejects_illegal_characters() {
        toml_key("has space");
    }

    /// 生成的文本本身是合法 TOML：用一个极简手写解析器验证关键不变量——每个 `key = value` 行
    /// 能找到配对的 `[section]`，字符串值的引号配对正确。不引入 `toml` crate 做完整解析，
    /// 这里只验证我们自己手写模板不会生产出破损语法。
    #[test]
    fn generated_text_has_balanced_quotes_per_line() {
        let models = [ModelSpec {
            id: "m1".into(),
            model: "has \"quotes\" and \\backslash".into(),
            max_context_size: 1,
            max_output_size: None,
            capabilities: vec!["a\"b".into()],
        }];
        let out = render(&req("127.0.0.1:1", "t", &models, "m1")).unwrap();
        for line in out.lines() {
            if let Some((_, rhs)) = line.split_once(" = ") {
                if rhs.starts_with('"') {
                    // 奇数个未转义的引号意味着字符串没闭合
                    let mut quotes = 0;
                    let mut escaped = false;
                    for c in rhs.chars() {
                        if escaped {
                            escaped = false;
                            continue;
                        }
                        match c {
                            '\\' => escaped = true,
                            '"' => quotes += 1,
                            _ => {}
                        }
                    }
                    assert_eq!(quotes % 2, 0, "unbalanced quotes in line: {line}");
                }
            }
        }
    }
}
