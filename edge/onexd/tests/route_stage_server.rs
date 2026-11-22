use std::path::Path;
use std::time::Duration;

use onex_core::route_pool::CredentialRef;
use onexd::pricing::parse_ms;
use onexd::route_stage::{self, Input, Session};
use onexd::secret::DeviceKey;
use serde_json::Value;
use tokio::process::Command;

async fn seal_with_server() -> Value {
    let checkout = Path::new(env!("CARGO_MANIFEST_DIR")).join("../..");
    let mut command = Command::new("bun");
    command.args(["--no-env-file", "tests/e2e/routing/seal-sample.ts"]).current_dir(checkout).kill_on_drop(true);
    let output = tokio::time::timeout(Duration::from_secs(10), command.output())
        .await
        .expect("make sealed fixture before the test deadline")
        .expect("start Bun to call the Server credential code");
    assert!(output.status.success(), "{}", String::from_utf8_lossy(&output.stderr));
    serde_json::from_slice(&output.stdout).expect("Server helper returned JSON")
}

#[tokio::test]
async fn stages_real_server_envelopes_and_rejects_wrong_device_key() {
    let initial_seal = seal_with_server().await;
    let fresh_seal = seal_with_server().await;
    let initial = &initial_seal["config"];
    let resealed = &fresh_seal["config"];
    let policy = &initial["policy"];
    let session = Session {
        tenant_id: policy["tenant_id"].as_str().unwrap(),
        user_id: policy["user_id"].as_str().unwrap(),
        device_id: policy["device_id"].as_str().unwrap(),
    };
    let fixture: Value = serde_json::from_str(include_str!("../../../tests/fixtures/routing/p0-ab.json")).unwrap();
    let now_ms = parse_ms(fixture["clock_utc"].as_str().unwrap()).expect("valid fixture time");
    // This is the known fixture key used by seal-sample.ts, never a real device key.
    let key = DeviceKey::from_bytes([7; 32]);
    let input = Input { session, now_ms, device_key: &key, applied: None, revocation_revision: 0, adapters: &[] };
    let staged = route_stage::stage(initial, &input).expect("open the server-generated seals");
    assert_eq!(staged.labels.len(), 1);
    assert_eq!(staged.labels[0].input_multiplier_ppm, 4_000_000);
    assert_eq!(staged.labels[0].rate_version_id, "rate_m_12");
    assert_eq!(staged.credentials().len(), 2);

    for (id, version, plain) in [("cred_a", 1, "fixture-inference-key"), ("cred_b", 2, "fixture-inference-key-b")] {
        let reference = CredentialRef { credential_id: id.into(), credential_version: version };
        assert_eq!(staged.key(&reference), Some(plain));
    }

    // The production sealing function generates fresh envelopes on every run.
    assert_ne!(initial["route_pool"]["secrets"], resealed["route_pool"]["secrets"]);
    let previous = Input { applied: Some(&staged.identity), ..input };
    let same = route_stage::stage(resealed, &previous).expect("the same business projection may be resealed");
    assert!(same.resealed);
    assert_eq!(staged.identity, same.identity);

    let mut shuffled = resealed.clone();
    shuffled["route_pool"]["secrets"].as_array_mut().unwrap().reverse();
    assert!(route_stage::stage(&shuffled, &previous).unwrap().resealed);
    shuffled["route_pool"]["secrets"].as_array_mut().unwrap().pop();
    let incomplete = route_stage::stage(&shuffled, &previous).expect_err("a required envelope is missing");
    assert_eq!(incomplete.code, "missing_route_credential");

    let wrong_key = DeviceKey::generate();
    let wrong = Input { device_key: &wrong_key, ..previous };
    let rejected = route_stage::stage(initial, &wrong).expect_err("a different device cannot open the envelopes");
    assert_eq!(rejected.code, "invalid_config");
    assert_eq!(rejected.reason, "envelope_rejected");
}
