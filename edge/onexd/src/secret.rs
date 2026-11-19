//! 上游密钥下发的解密（契约 edge-ws.md “密钥下发” v0.7）。
//!
//! 设备持有一把 X25519 私钥，注册时把公钥交给 Server。每条 `secret` 由 Server 用临时密钥对加密：
//! `key_id` 是临时公钥；共享密钥经 HKDF-SHA256（无 salt，info `onex-edge-secret-v1`）派生 32 字节；
//! XChaCha20-Poly1305，24 字节 nonce，AAD 为 `provider_id`，密文后接 16 字节 tag。二进制字段都是标准 base64。
//!
//! 私钥由 daemon 持有，macOS 上仅通过 Keychain 持久化，不经 IPC 传输。

use base64::Engine;
use base64::engine::general_purpose::STANDARD as B64;
use chacha20poly1305::aead::{Aead, KeyInit, Payload};
use chacha20poly1305::{XChaCha20Poly1305, XNonce};
use hkdf::Hkdf;
use sha2::Sha256;
use x25519_dalek::{PublicKey, StaticSecret};
use zeroize::{Zeroize, Zeroizing};

const INFO: &[u8] = b"onex-edge-secret-v1";

pub struct DeviceKey {
    secret: StaticSecret,
}

#[derive(Debug, PartialEq, Eq)]
pub enum OpenError {
    /// 字段不是标准 base64 或长度不对
    Malformed(&'static str),
    /// 认证失败：不是发给这把私钥的、provider_id 不符或被改过
    Rejected,
    /// 明文不是 UTF-8
    NotText,
}

impl DeviceKey {
    pub fn generate() -> Self {
        Self { secret: StaticSecret::random_from_rng(rand_core::OsRng) }
    }

    pub fn from_bytes(b: [u8; 32]) -> Self {
        Self { secret: StaticSecret::from(b) }
    }

    pub(crate) fn bytes_for_keychain(&self) -> [u8; 32] {
        self.secret.to_bytes()
    }

    /// 注册设备时提交的公钥（标准 base64）
    pub fn public_b64(&self) -> String {
        B64.encode(PublicKey::from(&self.secret).as_bytes())
    }

    /// 解开一条 `secret`，返回上游密钥明文。
    pub fn open(
        &self,
        provider_id: &str,
        key_id: &str,
        nonce: &str,
        ciphertext: &str,
    ) -> Result<Zeroizing<String>, OpenError> {
        let eph: [u8; 32] = decode(key_id, "key_id")?.try_into().map_err(|_| OpenError::Malformed("key_id"))?;
        let nonce: [u8; 24] = decode(nonce, "nonce")?.try_into().map_err(|_| OpenError::Malformed("nonce"))?;
        let ct = decode(ciphertext, "ciphertext")?;
        let shared = self.secret.diffie_hellman(&PublicKey::from(eph));
        // 临时公钥是低阶点时共享密钥全零，拒绝
        if !shared.was_contributory() {
            return Err(OpenError::Rejected);
        }
        let mut key = Zeroizing::new([0u8; 32]);
        Hkdf::<Sha256>::new(None, shared.as_bytes())
            .expand(INFO, key.as_mut())
            .expect("32 bytes is a valid HKDF length");
        let cipher = XChaCha20Poly1305::new(key.as_ref().into());
        let plain = cipher
            .decrypt(XNonce::from_slice(&nonce), Payload { msg: &ct, aad: provider_id.as_bytes() })
            .map_err(|_| OpenError::Rejected)?;
        match String::from_utf8(plain) {
            Ok(s) => Ok(Zeroizing::new(s)),
            Err(e) => {
                e.into_bytes().zeroize();
                Err(OpenError::NotText)
            }
        }
    }
}

fn decode(s: &str, field: &'static str) -> Result<Vec<u8>, OpenError> {
    B64.decode(s).map_err(|_| OpenError::Malformed(field))
}

#[cfg(test)]
mod tests {
    use super::*;

    // 由 server/src/edge-config.ts 的 encryptEdgeSecret 生成：设备私钥 32 字节 0x07，provider_id "prv_vec"
    const PK: &str = "E75P6uryBMf9M1j8nAByGIHRdCeBKCJ+xnTzf3/pe20=";
    const KEY_ID: &str = "VkN2Q/5fH877N3EDMw/33AcYpOvkWpFio2xQ1opmJV8=";
    const NONCE: &str = "sS0sgzB6hbPkc4mZRdXXUcKONuuB5RXA";
    const CT: &str = "8e15HC9vYxKVogfXfecEn6IIrO9X9D7xl2bfW/iVUGDBig==";

    #[test]
    fn opens_server_vector() {
        let k = DeviceKey::from_bytes([7; 32]);
        assert_eq!(k.public_b64(), PK);
        assert_eq!(k.open("prv_vec", KEY_ID, NONCE, CT).unwrap().as_str(), "sk-test-vector-123");
    }

    #[test]
    fn rejects_wrong_provider_key_or_tampering() {
        let k = DeviceKey::from_bytes([7; 32]);
        // AAD 绑定 provider_id：拿 A 的密文冒充 B 不行
        assert_eq!(k.open("prv_other", KEY_ID, NONCE, CT).unwrap_err(), OpenError::Rejected);
        assert_eq!(DeviceKey::from_bytes([8; 32]).open("prv_vec", KEY_ID, NONCE, CT).unwrap_err(), OpenError::Rejected);
        let mut ct = B64.decode(CT).unwrap();
        ct[0] ^= 1;
        assert_eq!(k.open("prv_vec", KEY_ID, NONCE, &B64.encode(ct)).unwrap_err(), OpenError::Rejected);
        assert_eq!(k.open("prv_vec", KEY_ID, "AAAA", CT).unwrap_err(), OpenError::Malformed("nonce"));
        assert_eq!(k.open("prv_vec", "not base64!", NONCE, CT).unwrap_err(), OpenError::Malformed("key_id"));
        // 低阶点（全零公钥）
        assert_eq!(k.open("prv_vec", &B64.encode([0u8; 32]), NONCE, CT).unwrap_err(), OpenError::Rejected);
    }

    #[test]
    fn generated_keys_differ() {
        assert_ne!(DeviceKey::generate().public_b64(), DeviceKey::generate().public_b64());
    }
}
