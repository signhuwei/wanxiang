use std::time::Duration;

use anyhow::{Context, Result, ensure};
use serde::Deserialize;
use serde_json::json;

use crate::credentials::{CredentialStore, DeviceCredentials, HistoryIdentity, HistoryScope};
use crate::secret::DeviceKey;

const RESUME_CONTEXT: &str = "onex-device-resume-v1";

#[derive(Deserialize)]
struct Scope {
    user: Identity,
    tenant: Identity,
}

#[derive(Deserialize)]
struct Identity {
    id: String,
}

#[derive(Deserialize)]
struct Challenge {
    key_id: String,
    nonce: String,
    ciphertext: String,
}

#[derive(Deserialize)]
struct Resumed {
    device_id: String,
    device_token: String,
}

async fn get_challenge(
    http: &reqwest::Client,
    server: &str,
    session: &str,
    identity: &HistoryIdentity,
) -> Result<reqwest::Response> {
    ensure!(
        identity.device_id.starts_with("dev_")
            && identity.device_id.len() <= 64
            && identity.device_id.bytes().all(|byte| byte.is_ascii_alphanumeric() || byte == b'_'),
        "invalid stored device identity"
    );
    Ok(http
        .post(format!("{server}/v1/devices/{}/resume-challenge", identity.device_id))
        .bearer_auth(session)
        .json(&json!({}))
        .send()
        .await?)
}

/// Recover the original device using both an authenticated account and possession of its retained key.
pub(crate) async fn resume(
    store: &dyn CredentialStore,
    server: &str,
    session: &str,
    current: Option<HistoryIdentity>,
) -> Result<Option<DeviceCredentials>> {
    ensure!(!session.is_empty() && session.len() <= 512, "invalid scoped login session");
    let http = reqwest::Client::builder()
        .no_proxy()
        .redirect(reqwest::redirect::Policy::none())
        .connect_timeout(Duration::from_secs(4))
        .timeout(Duration::from_secs(6))
        .build()?;
    let account: Scope =
        http.get(format!("{server}/v1/me")).bearer_auth(session).send().await?.error_for_status()?.json().await?;
    ensure!(!account.tenant.id.is_empty() && !account.user.id.is_empty(), "login is not scoped");
    let scope = HistoryScope { server, tenant_id: &account.tenant.id, user_id: &account.user.id };
    // A pre-upgrade device may first connect with an expired bearer, before
    // having an authenticated welcome that could create the scoped record.
    let mut pending = Vec::new();
    let (identity, challenge) = if let Some(identity) = match current {
        Some(identity) => Some(identity),
        None => store.load_history(&scope)?,
    } {
        let challenge = get_challenge(&http, server, session, &identity).await?.error_for_status()?;
        (identity, challenge)
    } else {
        pending = store.load_unscoped_history(server)?;
        let requests = pending.iter().rev().map(|identity| async {
            let response = get_challenge(&http, server, session, identity).await?;
            if response.status() == reqwest::StatusCode::NOT_FOUND {
                return Ok(None);
            }
            Ok::<_, anyhow::Error>(Some((identity.clone(), response.error_for_status()?)))
        });
        let Some(verified) = futures_util::future::try_join_all(requests).await?.into_iter().flatten().next() else {
            return Ok(None);
        };
        verified
    };
    let device = format!("{server}/v1/devices/{}", identity.device_id);
    let challenge: Challenge = challenge.json().await?;
    let key = DeviceKey::from_bytes(identity.device_key);
    let proof = key
        .open(RESUME_CONTEXT, &challenge.key_id, &challenge.nonce, &challenge.ciphertext)
        .ok()
        .context("history identity did not unlock its challenge")?;
    // The scoped server authorizes the challenge by account and encrypts it to
    // the recorded device key. Persist this association before rotating the bearer.
    store.save_history(&scope, &identity)?;
    let idempotency = crate::id::new("resume");
    let rotate = || {
        http.post(format!("{device}/resume"))
            .bearer_auth(session)
            .header("Idempotency-Key", &idempotency)
            .json(&json!({"proof": proof.as_str()}))
            .send()
    };
    let response = match rotate().await {
        Ok(response) if !response.status().is_server_error() => response,
        _ => rotate().await?,
    };
    let resumed: Resumed = response.error_for_status()?.json().await?;
    ensure!(
        resumed.device_id == identity.device_id && !resumed.device_token.is_empty(),
        "wrong device resume response"
    );
    if !pending.is_empty() {
        pending.retain(|record| record.device_id != identity.device_id);
        if let Err(error) = store.save_unscoped_history(server, &pending) {
            tracing::warn!(%error, "could not clean up the recovered pre-upgrade device key");
        }
    }
    Ok(Some(DeviceCredentials {
        server: server.to_owned(),
        device_id: resumed.device_id,
        device_token: resumed.device_token,
        device_key: identity.device_key,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::extract::State;
    use axum::http::{HeaderMap, StatusCode};
    use axum::routing::{get, post};
    use axum::{Json, Router};
    use base64::Engine;
    use serde_json::Value;
    use std::sync::{Arc, Mutex};

    use crate::credentials::{MemoryStore, fingerprint};
    use crate::outbox::{Kind, Outbox};

    const ORIG_ID: &str = "dev_original";
    const PROOF: &str = "authentic-device-proof";

    #[tokio::test]
    async fn upgrade_recovers_original_device_and_only_its_account_can_reopen_the_outbox() {
        let key = DeviceKey::from_bytes([7; 32]);
        let public = base64::engine::general_purpose::STANDARD.decode(key.public_b64()).unwrap();
        let (key_id, nonce, ciphertext) = crate::secret::seal_for_test(
            &public.try_into().unwrap(),
            [9; 32],
            [3; 24],
            b"onex-edge-secret-v1",
            RESUME_CONTEXT.as_bytes(),
            PROOF,
        );
        let envelope = json!({ "key_id": key_id, "nonce": nonce, "ciphertext": ciphertext });
        let attempted_key = Arc::new(Mutex::new(None::<String>));
        let app = Router::new()
            .route("/v1/me", get(|headers: HeaderMap| async move {
                let (tenant, user) = match headers["authorization"].to_str().unwrap() {
                    "Bearer account-a" => ("tenant-a", "user-a"),
                    "Bearer account-b" => ("tenant-a", "user-b"),
                    "Bearer account-c" => ("tenant-b", "user-a"),
                    _ => return Err(StatusCode::UNAUTHORIZED),
                };
                Ok(Json(json!({ "tenant": { "id": tenant }, "user": { "id": user } })))
            }))
            .route("/v1/devices/dev_original/resume-challenge", post(move |headers: HeaderMap| {
                let envelope = envelope.clone();
                async move {
                    if headers["authorization"] == "Bearer account-a" {
                        Ok(Json(envelope))
                    } else {
                        Err(StatusCode::NOT_FOUND)
                    }
                }
            }))
            .route("/v1/devices/dev_original/resume", post(|State(key): State<Arc<Mutex<Option<String>>>>, headers: HeaderMap, Json(body): Json<Value>| async move {
                assert_eq!(headers["authorization"], "Bearer account-a");
                assert_eq!(body, json!({ "proof": PROOF }));
                let idempotency = headers["idempotency-key"].to_str().unwrap();
                let mut attempted = key.lock().unwrap();
                if let Some(previous) = attempted.take() {
                    assert_eq!(previous, idempotency);
                    Ok(Json(json!({ "device_id": ORIG_ID, "device_token": "new-bearer" })))
                } else {
                    *attempted = Some(idempotency.to_owned());
                    Err(StatusCode::SERVICE_UNAVAILABLE)
                }
            }))
            .with_state(attempted_key);
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let origin = format!("http://{}", listener.local_addr().unwrap());
        let task = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });

        let store = MemoryStore::new();
        let legacy = HistoryIdentity { device_id: ORIG_ID.into(), device_key: key.bytes_for_keychain() };
        let dir = tempfile::tempdir().unwrap();
        let data = dir.path().join(fingerprint(&key.public_b64()));
        std::fs::create_dir(&data).unwrap();
        let outbox = data.join("outbox.sqlite");
        Outbox::open(&outbox).unwrap().append(Kind::Events, json!({"fixture":"pending"})).unwrap();
        assert!(resume(&store, &origin, "account-b", Some(legacy.clone())).await.is_err());
        store.save_unscoped_history(&origin, &[legacy]).unwrap();
        assert!(resume(&store, &origin, "account-b", None).await.unwrap().is_none());
        let resumed = resume(&store, &origin, "account-a", None).await.unwrap().unwrap();
        assert!(store.load_unscoped_history(&origin).unwrap().is_empty());
        assert_eq!(resumed.device_id, ORIG_ID);
        assert_eq!(resumed.device_token, "new-bearer");
        store.save(&resumed).unwrap();
        store.clear().unwrap();
        assert!(store.load().unwrap().is_none());
        assert!(resume(&store, &origin, "account-b", None).await.unwrap().is_none());
        assert!(resume(&store, &origin, "account-c", None).await.unwrap().is_none());
        let resumed = resume(&store, &origin, "account-a", None).await.unwrap().unwrap();
        let restored_id = fingerprint(&DeviceKey::from_bytes(resumed.device_key).public_b64());
        let reopened = Outbox::open(&dir.path().join(restored_id).join("outbox.sqlite")).unwrap();
        assert_eq!(reopened.pending(0, 10).unwrap().len(), 1);
        task.abort();
    }
}
