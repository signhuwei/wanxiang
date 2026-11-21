//! 受管 Agent 制品：从 Server 下发的发行目录（`config.agents`）里选版本、下载、校验、原子缓存。
//! 见 `docs/specs/agents/claude-code.md` §1。
//!
//! 只信 Server 下发的 `AgentRelease{agent, os, arch, version, url, sha256, size}`：
//! onex-cli 不传版本、URL 或摘要，onexd 自己选型并在每次启动前复核，包括复用缓存的制品。
//! 缓存命中也要重新算一次完整 SHA-256，不是只信文件名或大小——文件可能在磁盘上被篡改或截断。

use std::io::Write;
use std::path::{Path, PathBuf};

use anyhow::{Context, Result, bail};
use futures_util::StreamExt;
use onex_core::ipc::ArtifactProgress;
use onex_core::ws::AgentRelease;
use sha2::{Digest, Sha256};

use crate::desktop_bundle::{Bundle, RuntimeBundle};
use crate::id;

/// `contracts/edge-ws.md` 多 Agent 一节定下的三个名字。Server 下发的目录里混进别的 agent
/// （配置错误或将来扩展）不能被当作可执行的候选，否则校验通过也不该拿来启动——这里连选型
/// 都不让它进来。制品的下载、校验、缓存逻辑本身不分 Agent（已经按 `agent` 参数化），只有
/// 启动准备（`launch.rs::prepare`）和采集（`capture.rs`）按 Agent 分派。
const SUPPORTED_AGENTS: &[&str] = &["claude-code", "codex", "kimi-code"];

#[derive(Debug, Clone, PartialEq)]
pub enum ResolveError {
    /// 发行目录里没有匹配 agent/os/arch 的条目（可能合约没开通，或 Server 还没下发配置）
    NoRelease,
    /// Server 下发的发行记录本身不合法（sha256 不是 64 位十六进制、size 为 0、agent 不受支持、
    /// 或 URL 不是 HTTPS）——这是配置或传输问题，不是正常的「还没开通」
    BadRelease(&'static str),
}

impl std::fmt::Display for ResolveError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::NoRelease => write!(f, "没有可用的受管发行版本"),
            Self::BadRelease(why) => write!(f, "发行记录不合法：{why}"),
        }
    }
}
impl std::error::Error for ResolveError {}

/// 发行目录里选一个精确匹配 agent/os/arch 的候选，取版本号最大的（按 `.` 分段的数值比较，
/// 非数值分段按字符串比较兜底）。Server 不应该让同一 agent/os/arch 同时有多个 `active`，
/// 这里选最大版本只是兜底，不是鼓励多版本并存。platform-matched 但记录本身不合法（见 `validate`）
/// 时报 `BadRelease` 而不是悄悄当成「没有匹配」，这是配置问题，值得和「还没开通」区分开。
pub fn select<'a>(
    releases: &'a [AgentRelease],
    agent: &str,
    os: &str,
    arch: &str,
) -> Result<&'a AgentRelease, ResolveError> {
    let matched: Vec<&AgentRelease> =
        releases.iter().filter(|r| r.agent == agent && r.os == os && r.arch == arch).collect();
    if matched.is_empty() {
        return Err(ResolveError::NoRelease);
    }
    for r in &matched {
        validate(r)?;
    }
    Ok(matched.into_iter().max_by(|a, b| compare_versions(&a.version, &b.version)).expect("matched is non-empty"))
}

/// Server 下发记录本身的合法性：不是「能不能下载成功」，是「这条记录像不像是正常的发行记录」。
/// 真正的内容完整性仍然只认重新算出来的 SHA-256（见 `verify`），这里只挡明显畸形的输入。
fn validate(r: &AgentRelease) -> Result<(), ResolveError> {
    let desktop = crate::desktop_bundle::Bundle::manages(&r.agent);
    if !SUPPORTED_AGENTS.contains(&r.agent.as_str())
        && !(desktop
            && cfg!(all(target_os = "macos", target_arch = "aarch64"))
            && crate::desktop_bundle::Bundle::for_release(r).is_some()
            && is_server_artifact(r))
    {
        return Err(ResolveError::BadRelease("unsupported agent"));
    }
    if r.sha256.len() != 64 || !r.sha256.bytes().all(|b| b.is_ascii_hexdigit()) {
        return Err(ResolveError::BadRelease("sha256 is not 64 hex characters"));
    }
    if r.size == 0 {
        return Err(ResolveError::BadRelease("size must be greater than zero"));
    }
    let max_mib = if desktop { 768 } else { 512 };
    if r.size > max_mib * 1024 * 1024 {
        return Err(ResolveError::BadRelease("size is outside the supported artifact limit"));
    }
    if !is_server_artifact(r) {
        let Ok(url) = reqwest::Url::parse(&r.url) else {
            return Err(ResolveError::BadRelease("url must be an HTTPS URL or its same-origin artifact path"));
        };
        if (url.scheme() != "https" && !loopback_http(&url)) || !url.username().is_empty() || url.password().is_some() {
            return Err(ResolveError::BadRelease("url must be https (loopback http only for local test fixtures)"));
        }
    }
    Ok(())
}

pub(crate) fn is_server_artifact(release: &AgentRelease) -> bool {
    !release.id.is_empty()
        && release.id.len() <= 128
        && release.id.bytes().all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-'))
        && release.url.strip_prefix("/v1/edge/agent-artifacts/") == Some(release.id.as_str())
}

#[derive(Clone, Copy)]
pub struct ArtifactAccess<'a> {
    pub origin: &'a str,
    pub device_token: &'a str,
}

fn loopback_http(url: &reqwest::Url) -> bool {
    url.scheme() == "http" && matches!(url.host_str(), Some("127.0.0.1" | "localhost" | "[::1]" | "::1"))
}

fn compare_versions(a: &str, b: &str) -> std::cmp::Ordering {
    let seg = |s: &str| -> Vec<Result<u64, String>> {
        s.split('.').map(|p| p.parse::<u64>().map_err(|_| p.to_string())).collect()
    };
    let (sa, sb) = (seg(a), seg(b));
    for i in 0..sa.len().max(sb.len()) {
        let ord = match (sa.get(i), sb.get(i)) {
            (Some(Ok(x)), Some(Ok(y))) => x.cmp(y),
            (Some(x), Some(y)) => format!("{x:?}").cmp(&format!("{y:?}")),
            (Some(_), None) => std::cmp::Ordering::Greater,
            (None, Some(_)) => std::cmp::Ordering::Less,
            (None, None) => std::cmp::Ordering::Equal,
        };
        if ord != std::cmp::Ordering::Equal {
            return ord;
        }
    }
    std::cmp::Ordering::Equal
}

/// `<home>/agents/<agent>/releases/<sha256>/<binary name>`。按摘要分目录，换版本不覆盖旧缓存，
/// 旧版本缓存留着也没关系（S1 不做清理）。
fn cache_path(home: &Path, agent: &str, release: &AgentRelease) -> PathBuf {
    let name = if crate::desktop_bundle::Bundle::manages(agent) {
        format!("{agent}.dmg")
    } else if release.os == "win32" {
        format!("{agent}.exe")
    } else {
        agent.to_string()
    };
    home.join("agents").join(agent).join("releases").join(&release.sha256).join(name)
}

/// 给 `onex status`/诊断用的只读检查：选中的版本是否已经缓存，不触发下载。只做便宜的检查
/// （文件存在、大小吻合），不是完整复核——制品可能有几百 MB，status 不该每次都重新算 SHA-256；
/// 真正要用它启动时 `resolve` 一定会再做一次完整的 `verify`。
pub fn cached(home: &Path, releases: &[AgentRelease], agent: &str, os: &str, arch: &str) -> Option<(String, bool)> {
    let release = select(releases, agent, os, arch).ok()?;
    Some((release.version.clone(), cache_ready(home, release)))
}

pub(crate) fn cache_ready(home: &Path, release: &AgentRelease) -> bool {
    let path = cache_path(home, &release.agent, release);
    let has_size = |path: &Path, size| path.symlink_metadata().is_ok_and(|meta| meta.is_file() && meta.len() == size);
    if !has_size(&path, release.size) {
        return false;
    }
    if !Bundle::manages(&release.agent) {
        return true;
    }
    Bundle::for_release(release).is_some_and(|bundle| {
        bundle.runtime.is_none_or(|engine| has_size(&claude_engine_path(&path, engine), engine.bytes))
    })
}

/// 解析出一个已校验好的可执行文件绝对路径：命中且复核通过就直接用，否则下载。命中缓存也会重新算一遍
/// 完整 SHA-256（`verify`），这里的开销只在启动这一刻付，不是每次 `onex status` 都付。
pub async fn resolve(
    home: &Path,
    http: &reqwest::Client,
    releases: &[AgentRelease],
    agent: &str,
    os: &str,
    arch: &str,
    access: Option<ArtifactAccess<'_>>,
) -> Result<PathBuf> {
    resolve_with_progress(home, http, releases, agent, os, arch, access, |_| {}).await
}

pub(crate) async fn resolve_with_progress(
    home: &Path,
    http: &reqwest::Client,
    releases: &[AgentRelease],
    agent: &str,
    os: &str,
    arch: &str,
    access: Option<ArtifactAccess<'_>>,
    progress: impl Fn(ArtifactProgress),
) -> Result<PathBuf> {
    let release = select(releases, agent, os, arch)?;
    let path = cache_path(home, agent, release);
    let engine = Bundle::for_release(release).and_then(|bundle| bundle.runtime);
    let total_bytes = release.size + engine.map_or(0, |e| e.bytes);
    if verify(&path, release.size, &release.sha256).is_err() {
        let request = artifact_request(http, release, access)?;
        download_and_verify(request, &path, release.size, &release.sha256, |downloaded_bytes, verifying| {
            progress(ArtifactProgress { downloaded_bytes, total_bytes, verifying })
        })
        .await?;
    }
    if let Some(engine) = engine {
        resolve_engine(&path, release, engine, access, |received, verifying| {
            progress(ArtifactProgress { downloaded_bytes: release.size + received, total_bytes, verifying })
        })
        .await?;
    }
    Ok(path)
}

fn claude_engine_path(bundle: &Path, engine: RuntimeBundle) -> PathBuf {
    let version = engine.version;
    bundle.with_file_name(format!("claude-code-{version}.tar.zst"))
}

pub(crate) async fn resolve_claude_engine(
    home: &Path,
    release: &AgentRelease,
    access: Option<ArtifactAccess<'_>>,
) -> Result<(PathBuf, RuntimeBundle)> {
    anyhow::ensure!(release.agent == "claude-desktop", "runtime must belong to Claude Desktop");
    validate(release)?;
    let engine = Bundle::for_release(release)
        .and_then(|bundle| bundle.runtime)
        .context("missing pinned Claude Desktop runtime")?;
    let path = resolve_engine(&cache_path(home, &release.agent, release), release, engine, access, |_, _| {}).await?;
    Ok((path, engine))
}

async fn resolve_engine(
    bundle: &Path,
    release: &AgentRelease,
    engine: RuntimeBundle,
    access: Option<ArtifactAccess<'_>>,
    notify: impl Fn(u64, bool),
) -> Result<PathBuf> {
    let path = claude_engine_path(bundle, engine);
    if verify(&path, engine.bytes, engine.digest).is_err() {
        let request = server_request(&format!("{}/runtime", release.url), access)?;
        download_and_verify(request, &path, engine.bytes, engine.digest, notify).await?;
    }
    Ok(path)
}

/// 重新计算整份文件的 SHA-256 和大小，和发行记录比对。
fn verify(path: &Path, bytes: u64, digest: &str) -> Result<()> {
    let meta = std::fs::symlink_metadata(path).with_context(|| format!("stat {}", path.display()))?;
    if !meta.is_file() || meta.len() != bytes {
        bail!("cached artifact size mismatch: want {bytes} got {}", meta.len());
    }
    let mut f = std::fs::File::open(path)?;
    let mut hasher = Sha256::new();
    std::io::copy(&mut f, &mut hasher)?;
    let got = hex(&hasher.finalize());
    if !got.eq_ignore_ascii_case(digest) {
        bail!("cached artifact sha256 mismatch: want {digest} got {got}");
    }
    Ok(())
}

fn artifact_request(
    http: &reqwest::Client,
    release: &AgentRelease,
    access: Option<ArtifactAccess<'_>>,
) -> Result<reqwest::RequestBuilder> {
    if is_server_artifact(release) {
        return server_request(&release.url, access);
    }
    let url = reqwest::Url::parse(&release.url).context("parse approved artifact URL")?;
    if loopback_http(&url) {
        Ok(reqwest::Client::builder()
            .no_proxy()
            .redirect(reqwest::redirect::Policy::none())
            .timeout(std::time::Duration::from_secs(30))
            .build()?
            .get(url))
    } else {
        Ok(http.get(url))
    }
}

fn server_request(path: &str, access: Option<ArtifactAccess<'_>>) -> Result<reqwest::RequestBuilder> {
    let access = access.context("device credentials are required for the server cache")?;
    let origin = crate::ipc::normalize_origin(access.origin).context("invalid OneX Server origin")?;
    let url = reqwest::Url::parse(&format!("{origin}{path}"))?;
    let mut builder = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .connect_timeout(std::time::Duration::from_secs(10))
        .timeout(std::time::Duration::from_secs(300));
    if url.scheme() == "http" {
        // Use the direct route for the configured HTTP control plane.
        builder = builder.no_proxy();
    }
    Ok(builder.build()?.get(url).bearer_auth(access.device_token))
}

/// 下载到同目录的临时文件，边下边算摘要；大小或摘要不符就删临时文件并报错，绝不把未经校验的文件
/// 暴露在最终路径上。校验通过后 `rename` 原子落地并加可执行权限。
async fn download_and_verify(
    request: reqwest::RequestBuilder,
    dest: &Path,
    bytes: u64,
    digest: &str,
    notify: impl Fn(u64, bool),
) -> Result<()> {
    notify(0, false);
    let dir = dest.parent().context("artifact cache path has no parent")?;
    std::fs::create_dir_all(dir).with_context(|| format!("create {}", dir.display()))?;
    let resp = request.send().await.map_err(reqwest::Error::without_url)?;
    let status = resp.status();
    if !status.is_success() {
        bail!("download failed: HTTP {status}");
    }
    if let Some(len) = resp.content_length()
        && len != bytes
    {
        bail!("download size mismatch before transfer: manifest says {}, server says {len}", bytes);
    }

    let tmp = dir.join(format!(".tmp-{}", id::new("dl")));
    let mut open = std::fs::OpenOptions::new();
    open.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        open.mode(0o600);
    }
    let mut file = open.open(&tmp).with_context(|| format!("create {}", tmp.display()))?;
    let cleanup = DownloadTemp(tmp);
    let mut hasher = Sha256::new();
    let mut written: u64 = 0;
    let mut stream = resp.bytes_stream();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(reqwest::Error::without_url).context("read download stream")?;
        written += chunk.len() as u64;
        if written > bytes {
            bail!("download exceeded manifest size {}", bytes);
        }
        hasher.update(&chunk);
        file.write_all(&chunk).context("write downloaded artifact")?;
        notify(written, false);
    }
    notify(written, true);
    file.sync_all()?;
    drop(file);

    if written != bytes {
        bail!("downloaded {written} bytes, manifest says {}", bytes);
    }
    let got = hex(&hasher.finalize());
    if !got.eq_ignore_ascii_case(digest) {
        bail!("downloaded artifact sha256 mismatch: want {}, got {got}", digest);
    }
    // Windows 的可执行权限不是文件属性而是文件扩展名（`.exe`）；`cache_path` 对 `win32` 已经
    // 带了 `.exe` 后缀，这里不需要额外设置任何位。
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&cleanup.0, std::fs::Permissions::from_mode(0o700))?;
    }
    std::fs::rename(&cleanup.0, dest)?;
    Ok(())
}

struct DownloadTemp(PathBuf);

impl Drop for DownloadTemp {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.0);
    }
}

fn hex(b: &[u8]) -> String {
    b.iter().map(|x| format!("{x:02x}")).collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::body::Bytes;
    use axum::extract::State as AxState;
    use axum::routing::get;
    use std::sync::{Arc, Mutex};

    fn release(url: &str, body: &[u8]) -> AgentRelease {
        AgentRelease {
            id: "rel_1".into(),
            agent: "claude-code".into(),
            version: "2.1.308".into(),
            os: "darwin".into(),
            arch: "arm64".into(),
            url: url.into(),
            sha256: hex(&Sha256::digest(body)),
            size: body.len() as u64,
        }
    }

    #[tokio::test]
    async fn cache_download_uses_device_auth_only_at_the_configured_origin() {
        use axum::http::{HeaderMap, StatusCode};
        use axum::response::IntoResponse;

        let raw = b"verified artifact";
        let app = axum::Router::new()
            .route(
                "/v1/edge/agent-artifacts/rel_1",
                get(|headers: HeaderMap| async move {
                    if headers.get("authorization").and_then(|value| value.to_str().ok())
                        != Some("Bearer fake-device-token")
                    {
                        return StatusCode::UNAUTHORIZED.into_response();
                    }
                    Bytes::from_static(b"verified artifact").into_response()
                }),
            )
            .route(
                "/v1/edge/agent-artifacts/rel_redirect",
                get(|| async { axum::response::Redirect::temporary("/v1/edge/agent-artifacts/rel_1") }),
            );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let origin = format!("http://{}", listener.local_addr().unwrap());
        let task = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        let home = tempfile::tempdir().unwrap();
        let http = reqwest::Client::new();
        let rel = release("/v1/edge/agent-artifacts/rel_1", raw);
        let access = || Some(ArtifactAccess { origin: &origin, device_token: "fake-device-token" });
        let attempt = resolve(home.path(), &http, std::slice::from_ref(&rel), "claude-code", "darwin", "arm64", None);
        assert!(attempt.await.is_err());
        let path = resolve(home.path(), &http, &[rel], "claude-code", "darwin", "arm64", access()).await.unwrap();
        assert_eq!(std::fs::read(path).unwrap(), raw);
        let rel = AgentRelease {
            id: "rel_redirect".into(),
            ..release("/v1/edge/agent-artifacts/rel_redirect", b"different")
        };
        let result = resolve(home.path(), &http, &[rel], "claude-code", "darwin", "arm64", access()).await;
        assert!(result.unwrap_err().to_string().contains("307"));
        task.abort();
    }

    #[cfg(all(target_os = "macos", target_arch = "aarch64"))]
    #[tokio::test]
    async fn claude_engine_requires_a_pinned_server_release_and_checks_its_download() {
        use axum::http::{HeaderMap, StatusCode};
        use axum::response::IntoResponse;

        let app = axum::Router::new().route(
            "/v1/edge/agent-artifacts/rel_claude/runtime",
            get(|headers: HeaderMap| async move {
                if headers.get("authorization").and_then(|value| value.to_str().ok())
                    != Some("Bearer fake-device-token")
                {
                    return StatusCode::UNAUTHORIZED.into_response();
                }
                Bytes::from_static(b"not the pinned engine").into_response()
            }),
        );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let origin = format!("http://{}", listener.local_addr().unwrap());
        let task = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        let home = tempfile::tempdir().unwrap();
        let mut release = AgentRelease {
            id: "rel_claude".into(),
            agent: "claude-desktop".into(),
            version: "6.28899.6".into(),
            os: "darwin".into(),
            arch: "arm64".into(),
            url: "/v1/edge/agent-artifacts/rel_claude".into(),
            sha256: "a1226d5e7072a713f7eab74d06d1745fc47aa57eae3ba202a103032d1329530f".into(),
            size: 402202476,
        };
        let access = Some(ArtifactAccess { origin: &origin, device_token: "fake-device-token" });
        let anonymous = resolve_claude_engine(home.path(), &release, None).await.unwrap_err();
        assert!(anonymous.to_string().contains("device credentials"));
        let wrong_asset = resolve_claude_engine(home.path(), &release, access).await.unwrap_err();
        assert!(wrong_asset.to_string().contains("download size mismatch"));
        let bundle = cache_path(home.path(), &release.agent, &release);
        let engine = Bundle::for_release(&release).unwrap().runtime.unwrap();
        let dest = claude_engine_path(&bundle, engine);
        assert!(!dest.exists());
        std::fs::File::create(bundle).unwrap().set_len(release.size).unwrap();
        let releases = std::slice::from_ref(&release);
        assert_eq!(
            cached(home.path(), releases, "claude-desktop", "darwin", "arm64"),
            Some(("6.28899.6".into(), false))
        );
        std::fs::File::create(dest).unwrap().set_len(engine.bytes).unwrap();
        assert_eq!(
            cached(home.path(), releases, "claude-desktop", "darwin", "arm64"),
            Some(("6.28899.6".into(), true))
        );

        release.url = format!("{origin}/v1/edge/agent-artifacts/rel_claude");
        assert_eq!(
            resolve_claude_engine(home.path(), &release, access).await.unwrap_err().downcast::<ResolveError>().unwrap(),
            ResolveError::BadRelease("unsupported agent")
        );
        task.abort();
    }

    async fn serve(body: Vec<u8>, hits: Arc<Mutex<u32>>) -> String {
        let app = axum::Router::new().route(
            "/claude",
            get(move |AxState((body, hits)): AxState<(Vec<u8>, Arc<Mutex<u32>>)>| async move {
                *hits.lock().unwrap() += 1;
                Bytes::from(body)
            }),
        );
        let app = app.with_state((body, hits));
        let l = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}/claude", l.local_addr().unwrap());
        tokio::spawn(async move { axum::serve(l, app).await.unwrap() });
        url
    }

    #[tokio::test]
    async fn downloads_verifies_and_caches() {
        let hits = Arc::new(Mutex::new(0));
        let body = b"fake claude binary".to_vec();
        let url = serve(body.clone(), hits.clone()).await;
        let rel = release(&url, &body);
        let home = tempfile::tempdir().unwrap();
        let http = reqwest::Client::new();

        let updates = Mutex::new(Vec::new());
        let p1 = resolve_with_progress(
            home.path(),
            &http,
            &[rel.clone()],
            "claude-code",
            "darwin",
            "arm64",
            None,
            |progress| {
                updates.lock().unwrap().push(progress);
            },
        )
        .await
        .unwrap();
        let updates = updates.into_inner().unwrap();
        assert_eq!(updates.first().map(|progress| progress.downloaded_bytes), Some(0));
        assert_eq!(
            updates.last().copied(),
            Some(ArtifactProgress {
                downloaded_bytes: body.len() as u64,
                total_bytes: body.len() as u64,
                verifying: true,
            })
        );
        assert_eq!(std::fs::read(&p1).unwrap(), body);
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(std::fs::metadata(&p1).unwrap().permissions().mode() & 0o777, 0o700);
        }
        assert_eq!(*hits.lock().unwrap(), 1);

        // 第二次命中缓存，不重新下载
        let p2 = resolve(home.path(), &http, &[rel], "claude-code", "darwin", "arm64", None).await.unwrap();
        assert_eq!(p1, p2);
        assert_eq!(*hits.lock().unwrap(), 1);
    }

    #[tokio::test]
    async fn rejects_bad_sha256_and_leaves_no_partial_file() {
        let hits = Arc::new(Mutex::new(0));
        let body = b"real bytes".to_vec();
        let url = serve(body.clone(), hits).await;
        let mut rel = release(&url, &body);
        rel.sha256 = hex(&Sha256::digest(b"not the real bytes"));
        let home = tempfile::tempdir().unwrap();
        let http = reqwest::Client::new();

        let err =
            resolve(home.path(), &http, &[rel.clone()], "claude-code", "darwin", "arm64", None).await.unwrap_err();
        assert!(format!("{err:#}").contains("sha256 mismatch"), "{err:#}");
        let dir = cache_path(home.path(), "claude-code", &rel).parent().unwrap().to_path_buf();
        let leftover: Vec<_> = std::fs::read_dir(&dir).map(|d| d.collect()).unwrap_or_default();
        assert!(leftover.is_empty(), "expected no leftover files, found {leftover:?}");
    }

    #[tokio::test]
    async fn cached_reports_version_without_downloading() {
        let hits = Arc::new(Mutex::new(0));
        let body = b"not downloaded yet".to_vec();
        let url = serve(body.clone(), hits.clone()).await;
        let rel = release(&url, &body);
        let home = tempfile::tempdir().unwrap();

        assert_eq!(
            cached(home.path(), &[rel.clone()], "claude-code", "darwin", "arm64"),
            Some(("2.1.308".into(), false))
        );
        assert_eq!(*hits.lock().unwrap(), 0);
        assert_eq!(cached(home.path(), &[rel.clone()], "claude-code", "win32", "x64"), None);

        let http = reqwest::Client::new();
        resolve(home.path(), &http, &[rel.clone()], "claude-code", "darwin", "arm64", None).await.unwrap();
        assert_eq!(cached(home.path(), &[rel], "claude-code", "darwin", "arm64"), Some(("2.1.308".into(), true)));
    }

    #[tokio::test]
    async fn rejects_wrong_size_before_accepting() {
        let hits = Arc::new(Mutex::new(0));
        let body = b"twelve bytes".to_vec();
        let url = serve(body.clone(), hits).await;
        let mut rel = release(&url, &body);
        rel.size = 3; // manifest 和服务器实际响应不符
        let home = tempfile::tempdir().unwrap();
        let http = reqwest::Client::new();
        let err = resolve(home.path(), &http, &[rel], "claude-code", "darwin", "arm64", None).await.unwrap_err();
        assert!(format!("{err:#}").contains("size mismatch"), "{err:#}");
    }

    #[tokio::test]
    async fn redownloads_when_cached_file_is_corrupted() {
        let hits = Arc::new(Mutex::new(0));
        let body = b"good content here".to_vec();
        let url = serve(body.clone(), hits.clone()).await;
        let rel = release(&url, &body);
        let home = tempfile::tempdir().unwrap();
        let http = reqwest::Client::new();

        let p = resolve(home.path(), &http, &[rel.clone()], "claude-code", "darwin", "arm64", None).await.unwrap();
        assert_eq!(*hits.lock().unwrap(), 1);
        // 篡改缓存里的文件
        std::fs::write(&p, b"tampered!!!!!!!!!").unwrap();
        let p2 = resolve(home.path(), &http, &[rel], "claude-code", "darwin", "arm64", None).await.unwrap();
        assert_eq!(p, p2);
        assert_eq!(std::fs::read(&p2).unwrap(), body);
        assert_eq!(*hits.lock().unwrap(), 2);
    }

    #[test]
    fn selects_matching_platform_and_highest_version() {
        let mk = |agent: &str, os: &str, arch: &str, version: &str| AgentRelease {
            id: format!("rel_{version}"),
            agent: agent.into(),
            version: version.into(),
            os: os.into(),
            arch: arch.into(),
            url: "https://x.example/artifact".into(),
            sha256: "0".repeat(64),
            size: 1,
        };
        let releases = vec![
            mk("claude-code", "darwin", "arm64", "2.1.9"),
            mk("claude-code", "darwin", "arm64", "2.1.10"),
            mk("claude-code", "darwin", "x64", "9.9.9"),
        ];
        let got = select(&releases, "claude-code", "darwin", "arm64").unwrap();
        assert_eq!(got.version, "2.1.10"); // 数值比较，不是字符串比较（否则 "2.1.9" > "2.1.10"）
        assert_eq!(select(&releases, "claude-code", "win32", "x64"), Err(ResolveError::NoRelease));
    }

    #[test]
    fn no_release_error_message() {
        assert_eq!(ResolveError::NoRelease.to_string(), "没有可用的受管发行版本");
    }

    fn valid_release() -> AgentRelease {
        AgentRelease {
            id: "rel_1".into(),
            agent: "claude-code".into(),
            version: "2.1.311".into(),
            os: "darwin".into(),
            arch: "arm64".into(),
            url: "https://downloads.example/claude".into(),
            sha256: "a".repeat(64),
            size: 42,
        }
    }

    #[test]
    fn rejects_release_for_an_unsupported_agent() {
        let mut r = valid_release();
        r.agent = "workbuddy".into();
        assert_eq!(select(&[r], "workbuddy", "darwin", "arm64"), Err(ResolveError::BadRelease("unsupported agent")));
    }

    #[test]
    fn accepts_releases_for_all_v0_12_agents() {
        for agent in ["claude-code", "codex", "kimi-code"] {
            let mut r = valid_release();
            r.agent = agent.into();
            let releases = [r];
            assert_eq!(select(&releases, agent, "darwin", "arm64"), Ok(&releases[0]));
        }
    }

    #[test]
    fn rejects_malformed_sha256() {
        let mut r = valid_release();
        r.sha256 = "not-hex".into();
        assert_eq!(
            select(&[r], "claude-code", "darwin", "arm64"),
            Err(ResolveError::BadRelease("sha256 is not 64 hex characters"))
        );
    }

    #[test]
    fn rejects_zero_size() {
        let mut r = valid_release();
        r.size = 0;
        assert_eq!(
            select(&[r], "claude-code", "darwin", "arm64"),
            Err(ResolveError::BadRelease("size must be greater than zero"))
        );
    }

    #[test]
    fn rejects_non_https_url_except_loopback() {
        let mut r = valid_release();
        r.url = "http://cdn.example/claude".into();
        assert!(matches!(select(&[r], "claude-code", "darwin", "arm64"), Err(ResolveError::BadRelease(_))));

        let mut loopback = valid_release();
        loopback.url = "http://127.0.0.1:9/claude".into();
        assert_eq!(select(&[loopback.clone()], "claude-code", "darwin", "arm64"), Ok(&loopback));
    }
}
