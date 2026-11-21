//! WorkBuddy's command hook reads one vendor event on stdin. Only its identity
//! fields cross the local control connection.
use std::io::Read;
use std::path::{Component, Path, PathBuf};
use std::time::Duration;

use anyhow::{Context, Result, ensure};
use serde::Deserialize;

use crate::workbuddy_turns::{Change, HookEvent};

#[derive(Deserialize)]
struct Policy {
    origin: String,
    workspace: PathBuf,
    config: PathBuf,
    #[serde(rename = "privateHome")]
    private_home: PathBuf,
    credential: PathBuf,
}

#[derive(Deserialize)]
struct Event {
    session_id: String,
    generation_id: String,
    hook_event_name: HookEvent,
    transcript_path: PathBuf,
    cwd: Option<PathBuf>,
}

fn change(policy: &Policy, event: Event) -> Result<Change> {
    let sid = &event.session_id;
    ensure!(
        !sid.is_empty()
            && sid.len() <= 128
            && sid.bytes().all(|b| b.is_ascii_alphanumeric() || matches!(b, b'_' | b'-')),
        "invalid native session"
    );
    let projects = policy.config.canonicalize()?.join("projects");
    let relative = event.transcript_path.strip_prefix(&projects)?;
    let mut components = relative.components();
    ensure!(
        matches!(components.next(), Some(Component::Normal(_)))
            && matches!(components.next(), Some(Component::Normal(_)))
            && components.next().is_none()
            && event.transcript_path.file_name().and_then(|n| n.to_str()) == Some(&format!("{sid}.jsonl")),
        "transcript is outside the native session"
    );
    // A first prompt can precede creation of the transcript. Validate each
    // existing component without following links outside the managed profile.
    for p in [projects.as_path(), event.transcript_path.parent().unwrap(), &event.transcript_path] {
        match p.symlink_metadata() {
            Ok(info) => {
                ensure!(!info.file_type().is_symlink() && p.canonicalize()? == p, "invalid transcript location")
            }
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(e) => return Err(e.into()),
        }
    }
    let source = if let Some(cwd) = event.cwd {
        let cwd = cwd.canonicalize()?;
        ensure!(
            cwd == policy.workspace.canonicalize()?
                || cwd.starts_with(policy.private_home.canonicalize()?.join("WorkBuddy")),
            "workspace mismatch"
        );
        let project =
            relative.parent().and_then(|p| p.file_name()).and_then(|p| p.to_str()).context("invalid project")?;
        matches!(event.hook_event_name, HookEvent::UserPromptSubmit)
            .then(|| crate::workbuddy_capture::Source { project: project.to_owned(), cwd })
    } else {
        ensure!(matches!(event.hook_event_name, HookEvent::Stop), "missing workspace");
        None
    };
    Ok(Change { native_id: event.session_id, generation_id: event.generation_id, event: event.hook_event_name, source })
}

pub async fn notify(policy_file: &Path) -> Result<()> {
    let policy: Policy = serde_json::from_slice(&std::fs::read(policy_file)?)?;
    let origin = reqwest::Url::parse(&policy.origin)?;
    ensure!(
        origin.scheme() == "http"
            && origin.host_str() == Some("127.0.0.1")
            && origin.port().is_some()
            && origin.username().is_empty()
            && origin.password().is_none()
            && origin.path() == "/"
            && origin.query().is_none()
            && origin.fragment().is_none(),
        "invalid hook origin"
    );
    ensure!(
        policy_file.canonicalize()? == policy_file
            && policy.credential.canonicalize()? == policy.credential
            && policy.credential.parent() == policy_file.parent(),
        "invalid hook credential location"
    );
    let mut input = Vec::new();
    const LIMIT: u64 = 2 * 1024 * 1024;
    std::io::stdin().lock().take(LIMIT + 1).read_to_end(&mut input)?;
    ensure!((input.len() as u64) <= LIMIT, "hook payload exceeded limit");
    let change = change(&policy, serde_json::from_slice(&input)?)?;
    let credential = std::fs::read_to_string(&policy.credential)?;
    let client = reqwest::Client::builder()
        .no_proxy()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(Duration::from_secs(4))
        .build()?;
    let response = client
        .post(origin.join("/v1/onex/workbuddy/turn")?)
        .bearer_auth(credential.trim())
        .json(&change)
        .send()
        .await
        .context("unable to report native turn")?;
    ensure!(response.status() == reqwest::StatusCode::NO_CONTENT, "native turn was rejected");
    Ok(())
}
