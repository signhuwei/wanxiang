//! Build diagnostics from known daemon events and upload only to the connected OneX Server.

use std::fs::{self, File};
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::time::Duration;

use onex_core::ws::{Diag, DiagResult};
use reqwest::Url;
use serde_json::{Value, json};
use time::{OffsetDateTime, format_description::well_known::Rfc3339};

const LOG_BYTES_PER_FILE: u64 = 128 * 1024;
const LOG_FILES: usize = 3;
const LOG_ENTRIES: usize = 1_000;

#[derive(Debug, Clone)]
pub(crate) struct LogSource {
    pub directory: PathBuf,
    pub started_at: OffsetDateTime,
}

pub(crate) async fn run(diag: Diag, source: Option<LogSource>, server: &str, token: &str, status: Value) -> DiagResult {
    let result = match diag.kind.as_str() {
        "status" => Ok(status),
        "logs" => upload(&diag, source, server, token).await,
        _ => Err("unsupported_kind"),
    };
    let (ok, detail) = match result {
        Ok(detail) => (true, detail),
        Err(reason) => (false, json!({ "reason": reason })),
    };
    DiagResult { id: crate::id::new("msg"), diag_id: diag.diag_id, ok, detail }
}

async fn upload(diag: &Diag, source: Option<LogSource>, server: &str, token: &str) -> Result<Value, &'static str> {
    let target = upload_target(server, diag).ok_or("invalid_upload_target")?;
    let source = source.ok_or("logs_unavailable")?;
    let data = tokio::task::spawn_blocking(move || collect(&source)).await.map_err(|_| "logs_unavailable")?;
    let payload = archive(data.as_bytes());
    let bytes = payload.len();
    let client = reqwest::Client::builder()
        .no_proxy()
        .redirect(reqwest::redirect::Policy::none())
        .connect_timeout(Duration::from_secs(5))
        .timeout(Duration::from_secs(30))
        .build()
        .map_err(|_| "upload_failed")?;
    let response = client
        .put(target)
        .bearer_auth(token)
        .header("Content-Type", "application/x-tar")
        .body(payload)
        .send()
        .await
        .map_err(|_| "upload_failed")?;
    if !response.status().is_success() {
        return Err("upload_failed");
    }
    Ok(json!({ "bytes": bytes }))
}

fn upload_target(server: &str, diag: &Diag) -> Option<Url> {
    let id = &diag.diag_id;
    if id.len() > 64 || !id.starts_with("dgj_") || !id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_') {
        return None;
    }
    let path = format!("/v1/diag/{id}/upload");
    if diag.upload_url.as_deref()? != path {
        return None;
    }
    let origin = Url::parse(&onex_core::ipc::http_base(server)?).ok()?;
    if !origin.username().is_empty() || origin.password().is_some() {
        return None;
    }
    origin.join(&path).ok()
}

fn collect(source: &LogSource) -> String {
    let mut paths: Vec<_> = fs::read_dir(&source.directory)
        .into_iter()
        .flatten()
        .filter_map(Result::ok)
        .filter(|entry| entry.file_type().is_ok_and(|kind| kind.is_file()) && allowed_log_name(&entry.path()))
        .map(|entry| entry.path())
        .collect();
    paths.sort_unstable();
    let mut entries = Vec::new();
    for path in paths.iter().rev().take(LOG_FILES) {
        let Ok(mut file) = File::open(path) else { continue };
        let Ok(meta) = file.metadata() else { continue };
        let start = meta.len().saturating_sub(LOG_BYTES_PER_FILE);
        if file.seek(SeekFrom::Start(start)).is_err() {
            continue;
        }
        let mut bytes = Vec::new();
        if file.take(LOG_BYTES_PER_FILE).read_to_end(&mut bytes).is_err() {
            continue;
        }
        let text = String::from_utf8_lossy(&bytes);
        entries.extend(text.lines().skip(usize::from(start > 0)).filter_map(|line| redact(line, source.started_at)));
    }
    entries.sort_unstable_by_key(|(at, _, _)| *at);
    let mut log = String::from("OneX Edge diagnostics\n");
    for (at, severity, event) in &entries[entries.len().saturating_sub(LOG_ENTRIES)..] {
        if let Ok(at) = at.format(&Rfc3339) {
            log.push_str(&format!("{at} {severity} {event}\n"));
        }
    }
    log
}

fn allowed_log_name(path: &Path) -> bool {
    let Some(name) = path.file_name().and_then(|name| name.to_str()) else { return false };
    let Some(date) = name.strip_prefix("onexd.").and_then(|rest| rest.strip_suffix(".log")) else { return false };
    date.len() == 10
        && date.bytes().enumerate().all(
            |(index, b)| {
                if matches!(index, 4 | 7) { b == b'-' } else { b.is_ascii_digit() }
            },
        )
}

fn redact(line: &str, started_at: OffsetDateTime) -> Option<(OffsetDateTime, &'static str, &'static str)> {
    let mut fields = line.split_whitespace();
    let at = OffsetDateTime::parse(fields.next()?, &Rfc3339).ok()?;
    if at < started_at {
        return None;
    }
    let severity = match fields.next()? {
        "INFO" => "INFO",
        "WARN" => "WARN",
        "ERROR" => "ERROR",
        _ => return None,
    };
    let (component, message) = line.split_once(severity)?.1.trim_start().split_once(": ")?;
    const ALLOWED: &[(&str, &[&str])] = &[
        ("onexd", &["onexd starting", "router listening"]),
        (
            "onexd::ws",
            &[
                "ws connected",
                "ws disconnected",
                "config applied",
                "lease rejected",
                "secret rejected",
                "server rejected device token",
            ],
        ),
        ("onexd::lease", &["cutoff"]),
        (
            "onexd::router",
            &[
                "no rate for model",
                "request blocked by lease",
                "upstream request failed",
                "upstream response has no complete usage",
                "upstream stream ended before message_stop",
                "upstream stream error",
                "upstream SSE line or event exceeded the byte limit",
                "chat response conversion failed",
            ],
        ),
    ];
    let (_, messages) = ALLOWED.iter().find(|(name, _)| *name == component)?;
    let event = messages
        .iter()
        .find(|name| message == **name || message.strip_prefix(**name).is_some_and(|tail| tail.starts_with(' ')))?;
    Some((at, severity, event))
}

/// One regular file with fixed ustar metadata. No filesystem path or account data goes in the archive.
fn archive(data: &[u8]) -> Vec<u8> {
    let mut header = [0u8; 512];
    let name = b"onexd.log";
    header[..name.len()].copy_from_slice(name);
    header[100..108].copy_from_slice(b"0000600\0");
    header[108..116].copy_from_slice(b"0000000\0");
    header[116..124].copy_from_slice(b"0000000\0");
    header[124..136].copy_from_slice(format!("{:011o}\0", data.len()).as_bytes());
    header[136..148].copy_from_slice(b"00000000000\0");
    header[148..156].fill(b' ');
    header[156] = b'0';
    header[257..263].copy_from_slice(b"ustar\0");
    header[263..265].copy_from_slice(b"00");
    let checksum: u32 = header.iter().map(|byte| u32::from(*byte)).sum();
    header[148..156].copy_from_slice(format!("{checksum:06o}\0 ").as_bytes());
    let mut out = header.to_vec();
    out.extend_from_slice(data);
    out.resize(512 * (data.len().div_ceil(512) + 3), 0);
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn archive_only_has_recognized_events_from_current_daemon() {
        let directory = tempfile::tempdir().unwrap();
        let logs = "2026-11-18T23:00:00Z  WARN onexd::router: upstream stream error old-secret\n\
            2026-11-19T00:00:00Z  WARN onexd::router: upstream stream error request_id=req_987 error=synthetic-token\n\
            2026-11-19T00:00:01Z  WARN onexd::other: message=synthetic-dialogue\n";
        fs::write(directory.path().join("onexd.2026-11-19.log"), logs).unwrap();
        fs::write(directory.path().join("unrelated.log"), logs).unwrap();
        let source = LogSource {
            directory: directory.path().into(),
            started_at: OffsetDateTime::parse("2026-11-19T00:00:00Z", &Rfc3339).unwrap(),
        };
        let data = collect(&source);
        assert_eq!(data, "OneX Edge diagnostics\n2026-11-19T00:00:00Z WARN upstream stream error\n");
        let bytes = archive(data.as_bytes());
        assert_eq!(&bytes[512..512 + data.len()], data.as_bytes());
        assert_eq!(&bytes[..9], b"onexd.log");
    }

    #[test]
    fn upload_targets_are_bound_to_the_same_server_and_job() {
        let mut job = Diag {
            id: "m1".into(),
            diag_id: "dgj_fixture".into(),
            kind: "logs".into(),
            upload_url: Some("/v1/diag/dgj_fixture/upload".into()),
        };
        let server = "wss://one.invalid:8443/v1/edge/ws";
        assert_eq!(
            upload_target(server, &job).unwrap().as_str(),
            "https://one.invalid:8443/v1/diag/dgj_fixture/upload"
        );
        for target in [
            "https://other.invalid/v1/diag/dgj_fixture/upload",
            "/v1/diag/dgj_other/upload",
            "/v1/diag/dgj_fixture/upload?x=1",
        ] {
            job.upload_url = Some(target.into());
            assert!(upload_target(server, &job).is_none());
        }
    }
}
