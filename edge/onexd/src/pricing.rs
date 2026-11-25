//! 计价：单价是毫橡皮每百万 token，整数运算，整笔向上取整。

use onex_core::ws::Rate;
use time::OffsetDateTime;
use time::format_description::well_known::Rfc3339;

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct Tokens {
    pub input: u64,
    pub output: u64,
    pub cache_read: u64,
    pub cache_write: u64,
}

const MTOK: u128 = 1_000_000;

/// 四类 token 分别乘单价后求和，再整体除以一百万并向上取整。
/// 先求和再取整，避免每类各进一位导致多收。
pub fn cost_milli(rate: &Rate, t: &Tokens) -> i64 {
    let mul = |n: u64, p: u64| n as u128 * p as u128;
    let micro = mul(t.input, rate.input_milli_per_mtok)
        .saturating_add(mul(t.output, rate.output_milli_per_mtok))
        .saturating_add(mul(t.cache_read, rate.cache_read_milli_per_mtok))
        .saturating_add(mul(t.cache_write, rate.cache_write_milli_per_mtok));
    micro.div_ceil(MTOK).min(i64::MAX as u128) as i64
}

/// 选 `model_id` 的单价：`effective_from` 不晚于 `now_ms` 的条目里取最新的一条；没写生效时间的视为一直有效。
pub fn pick_rate<'a>(rates: &'a [Rate], model_id: &str, now_ms: i64) -> Option<&'a Rate> {
    rates
        .iter()
        .filter(|r| r.model_id == model_id)
        .filter_map(|r| match &r.effective_from {
            None => Some((i64::MIN, r)),
            Some(s) => parse_ms(s).filter(|&from| from <= now_ms).map(|from| (from, r)),
        })
        .max_by_key(|(from, _)| *from)
        .map(|(_, r)| r)
}

/// 流式输出的 token 估算：只在上游还没报用量时用来实时判断是否超额。
/// 按每 3 字节 1 个 token 算，英文和中文都偏多，宁可早断不能少算。
pub fn estimate_tokens(bytes: usize) -> u64 {
    bytes.div_ceil(3) as u64
}

pub fn parse_ms(s: &str) -> Option<i64> {
    OffsetDateTime::parse(s, &Rfc3339).ok().map(|t| (t.unix_timestamp_nanos() / 1_000_000) as i64)
}

pub fn format_ms(ms: i64) -> String {
    OffsetDateTime::from_unix_timestamp_nanos(ms as i128 * 1_000_000)
        .ok()
        .and_then(|t| t.format(&Rfc3339).ok())
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rate(id: &str, from: Option<&str>, input: u64) -> Rate {
        Rate {
            model_id: id.into(),
            input_milli_per_mtok: input,
            output_milli_per_mtok: 15_000,
            cache_read_milli_per_mtok: 300,
            cache_write_milli_per_mtok: 3_750,
            effective_from: from.map(String::from),
        }
    }

    #[test]
    fn cost_sums_categories_then_rounds_up() {
        let r = rate("m", None, 3_000);
        let t = Tokens { input: 1_000_000, output: 1_000_000, cache_read: 1_000_000, cache_write: 1_000_000 };
        assert_eq!(cost_milli(&r, &t), 3_000 + 15_000 + 300 + 3_750);
        // 1 token 输入 = 0.003 毫橡皮，向上取整为 1
        assert_eq!(cost_milli(&r, &Tokens { input: 1, ..Default::default() }), 1);
        assert_eq!(cost_milli(&r, &Tokens::default()), 0);
        // 333_334 × 3_000 = 1_000_002_000 → 1000.002 → 1001
        assert_eq!(cost_milli(&r, &Tokens { input: 333_334, ..Default::default() }), 1_001);
        // 两类各自不足 1，合起来也只进一位
        let t = Tokens { input: 100, cache_read: 1000, ..Default::default() };
        assert_eq!(cost_milli(&r, &t), 1);
    }

    #[test]
    fn cost_does_not_overflow() {
        let r = Rate { output_milli_per_mtok: u64::MAX, ..rate("m", None, u64::MAX) };
        let t = Tokens { input: u64::MAX, output: u64::MAX, ..Default::default() };
        assert_eq!(cost_milli(&r, &t), i64::MAX);
    }

    #[test]
    fn picks_latest_effective_rate() {
        let rs = [
            rate("a", Some("2026-01-01T00:00:00Z"), 1),
            rate("a", Some("2026-11-01T00:00:00Z"), 2),
            rate("a", Some("2027-01-01T00:00:00Z"), 3),
            rate("b", None, 9),
        ];
        let now = parse_ms("2026-11-19T08:00:00Z").unwrap();
        assert_eq!(pick_rate(&rs, "a", now).unwrap().input_milli_per_mtok, 2);
        assert_eq!(pick_rate(&rs, "b", now).unwrap().input_milli_per_mtok, 9);
        assert!(pick_rate(&rs, "c", now).is_none());
        assert!(pick_rate(&rs[1..3], "a", parse_ms("2026-10-01T00:00:00Z").unwrap()).is_none());
    }

    #[test]
    fn time_roundtrip() {
        let ms = parse_ms("2026-11-19T08:00:00.250Z").unwrap();
        assert_eq!(parse_ms(&format_ms(ms)), Some(ms));
        assert_eq!(estimate_tokens(0), 0);
        assert_eq!(estimate_tokens(7), 3);
    }
}
