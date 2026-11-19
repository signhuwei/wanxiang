//! SSE 切分：把上游字节流切成完整事件，原样转发事件字节，同时解析出 `event` 和 `data`。
//!
//! 只转发完整事件，所以上游中途断开时，客户端不会收到半个事件。
//! 行尾支持 `\n` 和 `\r\n`；单独的 `\r` 不支持（Anthropic 和兼容上游都不用）。

use bytes::{Bytes, BytesMut};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Event {
    pub event: Option<String>,
    pub data: String,
}

#[derive(Default)]
pub struct Splitter {
    buf: BytesMut,
    /// buf 中已解析过的整行的末尾，下一行从这里开始。
    scanned: usize,
    event: Option<String>,
    data: Vec<String>,
    has_fields: bool,
}

impl Splitter {
    /// 喂入一段字节，返回可以转发的完整事件字节和解析出的事件。
    pub fn push(&mut self, chunk: &[u8]) -> (Bytes, Vec<Event>) {
        self.buf.extend_from_slice(chunk);
        let mut events = Vec::new();
        let mut boundary = 0;
        while let Some(nl) = self.buf[self.scanned..].iter().position(|&b| b == b'\n') {
            let start = self.scanned;
            let end = start + nl;
            self.scanned = end + 1;
            let mut line = &self.buf[start..end];
            if line.last() == Some(&b'\r') {
                line = &line[..line.len() - 1];
            }
            if line.is_empty() {
                if self.has_fields {
                    events.push(Event { event: self.event.take(), data: self.data.join("\n") });
                    self.data.clear();
                    self.has_fields = false;
                }
                boundary = self.scanned;
            } else {
                let line = String::from_utf8_lossy(line).into_owned();
                self.field(&line);
            }
        }
        let out = self.buf.split_to(boundary).freeze();
        self.scanned -= boundary;
        (out, events)
    }

    /// 还有没结束的事件（上游断开时用来判断是否截断）。
    pub fn has_partial(&self) -> bool {
        !self.buf.iter().all(|b| b.is_ascii_whitespace())
    }

    fn field(&mut self, line: &str) {
        if line.starts_with(':') {
            return;
        }
        let (name, value) = match line.split_once(':') {
            Some((n, v)) => (n, v.strip_prefix(' ').unwrap_or(v)),
            None => (line, ""),
        };
        match name {
            "event" => {
                self.event = Some(value.to_string());
                self.has_fields = true;
            }
            "data" => {
                self.data.push(value.to_string());
                self.has_fields = true;
            }
            _ => {}
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const STREAM: &str =
        "event: message_start\ndata: {\"a\":1}\n\n: comment\n\nevent: ping\r\ndata: {}\r\n\r\ndata: x\ndata: y\n\n";

    fn collect(chunks: &[&[u8]]) -> (Vec<u8>, Vec<Event>) {
        let mut s = Splitter::default();
        let mut out = Vec::new();
        let mut evs = Vec::new();
        for c in chunks {
            let (b, e) = s.push(c);
            out.extend_from_slice(&b);
            evs.extend(e);
        }
        assert!(!s.has_partial());
        (out, evs)
    }

    #[test]
    fn whole_stream() {
        let (out, evs) = collect(&[STREAM.as_bytes()]);
        assert_eq!(out, STREAM.as_bytes());
        assert_eq!(
            evs,
            [
                Event { event: Some("message_start".into()), data: "{\"a\":1}".into() },
                Event { event: Some("ping".into()), data: "{}".into() },
                Event { event: None, data: "x\ny".into() },
            ]
        );
    }

    #[test]
    fn byte_by_byte_gives_same_result() {
        let chunks: Vec<&[u8]> = STREAM.as_bytes().chunks(1).collect();
        let (out, evs) = collect(&chunks);
        assert_eq!(out, STREAM.as_bytes());
        assert_eq!(evs.len(), 3);
        // 每一种切分位置都要一致
        for cut in 1..STREAM.len() {
            let (a, b) = STREAM.as_bytes().split_at(cut);
            let (out, evs2) = collect(&[a, b]);
            assert_eq!(out, STREAM.as_bytes(), "cut at {cut}");
            assert_eq!(evs2, evs, "cut at {cut}");
        }
    }

    #[test]
    fn holds_back_partial_event() {
        let mut s = Splitter::default();
        let (out, evs) = s.push(b"event: a\ndata: 1\n\nevent: b\ndata: {\"tru");
        assert_eq!(&out[..], b"event: a\ndata: 1\n\n");
        assert_eq!(evs.len(), 1);
        assert!(s.has_partial());
    }

    #[test]
    fn multibyte_utf8_split() {
        let text = "data: 你好\n\n".as_bytes();
        let (out, evs) = collect(&[&text[..7], &text[7..]]);
        assert_eq!(out, text);
        assert_eq!(evs[0].data, "你好");
    }
}
