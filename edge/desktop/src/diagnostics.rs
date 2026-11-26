use std::collections::VecDeque;
use std::fs::{self, File};
use std::io::{Read, Seek, SeekFrom};
use std::path::Path;

use serde::Serialize;
use time::{OffsetDateTime, format_description::well_known::Rfc3339};

const LOG_TAIL: u64 = 128 * 1024;
const LOG_COUNT: usize = 150;

#[derive(Clone, Serialize)]
pub(crate) struct Entry {
    at_ms: i64,
    source: &'static str,
    level: &'static str,
    event: &'static str,
    version: Option<String>,
    agent: Option<&'static str>,
    code: Option<&'static str>,
    config_revision: Option<u64>,
    exit_code: Option<i32>,
}

#[derive(Serialize)]
pub(crate) struct DiagnosticView {
    pub desktop_version: String,
    pub daemon_version: Option<String>,
    pub entries: Vec<Entry>,
}

#[derive(Clone, Copy)]
pub(crate) enum Action {
    Launch(&'static str),
    Download(&'static str),
}

pub(crate) struct Session {
    pub since: OffsetDateTime,
    entries: VecDeque<Entry>,
}

impl Default for Session {
    fn default() -> Self {
        Self { since: OffsetDateTime::now_utc(), entries: VecDeque::new() }
    }
}

impl Session {
    pub fn push(
        &mut self,
        version: &str,
        level: &'static str,
        event: &'static str,
        agent: Option<&'static str>,
        code: Option<&'static str>,
    ) {
        if self.entries.len() == LOG_COUNT {
            self.entries.pop_front();
        }
        self.entries.push_back(Entry {
            at_ms: millis(OffsetDateTime::now_utc()),
            source: "desktop",
            level,
            event,
            version: safe_version(version),
            agent,
            code,
            config_revision: None,
            exit_code: None,
        });
    }

    pub fn view(
        &self,
        desktop_version: &str,
        daemon_version: Option<String>,
        mut daemon: Vec<Entry>,
    ) -> DiagnosticView {
        daemon.extend(self.entries.iter().cloned());
        daemon.sort_by_key(|entry| std::cmp::Reverse(entry.at_ms));
        daemon.truncate(LOG_COUNT);
        DiagnosticView { desktop_version: desktop_version.into(), daemon_version, entries: daemon }
    }
}

pub(crate) fn safe_version(raw: &str) -> Option<String> {
    let version = raw.trim_matches('"');
    if version.len() > 48 || !version.bytes().all(|byte| byte.is_ascii_digit() || b".rcbtaelph-".contains(&byte)) {
        return None;
    }
    semver::Version::parse(version).ok().map(|version| version.to_string())
}

fn millis(at: OffsetDateTime) -> i64 {
    (at.unix_timestamp_nanos() / 1_000_000) as i64
}

pub(crate) fn daemon_logs(directory: &Path, since: OffsetDateTime, include_account_events: bool) -> Vec<Entry> {
    let Ok(dir) = fs::symlink_metadata(directory) else { return vec![] };
    if !dir.file_type().is_dir() {
        return vec![];
    }
    let mut files: Vec<_> = fs::read_dir(directory)
        .into_iter()
        .flatten()
        .filter_map(Result::ok)
        .filter(|entry| {
            entry.file_type().is_ok_and(|kind| kind.is_file()) && log_name(&entry.file_name().to_string_lossy())
        })
        .map(|entry| entry.path())
        .collect();
    files.sort_unstable();
    let mut records = VecDeque::new();
    let mut version = None;
    let from = files.len().saturating_sub(3);
    for path in &files[from..] {
        let Ok(mut file) = File::open(path) else { continue };
        let Ok(meta) = file.metadata() else { continue };
        let start = meta.len().saturating_sub(LOG_TAIL);
        if file.seek(SeekFrom::Start(start)).is_err() {
            continue;
        }
        let mut bytes = Vec::new();
        if file.take(LOG_TAIL).read_to_end(&mut bytes).is_err() {
            continue;
        }
        let text = String::from_utf8_lossy(&bytes);
        for line in text.split_inclusive('\n').skip(usize::from(start > 0)).filter(|line| line.ends_with('\n')) {
            let Some((at, mut entry)) = parse(line.trim_end()) else { continue };
            if entry.event == "daemon_started" {
                version.clone_from(&entry.version);
            } else {
                entry.version.clone_from(&version);
            }
            if at < since
                || (!include_account_events
                    && !matches!(entry.event, "daemon_started" | "router_listening" | "daemon_failed"))
            {
                continue;
            }
            if records.len() == LOG_COUNT {
                records.pop_front();
            }
            records.push_back(entry);
        }
    }
    records.into()
}

fn log_name(name: &str) -> bool {
    let Some(date) = name.strip_prefix("onexd.").and_then(|rest| rest.strip_suffix(".log")) else { return false };
    date.len() == 10
        && date
            .bytes()
            .enumerate()
            .all(|(index, byte)| if matches!(index, 4 | 7) { byte == b'-' } else { byte.is_ascii_digit() })
}

fn parse(line: &str) -> Option<(OffsetDateTime, Entry)> {
    let (timestamp, remainder) = line.split_once(' ')?;
    let at = OffsetDateTime::parse(timestamp, &Rfc3339).ok()?;
    let (severity, remainder) = remainder.trim_start().split_once(' ')?;
    let level = match severity {
        "INFO" => "info",
        "WARN" => "warn",
        "ERROR" => "error",
        _ => return None,
    };
    let (component, message) = remainder.trim_start().split_once(": ")?;
    let event = EVENTS.iter().find_map(|&(target, prefix, event)| {
        (component == target
            && message.strip_prefix(prefix).is_some_and(|tail| tail.is_empty() || tail.starts_with(' ')))
        .then_some(event)
    })?;
    // The original line contains account paths, credentials and arbitrary error text. Return fixed
    // event names and tightly typed metadata, never an original line, arbitrary field or identifier.
    let field = |key: &str| message.split_whitespace().find_map(|word| word.strip_prefix(key));
    let agent = field("agent=").and_then(|raw| AGENTS.iter().copied().find(|agent| *agent == raw.trim_matches('"')));
    let version = (event == "daemon_started").then(|| field("version=").and_then(safe_version)).flatten();
    let code = if event == "config_rejected" {
        match field("reason=").map(|reason| reason.trim_matches('"')) {
            Some("设备策略包含无效或不适用的受管工具") => Some("policy_tools_invalid"),
            Some("设备策略包含不适用的受管发行") => Some("policy_agents_invalid"),
            Some("设备策略修订号无效或已回退") => Some("policy_revision_invalid"),
            Some("设备策略与当前登录身份不符") => Some("policy_identity_invalid"),
            Some("设备策略路由与费率不一致") => Some("policy_rates_invalid"),
            Some("不支持的设备策略版本") => Some("policy_abi_unsupported"),
            _ => None,
        }
    } else {
        None
    };
    let config_revision =
        matches!(event, "config_applied" | "config_rejected").then(|| field("revision=")?.parse().ok()).flatten();
    let exit_code = (event == "agent_exited")
        .then(|| field("exit_code=")?.strip_prefix("Some(")?.strip_suffix(')')?.parse().ok())
        .flatten();
    Some((
        at,
        Entry { at_ms: millis(at), source: "daemon", level, event, version, agent, code, config_revision, exit_code },
    ))
}

const AGENTS: &[&str] =
    &["claude-code", "codex", "kimi-code", "deepseek-desktop", "workbuddy", "codex-desktop", "claude-desktop"];

const EVENTS: &[(&str, &str, &str)] = &[
    ("onexd", "onexd starting", "daemon_started"),
    ("onexd", "router listening", "router_listening"),
    ("onexd", "onexd exited with error", "daemon_failed"),
    ("onexd::ws", "ws connected", "ws_connected"),
    ("onexd::ws", "ws disconnected", "ws_disconnected"),
    ("onexd::ws", "config applied", "config_applied"),
    ("onexd::ws", "route_pool config applied", "config_applied"),
    ("onexd::ws", "device configuration rejected", "config_rejected"),
    ("onexd::ws", "lease rejected", "lease_rejected"),
    ("onexd::router", "upstream request failed", "upstream_failed"),
    ("onexd::ipc", "ipc connection", "ipc_failed"),
    ("onexd::ipc", "managed agent artifact resolution failed", "agent_artifact_failed"),
    ("onexd::ipc", "managed tool bundle resolution failed", "tool_bundle_failed"),
    ("onexd::ipc", "could not prepare managed tools", "tool_prepare_failed"),
    ("onexd::ipc", "desktop bundle rejected", "desktop_bundle_rejected"),
    ("onexd::ipc", "desktop profile rejected", "desktop_profile_rejected"),
    ("onexd::ipc", "desktop process did not start", "desktop_spawn_failed"),
    ("onexd::ipc", "agent launch prepared", "agent_prepared"),
    ("onexd::ipc", "agent exited", "agent_exited"),
    ("onexd::ipc", "desktop process exited", "desktop_exited"),
];

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn emits_only_known_events_and_metadata_inside_the_current_session() {
        let dir = tempfile::tempdir().unwrap();
        let logs = concat!(
            "2026-11-25T23:59:00Z  INFO onexd: onexd starting version=\"0.1.0-rc28\" home=SECRET_HOME\n",
            "2026-11-25T23:59:30Z  WARN onexd::ipc: managed tool bundle resolution failed agent=codex error=OTHER_ACCOUNT\n",
            "2026-11-26T00:00:01Z  INFO onexd::ws: config applied revision=166 tenant_id=SECRET_TENANT\n",
            "2026-11-26T00:00:02Z  WARN onexd::ipc: managed tool bundle resolution failed agent=deepseek-desktop error=SECRET_VALUE\n",
            "2026-11-26T00:00:03Z  INFO onexd::ipc: agent exited launch_id=SECRET_LAUNCH exit_code=Some(17)\n",
            "2026-11-26T00:00:04Z  INFO onexd::ipc: unknown event user_prompt=SECRET_PROMPT\n",
            "2026-11-26T00:00:05Z  WARN onexd::ws: device configuration rejected revision=167 reason=\"设备策略包含无效或不适用的受管工具\"\n",
        );
        let path = dir.path().join("onexd.2026-11-26.log");
        fs::write(&path, logs).unwrap();
        fs::write(dir.path().join("wrong.log"), logs).unwrap();
        let since = OffsetDateTime::parse("2026-11-26T00:00:00Z", &Rfc3339).unwrap();
        let entries = daemon_logs(dir.path(), since, true);
        assert_eq!(entries.len(), 4);
        assert_eq!(entries[0].config_revision, Some(166));
        assert_eq!(entries[0].version.as_deref(), Some("0.1.0-rc28"));
        assert_eq!(entries[1].agent, Some("deepseek-desktop"));
        assert_eq!(entries[2].exit_code, Some(17));
        assert_eq!(entries[3].config_revision, Some(167));
        assert_eq!(entries[3].code, Some("policy_tools_invalid"));
        let view = serde_json::to_string(&entries).unwrap();
        assert!(!view.contains("SECRET"));
        assert!(!view.contains("OTHER_ACCOUNT"));
        assert!(daemon_logs(dir.path(), since, false).is_empty());
    }
}
