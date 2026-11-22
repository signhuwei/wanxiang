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
/// `route_pool.v1` 信封的 HKDF info（contracts/routing-pricing-and-staging.md）。
const ROUTE_INFO: &[u8] = b"onex-edge-route-secret-v1";

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
        self.open_with(INFO, provider_id.as_bytes(), key_id, nonce, ciphertext)
    }

    /// 解开 `route_pool.secrets[]` 的一个信封。`aad` 由 [`route_secret_aad`] 生成。
    pub fn open_route(
        &self,
        aad: &[u8],
        key_id: &str,
        nonce: &str,
        ciphertext: &str,
    ) -> Result<Zeroizing<String>, OpenError> {
        self.open_with(ROUTE_INFO, aad, key_id, nonce, ciphertext)
    }

    fn open_with(
        &self,
        info: &[u8],
        aad: &[u8],
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
        let key = derive(shared.as_bytes(), info);
        let cipher = XChaCha20Poly1305::new(key.as_ref().into());
        let plain =
            cipher.decrypt(XNonce::from_slice(&nonce), Payload { msg: &ct, aad }).map_err(|_| OpenError::Rejected)?;
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

fn derive(shared: &[u8; 32], info: &[u8]) -> Zeroizing<[u8; 32]> {
    let mut key = Zeroizing::new([0u8; 32]);
    Hkdf::<Sha256>::new(None, shared).expand(info, key.as_mut()).expect("32 bytes is a valid HKDF length");
    key
}

/// 路由信封 AAD：无空格的 UTF-8 JSON 数组
/// `["onex-edge-route-secret-v1",tenant_id,device_id,projection_id,revision,credential_id,credential_version]`。
/// ID 由调用方先按 ASCII 字母、数字、`_-.` 校验，因此紧凑 JSON 编码在各语言一致。
pub fn route_secret_aad(
    tenant_id: &str,
    device_id: &str,
    projection_id: &str,
    revision: u64,
    credential_id: &str,
    credential_version: u64,
) -> Vec<u8> {
    serde_json::to_vec(&serde_json::json!([
        "onex-edge-route-secret-v1",
        tenant_id,
        device_id,
        projection_id,
        revision,
        credential_id,
        credential_version
    ]))
    .expect("json array of strings and integers")
}

/// 只供测试：按 Server 的封装规则生成路由信封，返回 `(key_id, nonce, ciphertext)`。
#[cfg(test)]
pub(crate) fn seal_route_for_test(
    device_public: &[u8; 32],
    sender_secret: [u8; 32],
    nonce: [u8; 24],
    aad: &[u8],
    plaintext: &str,
) -> (String, String, String) {
    let sender = StaticSecret::from(sender_secret);
    let shared = sender.diffie_hellman(&PublicKey::from(*device_public));
    let key = derive(shared.as_bytes(), ROUTE_INFO);
    let ct = XChaCha20Poly1305::new(key.as_ref().into())
        .encrypt(XNonce::from_slice(&nonce), Payload { msg: plaintext.as_bytes(), aad })
        .expect("encrypt");
    (B64.encode(PublicKey::from(&sender).as_bytes()), B64.encode(nonce), B64.encode(ct))
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

    // contracts/routing-pricing-and-staging.md 的跨语言合成向量。
    const ROUTE_KEY_ID: &str = "MdSras7slhE3kXA3k25gcW+sVzr+lNnahKgCBEjfwRI=";
    const ROUTE_NONCE: &str = "AAECAwQFBgcICQoLDA0ODxAREhMUFRYX";
    const ROUTE_CT: &str = "fp1Fke4jFdKim93jA03oMTHhmAJmfFP4SJR5swErN1Rsv1DzXg==";

    fn vector_aad() -> Vec<u8> {
        route_secret_aad("ten_demo", "dev_lin", "prj_91", 91, "cred_a", 1)
    }

    fn vector_nonce() -> [u8; 24] {
        std::array::from_fn(|i| i as u8)
    }

    #[test]
    fn route_aad_is_compact_json() {
        assert_eq!(
            String::from_utf8(vector_aad()).unwrap(),
            r#"["onex-edge-route-secret-v1","ten_demo","dev_lin","prj_91",91,"cred_a",1]"#
        );
    }

    #[test]
    fn opens_route_vector() {
        let k = DeviceKey::from_bytes([7; 32]);
        let plain = k.open_route(&vector_aad(), ROUTE_KEY_ID, ROUTE_NONCE, ROUTE_CT).unwrap();
        assert_eq!(plain.as_str(), "fixture-inference-key");
    }

    #[test]
    fn seals_route_vector_byte_for_byte() {
        let public = PublicKey::from(&StaticSecret::from([7u8; 32])).to_bytes();
        let sealed = seal_route_for_test(&public, [8; 32], vector_nonce(), &vector_aad(), "fixture-inference-key");
        assert_eq!(sealed, (ROUTE_KEY_ID.into(), ROUTE_NONCE.into(), ROUTE_CT.into()));
    }

    #[test]
    fn route_envelope_is_bound_to_identity_and_info() {
        let k = DeviceKey::from_bytes([7; 32]);
        let open = |aad: Vec<u8>| k.open_route(&aad, ROUTE_KEY_ID, ROUTE_NONCE, ROUTE_CT).map(|_| ());
        for aad in [
            route_secret_aad("ten_other", "dev_lin", "prj_91", 91, "cred_a", 1),
            route_secret_aad("ten_demo", "dev_other", "prj_91", 91, "cred_a", 1),
            route_secret_aad("ten_demo", "dev_lin", "prj_92", 91, "cred_a", 1),
            route_secret_aad("ten_demo", "dev_lin", "prj_91", 92, "cred_a", 1),
            route_secret_aad("ten_demo", "dev_lin", "prj_91", 91, "cred_b", 1),
            route_secret_aad("ten_demo", "dev_lin", "prj_91", 91, "cred_a", 2),
        ] {
            assert_eq!(open(aad), Err(OpenError::Rejected));
        }
        // 另一台设备的私钥打不开。
        assert_eq!(
            DeviceKey::from_bytes([9; 32]).open_route(&vector_aad(), ROUTE_KEY_ID, ROUTE_NONCE, ROUTE_CT).unwrap_err(),
            OpenError::Rejected
        );
        // 旧版 info 与新版信封互不通用。
        assert_eq!(k.open("prv_vec", ROUTE_KEY_ID, ROUTE_NONCE, ROUTE_CT).unwrap_err(), OpenError::Rejected);
        assert_eq!(k.open_route(b"prv_vec", KEY_ID, NONCE, CT).unwrap_err(), OpenError::Rejected);
    }

    #[test]
    fn generated_keys_differ() {
        assert_ne!(DeviceKey::generate().public_b64(), DeviceKey::generate().public_b64());
    }
}
