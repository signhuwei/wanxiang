//! 设备凭据持久化：daemon 重启后沿用同一个已登录设备身份，不需要重新 `onex login`。
//!
//! 保存 device_id、device_token、注册时用的 Server 地址，和设备的 X25519 私钥（原始 32 字节）。
//! 四者必须一起恢复：Server 记的公钥是私钥派生的，只换 token 不换私钥就解不开下发的 `secret`；
//! 只换私钥不换 token 则设备身份和 Server 记录的不是同一个。
//!
//! 真正的存储是 macOS Keychain（`security-framework`，generic password，service 按 `ONEX_HOME` 区分，
//! 一台机器装多份 onexd 互不干扰）。单元测试一律用内存实现，不碰真实 Keychain；
//! Keychain 后端本身只有一个被 `ONEX_TEST_KEYCHAIN=1` 显式打开的烟雾测试（见模块末尾）。

#[cfg(target_os = "macos")]
use anyhow::Context;
use anyhow::Result;
use serde::{Deserialize, Serialize};
#[cfg(target_os = "macos")]
use zeroize::Zeroizing;

/// 完整的已登录设备身份。`device_key` 是 X25519 私钥的原始字节，等价于 `secret::DeviceKey::from_bytes`。
/// `Debug` 手写并打码：`device_token`、`device_key` 是秘密，不能让意外的 `{:?}` 把它们打到日志里。
#[derive(Clone, PartialEq, Serialize, Deserialize)]
pub struct DeviceCredentials {
    pub server: String,
    pub device_id: String,
    pub device_token: String,
    pub device_key: [u8; 32],
}

impl std::fmt::Debug for DeviceCredentials {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("DeviceCredentials")
            .field("server", &self.server)
            .field("device_id", &self.device_id)
            .field("device_token", &"<redacted>")
            .field("device_key", &"<redacted>")
            .finish()
    }
}

/// 凭据存取的后端。`service` 用来在同一台机器区分多个 `ONEX_HOME`（例如并行跑的测试或多开发环境）。
pub trait CredentialStore: Send + Sync {
    fn load(&self) -> Result<Option<DeviceCredentials>>;
    fn save(&self, creds: &DeviceCredentials) -> Result<()>;
    fn clear(&self) -> Result<()>;
}

/// 按 `ONEX_HOME` 路径派生一个稳定、互不冲突的 Keychain service 名。
pub fn service_name(home: &std::path::Path) -> String {
    format!("OneX Edge Device Credentials: {}", home.display())
}

/// 设备公钥的 SHA-256，取前 16 字节的十六进制。用作 outbox/lease 的子目录名：
/// 换了设备身份（新登录、不同 Keychain 记录）就是新目录，旧身份的 outbox 和租约状态原样留在旧目录，
/// 不会被新身份的 hello/续租误用，也不自动合并或导入。
pub fn fingerprint(public_key_b64: &str) -> String {
    use sha2::{Digest, Sha256};
    let mut hasher = Sha256::new();
    hasher.update(public_key_b64.as_bytes());
    let digest = hasher.finalize();
    digest[..16].iter().map(|b| format!("{b:02x}")).collect()
}

#[cfg(target_os = "macos")]
pub struct KeychainStore {
    service: String,
    account: String,
}

#[cfg(target_os = "macos")]
impl KeychainStore {
    pub fn new(service: String) -> Self {
        Self { service, account: "device".into() }
    }
}

#[cfg(target_os = "macos")]
impl CredentialStore for KeychainStore {
    fn load(&self) -> Result<Option<DeviceCredentials>> {
        use security_framework_sys::base::errSecItemNotFound;
        match security_framework::passwords::get_generic_password(&self.service, &self.account) {
            Ok(bytes) => {
                let bytes = Zeroizing::new(bytes);
                let c: DeviceCredentials =
                    serde_json::from_slice(&bytes).context("stored device credentials are not valid JSON")?;
                Ok(Some(c))
            }
            Err(e) if e.code() == errSecItemNotFound => Ok(None),
            Err(e) => Err(sec_err(e)),
        }
    }

    fn save(&self, creds: &DeviceCredentials) -> Result<()> {
        let bytes = Zeroizing::new(serde_json::to_vec(creds).context("serialize device credentials")?);
        security_framework::passwords::set_generic_password(&self.service, &self.account, &bytes)
            .map_err(sec_err)
            .context("write device credentials to Keychain")
    }

    fn clear(&self) -> Result<()> {
        use security_framework_sys::base::errSecItemNotFound;
        match security_framework::passwords::delete_generic_password(&self.service, &self.account) {
            Ok(()) => Ok(()),
            Err(e) if e.code() == errSecItemNotFound => Ok(()),
            Err(e) => Err(sec_err(e)),
        }
    }
}

#[cfg(target_os = "macos")]
fn sec_err(e: security_framework::base::Error) -> anyhow::Error {
    anyhow::anyhow!("macOS Keychain error {}: {}", e.code(), e)
}

/// Windows：系统凭据存储用 Windows 凭据管理器（Credential Manager）的 generic credential，
/// `CRED_PERSIST_LOCAL_MACHINE` 在本机跨登录保留，凭据仍属于当前 Windows 用户。
/// target name 复用 `service_name()`，和 macOS Keychain 的 service 字符串按 `ONEX_HOME` 区分
/// 是同一个目的。凭据 blob 存的是 `DeviceCredentials` 的 JSON 序列化字节，和 macOS 分支一致。
#[cfg(windows)]
pub struct KeychainStore {
    target: String,
}

#[cfg(windows)]
impl KeychainStore {
    pub fn new(service: String) -> Self {
        Self { target: service }
    }
}

#[cfg(windows)]
impl CredentialStore for KeychainStore {
    fn load(&self) -> Result<Option<DeviceCredentials>> {
        windows_credentials::load(&self.target)
    }
    fn save(&self, creds: &DeviceCredentials) -> Result<()> {
        windows_credentials::save(&self.target, creds)
    }
    fn clear(&self) -> Result<()> {
        windows_credentials::clear(&self.target)
    }
}

/// 非 macOS、非 Windows：没有等价的系统凭据存储，身份只在内存里（和此前所有平台的行为一致）。
#[cfg(not(any(target_os = "macos", windows)))]
pub struct KeychainStore;

#[cfg(not(any(target_os = "macos", windows)))]
impl KeychainStore {
    pub fn new(_service: String) -> Self {
        Self
    }
}

#[cfg(not(any(target_os = "macos", windows)))]
impl CredentialStore for KeychainStore {
    fn load(&self) -> Result<Option<DeviceCredentials>> {
        Ok(None)
    }
    fn save(&self, _creds: &DeviceCredentials) -> Result<()> {
        Ok(())
    }
    fn clear(&self) -> Result<()> {
        Ok(())
    }
}

#[cfg(windows)]
mod windows_credentials {
    //! `CredWriteW`/`CredReadW`/`CredDeleteW` 的窄封装，只处理 `CRED_TYPE_GENERIC`。
    //! 所有宽字符串转换和裸指针操作集中在这里，调用方（`KeychainStore`）只打交道
    //! `DeviceCredentials` 和 `anyhow::Result`。

    use super::DeviceCredentials;
    use anyhow::{Context, Result, bail};
    use std::ffi::OsStr;
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Foundation::{ERROR_NOT_FOUND, GetLastError};
    use windows_sys::Win32::Security::Credentials::{
        CRED_PERSIST_LOCAL_MACHINE, CRED_TYPE_GENERIC, CREDENTIALW, CredDeleteW, CredFree, CredReadW, CredWriteW,
    };
    use zeroize::Zeroizing;

    fn wide(s: &str) -> Vec<u16> {
        OsStr::new(s).encode_wide().chain(Some(0)).collect()
    }

    pub(super) fn load(target: &str) -> Result<Option<DeviceCredentials>> {
        let target_w = wide(target);
        let mut p_cred: *mut CREDENTIALW = std::ptr::null_mut();
        // SAFETY: `target_w` 是有效的、以 NUL 结尾的宽字符串；成功时系统分配好一份 `CREDENTIALW`
        // 并把指针写进 `p_cred`，用 `CredFree` 释放。失败且错误码是 ERROR_NOT_FOUND 时不是异常，
        // 是"从没存过"。
        let ok = unsafe { CredReadW(target_w.as_ptr(), CRED_TYPE_GENERIC, 0, &mut p_cred) };
        if ok == 0 {
            let err = unsafe { GetLastError() };
            if err == ERROR_NOT_FOUND {
                return Ok(None);
            }
            bail!("CredReadW failed with error {err}");
        }
        anyhow::ensure!(!p_cred.is_null(), "CredReadW returned no credential");
        let result = (|| -> Result<DeviceCredentials> {
            // SAFETY: Windows returned a non-null credential owned by CredFree.
            let cred = unsafe { &*p_cred };
            anyhow::ensure!(
                cred.CredentialBlobSize != 0 && !cred.CredentialBlob.is_null(),
                "stored device credentials have no data"
            );
            // SAFETY: the checked buffer is initialized and remains live until CredFree below.
            let bytes = unsafe {
                Zeroizing::new(
                    std::slice::from_raw_parts(cred.CredentialBlob, cred.CredentialBlobSize as usize).to_vec(),
                )
            };
            serde_json::from_slice(&bytes).context("stored device credentials are not valid JSON")
        })();
        unsafe { CredFree(p_cred as *const _) };
        result.map(Some)
    }

    pub(super) fn save(target: &str, creds: &DeviceCredentials) -> Result<()> {
        let target_w = wide(target);
        let mut comment_w = wide("OneX Edge device identity");
        let mut blob = Zeroizing::new(serde_json::to_vec(creds).context("serialize device credentials")?);
        // `CRED_PERSIST_LOCAL_MACHINE`：persists across logons for this Windows user account only
        // (Windows partitions Credential Manager storage per user; this is not machine-wide).
        // `CRED_PERSIST_SESSION` would be lost on every daemon restart, which defeats the point.
        let cred = CREDENTIALW {
            Flags: 0,
            Type: CRED_TYPE_GENERIC,
            TargetName: target_w.as_ptr() as *mut u16,
            Comment: comment_w.as_mut_ptr(),
            LastWritten: unsafe { std::mem::zeroed() },
            CredentialBlobSize: blob.len() as u32,
            CredentialBlob: blob.as_mut_ptr(),
            Persist: CRED_PERSIST_LOCAL_MACHINE,
            AttributeCount: 0,
            Attributes: std::ptr::null_mut(),
            TargetAlias: std::ptr::null_mut(),
            UserName: std::ptr::null_mut(),
        };
        // SAFETY: 所有指针字段指向本函数栈上活到调用结束的缓冲区（`target_w`、`comment_w`、`blob`）。
        let ok = unsafe { CredWriteW(&cred, 0) };
        if ok == 0 {
            let err = unsafe { GetLastError() };
            bail!("CredWriteW failed with error {err}");
        }
        Ok(())
    }

    pub(super) fn clear(target: &str) -> Result<()> {
        let target_w = wide(target);
        // SAFETY: `target_w` 是有效的、以 NUL 结尾的宽字符串。
        let ok = unsafe { CredDeleteW(target_w.as_ptr(), CRED_TYPE_GENERIC, 0) };
        if ok == 0 {
            let err = unsafe { GetLastError() };
            if err == ERROR_NOT_FOUND {
                return Ok(());
            }
            bail!("CredDeleteW failed with error {err}");
        }
        Ok(())
    }
}

#[cfg(test)]
pub struct MemoryStore(std::sync::Mutex<Option<DeviceCredentials>>);

#[cfg(test)]
impl MemoryStore {
    pub fn new() -> Self {
        Self(std::sync::Mutex::new(None))
    }
}

#[cfg(test)]
impl CredentialStore for MemoryStore {
    fn load(&self) -> Result<Option<DeviceCredentials>> {
        Ok(self.0.lock().unwrap().clone())
    }
    fn save(&self, creds: &DeviceCredentials) -> Result<()> {
        *self.0.lock().unwrap() = Some(creds.clone());
        Ok(())
    }
    fn clear(&self) -> Result<()> {
        *self.0.lock().unwrap() = None;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn creds(server: &str) -> DeviceCredentials {
        DeviceCredentials {
            server: server.into(),
            device_id: "dev_1".into(),
            device_token: "s3cr3t-token-value".into(),
            device_key: [7; 32],
        }
    }

    #[test]
    fn memory_store_roundtrips_and_clears() {
        let s = MemoryStore::new();
        assert_eq!(s.load().unwrap(), None);
        s.save(&creds("http://x")).unwrap();
        assert_eq!(s.load().unwrap(), Some(creds("http://x")));
        s.save(&creds("http://y")).unwrap();
        assert_eq!(s.load().unwrap().unwrap().server, "http://y");
        s.clear().unwrap();
        assert_eq!(s.load().unwrap(), None);
        // 清空已清空的不是错误
        s.clear().unwrap();
    }

    #[test]
    fn service_name_is_stable_and_scoped_to_home() {
        let a = service_name(std::path::Path::new("/Users/a/Library/Application Support/OneX"));
        let b = service_name(std::path::Path::new("/Users/a/Library/Application Support/OneX-MVP"));
        assert_ne!(a, b);
        assert_eq!(a, service_name(std::path::Path::new("/Users/a/Library/Application Support/OneX")));
    }

    #[test]
    fn fingerprint_is_stable_and_distinguishes_keys() {
        assert_eq!(fingerprint("abc"), fingerprint("abc"));
        assert_ne!(fingerprint("abc"), fingerprint("xyz"));
        assert_eq!(fingerprint("abc").len(), 32); // 16 字节的十六进制
    }

    #[test]
    fn debug_redacts_secrets() {
        let dbg = format!("{:?}", creds("http://x"));
        assert!(dbg.contains("redacted"));
        assert!(!dbg.contains("s3cr3t-token-value"));
    }

    /// 真实系统凭据存储的烟雾测试（macOS Keychain 或 Windows 凭据管理器）：会实际写入/删除
    /// 本机登录账户下的一个条目。默认跳过；本机人工验收时设置 `ONEX_TEST_KEYCHAIN=1` 单独运行。
    #[test]
    #[cfg_attr(not(any(target_os = "macos", windows)), ignore)]
    fn keychain_roundtrips_on_native_store() {
        if std::env::var("ONEX_TEST_KEYCHAIN").is_err() {
            eprintln!("skipping: set ONEX_TEST_KEYCHAIN=1 to exercise the real system credential store");
            return;
        }
        #[cfg(any(target_os = "macos", windows))]
        {
            let svc = format!("OneX Edge Device Credentials: test-{}", id_for_test());
            let store = KeychainStore::new(svc);
            store.clear().unwrap();
            assert_eq!(store.load().unwrap(), None);
            let c = creds("https://test.example");
            store.save(&c).unwrap();
            assert_eq!(store.load().unwrap(), Some(c.clone()));
            let c2 = creds("https://other.example");
            store.save(&c2).unwrap();
            assert_eq!(store.load().unwrap(), Some(c2));
            store.clear().unwrap();
            assert_eq!(store.load().unwrap(), None);
        }
    }

    #[cfg(any(target_os = "macos", windows))]
    fn id_for_test() -> u128 {
        let mut b = [0u8; 16];
        b.copy_from_slice(&rand::random::<[u8; 16]>());
        u128::from_le_bytes(b)
    }
}
