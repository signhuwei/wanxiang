//! Relate the vendor's authenticated, native turn evidence to model requests.
//! Only the runtime that verifies the native SID and original journal may admit a turn.
use std::collections::{HashMap, hash_map::Entry};
use std::sync::Mutex;

use crate::state::LaunchBinding;

#[derive(serde::Deserialize, serde::Serialize)]
pub(crate) enum HookEvent {
    UserPromptSubmit,
    Stop,
}

#[derive(serde::Deserialize, serde::Serialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct Change {
    pub native_id: String,
    pub generation_id: String,
    pub event: HookEvent,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source: Option<crate::workbuddy_capture::Source>,
}

pub(crate) async fn observe(
    axum::extract::State(router): axum::extract::State<std::sync::Arc<crate::router::Router>>,
    headers: axum::http::HeaderMap,
    axum::Json(change): axum::Json<Change>,
) -> axum::http::StatusCode {
    use axum::http::{StatusCode, header::AUTHORIZATION};
    let mut credentials = headers.get_all(AUTHORIZATION).iter();
    let Some(control) = credentials.next().and_then(|h| h.to_str().ok()).and_then(|v| v.strip_prefix("Bearer ")) else {
        return StatusCode::UNAUTHORIZED;
    };
    if credentials.next().is_some() || control.is_empty() {
        return StatusCode::UNAUTHORIZED;
    }
    let turns = &router.state.workbuddy_turns;
    let accepted = match change.event {
        HookEvent::UserPromptSubmit => {
            let Some(source) = change.source else { return StatusCode::UNPROCESSABLE_ENTITY };
            if !generation_id(&change.generation_id) {
                return StatusCode::UNPROCESSABLE_ENTITY;
            }
            if !router.state.desktop_sessions.register_workbuddy_source(control, &change.native_id, source).await {
                return StatusCode::FORBIDDEN;
            }
            turns.admit(control, &change.native_id, &change.generation_id)
        }
        HookEvent::Stop => turns.finish(control, &change.native_id, &change.generation_id),
    };
    if accepted { StatusCode::NO_CONTENT } else { StatusCode::FORBIDDEN }
}

#[derive(Default)]
pub struct Turns(Mutex<HashMap<String, Launch>>);

struct Launch {
    model_bearer: String,
    device: String,
    release: String,
    model: String,
    // An ended or conflicting generation stays closed for the lifetime of the credential.
    turns: HashMap<String, Turn>,
}

enum Turn {
    Active(String),
    Ended(String),
    Conflicted,
}

fn generation_id(id: &str) -> bool {
    let bytes = id.as_bytes();
    bytes.len() == 32
        && bytes.iter().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(b))
        && bytes[12] == b'7'
        && matches!(bytes[16], b'8' | b'9' | b'a' | b'b')
}

impl Turns {
    pub(crate) fn start(&self, control: &str, bearer: &str, device: &str, release: &str, model: &str) -> bool {
        if control.is_empty()
            || bearer.is_empty()
            || control == bearer
            || device.is_empty()
            || release.is_empty()
            || model.is_empty()
        {
            return false;
        }
        let mut launches = self.0.lock().unwrap();
        if launches.contains_key(control)
            || launches.contains_key(bearer)
            || launches.values().any(|launch| launch.model_bearer == control || launch.model_bearer == bearer)
        {
            return false;
        }
        launches.insert(
            control.into(),
            Launch {
                model_bearer: bearer.into(),
                device: device.into(),
                release: release.into(),
                model: model.into(),
                turns: HashMap::new(),
            },
        );
        true
    }

    /// Call after validating the original managed Hook or matched native journal evidence.
    pub(crate) fn admit(&self, control: &str, native_sid: &str, generation: &str) -> bool {
        if !generation_id(generation)
            || native_sid.is_empty()
            || native_sid.len() > 128
            || !native_sid.bytes().all(|b| b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_'))
        {
            return false;
        }
        let mut launches = self.0.lock().unwrap();
        let Some(launch) = launches.get_mut(control) else { return false };
        if launch.turns.len() >= 65536 && !launch.turns.contains_key(generation) {
            return false;
        }
        match launch.turns.entry(generation.to_owned()) {
            Entry::Vacant(slot) => {
                slot.insert(Turn::Active(native_sid.to_owned()));
                true
            }
            Entry::Occupied(mut slot) => match slot.get() {
                Turn::Active(owner) if owner == native_sid => true,
                Turn::Active(_) => {
                    slot.insert(Turn::Conflicted);
                    false
                }
                _ => false,
            },
        }
    }

    pub(crate) fn finish(&self, control: &str, native_sid: &str, generation: &str) -> bool {
        let mut launches = self.0.lock().unwrap();
        let Some(slot) = launches.get_mut(control).and_then(|launch| launch.turns.get_mut(generation)) else {
            return false;
        };
        match slot {
            Turn::Active(owner) if owner == native_sid => {
                *slot = Turn::Ended(native_sid.to_owned());
                true
            }
            Turn::Ended(owner) => owner == native_sid,
            _ => false,
        }
    }

    pub(crate) fn resolve(&self, bearer: &str, generation: &str) -> Option<LaunchBinding> {
        if !generation_id(generation) {
            return None;
        }
        let launches = self.0.lock().unwrap();
        let launch = launches.values().find(|launch| launch.model_bearer == bearer)?;
        let Turn::Active(sid) = launch.turns.get(generation)? else { return None };
        Some(LaunchBinding {
            session_id: crate::native_capture::session_id(&launch.device, "workbuddy", sid),
            agent: "workbuddy".into(),
            release_id: Some(launch.release.clone()),
            approved_model: Some(launch.model.clone()),
            first_native_session: None,
        })
    }

    pub(crate) fn stop(&self, control: &str) {
        self.0.lock().unwrap().remove(control);
    }
    pub(crate) fn clear(&self) {
        self.0.lock().unwrap().clear();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const A: &str = "0198a1b2c3d47e5f8a9b0c1d2e3f4a5b";
    const B: &str = "0198a1b2c3d47e5f8a9b0c1d2e3f4a5c";

    #[test]
    fn two_native_tasks_share_a_provider_profile_but_keep_distinct_turns() {
        let state = Turns::default();
        assert!(state.start("hook", "model-key", "device", "release", "allowed"));
        assert!(!state.admit("model-key", "task-A", A));
        assert!(state.admit("hook", "task-A", A));
        assert!(state.admit("hook", "task-B", B));
        let first = state.resolve("model-key", A).unwrap();
        let second = state.resolve("model-key", B).unwrap();
        assert_ne!(first.session_id, second.session_id);
        assert_eq!(state.resolve("model-key", A).unwrap().session_id, first.session_id);
        assert!(state.resolve("hook", A).is_none());
        assert!(state.resolve("model-key", "").is_none());
        assert!(state.admit("hook", "task-A", A)); // repeated delivery of the same authenticated Hook
        assert!(state.finish("hook", "task-A", A));
        assert!(state.finish("hook", "task-A", A));
        assert!(!state.finish("hook", "task-B", A));
        assert!(state.resolve("model-key", A).is_none());
        assert!(!state.admit("hook", "task-A", A));
        assert_eq!(second.approved_model.as_deref(), Some("allowed"));
        assert_eq!(second.release_id.as_deref(), Some("release"));
        state.stop("hook");
        assert!(state.resolve("model-key", B).is_none());
    }

    #[test]
    fn a_conflicting_native_owner_quarantines_the_turn_only_in_its_launch() {
        let state = Turns::default();
        assert!(state.start("a-control", "a-key", "device-a", "release", "allowed"));
        assert!(state.start("b-control", "b-key", "device-b", "release", "allowed"));
        assert!(!state.start("b-key", "other", "device", "release", "allowed"));
        assert!(state.admit("a-control", "task-A", A));
        assert!(state.admit("b-control", "task-A", A));
        assert!(!state.admit("a-control", "task-B", A));
        assert!(state.resolve("a-key", A).is_none());
        assert!(state.resolve("b-key", A).is_some());
        assert!(!state.admit("b-control", "../bad", B));
        assert!(!state.admit("b-control", "task-A", &A.to_uppercase()));
        state.clear();
        assert!(state.resolve("b-key", A).is_none());
    }
}
