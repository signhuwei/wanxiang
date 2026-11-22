//! Reserve input tokens from text and recognised binary prompt parts without fetching attachment URLs.
use base64::Engine as _;
use base64::engine::general_purpose::{STANDARD, STANDARD_NO_PAD};
use serde_json::{Map, Value};

use crate::pricing::estimate_tokens;

const IMAGE_PREFIX_BASE64: usize = 88 * 1024;
const UNKNOWN_IMAGE_TOKENS: u64 = 3_072;
const FILE_BASE_TOKENS: u64 = 1_024;

pub(crate) fn estimate_request_fields(req: &Value, fields: &[&str]) -> u64 {
    let mut estimate = Estimate::default();
    for key in fields {
        if let Some(value) = req.get(*key) {
            estimate.walk(value);
        }
    }
    estimate_tokens(estimate.text_bytes).saturating_add(estimate.media_tokens)
}

#[derive(Default)]
struct Estimate {
    text_bytes: usize,
    media_tokens: u64,
}

impl Estimate {
    fn walk(&mut self, value: &Value) {
        match value {
            Value::String(text) => self.text_bytes = self.text_bytes.saturating_add(text.len()),
            Value::Array(items) => items.iter().for_each(|item| self.walk(item)),
            Value::Object(object) => self.walk_part(value, object),
            _ => {}
        }
    }

    fn fields(&mut self, object: &Map<String, Value>, skip: &[&str]) {
        for (key, value) in object {
            if !skip.contains(&key.as_str()) {
                self.walk(value);
            }
        }
    }

    fn nested_fields(&mut self, value: &Value, skip: &[&str]) {
        if let Some(object) = value.as_object() {
            self.fields(object, skip);
        }
    }

    fn media(&mut self, tokens: u64) {
        self.media_tokens = self.media_tokens.saturating_add(tokens);
    }

    fn walk_part(&mut self, part: &Value, object: &Map<String, Value>) {
        let skip: &[&str] = match part["type"].as_str() {
            Some("input_image" | "image_url") => {
                let image = &part["image_url"];
                let data = image.as_str().or_else(|| image["url"].as_str()).and_then(data_url);
                self.media(image_tokens(data));
                self.nested_fields(image, &["url"]);
                &["image_url", "file_id"]
            }
            Some("image") if part["source"].is_object() => {
                let source = &part["source"];
                let data = if source["type"] == "base64" {
                    source["data"].as_str().map(|payload| Encoded { mime: "image", payload })
                } else {
                    source["url"].as_str().and_then(data_url)
                };
                self.media(image_tokens(data));
                self.nested_fields(source, &["data", "url"]);
                &["source"]
            }
            Some("input_file") => {
                self.media(file_tokens(file_data(part)));
                &["file_data", "file_url", "file_id"]
            }
            Some("file") if part["file"].is_object() => {
                let file = &part["file"];
                self.media(file_tokens(file_data(file)));
                self.nested_fields(file, &["file_data", "file_url", "file_id"]);
                &["file"]
            }
            Some("document") if part["source"]["type"] == "base64" || part["source"]["type"] == "url" => {
                let source = &part["source"];
                let encoded = if source["type"] == "base64" {
                    source["data"]
                        .as_str()
                        .map(|payload| Encoded { mime: source["media_type"].as_str().unwrap_or_default(), payload })
                } else {
                    source["url"].as_str().and_then(data_url)
                };
                self.media(file_tokens(encoded));
                self.nested_fields(source, &["data", "url"]);
                &["source"]
            }
            _ => &[],
        };
        self.fields(object, skip);
    }
}

#[derive(Clone, Copy)]
struct Encoded<'a> {
    mime: &'a str,
    payload: &'a str,
}

impl Encoded<'_> {
    fn bytes(self) -> u64 {
        self.payload.trim_end_matches('=').len() as u64 * 3 / 4
    }
}

fn data_url(url: &str) -> Option<Encoded<'_>> {
    let (head, payload) = url.strip_prefix("data:")?.split_once(',')?;
    let metadata = head.strip_suffix(";base64")?;
    let mime = metadata.split(';').next()?;
    Some(Encoded { mime, payload })
}

fn file_data(part: &Value) -> Option<Encoded<'_>> {
    if let Some(data) = part["file_data"].as_str() {
        return data_url(data).or(Some(Encoded { mime: "", payload: data }));
    }
    part["file_url"].as_str().and_then(data_url)
}

fn file_tokens(data: Option<Encoded<'_>>) -> u64 {
    // File extraction and provider billing vary. Keep a separate allowance for binary documents,
    // while counting inline text files by their decoded size.
    let extra = data.map_or(0, |data| {
        let size = data.bytes();
        if data.mime.starts_with("text/") { size.div_ceil(3) } else { size.div_ceil(16) }
    });
    FILE_BASE_TOKENS + extra
}

fn image_tokens(data: Option<Encoded<'_>>) -> u64 {
    let Some(data) = data else { return UNKNOWN_IMAGE_TOKENS };
    let size = data.bytes();
    let Some((width, height)) = image_dimensions(data.payload) else {
        return UNKNOWN_IMAGE_TOKENS.max(size.div_ceil(1024));
    };
    // Reserve for either fine visual patches or tile overhead across compatible image APIs.
    let (width, height) = (u64::from(width), u64::from(height));
    let patches = width.div_ceil(32) * height.div_ceil(32);
    let tiles = width.div_ceil(512) * height.div_ceil(512);
    patches.max(85 + 170 * tiles)
}

fn image_dimensions(payload: &str) -> Option<(u32, u32)> {
    let prefix = &payload.as_bytes()[..payload.len().min(IMAGE_PREFIX_BASE64)];
    let bytes = STANDARD.decode(prefix).or_else(|_| STANDARD_NO_PAD.decode(prefix)).ok()?;
    let (width, height) = if bytes.starts_with(b"\x89PNG\r\n\x1a\n\0\0\0\x0dIHDR") {
        (be32(bytes.get(16..20)?)?, be32(bytes.get(20..24)?)?)
    } else if bytes.starts_with(b"GIF87a") || bytes.starts_with(b"GIF89a") {
        (le16(bytes.get(6..8)?)?, le16(bytes.get(8..10)?)?)
    } else if bytes.starts_with(b"\xff\xd8") {
        jpeg_dimensions(&bytes)?
    } else if bytes.starts_with(b"RIFF") && bytes.get(8..12)? == b"WEBP" {
        webp_dimensions(&bytes)?
    } else {
        return None;
    };
    (width != 0 && height != 0).then_some((width, height))
}

fn be32(bytes: &[u8]) -> Option<u32> {
    Some(u32::from_be_bytes(bytes.try_into().ok()?))
}

fn le16(bytes: &[u8]) -> Option<u32> {
    Some(u16::from_le_bytes(bytes.try_into().ok()?).into())
}

fn jpeg_dimensions(bytes: &[u8]) -> Option<(u32, u32)> {
    let mut rest = bytes.get(2..)?;
    while rest.first() == Some(&0xff) {
        let marker_at = rest.iter().position(|byte| *byte != 0xff)?;
        let marker = rest[marker_at];
        if matches!(marker, 0xd9 | 0xda) {
            return None;
        }
        let segment = rest.get(marker_at + 1..)?;
        let length = u16::from_be_bytes(segment.get(..2)?.try_into().ok()?) as usize;
        if matches!(marker, 0xc0..=0xc3 | 0xc5..=0xc7 | 0xc9..=0xcb | 0xcd..=0xcf) && length >= 7 {
            let height = u16::from_be_bytes(segment.get(3..5)?.try_into().ok()?);
            let width = u16::from_be_bytes(segment.get(5..7)?.try_into().ok()?);
            return Some((width.into(), height.into()));
        }
        if length < 2 {
            return None;
        }
        rest = segment.get(length..)?;
    }
    None
}

fn webp_dimensions(bytes: &[u8]) -> Option<(u32, u32)> {
    match bytes.get(12..16)? {
        b"VP8X" => {
            let width = u32::from_le_bytes([*bytes.get(24)?, *bytes.get(25)?, *bytes.get(26)?, 0]);
            let height = u32::from_le_bytes([*bytes.get(27)?, *bytes.get(28)?, *bytes.get(29)?, 0]);
            Some((width + 1, height + 1))
        }
        b"VP8L" if bytes.get(20) == Some(&0x2f) => {
            let packed = u32::from_le_bytes(bytes.get(21..25)?.try_into().ok()?);
            Some(((packed & 0x3fff) + 1, ((packed >> 14) & 0x3fff) + 1))
        }
        b"VP8 " if bytes.get(23..26)? == b"\x9d\x01\x2a" => {
            Some((le16(bytes.get(26..28)?)? & 0x3fff, le16(bytes.get(28..30)?)? & 0x3fff))
        }
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    const PNG: &str =
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGMwXhX6HwAEeAIy+TSxQAAAAABJRU5ErkJggg==";

    #[test]
    fn image_allowance_uses_dimensions_in_chat_and_responses() {
        assert_eq!(image_dimensions(PNG), Some((1, 1)));
        let small = Encoded { mime: "image/png", payload: PNG };
        assert_eq!(image_tokens(Some(small)), 255);
        let mut bytes = STANDARD.decode(PNG).unwrap();
        bytes[16..20].copy_from_slice(&2048_u32.to_be_bytes());
        bytes[20..24].copy_from_slice(&1024_u32.to_be_bytes());
        let large_encoded = STANDARD.encode(bytes);
        let large = Encoded { mime: "image/png", payload: &large_encoded };
        assert_eq!(image_tokens(Some(large)), 2048);
        let url = format!("data:image/png;base64,{large_encoded}");
        let chat = json!({"messages":[{"role":"user","content":[{"type":"image_url","image_url":{"url":url}}]}]});
        let responses = json!({"input":[{"role":"user","content":[{"type":"input_image","image_url":url}]}]});
        assert!((2048..2070).contains(&estimate_request_fields(&chat, &["messages"])));
        assert!((2048..2070).contains(&estimate_request_fields(&responses, &["input"])));
    }

    #[test]
    fn documents_reserve_from_decoded_size_and_untyped_data_remains_text() {
        let encoded = STANDARD.encode(vec![0u8; 48_000]);
        let file = format!("data:application/pdf;base64,{encoded}");
        for part in [
            json!({"type":"input_file","file_data":file}),
            json!({"type":"file","file":{"file_data":file,"filename":"fixture.pdf"}}),
            json!({"type":"document","source":{"type":"base64","media_type":"application/pdf","data":encoded}}),
        ] {
            let req = json!({"input":[part]});
            assert!((4024..4050).contains(&estimate_request_fields(&req, &["input"])));
        }
        let tool = json!({"input":{"type":"result","data":"a".repeat(30_000)}});
        assert!(estimate_request_fields(&tool, &["input"]) >= 10_000);
        let text = json!({"input":{"type":"document","source":{"type":"text","data":"a".repeat(30_000)}}});
        assert!(estimate_request_fields(&text, &["input"]) >= 10_000);
    }
}
