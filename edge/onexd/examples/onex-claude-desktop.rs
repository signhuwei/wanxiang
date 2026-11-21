//! Qualification launcher for the vendor's macOS Claude Desktop Code wrapper.

#[cfg(unix)]
mod qualification {
    use std::env;
    use std::fs::{self, File, OpenOptions};
    use std::io::{Read, Write};
    use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
    use std::os::unix::process::CommandExt;
    use std::path::{Path, PathBuf};
    use std::process::Command;
    use std::time::Duration;

    use anyhow::{Context, Result, bail, ensure};
    use reqwest::{Client, Url};
    use serde::{Deserialize, Serialize};
    use serde_json::{Value, json};
    use sha2::{Digest, Sha256};
    use uuid::Uuid;

    const SETTINGS_LIMIT: u64 = 32 * 1024;
    const CREDENTIAL_BYTES: usize = 64;

    #[derive(Deserialize, Serialize)]
    #[serde(deny_unknown_fields)]
    struct Plan {
        gateway: String,
        model: String,
        workspace: PathBuf,
        engine: PathBuf,
        engine_sha256: String,
        code_profile: PathBuf,
        launch_credential: PathBuf,
    }

    impl Plan {
        fn validate(&self) -> Result<Url> {
            let gateway = Url::parse(&self.gateway).context("invalid qualification gateway")?;
            ensure!(
                gateway.scheme() == "http"
                    && gateway.host_str() == Some("127.0.0.1")
                    && gateway.port().is_some_and(|port| port != 0)
                    && gateway.path() == "/"
                    && gateway.query().is_none()
                    && gateway.fragment().is_none()
                    && gateway.username().is_empty()
                    && gateway.password().is_none(),
                "qualification gateway must be a loopback HTTP origin with an explicit port"
            );
            ensure!(valid_model(&self.model), "invalid contract model ID");
            ensure!(
                self.engine_sha256.len() == 64
                    && self.engine_sha256.bytes().all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte)),
                "invalid pinned engine digest"
            );
            ensure!(
                self.workspace.is_dir() && self.workspace.canonicalize()? == self.workspace,
                "workspace must be an existing canonical directory"
            );
            private(&self.code_profile, true)?;
            private(&self.launch_credential, false)?;
            ensure!(
                !self.launch_credential.starts_with(&self.code_profile)
                    && !self.launch_credential.starts_with(&self.workspace),
                "keep the launch credential outside both the workspace and the Code profile"
            );
            Ok(gateway)
        }
    }

    fn valid_model(value: &str) -> bool {
        !value.is_empty()
            && value.len() <= 128
            && value
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.' | b':' | b'/'))
    }

    fn valid_token(value: &str) -> bool {
        value.len() == CREDENTIAL_BYTES
            && value.bytes().all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    }

    fn private(path: &Path, directory: bool) -> Result<()> {
        let metadata = path.symlink_metadata().context("cannot inspect private qualification path")?;
        ensure!(
            path.canonicalize()? == path
                && !metadata.file_type().is_symlink()
                && (if directory { metadata.is_dir() } else { metadata.is_file() })
                && metadata.permissions().mode() & 0o077 == 0,
            "qualification path must be canonical and private"
        );
        Ok(())
    }

    fn load_plan(path: &Path) -> Result<Plan> {
        private(path, false)?;
        let file = File::open(path).context("cannot read qualification plan")?;
        serde_json::from_reader(file.take(SETTINGS_LIMIT)).context("invalid qualification plan")
    }

    fn require_engine(plan: &Plan, path: &Path) -> Result<()> {
        ensure!(
            path.is_absolute() && path.canonicalize()? == plan.engine && plan.engine.is_file(),
            "vendor CLI path differs from the pinned engine"
        );
        let mut engine = File::open(&plan.engine).context("cannot read pinned engine")?;
        let mut digest = Sha256::new();
        std::io::copy(&mut engine, &mut digest).context("cannot hash pinned engine")?;
        ensure!(
            format!("{:x}", digest.finalize()) == plan.engine_sha256,
            "vendor CLI digest differs from the pinned engine"
        );
        Ok(())
    }

    #[cfg(target_os = "macos")]
    fn verify_engine_signature(path: &Path) -> Result<()> {
        let requirement = r#"=anchor apple generic and identifier "com.anthropic.claude-code" and certificate leaf[subject.OU] = "Q6L2SF6YDW""#;
        let status =
            Command::new("/usr/bin/codesign").args(["--verify", "--strict", "-R", requirement]).arg(path).status()?;
        ensure!(status.success(), "pinned engine failed Anthropic signature verification");
        Ok(())
    }

    #[cfg(not(target_os = "macos"))]
    fn verify_engine_signature(_: &Path) -> Result<()> {
        bail!("Claude Desktop signature verification requires macOS")
    }

    fn policy(plan: &Plan, executable: &Path, plan_path: &Path) -> Result<(Value, Value)> {
        let wrapper = serde_json::to_string(&json!([executable, "wrap", plan_path]))?;
        let desktop = json!({
            "deploymentMode": "3p",
            "disableDeploymentModeChooser": true,
            "desktopHome": "off",
            "chatTabEnabled": false,
            "coworkTabEnabled": false,
            "isClaudeCodeForDesktopEnabled": true,
            "claudeCodeProcessWrapperEnabled": true,
            "sshHostAllowlist": [],
            "sshConfigs": [],
            "disableWslSessions": true,
            "allowedWorkspaceFolders": [{"path":plan.workspace,"mode":"rw"}],
            "blockReadsOutsideWorkingDirectories": true,
            "scheduledTasksEnabled": false,
            "disableAutoUpdates": true,
            "disableDeepLinkRegistration": true,
            "developerModeEnabled": false,
            "autoModeEnabled": false,
            "disableBypassPermissionsMode": true,
            "inferenceProvider": "gateway",
            "inferenceGatewayBaseUrl": plan.gateway,
            "inferenceGatewayAuthScheme": "bearer",
            "inferenceCredentialHelper": executable,
            "inferenceCredentialHelperArgs": ["desktop-credential-unavailable"],
            "inferenceModels": [{"name": plan.model}],
            "modelDiscoveryEnabled": false,
            "modelCatalogEnabled": false,
            "alwaysStartWithDefaultModel": true
        });
        let code = json!({
            "parentSettingsBehavior": "merge",
            "processWrapper": wrapper,
            "permissions": {
                "disableBypassPermissionsMode": "disable",
                "disableAutoMode": "disable"
            }
        });
        Ok((desktop, code))
    }

    fn write_policy(path: &Path, value: &Value) -> Result<()> {
        let mut bytes = serde_json::to_vec_pretty(value)?;
        bytes.push(b'\n');
        let mut file = OpenOptions::new().write(true).create_new(true).mode(0o600).open(path)?;
        file.write_all(&bytes)?;
        file.sync_all()?;
        Ok(())
    }

    fn prepare(plan_path: &Path, directory: &Path) -> Result<()> {
        let plan = load_plan(plan_path)?;
        plan.validate()?;
        require_engine(&plan, &plan.engine)?;
        verify_engine_signature(&plan.engine)?;
        private(directory, true)?;
        let executable = env::current_exe()?.canonicalize()?;
        let (desktop, code) = policy(&plan, &executable, plan_path)?;
        let output = directory.join("claude-policy");
        ensure!(!output.exists(), "qualification policy directory already exists");
        let staged = tempfile::tempdir_in(directory)?;
        write_policy(&staged.path().join("claude-desktop-managed.json"), &desktop)?;
        write_policy(&staged.path().join("claude-code-managed.json"), &code)?;
        fs::rename(staged.path(), output).context("cannot publish the two qualification policies")?;
        Ok(())
    }

    #[derive(Debug, PartialEq, Eq)]
    enum Invocation {
        Version,
        Session(Uuid),
    }

    fn invocation(args: &[String], approved_model: &str) -> Result<Invocation> {
        if args == ["--version"] {
            return Ok(Invocation::Version);
        }
        let mut native_id = None;
        let mut model_seen = false;
        let mut args = args.iter();
        while let Some(argument) = args.next() {
            if argument == "--" {
                break;
            }
            let (name, inline) =
                argument.split_once('=').map_or((argument.as_str(), None), |(name, value)| (name, Some(value)));
            match name {
                "--resume" | "-r" | "--session-id" => {
                    let value = inline.or_else(|| args.next().map(String::as_str)).context("missing native UUID")?;
                    let id = Uuid::parse_str(value).context("invalid native UUID")?;
                    ensure!(!id.is_nil() && id.hyphenated().to_string() == value, "native UUID is not canonical");
                    ensure!(native_id.replace(id).is_none(), "multiple native UUIDs in one invocation");
                }
                "--model" => {
                    let value = inline.or_else(|| args.next().map(String::as_str));
                    ensure!(!model_seen && value == Some(approved_model), "model differs from the capability contract");
                    model_seen = true;
                }
                "--permission-mode" => {
                    let mode = inline.or_else(|| args.next().map(String::as_str));
                    ensure!(
                        mode.is_some_and(|mode| !matches!(mode, "auto" | "bypassPermissions")),
                        "permission mode is outside the qualified local Code path"
                    );
                }
                "-c"
                | "--continue"
                | "--fork-session"
                | "--remote"
                | "--remote-control"
                | "--teleport"
                | "--settings"
                | "--setting-sources"
                | "--dangerously-skip-permissions"
                | "--allow-dangerously-skip-permissions" => {
                    bail!("invocation is outside the qualified local Code path")
                }
                _ => {}
            }
        }
        Ok(Invocation::Session(native_id.context("the vendor must supply an explicit native session UUID")?))
    }

    #[derive(Deserialize)]
    struct ModelCredential {
        model_token: String,
    }

    async fn model_credential(origin: &Url, path: &Path, native_id: Uuid) -> Result<String> {
        let mut launch_token = String::new();
        File::open(path)?
            .take((CREDENTIAL_BYTES + 1) as u64)
            .read_to_string(&mut launch_token)
            .context("cannot read private launch credential")?;
        ensure!(valid_token(&launch_token), "invalid private launch credential");
        let client = Client::builder()
            .no_proxy()
            .redirect(reqwest::redirect::Policy::none())
            .timeout(Duration::from_secs(5))
            .build()?;
        let request = json!({"native_id":native_id.to_string(),"records":[]});
        let response = client
            .post(origin.join("/v1/onex/desktop/session")?)
            .bearer_auth(launch_token)
            .header("content-type", "application/json")
            .body(serde_json::to_vec(&request)?)
            .send()
            .await
            .context("cannot bind native Code session")?;
        ensure!(response.status().is_success(), "local session binding rejected ({})", response.status());
        let response: ModelCredential = serde_json::from_slice(&response.bytes().await?)
            .map_err(|_| anyhow::anyhow!("invalid local session binding response"))?;
        ensure!(valid_token(&response.model_token), "invalid local model credential");
        Ok(response.model_token)
    }

    fn child(plan: &Plan, origin: &Url, args: &[String], model_token: Option<&str>) -> Command {
        let mut child = Command::new(&plan.engine);
        child
            .args(args)
            .env_remove("ANTHROPIC_API_KEY")
            .env_remove("ANTHROPIC_AUTH_TOKEN")
            .env_remove("ANTHROPIC_CUSTOM_HEADERS")
            .env_remove("CLAUDE_CODE_OAUTH_TOKEN")
            .env_remove("CLAUDE_CODE_PROCESS_WRAPPER")
            .env_remove("CLAUDE_CODE_USE_BEDROCK")
            .env_remove("CLAUDE_CODE_USE_VERTEX")
            .env_remove("CLAUDE_CODE_USE_FOUNDRY")
            .env_remove("CLAUDE_CODE_PROXY_RESOLVES_HOSTS")
            .env_remove("HTTPS_PROXY")
            .env_remove("https_proxy")
            .env_remove("HTTP_PROXY")
            .env_remove("http_proxy")
            .env_remove("ALL_PROXY")
            .env_remove("all_proxy")
            .env("CLAUDE_CONFIG_DIR", &plan.code_profile)
            .env("ANTHROPIC_BASE_URL", origin.as_str().trim_end_matches('/'))
            .env("ANTHROPIC_MODEL", &plan.model)
            .env("ANTHROPIC_DEFAULT_HAIKU_MODEL", &plan.model)
            .env("ANTHROPIC_DEFAULT_SONNET_MODEL", &plan.model)
            .env("ANTHROPIC_DEFAULT_OPUS_MODEL", &plan.model)
            .env("CLAUDE_CODE_SUBAGENT_MODEL", &plan.model);
        if let Some(token) = model_token {
            child.env("ANTHROPIC_AUTH_TOKEN", token);
        }
        child
    }

    async fn wrap(plan_path: &Path, engine: &Path, args: &[String]) -> Result<()> {
        let plan = load_plan(plan_path)?;
        let origin = plan.validate()?;
        let invocation = invocation(args, &plan.model)?;
        require_engine(&plan, engine)?;
        let model_token = match invocation {
            Invocation::Version => None,
            Invocation::Session(native_id) => {
                ensure!(
                    env::current_dir()?.canonicalize()? == plan.workspace,
                    "native working directory differs from the contract workspace"
                );
                Some(model_credential(&origin, &plan.launch_credential, native_id).await?)
            }
        };
        Err(child(&plan, &origin, args, model_token.as_deref()).exec())
            .context("cannot execute the pinned Claude Code CLI")
    }

    pub(super) async fn run() -> Result<()> {
        let args: Vec<String> = env::args().skip(1).collect();
        match args.as_slice() {
            [operation, plan, directory] if operation == "prepare" => prepare(Path::new(plan), Path::new(directory)),
            [operation, plan, engine, rest @ ..] if operation == "wrap" => {
                wrap(Path::new(plan), Path::new(engine), rest).await
            }
            [operation] if operation == "desktop-credential-unavailable" => {
                bail!("only a bound local Code session can obtain an inference credential")
            }
            _ => bail!("usage: onex-claude-desktop prepare <private-plan.json> <private-output-directory>"),
        }
    }

    #[cfg(test)]
    mod tests {
        use super::*;

        use axum::{Json, Router, http::HeaderMap, routing::post};

        const NATIVE: &str = "627946b7-3d12-4ecb-882a-599cc2564c15";
        const MODEL: &str = "claude-model-from-contract";

        fn args(values: &[&str]) -> Vec<String> {
            values.iter().map(|value| (*value).into()).collect()
        }

        fn fixture(root: &Path) -> Plan {
            let path = |name| root.join(name);
            let plan = Plan {
                gateway: "http://127.0.0.1:18703".into(),
                model: MODEL.into(),
                workspace: path("workspace"),
                engine: path("claude"),
                engine_sha256: format!("{:x}", Sha256::digest(b"pinned vendor binary")),
                code_profile: path("code-profile"),
                launch_credential: path("launch-token"),
            };
            fs::create_dir(&plan.workspace).unwrap();
            fs::create_dir(&plan.code_profile).unwrap();
            fs::set_permissions(&plan.code_profile, fs::Permissions::from_mode(0o700)).unwrap();
            fs::write(&plan.engine, b"pinned vendor binary").unwrap();
            OpenOptions::new().write(true).create_new(true).mode(0o600).open(&plan.launch_credential).unwrap();
            plan
        }

        #[test]
        fn binds_new_and_resumed_vendor_invocations_with_stable_native_uuid() {
            let expected = Invocation::Session(Uuid::parse_str(NATIVE).unwrap());
            assert_eq!(invocation(&args(&["--session-id", NATIVE, "--model", MODEL]), MODEL).unwrap(), expected);
            assert_eq!(
                invocation(&args(&[&format!("--resume={NATIVE}"), "--", "--model=example"]), MODEL).unwrap(),
                expected
            );
            assert_eq!(invocation(&args(&["--version"]), MODEL).unwrap(), Invocation::Version);
        }

        #[test]
        fn denies_unbound_or_unapproved_launches() {
            for flags in [
                args(&["--resume"]),
                args(&["-c"]),
                args(&["--session-id", "other"]),
                args(&["--session-id", NATIVE, "--fork-session"]),
                args(&["--session-id", NATIVE, "--model=vendor-default"]),
                args(&["--session-id", NATIVE, "--resume", NATIVE]),
                args(&["--session-id", NATIVE, "--settings", "/unmanaged"]),
                args(&["--session-id", NATIVE, "--remote"]),
            ] {
                assert!(invocation(&flags, MODEL).is_err(), "{flags:?}");
            }
        }

        #[test]
        fn pins_loopback_profile_and_binary() {
            let temp = tempfile::tempdir().unwrap();
            let mut plan = fixture(&temp.path().canonicalize().unwrap());
            assert!(plan.validate().is_ok());
            assert!(require_engine(&plan, &plan.engine).is_ok());
            fs::write(&plan.engine, b"modified").unwrap();
            assert!(require_engine(&plan, &plan.engine).is_err());
            for gateway in [
                "https://127.0.0.1:18703",
                "http://localhost:18703",
                "http://127.0.0.1:18703/v1",
                "http://user@127.0.0.1:18703",
                "http://127.0.0.1:18703/?query=1",
                "http://192.168.3.211:18703",
            ] {
                plan.gateway = gateway.into();
                assert!(plan.validate().is_err(), "{gateway}");
            }
            plan.gateway = "http://127.0.0.1:18703".into();
            fs::set_permissions(&plan.launch_credential, fs::Permissions::from_mode(0o644)).unwrap();
            assert!(plan.validate().is_err());
        }

        #[test]
        fn managed_policy_uses_native_launcher_and_withholds_control_credential() {
            let temp = tempfile::tempdir().unwrap();
            let root = temp.path().canonicalize().unwrap();
            let plan = fixture(&root);
            let executable = root.join("OneX Tool");
            let plan_path = root.join("Code plan.json");
            let (desktop, code) = policy(&plan, &executable, &plan_path).unwrap();
            assert_eq!(desktop["desktopHome"], "off");
            assert_eq!(desktop["deploymentMode"], "3p");
            assert_eq!(desktop["inferenceModels"], json!([{"name":MODEL}]));
            assert_eq!(desktop["inferenceCredentialHelperArgs"], json!(["desktop-credential-unavailable"]));
            assert_eq!(code["parentSettingsBehavior"], "merge");
            assert_eq!(code["permissions"]["disableAutoMode"], "disable");
            let wrapper: Value = serde_json::from_str(code["processWrapper"].as_str().unwrap()).unwrap();
            assert_eq!(wrapper, json!([executable, "wrap", plan_path]));
            assert!(!desktop.to_string().contains("launch-token"));
            assert!(!code.to_string().contains("launch-token"));
            let origin = plan.validate().unwrap();
            let cli = child(&plan, &origin, &[], Some("loopback-session-token"));
            let get_env = |key: &str| cli.get_envs().find(|(name, _)| name == &key).unwrap().1;
            assert_eq!(get_env("ANTHROPIC_API_KEY"), None);
            assert_eq!(get_env("CLAUDE_CODE_OAUTH_TOKEN"), None);
            assert_eq!(get_env("ANTHROPIC_AUTH_TOKEN").unwrap(), "loopback-session-token");
        }

        #[tokio::test]
        async fn exchanges_the_launch_capability_only_for_the_explicit_native_uuid() {
            let control = "a".repeat(CREDENTIAL_BYTES);
            let session = "b".repeat(CREDENTIAL_BYTES);
            let temp = tempfile::tempdir().unwrap();
            let root = temp.path().canonicalize().unwrap();
            let mut plan = fixture(&root);
            fs::write(&plan.launch_credential, &control).unwrap();

            let listener = tokio::net::TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, 0)).await.unwrap();
            plan.gateway = format!("http://{}", listener.local_addr().unwrap());
            let router = Router::new().route(
                "/v1/onex/desktop/session",
                post({
                    let session = session.clone();
                    move |headers: HeaderMap, Json(request): Json<Value>| async move {
                        assert_eq!(headers["authorization"], format!("Bearer {control}"));
                        assert_eq!(request, json!({"native_id":NATIVE,"records":[]}));
                        Json(json!({"model_token":session}))
                    }
                }),
            );
            let server = tokio::spawn(async move { axum::serve(listener, router).await.unwrap() });
            let credential =
                model_credential(&plan.validate().unwrap(), &plan.launch_credential, Uuid::parse_str(NATIVE).unwrap())
                    .await;
            server.abort();
            assert_eq!(credential.unwrap(), session);
        }
    }
}

#[cfg(unix)]
#[tokio::main(flavor = "current_thread")]
async fn main() -> anyhow::Result<()> {
    qualification::run().await
}

#[cfg(not(unix))]
fn main() -> anyhow::Result<()> {
    anyhow::bail!("Claude Desktop qualification launcher requires macOS")
}
