//! SSE 切分：把上游字节流切成完整事件，原样转发事件字节，同时解析出 `event` 和 `data`。
//!
//! 只转发完整事件，所以上游中途断开时，客户端不会收到半个事件。
//! 行尾支持 `\n` 和 `\r\n`；单独的 `\r` 不支持（Anthropic 和兼容上游都不用）。
//!
//! 单行和单个事件的累计字节都设了上限：失控或恶意的上游不能靠不发换行、或一个事件里堆无穷多
//! `data:` 行把 Edge 的内存无限撑大。超限是一个干净的错误，不是 panic 或静默截断。

use bytes::{Bytes, BytesMut};

/// 单行的原始字节上限，包含行尾。
const MAX_LINE_BYTES: usize = 1024 * 1024;
/// 单个事件的原始字节上限，包含分隔空行。
const MAX_EVENT_BYTES: usize = 4 * 1024 * 1024;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Event {
    pub event: Option<String>,
    pub data: String,
}

/// 单行或单个事件超过字节上限。
#[cfg(test)]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct TooLarge;

pub struct Batch {
    pub raw: Bytes,
    /// Each offset is the end of the corresponding event in raw.
    pub events: Vec<(usize, Event)>,
    pub oversized: bool,
}

#[derive(Default)]
pub struct Splitter {
    buf: BytesMut,
    /// buf 中已解析过的整行的末尾，下一行从这里开始。
    scanned: usize,
    event: Option<String>,
    data: Vec<String>,
    /// 当前事件已经攒下的原始字节数：从上一个分隔空行之后开始，含每一行的全部原始字节
    /// （含行尾换行符）——不管是 `event:`/`data:`/未知字段还是注释行，都要算进去，
    /// 不能只数 `data` 的 value，否则大量注释或未知字段仍能让一个事件无限增长。
    event_bytes: usize,
    has_fields: bool,
}

impl Splitter {
    /// 喂入一段字节，返回可以转发的完整事件字节和解析出的事件。
    /// 单行或单个事件超过字节上限时返回错误；此时 buf 中的内容已不可信，调用方应当结束这条流。
    #[cfg(test)]
    fn push(&mut self, chunk: &[u8]) -> Result<(Bytes, Vec<Event>), TooLarge> {
        let Batch { raw, events, oversized } = self.push_framed(chunk);
        if oversized {
            return Err(TooLarge);
        }
        Ok((raw, events.into_iter().map(|(_, event)| event).collect()))
    }

    /// Preserve complete frames received before an oversized frame.
    pub fn push_framed(&mut self, chunk: &[u8]) -> Batch {
        self.buf.extend_from_slice(chunk);
        let mut events = Vec::new();
        let mut boundary = 0;
        let oversized = loop {
            let rest = &self.buf[self.scanned..];
            let Some(nl) = rest.iter().position(|&b| b == b'\n') else {
                // The eventual newline alone would add at least one byte.
                break rest.len() >= MAX_LINE_BYTES || self.event_bytes + rest.len() >= MAX_EVENT_BYTES;
            };
            let start = self.scanned;
            let end = start + nl;
            self.scanned = end + 1;
            // 这一行的原始字节数，含行尾的 `\n`（CRLF 也按原始两字节算），计入当前事件总量，
            // 不区分是哪个字段、是注释还是空行。
            self.event_bytes += self.scanned - start;
            if nl + 1 > MAX_LINE_BYTES || self.event_bytes > MAX_EVENT_BYTES {
                break true;
            }
            let mut line = &self.buf[start..end];
            if line.last() == Some(&b'\r') {
                line = &line[..line.len() - 1];
            }
            if line.is_empty() {
                if self.has_fields {
                    events.push((self.scanned, Event { event: self.event.take(), data: self.data.join("\n") }));
                    self.data.clear();
                    self.has_fields = false;
                }
                // 分隔空行结束了当前事件（不管是否真的提交了事件），计数清零。
                self.event_bytes = 0;
                boundary = self.scanned;
            } else {
                let line = String::from_utf8_lossy(line).into_owned();
                self.field(&line);
            }
        };
        let raw = self.buf.split_to(boundary).freeze();
        self.scanned -= boundary;
        Batch { raw, events, oversized }
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
            let (b, e) = s.push(c).unwrap();
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
        let (out, evs) = s.push(b"event: a\ndata: 1\n\nevent: b\ndata: {\"tru").unwrap();
        assert_eq!(&out[..], b"event: a\ndata: 1\n\n");
        assert_eq!(evs.len(), 1);
        assert!(s.has_partial());
    }

    #[test]
    fn oversized_line_without_newline_is_rejected() {
        let mut s = Splitter::default();
        // 还没见到换行，但已经超过单行上限：不能无限期攒在内存里等换行。
        let huge = vec![b'x'; MAX_LINE_BYTES + 1];
        assert_eq!(s.push(&huge), Err(TooLarge));
    }

    #[test]
    fn complete_prefix_survives_an_oversized_tail() {
        let first = b": ping\n\nevent: message_stop\ndata: {}\n\n";
        let mut bytes = first.to_vec();
        bytes.extend(std::iter::repeat_n(b'x', MAX_LINE_BYTES));
        let batch = Splitter::default().push_framed(&bytes);
        assert!(batch.oversized);
        assert_eq!(&batch.raw[..], first);
        assert_eq!(batch.events.len(), 1);
        assert_eq!(batch.events[0].0, first.len());
    }

    #[test]
    fn line_limit_counts_crlf_consistently_across_chunks() {
        let mut line = b"data: ".to_vec();
        line.resize(MAX_LINE_BYTES - 2, b'x');
        line.extend_from_slice(b"\r\n\r\n");
        let expected = collect(&[&line]);
        let (before_lf, from_lf) = line.split_at(MAX_LINE_BYTES - 1);
        assert_eq!(collect(&[before_lf, from_lf]), expected);
    }

    #[test]
    fn oversized_data_line_is_rejected() {
        let mut s = Splitter::default();
        let mut line = b"data: ".to_vec();
        line.extend(std::iter::repeat_n(b'x', MAX_LINE_BYTES));
        line.push(b'\n');
        assert_eq!(s.push(&line), Err(TooLarge));
    }

    #[test]
    fn many_small_data_lines_exceeding_event_total_are_rejected() {
        let mut s = Splitter::default();
        // 每行都在单行上限之内，但同一个事件里的 data 行总量超过事件上限。
        let chunk_len = 64 * 1024;
        let line = format!("data: {}\n", "x".repeat(chunk_len - 7));
        let mut err = None;
        for _ in 0..(MAX_EVENT_BYTES / chunk_len + 2) {
            if let Err(e) = s.push(line.as_bytes()) {
                err = Some(e);
                break;
            }
        }
        assert_eq!(err, Some(TooLarge));
    }

    #[test]
    fn under_limit_lines_are_not_rejected() {
        let mut s = Splitter::default();
        let mut line = b"data: ".to_vec();
        line.extend(std::iter::repeat_n(b'x', MAX_LINE_BYTES - 7));
        line.extend_from_slice(b"\n\n");
        let (_, evs) = s.push(&line).unwrap();
        assert_eq!(evs.len(), 1);
    }

    /// 大量注释行（`:` 开头，被 field() 直接丢弃，不进 data）本身也要计入事件总字节，
    /// 不能靠只数 data 的 value 绕过上限。
    #[test]
    fn many_comment_lines_exceeding_event_total_are_rejected() {
        let mut s = Splitter::default();
        let chunk_len = 64 * 1024;
        let line = format!(": {}\n", "x".repeat(chunk_len - 3));
        let mut err = None;
        for _ in 0..(MAX_EVENT_BYTES / chunk_len + 2) {
            if let Err(e) = s.push(line.as_bytes()) {
                err = Some(e);
                break;
            }
        }
        assert_eq!(err, Some(TooLarge));
    }

    /// 未知字段名（非 event/data）同样被 field() 丢弃，但原始行字节依然要计入事件总量。
    #[test]
    fn many_unknown_field_lines_exceeding_event_total_are_rejected() {
        let mut s = Splitter::default();
        let chunk_len = 64 * 1024;
        let line = format!("retry: {}\n", "1".repeat(chunk_len - 8));
        let mut err = None;
        for _ in 0..(MAX_EVENT_BYTES / chunk_len + 2) {
            if let Err(e) = s.push(line.as_bytes()) {
                err = Some(e);
                break;
            }
        }
        assert_eq!(err, Some(TooLarge));
    }

    /// event: 字段名本身（不只是它的 value）也要计入；空的 data: 行（只有字段名和换行，没有
    /// value）同样要计入，不能因为 value 是空字符串就算 0 字节。
    #[test]
    fn field_name_and_empty_data_line_bytes_are_counted() {
        let mut s = Splitter::default();
        // 每行都只有很短的 value（甚至没有 value），但有足够多行，总的原始字节超过上限。
        let unit = "event: message_start\ndata:\n";
        let repeats = MAX_EVENT_BYTES / unit.len() + 10;
        let line = unit.repeat(repeats);
        assert!(line.len() > MAX_EVENT_BYTES, "test fixture must exceed the limit on its own");
        let mut err = None;
        for chunk in line.as_bytes().chunks(8192) {
            if let Err(e) = s.push(chunk) {
                err = Some(e);
                break;
            }
        }
        assert_eq!(err, Some(TooLarge));
    }

    /// 分隔空行之后，事件字节计数要清零：上一个事件攒得接近上限，不该让下一个正常大小的
    /// 事件被错误地拒绝。
    #[test]
    fn event_byte_count_resets_after_boundary() {
        let mut s = Splitter::default();
        // 多条各自在单行上限内的 data 行，总量攒到接近（但不超过）事件上限。
        let chunk_len = 64 * 1024;
        let line = format!("data: {}\n", "x".repeat(chunk_len - 7));
        let mut big = Vec::new();
        for _ in 0..(MAX_EVENT_BYTES / chunk_len - 1) {
            big.extend_from_slice(line.as_bytes());
        }
        big.extend_from_slice(b"\n");
        let (_, evs) = s.push(&big).unwrap();
        assert_eq!(evs.len(), 1);
        // 紧接着一个正常大小的事件必须正常通过和转发，不能被上一个事件的残留计数误拒。
        let next = b"event: ping\ndata: {}\n\n";
        let (out, evs) = s.push(next).unwrap();
        assert_eq!(&out[..], next);
        assert_eq!(evs, [Event { event: Some("ping".into()), data: "{}".into() }]);
    }

    /// 字节数正好落在单行上限内的合法切片必须原样转发，不被误判超限；也要覆盖按任意位置切块到达的情况。
    #[test]
    fn legitimate_slice_near_the_line_limit_is_forwarded_unchanged() {
        let mut data = "y".repeat(MAX_LINE_BYTES - 64);
        data.push_str("END");
        let text = format!("event: content_block_delta\ndata: {data}\n\n");
        let bytes = text.as_bytes();
        for cut in [1, bytes.len() / 3, bytes.len() / 2, bytes.len() - 1] {
            let (a, b) = bytes.split_at(cut);
            let mut s = Splitter::default();
            let (out1, mut evs) = s.push(a).unwrap();
            let (out2, evs2) = s.push(b).unwrap();
            let mut out = out1.to_vec();
            out.extend_from_slice(&out2);
            evs.extend(evs2);
            assert_eq!(out, bytes, "cut at {cut}");
            assert_eq!(evs, [Event { event: Some("content_block_delta".into()), data: data.clone() }], "cut at {cut}");
        }
    }

    /// 同样地，多条 data 行累计到接近（但不超过）事件上限时也要原样转发，覆盖任意切块位置。
    #[test]
    fn legitimate_multi_line_event_near_the_event_limit_is_forwarded_unchanged() {
        let chunk_len = 64 * 1024;
        let line = format!("data: {}\n", "x".repeat(chunk_len - 7));
        let mut text = line.repeat(MAX_EVENT_BYTES / chunk_len - 2);
        text.push('\n');
        let bytes = text.as_bytes();
        for cut in [1, bytes.len() / 3, bytes.len() / 2, bytes.len() - 1] {
            let (a, b) = bytes.split_at(cut);
            let mut s = Splitter::default();
            let (out1, mut evs) = s.push(a).unwrap();
            let (out2, evs2) = s.push(b).unwrap();
            let mut out = out1.to_vec();
            out.extend_from_slice(&out2);
            evs.extend(evs2);
            assert_eq!(out, bytes, "cut at {cut}");
            assert_eq!(evs.len(), 1, "cut at {cut}");
        }
    }

    #[test]
    fn multibyte_utf8_split() {
        let text = "data: 你好\n\n".as_bytes();
        let (out, evs) = collect(&[&text[..7], &text[7..]]);
        assert_eq!(out, text);
        assert_eq!(evs[0].data, "你好");
    }
}
