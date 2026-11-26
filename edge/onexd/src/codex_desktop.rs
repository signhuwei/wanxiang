//! Private launch policy and native stdio bridge for the pinned Codex Desktop build.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use anyhow::{Context, Result, bail, ensure};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

use crate::launch;

const PROVIDER: &str = "onex_codex_desktop";
const MODEL_TOKEN: &str = "ONEX_CODEX_DESKTOP_TOKEN";
const SCOPED_METHODS: &[&str] = &["thread/start", "thread/resume", "thread/fork", "turn/start"];

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct Plan {
    cli: PathBuf,
    cwd: PathBuf,
    config: PathBuf,
    router: String,
    model: String,
    control: String,
}

pub(crate) fn prepare(
    request: &crate::desktop_launch::Request<'_>,
    profile: &Path,
    data: &Path,
    run: &Path,
    cwd: &Path,
    env: &mut BTreeMap<String, String>,
    mcp: &[crate::tools::Mcp],
) -> Result<PathBuf> {
    crate::codex_launch::validate_project(cwd)?;
    let config = profile.join("codex");
    launch::private_dir(&config)?;
    let cli = request
        .entry
        .parent()
        .and_then(Path::parent)
        .context("missing Codex application directory")?
        .join("Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex");
    ensure!(cli.is_file(), "missing bundled Codex App Server");
    let catalog = json!({"models":[{
        "slug":request.model, "display_name":request.model,
        "base_instructions":"Help the user with their coding tasks.",
        "supported_reasoning_levels":[], "shell_type":"shell_command",
        "visibility":"list", "supported_in_api":true, "priority":0,
        "support_verbosity":false, "truncation_policy":{"mode":"tokens", "limit":10000},
        "experimental_supported_tools":[], "input_modalities":["text"],
        "context_window":32768, "max_context_window":32768
    }]});
    crate::desktop_launch::publish(&config, "models.json", &serde_json::to_vec(&catalog)?)?;
    let plan = Plan {
        cli,
        cwd: cwd.to_owned(),
        config: config.clone(),
        router: request.router.to_owned(),
        model: request.model.to_owned(),
        control: request.token.to_owned(),
    };
    let mut settings = plan.settings()?;
    settings.push(r#"desktop.conversationDetailMode = "STEPS_COMMANDS""#.into());
    for server in mcp {
        let name = format!("mcp_servers.{}", server.name);
        let command = crate::desktop_launch::path_text(&server.command)?;
        settings.push(format!("{name}.command = {}", crate::codex_launch::quote(&command)));
        settings.push(format!("{name}.args = {}", serde_json::to_string(&server.args)?));
        settings.push(format!("{name}.required = true"));
        for key in [MODEL_TOKEN, "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_API_KEY", "OPENAI_API_KEY"] {
            settings.push(format!("{name}.env.{key} = \"\""));
        }
    }
    crate::desktop_launch::publish(&config, "config.toml", settings.join("\n").as_bytes())?;
    let plan_file = run.join("codex-desktop.json");
    launch::write_private(&plan_file, &serde_json::to_vec(&plan)?)?;
    let wrapper = run.join("codex");
    write_wrapper(&wrapper, &plan_file)?;
    env.insert("CODEX_HOME".into(), crate::desktop_launch::path_text(&config)?);
    env.insert("CODEX_ELECTRON_USER_DATA_PATH".into(), crate::desktop_launch::path_text(data)?);
    env.insert("CODEX_CLI_PATH".into(), crate::desktop_launch::path_text(&wrapper)?);
    env.insert("CODEX_APP_SERVER_FORCE_CLI".into(), "1".into());
    env.insert("CODEX_APP_SERVER_USE_LOCAL_DAEMON".into(), "0".into());
    Ok(config)
}

#[cfg(unix)]
fn write_wrapper(wrapper: &Path, plan: &Path) -> Result<()> {
    use std::os::unix::fs::PermissionsExt;
    let daemon = std::env::current_exe()?;
    let shell_arg = |path: &Path| -> Result<String> {
        Ok(format!("'{}'", crate::desktop_launch::path_text(path)?.replace('\'', "'\\''")))
    };
    launch::write_private(
        wrapper,
        format!("#!/bin/sh\nexec {} codex-desktop-app-server {} \"$@\"\n", shell_arg(&daemon)?, shell_arg(plan)?,)
            .as_bytes(),
    )?;
    std::fs::set_permissions(wrapper, std::fs::Permissions::from_mode(0o700))?;
    Ok(())
}

#[cfg(not(unix))]
fn write_wrapper(_: &Path, _: &Path) -> Result<()> {
    bail!("Codex Desktop runtime is supported on macOS")
}

impl Plan {
    fn settings(&self) -> Result<Vec<String>> {
        let quote = crate::codex_launch::quote;
        let endpoint = format!("http://{}/v1", self.router);
        let catalog = crate::desktop_launch::path_text(&self.config.join("models.json"))?;
        let provider = format!("model_providers.{PROVIDER}");
        Ok([
            ("model".into(), quote(&self.model)),
            ("model_provider".into(), quote(PROVIDER)),
            ("model_catalog_json".into(), quote(&catalog)),
            ("cli_auth_credentials_store".into(), quote("file")),
            ("forced_login_method".into(), quote("api")),
            (format!("{provider}.name"), quote("OneX")),
            (format!("{provider}.base_url"), quote(&endpoint)),
            (format!("{provider}.env_key"), quote(MODEL_TOKEN)),
            (format!("{provider}.wire_api"), quote("responses")),
            (format!("{provider}.requires_openai_auth"), "false".into()),
            (format!("{provider}.supports_websockets"), "false".into()),
            (format!("{provider}.request_max_retries"), "0".into()),
            (format!("{provider}.stream_max_retries"), "0".into()),
            ("check_for_update_on_startup".into(), "false".into()),
            ("project_doc_max_bytes".into(), "0".into()),
            ("respect_system_proxy".into(), "false".into()),
            ("web_search".into(), quote("disabled")),
            ("features.plugins".into(), "false".into()),
            ("features.secret_auth_storage".into(), "false".into()),
            ("analytics.enabled".into(), "false".into()),
            ("feedback.enabled".into(), "false".into()),
            ("shell_environment_policy.exclude".into(), format!("[{}]", quote(MODEL_TOKEN))),
        ]
        .into_iter()
        .map(|(key, value)| format!("{key} = {value}"))
        .collect())
    }

    fn allow_request(&self, message: &Value) -> bool {
        let Some(method) = message["method"].as_str() else { return true };
        if matches!(
            method,
            "account/login/start"
                | "account/logout"
                | "account/login/cancel"
                | "account/sessions/add"
                | "account/sessions/switch"
                | "account/sessions/logout"
                | "accountSession/switch"
                | "thread/realtime/start"
                | "thread/inject_items"
                | "externalAgentConfig/import"
        ) {
            return false;
        }
        let params = &message["params"];
        let config_file = self.config.join("config.toml");
        let private_config = params["filePath"].is_null()
            || params["filePath"].as_str().and_then(|file| Path::new(file).canonicalize().ok()).as_ref()
                == Some(&config_file);
        let desktop_preference = |edit: &Value| match edit["keyPath"].as_str() {
            Some("desktop.conversationDetailMode") => edit["value"] == "STEPS_COMMANDS",
            Some("desktop.migratedFollowUpQueueToSteer") => edit["value"].is_boolean(),
            _ => false,
        };
        if method == "config/value/write" {
            return private_config && desktop_preference(params);
        }
        if method == "config/batchWrite" {
            return private_config
                && params["edits"].as_array().is_some_and(|edits| edits.iter().all(desktop_preference));
        }
        if !SCOPED_METHODS.contains(&method) {
            return true;
        }
        let allowed_cwd = |value: &Value| {
            value
                .as_str()
                .and_then(|cwd| Path::new(cwd).canonicalize().ok())
                .is_some_and(|cwd| cwd == self.cwd || is_private_work_dir(&self.config, &cwd))
        };
        let model = (params["model"].is_null() || params["model"] == self.model)
            && (params["modelProvider"].is_null() || params["modelProvider"] == PROVIDER);
        let workspace = (params["cwd"].is_null() || allowed_cwd(&params["cwd"]))
            && (params["runtimeWorkspaceRoots"].is_null()
                || params["runtimeWorkspaceRoots"].as_array().is_some_and(|roots| roots.iter().all(allowed_cwd)));
        let rollout = params["path"].is_null()
            || (matches!(method, "thread/resume" | "thread/fork")
                && params["path"].as_str().zip(params["threadId"].as_str()).is_some_and(|(path, thread)| {
                    crate::native_capture::codex_desktop_rollout(Path::new(path), &self.config, &self.cwd, thread)
                }));
        if !model || !workspace || !rollout {
            eprintln!(
                "OneX Codex Desktop policy denied {method} (model={model}, workspace={workspace}, rollout={rollout})"
            );
        }
        model && workspace && rollout
    }
}

pub(crate) fn is_private_work_dir(config: &Path, cwd: &Path) -> bool {
    config.parent().is_some_and(|profile| {
        let documents = profile.join("home/Documents");
        cwd.starts_with(documents.join("Codex")) || cwd.starts_with(documents.join("ChatGPT"))
    })
}

async fn read_line(reader: &mut (impl tokio::io::AsyncBufRead + Unpin), line: &mut Vec<u8>) -> Result<bool> {
    use tokio::io::{AsyncBufReadExt, AsyncReadExt};
    const MAX_LINE: u64 = 16 * 1024 * 1024;
    reader.take(MAX_LINE + 1 - line.len() as u64).read_until(b'\n', line).await?;
    ensure!(line.len() as u64 <= MAX_LINE, "Codex App Server frame exceeds the size limit");
    Ok(!line.is_empty())
}

fn app_server_args(args: &[std::ffi::OsString]) -> Result<(bool, Vec<&std::ffi::OsStr>)> {
    let args = args.strip_prefix(&["-c".into(), "features.code_mode_host=true".into()]).unwrap_or(args);
    let Some((command, args)) = args.split_first() else { bail!("missing Codex App Server command") };
    ensure!(command == "app-server", "unrecognized Codex launch command");
    let args = args.strip_prefix(&["--analytics-default-enabled".into()]).unwrap_or(args);
    let mut startup = false;
    let mut forwarded = Vec::new();
    let mut iter = args.iter();
    while let Some(arg) = iter.next() {
        match arg.to_str() {
            Some("-c") => {
                // The signed desktop supplies these switches when the local tools
                // socket or the vendor's auth-storage feature gate is available.
                // Recognize their exact wire form without forwarding either override.
                ensure!(
                    matches!(
                        iter.next().and_then(|value| value.to_str()),
                        Some(
                            "plugins.codex-app-tools@openai-bundled.mcp_servers.codex_app.enabled=false"
                                | "plugins.codex-app-tools@openai-bundled.mcp_servers.codex_app.enabled=true"
                                | "features.secret_auth_storage=true"
                        )
                    ),
                    "unrecognized native app-server configuration"
                );
            }
            Some("--print-startup-config") if !startup => {
                startup = true;
                forwarded.push(arg.as_os_str());
            }
            Some("--startup-client-info") => {
                let value = iter.next().context("missing native startup client metadata")?;
                ensure!(
                    value.len() <= 4096
                        && value
                            .to_str()
                            .and_then(|value| serde_json::from_str::<Value>(value).ok())
                            .is_some_and(|value| value.is_object()),
                    "invalid native startup client metadata"
                );
                forwarded.extend([arg.as_os_str(), value.as_os_str()]);
            }
            Some("--listen") => {
                ensure!(iter.next().is_some_and(|value| value == "stdio://"), "Codex App Server must use stdio");
            }
            _ => bail!("unrecognized Codex app-server launch option"),
        }
    }
    Ok((startup, forwarded))
}

/// Called only as the private launcher subcommand, before daemon startup.
#[doc(hidden)]
pub async fn app_server(args: Vec<std::ffi::OsString>) -> Result<()> {
    use std::process::Stdio;
    use tokio::io::{AsyncWriteExt, BufReader};

    let Some((file, vendor_args)) = args.split_first() else { bail!("missing private Codex launch plan") };
    ensure!(std::fs::symlink_metadata(file)?.is_file(), "invalid Codex launch plan");
    let plan: Plan = serde_json::from_slice(&std::fs::read(file)?)?;
    let mut child = tokio::process::Command::new(&plan.cli);
    child
        .current_dir(&plan.cwd)
        .env("CODEX_HOME", &plan.config)
        .env("NO_PROXY", "127.0.0.1,localhost")
        .env("no_proxy", "127.0.0.1,localhost");
    if vendor_args == ["--version"] || vendor_args == ["-V"] {
        ensure!(child.arg("--version").status().await?.success(), "Codex version check failed");
        return Ok(());
    }
    let (startup, app_server_args) = app_server_args(vendor_args)?;
    let address: std::net::SocketAddr = plan.router.parse().context("invalid Codex gateway origin")?;
    ensure!(address.ip() == std::net::Ipv4Addr::LOCALHOST && address.port() != 0, "Codex gateway must be local");
    let origin = format!("http://{address}");
    let control = reqwest::Client::builder()
        .no_proxy()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(std::time::Duration::from_secs(3))
        .build()?;
    for option in plan.settings()? {
        child.args(["-c", &option]);
    }
    child
        .arg("app-server")
        .args(app_server_args)
        .env(MODEL_TOKEN, crate::desktop_sessions::codex_model_token(&plan.control));
    if startup {
        ensure!(child.status().await?.success(), "Codex startup configuration probe failed");
        return Ok(());
    }
    child.stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::null()).kill_on_drop(true);
    let mut child = child.spawn().context("could not launch the signed Codex App Server")?;
    let mut engine_in = child.stdin.take().context("missing Codex App Server input pipe")?;
    let mut engine_out = BufReader::new(child.stdout.take().context("missing Codex App Server output pipe")?);
    let mut from_gui = BufReader::new(tokio::io::stdin());
    let mut to_gui = tokio::io::stdout();
    let mut gui_line = Vec::new();
    let mut engine_line = Vec::new();
    let mut initialize_id = None;
    loop {
        tokio::select! {
            ready = read_line(&mut from_gui, &mut gui_line) => {
                if !ready? {
                    engine_in.shutdown().await?;
                    break;
                }
                let mut msg: Value = serde_json::from_slice(&gui_line)?;
                if msg["method"] == "initialize" && !msg["id"].is_null() {
                    initialize_id = Some(msg["id"].clone());
                }
                if plan.allow_request(&msg) {
                    let guarded = msg["method"].as_str().is_some_and(|method| SCOPED_METHODS.contains(&method));
                    if guarded && msg["params"].as_object_mut().and_then(|params| params.remove("config")).is_some() {
                        engine_in.write_all(&serde_json::to_vec(&msg)?).await?;
                        engine_in.write_all(b"\n").await?;
                    } else {
                        engine_in.write_all(&gui_line).await?;
                    }
                    engine_in.flush().await?;
                } else if !msg["id"].is_null() {
                    let error = json!({"id":msg["id"],"error":{
                        "code":-32602,"message":"OneX restricts this window to its contracted workspace and model"
                    }});
                    to_gui.write_all(&serde_json::to_vec(&error)?).await?;
                    to_gui.write_all(b"\n").await?;
                    to_gui.flush().await?;
                }
                gui_line.clear();
            }
            ready = read_line(&mut engine_out, &mut engine_line) => {
                if !ready? {
                    break;
                }
                let msg: Value = serde_json::from_slice(&engine_line)?;
                if initialize_id.as_ref() == msg.get("id").filter(|id| !id.is_null()) && msg.get("result").is_some() {
                    initialize_id = None;
                    let reply = control.post(format!("{origin}/v1/onex/desktop/ready"))
                        .bearer_auth(&plan.control).send().await?;
                    ensure!(reply.status().is_success(), "OneX rejected the Codex app-server launch");
                }
                if let Some(method @ ("turn/started" | "turn/completed")) = msg["method"].as_str() {
                    let p = &msg["params"];
                    if let (Some(thread), Some(turn)) = (p["threadId"].as_str(),p["turn"]["id"].as_str()) {
                        let body = json!({"session":{"thread_id":thread,"turn_id":turn},"started":method == "turn/started"});
                        let reply = control.post(format!("{origin}/v1/onex/desktop/codex-turn"))
                            .bearer_auth(&plan.control).body(serde_json::to_vec(&body)?).send().await?;
                        ensure!(reply.status().is_success(), "OneX rejected the native Codex turn");
                    }
                }
                to_gui.write_all(&engine_line).await?;
                to_gui.flush().await?;
                engine_line.clear();
            }
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_only_original_native_stdio_arguments() {
        let native = [
            "-c",
            "features.code_mode_host=true",
            "app-server",
            "--analytics-default-enabled",
            "-c",
            "plugins.codex-app-tools@openai-bundled.mcp_servers.codex_app.enabled=false",
        ]
        .map(Into::into);
        let startup = ["app-server", "--print-startup-config", "--startup-client-info", "{}"].map(Into::into);
        let external = ["app-server", "--listen", "ws://127.0.0.1:46789"].map(Into::into);
        assert!(!app_server_args(&native).unwrap().0);
        assert!(app_server_args(&startup).unwrap().0);
        assert!(app_server_args(&external).is_err());

        let native_aqua = [
            "-c",
            "features.code_mode_host=true",
            "app-server",
            "--analytics-default-enabled",
            "-c",
            "features.secret_auth_storage=true",
            "-c",
            "plugins.codex-app-tools@openai-bundled.mcp_servers.codex_app.enabled=true",
        ]
        .map(Into::into);
        assert_eq!(app_server_args(&native_aqua).unwrap(), (false, Vec::new()));
        for invalid in [
            "plugins.codex-app-tools@openai-bundled.mcp_servers.codex_app.enabled=\"true\"",
            "plugins.codex-app-tools@openai-bundled.mcp_servers.codex_app.command=/tmp/other",
            "features.secret_auth_storage=true\nmodel=other",
            "cli_auth_credentials_store=keyring",
            "model=other",
        ] {
            assert!(app_server_args(&["app-server", "-c", invalid].map(Into::into)).is_err());
        }
    }

    #[test]
    fn keeps_native_requests_inside_private_workspaces_and_applies_only_approved_models() {
        let folder = tempfile::tempdir().unwrap();
        let root = folder.path().canonicalize().unwrap();
        let private = root.join("home/Documents/Codex/test");
        std::fs::create_dir_all(&private).unwrap();
        let plan = Plan {
            cli: PathBuf::new(),
            cwd: root.join("workspace"),
            config: root.join("codex"),
            router: "127.0.0.1:1".into(),
            model: "contract-model".into(),
            control: String::new(),
        };
        assert!(
            plan.allow_request(&json!({"method":"thread/start", "params":{"model":"contract-model", "cwd":private}}))
        );
        assert!(!plan.allow_request(&json!({"method":"thread/start", "params":{"model":"outside-contract"}})));
        assert!(!plan.allow_request(&json!({"method":"thread/start", "params":{"cwd":root}})));
        assert!(!plan.allow_request(&json!({"method":"account/sessions/switch"})));
        assert!(!plan.allow_request(
            &json!({"method":"config/value/write", "params":{"keyPath":"model_provider","value":"openai"}})
        ));
        assert!(plan.allow_request(&json!({"method":"config/value/write", "params":{
            "keyPath":"desktop.conversationDetailMode","value":"STEPS_COMMANDS"
        }})));
    }
}
