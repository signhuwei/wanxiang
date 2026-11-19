//! 带前缀的 ULID，例如 `req_01JD...`。

use std::time::{SystemTime, UNIX_EPOCH};

const CROCKFORD: &[u8; 32] = b"0123456789ABCDEFGHJKMNPQRSTVWXYZ";

pub fn new(prefix: &str) -> String {
    let ms = SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_millis();
    let n = (ms & ((1 << 48) - 1)) << 80 | (rand::random::<u128>() & ((1 << 80) - 1));
    let mut out = String::with_capacity(prefix.len() + 27);
    out.push_str(prefix);
    out.push('_');
    for i in (0..26).rev() {
        out.push(CROCKFORD[((n >> (i * 5)) & 31) as usize] as char);
    }
    out
}

/// 64 个十六进制字符的随机令牌。
pub fn token() -> String {
    let b: [u8; 32] = rand::random();
    b.iter().map(|x| format!("{x:02x}")).collect()
}

#[cfg(test)]
mod tests {
    #[test]
    fn shape() {
        let a = super::new("req");
        assert_eq!(a.len(), 30);
        assert!(a.starts_with("req_"));
        assert_ne!(a, super::new("req"));
        assert_eq!(super::token().len(), 64);
    }
}
