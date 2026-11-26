//! Construct each vendor's private profile and run the original GUI.

use std::path::{Path, PathBuf};

use anyhow::{Context, Result, bail};
use onex_core::ws::ModelLimits;
use serde_json::json;
use sha2::{Digest, Sha256};

use crate::launch::{self, Launch};
use crate::router::AgentProtocol;

#[derive(Clone)]
pub(crate) struct DeepSeekModel {
    pub(crate) name: String,
    pub(crate) api: AgentProtocol,
    pub(crate) image_input: bool,
    context_window: u64,
    max_output_tokens: u64,
}

impl DeepSeekModel {
    pub(crate) fn new(
        name: String,
        api: AgentProtocol,
        image_input: bool,
        limits: Option<&ModelLimits>,
        policy_max_output: Option<u64>,
    ) -> Self {
        let context_window = limits.map_or(32768, |limits| limits.context_window.get());
        let model_max_output = limits.and_then(|limits| limits.max_output_tokens).map(|max| max.get());
        let max_output_tokens =
            [model_max_output, policy_max_output].into_iter().flatten().min().unwrap_or(4096).min(context_window);
        Self { name, api, image_input, context_window, max_output_tokens }
    }
}

pub(crate) struct Request<'a> {
    pub(crate) owner: &'a str,
    pub(crate) home: &'a Path,
    pub(crate) agent: &'a str,
    pub(crate) entry: &'a Path,
    pub(crate) cwd: &'a Path,
    pub(crate) token: &'a str,
    pub(crate) model_bearer: Option<&'a str>,
    pub(crate) router: &'a str,
    pub(crate) model: &'a str,
    pub(crate) deepseek_models: &'a [DeepSeekModel],
    pub(crate) tools: &'a [crate::tools::Bundle],
}

pub(crate) struct Prepared {
    pub(crate) launch: Launch,
    pub(crate) workspace: String,
    pub(crate) runtime: Option<tempfile::TempDir>,
    pub(crate) claude_profile: Option<crate::claude_desktop::Profile>,
}

pub(crate) fn prepare(
    request: &Request<'_>,
    engine_archive: Option<(&Path, crate::desktop_bundle::RuntimeBundle)>,
) -> Result<Prepared> {
    let owner = crate::capture::hex(&Sha256::digest(request.owner.as_bytes()));
    let cwd = if request.cwd.as_os_str().is_empty() {
        let workspace = request.home.join("workspaces").join(&owner);
        launch::private_dir(&workspace)?;
        workspace
    } else {
        request.cwd.to_path_buf()
    }
    .canonicalize()
    .context("workspace unavailable")?;
    if !cwd.is_dir() {
        bail!("workspace unavailable");
    }
    let workspace = path_text(&cwd)?;
    let hash = workspace_hash(&workspace);
    let profile_root = request.home.join("agents").join(request.agent).join("profiles");
    #[cfg(not(windows))]
    let profile = profile_root.join(owner).join(&hash);
    #[cfg(windows)]
    let profile = profile_root.join(crate::capture::hex(&Sha256::digest(format!("{owner}:{hash}"))));
    let home = profile.join("home");
    let data = profile.join("electron");
    // WorkBuddy discovers its own sidecar under TMPDIR. A fresh namespace per
    // launch prevents reuse of the previous launch's model and Hook credentials.
    let runtime = if request.agent == "workbuddy" {
        Some(tempfile::Builder::new().prefix("onex-wb-").tempdir_in("/private/tmp")?)
    } else {
        None
    };
    let tmp = runtime.as_ref().map_or_else(|| profile.join("tmp"), |dir| dir.path().to_owned());
    for dir in [&profile, &home, &data, &tmp] {
        launch::private_dir(dir)?;
    }
    let launch_id = crate::id::new("lch");
    let run = request.home.join("run").join(&launch_id);
    launch::private_dir(&run)?;
    let result = (|| {
        let mut env = std::collections::BTreeMap::from([
            ("HOME".to_owned(), path_text(&home)?),
            ("CFFIXED_USER_HOME".to_owned(), path_text(&home)?),
            ("TMPDIR".to_owned(), path_text(&tmp)?),
            ("PATH".to_owned(), desktop_path(&run)?),
            ("NO_PROXY".to_owned(), "127.0.0.1,localhost".into()),
            ("no_proxy".to_owned(), "127.0.0.1,localhost".into()),
        ]);
        let origin = format!("http://{}", request.router);
        let tools = crate::desktop_tools::prepare(request.agent, &run, request.tools)?;
        let mut claude_profile = None;
        let mut args = vec![format!("--user-data-dir={}", path_text(&data)?)];
        let config = match request.agent {
            "claude-desktop" => {
                let (archive, engine) = engine_archive.context("missing Claude Desktop runtime")?;
                let prepared =
                    crate::claude_desktop::prepare(request, &home, &run, &cwd, archive, engine, &mut env, &tools)?;
                tools.link_skills(&prepared.code)?;
                let code = prepared.code.clone();
                claude_profile = Some(prepared);
                args.clear();
                code
            }
            "codex-desktop" => {
                let agents = crate::desktop_tools::private_subdirectory(&home, ".agents")?;
                tools.link_skills(&agents)?;
                crate::codex_desktop::prepare(request, &profile, &data, &run, &cwd, &mut env, &tools.mcp)?
            }
            "workbuddy" => {
                let config = profile.join("config");
                launch::private_dir(&config)?;
                tools.link_skills(&config)?;
                let mcp = tools.write_mcp(&run)?;
                let model_bearer = request.model_bearer.context("WorkBuddy requires a separate model credential")?;
                anyhow::ensure!(
                    !model_bearer.is_empty() && model_bearer != request.token,
                    "invalid WorkBuddy model credential"
                );
                let entry = request.entry.canonicalize()?;
                let app = entry.ancestors().nth(3).context("missing WorkBuddy application bundle")?;
                anyhow::ensure!(app.join("Contents/MacOS/Electron") == entry, "invalid WorkBuddy desktop executable");
                let adapter = run.join("workbuddy.cjs");
                launch::write_private(&adapter, include_bytes!("desktop_adapters/workbuddy.cjs"))?;
                let models = json!({
                    "models":[{ "id":request.model, "name":request.model, "vendor":"Custom",
                        "url":format!("{origin}/v1/chat/completions"), "apiKey":"${ONEX_WORKBUDDY_SESSION_MODEL_TOKEN}", "supportsToolCall":true }],
                    "availableModels":[request.model]
                });
                // Project model overrides win over the user-level allowlist in CodeBuddy.
                let project_models = cwd.join(".codebuddy/models.json");
                match project_models.symlink_metadata() {
                    Err(err) if err.kind() == std::io::ErrorKind::NotFound => {}
                    _ => bail!("the workspace contains a WorkBuddy project model override"),
                }
                let helper = std::env::current_exe().context("find the installed OneX Hook command")?;
                let policy = run.join("workbuddy-policy.json");
                let credential = run.join("desktop.token");
                launch::write_private(&credential, request.token.as_bytes())?;
                launch::write_private(
                    &policy,
                    &serde_json::to_vec(&json!({
                        "origin":origin, "workspace":workspace, "config":path_text(&config)?, "bundle":path_text(app)?, "model":request.model,
                        "privateHome":path_text(&home.canonicalize()?)?, "credential":path_text(&credential)?,
                        "skills":path_text(&tools.skills)?, "mcp":path_text(&mcp)?
                    }))?,
                )?;
                let quote =
                    |path: &Path| -> Result<String> { Ok(format!("'{}'", path_text(path)?.replace('\'', "'\\''"))) };
                let command = format!("{} workbuddy-hook {}", quote(&helper)?, quote(&policy)?);
                let handler = json!([{"hooks":[{"type":"command","command":command}]}]);
                publish(&config, "models.json", &serde_json::to_vec_pretty(&models)?)?;
                // Retain preferences written by the vendor in this private profile across launches.
                let settings_path = config.join("settings.json");
                let mut settings: serde_json::Map<String, serde_json::Value> = match settings_path.symlink_metadata() {
                    Ok(meta) if meta.is_file() => serde_json::from_slice(&std::fs::read(&settings_path)?)?,
                    Err(err) if err.kind() == std::io::ErrorKind::NotFound => Default::default(),
                    _ => bail!("invalid WorkBuddy settings path"),
                };
                settings.insert(
                    "hooks".into(),
                    json!({
                        "UserPromptSubmit":handler,"Stop":handler,"PostToolUse":tools.post_tool_use()?
                    }),
                );
                publish(&config, "settings.json", &serde_json::to_vec_pretty(&settings)?)?;
                env.insert("WORKBUDDY_CONFIG_DIR".into(), path_text(&config)?);
                env.insert("CODEBUDDY_CONFIG_DIR".into(), path_text(&config)?);
                env.insert("WORKBUDDY_USER_DATA_DIR".into(), path_text(&data)?);
                env.insert("WORKBUDDY_CLI_PREWARM_POOL_SIZE".into(), "0".into());
                env.insert("ONEX_WORKBUDDY_POLICY".into(), path_text(&policy)?);
                let adapter = path_text(&adapter)?.replace('\\', "\\\\").replace('"', "\\\"");
                env.insert("NODE_OPTIONS".into(), format!("--require=\"{adapter}\""));
                args.push("--no-proxy-server".into());
                config
            }
            "deepseek-desktop" => {
                let (providers, model_permissions, default_provider) =
                    deepseek_model_config(&origin, request.model, request.deepseek_models)?;
                #[cfg(windows)]
                {
                    windows_deepseek_environment(&mut env, &home, &tmp)?;
                    args.push("--no-proxy-server".into());
                }
                let root = profile.join("dsh");
                let desktop = root.join("profiles/desktop");
                launch::private_dir(&desktop)?;
                let plugin = run.join("onex-desktop.mjs");
                launch::write_private(&plugin, include_bytes!("desktop_adapters/deepseek.mjs"))?;
                launch::write_private(
                    &run.join("onex-attachments.mjs"),
                    include_bytes!("desktop_adapters/deepseek-attachments.mjs"),
                )?;
                let credentials = run.join("onex-credentials.mjs");
                launch::write_private(&credentials, include_bytes!("desktop_adapters/deepseek-credentials.mjs"))?;
                let credentials_url = file_url(&credentials)?;
                let credential = run.join("desktop.token");
                launch::write_private(&credential, request.token.as_bytes())?;
                let plugin_url = file_url(&plugin)?;
                let manifest = json!({
                    "name":"onex-managed-desktop", "version":"1.0.0", "private":true,
                    "dsh":{"profile":{"bundles":["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app"]}}
                });
                let mut patch = vec![
                    json!({ "id":"credentials", "disabled":true }),
                    json!({ "insert":[{"id":"onex-session-credentials","name":credentials_url.as_str()}] }),
                    json!({ "id":"llm-deepseek", "disabled":true }),
                    json!({ "id":"llm-deepseek-account", "disabled":true }),
                    json!({ "id":"plugin-manager", "disabled":true }),
                    json!({ "id":"tool-plugin-manager", "disabled":true }),
                    json!({ "id":"llm-pi-ai", "config": { "providers":providers } }),
                    json!({ "id":"agent-default-model", "config": { "provider":default_provider, "model":request.model } }),
                    json!({ "insert": [{ "id":"onex-managed-session", "name":plugin_url.as_str(), "config": {
                        "origin":origin, "workspace":workspace, "models":model_permissions, "credential":path_text(&credential)?,
                        "extractor":path_text(&std::env::current_exe()?)?
                    }}] }),
                ];
                tools.insert_deepseek_mcp(&mut patch)?;
                publish(&desktop, "cordis.yml", b"[]\n")?;
                publish(&desktop, "package.json", &serde_json::to_vec_pretty(&manifest)?)?;
                publish(&desktop, "cordis.patch.yml", &serde_json::to_vec_pretty(&patch)?)?;
                env.insert("DSH_HOME".into(), path_text(&root)?);
                env.insert("DSH_AGENTS_HOME".into(), path_text(&tools.root)?);
                env.insert("DSH_DESKTOP_USER_DATA_DIR".into(), path_text(&data)?);
                root
            }
            _ => bail!("the desktop agent has no verified profile"),
        };
        Ok(Prepared {
            launch: Launch {
                launch_id: launch_id.clone(),
                session_id: crate::launch::uuid_v4(),
                program: request.entry.to_path_buf(),
                args,
                env,
                cwd,
                config_dir: config,
                run_dir: run,
            },
            workspace: hash,
            runtime,
            claude_profile,
        })
    })();
    if result.is_err() {
        let _ = launch::finish(request.home, &launch_id);
    }
    result
}

fn deepseek_model_config(
    origin: &str,
    default_model: &str,
    models: &[DeepSeekModel],
) -> Result<(serde_json::Value, serde_json::Value, &'static str)> {
    let mut seen = std::collections::HashSet::new();
    for model in models {
        anyhow::ensure!(
            !model.name.is_empty() && !model.name.contains('*') && seen.insert(model.name.as_str()),
            "invalid or repeated DeepSeek model"
        );
        anyhow::ensure!(
            matches!(model.api, AgentProtocol::Chat | AgentProtocol::Messages),
            "unsupported DeepSeek model protocol"
        );
    }

    let mut providers = serde_json::Map::new();
    let mut permissions = Vec::with_capacity(models.len());
    let mut default_provider = None;
    // Keep the installed Chat provider ID for saved sessions. The native
    // Anthropic SDK appends /v1/messages, while the OpenAI client appends /chat/completions.
    for (protocol, provider, label, api, path) in [
        (AgentProtocol::Chat, "onex", "OneX", "openai-completions", "/v1"),
        (AgentProtocol::Messages, "onex-anthropic", "OneX · Anthropic", "anthropic-messages", ""),
    ] {
        let native_models: Vec<_> = models
            .iter()
            .filter(|model| model.api == protocol)
            .map(|model| {
                if model.name == default_model {
                    default_provider = Some(provider);
                }
                permissions.push(json!({"provider":provider,"id":model.name,"imageInput":model.image_input}));
                json!({"id":model.name,"name":model.name,"contextWindow":model.context_window,
                "maxTokens":model.max_output_tokens,
                "input":if model.image_input { vec!["text", "image"] } else { vec!["text"] }, "reasoningEfforts":false})
            })
            .collect();
        if !native_models.is_empty() {
            providers.insert(
                provider.into(),
                json!({
                    "displayName":label,"api":api,"baseURL":format!("{origin}{path}"),"apiKeyEnv":"ONEX_NATIVE_SESSION",
                    "retryPolicy":{"mode":"normal","maxRetries":0},"models":native_models
                }),
            );
        }
    }
    Ok((providers.into(), permissions.into(), default_provider.context("missing default DeepSeek model")?))
}

#[cfg(test)]
mod deepseek_model_tests {
    use super::*;

    #[test]
    fn deepseek_profile_uses_native_protocol_and_selected_models() {
        let models = [
            DeepSeekModel::new("approved-chat".into(), AgentProtocol::Chat, false, None, None),
            DeepSeekModel::new("approved-vision".into(), AgentProtocol::Chat, true, None, None),
            DeepSeekModel::new("approved-messages".into(), AgentProtocol::Messages, true, None, None),
        ];
        let (providers, permissions, default_provider) =
            deepseek_model_config("http://127.0.0.1:1234", "approved-chat", &models).unwrap();
        assert_eq!(default_provider, "onex");
        assert_eq!(providers["onex"]["baseURL"], "http://127.0.0.1:1234/v1");
        assert_eq!(providers["onex"]["api"], "openai-completions");
        assert_eq!(providers["onex"]["models"].as_array().unwrap().len(), 2);
        assert_eq!(providers["onex"]["models"][0]["contextWindow"], 32768);
        assert_eq!(providers["onex"]["models"][0]["maxTokens"], 4096);
        assert_eq!(providers["onex"]["models"][0]["input"], json!(["text"]));
        assert_eq!(providers["onex"]["models"][1]["input"], json!(["text", "image"]));
        assert_eq!(providers["onex-anthropic"]["baseURL"], "http://127.0.0.1:1234");
        assert_eq!(providers["onex-anthropic"]["api"], "anthropic-messages");
        assert_eq!(providers["onex-anthropic"]["models"][0]["id"], "approved-messages");
        assert_eq!(providers["onex-anthropic"]["apiKeyEnv"], "ONEX_NATIVE_SESSION");
        assert_eq!(permissions[2], json!({"provider":"onex-anthropic","id":"approved-messages","imageInput":true}));
        assert_eq!(
            deepseek_model_config("http://127.0.0.1:1234", "approved-messages", &models[2..]).unwrap().2,
            "onex-anthropic"
        );
        assert!(deepseek_model_config("http://127.0.0.1:1234", "unknown", &models).is_err());
    }

    #[test]
    fn deepseek_profile_advertises_each_configured_model_limit() {
        let large_window = serde_json::from_value(json!({"context_window":262144,"max_output_tokens":65536})).unwrap();
        let context_only = serde_json::from_value(json!({"context_window":200000})).unwrap();
        let small_window = serde_json::from_value(json!({"context_window":1024})).unwrap();
        let models = [
            DeepSeekModel::new("qwen".into(), AgentProtocol::Chat, false, Some(&large_window), None),
            DeepSeekModel::new("signed-cap".into(), AgentProtocol::Chat, true, Some(&large_window), Some(16384)),
            DeepSeekModel::new("small-context".into(), AgentProtocol::Chat, false, Some(&small_window), None),
            DeepSeekModel::new("messages".into(), AgentProtocol::Messages, true, Some(&context_only), Some(32768)),
        ];
        let (providers, _, _) = deepseek_model_config("http://127.0.0.1:1234", "qwen", &models).unwrap();
        let chats = &providers["onex"]["models"];
        assert_eq!(chats[0]["contextWindow"], 262144);
        assert_eq!(chats[0]["maxTokens"], 65536);
        assert_eq!(chats[1]["contextWindow"], 262144);
        assert_eq!(chats[1]["maxTokens"], 16384);
        assert_eq!(chats[2]["contextWindow"], 1024);
        assert_eq!(chats[2]["maxTokens"], 1024);
        let messages = &providers["onex-anthropic"]["models"][0];
        assert_eq!(messages["contextWindow"], 200000);
        assert_eq!(messages["maxTokens"], 32768);
        assert_eq!(messages["input"], json!(["text", "image"]));
    }
}

#[cfg(windows)]
fn windows_deepseek_environment(
    env: &mut std::collections::BTreeMap<String, String>,
    home: &Path,
    tmp: &Path,
) -> Result<()> {
    let roaming = home.join("AppData/Roaming");
    let local = home.join("AppData/Local");
    launch::private_dir(&roaming)?;
    launch::private_dir(&local)?;
    let system_root = std::env::var_os("SystemRoot").map(PathBuf::from).context("Windows SystemRoot is unavailable")?;
    let system32 = system_root.join("System32");
    let shell = system32.join("cmd.exe");
    anyhow::ensure!(system_root.is_absolute() && shell.is_file(), "Windows command shell is unavailable");
    let git = ["ProgramW6432", "ProgramFiles", "ProgramFiles(x86)", "LOCALAPPDATA"]
        .into_iter()
        .filter_map(std::env::var_os)
        .map(PathBuf::from)
        .flat_map(|base| [base.join("Git/cmd"), base.join("Programs/Git/cmd")])
        .chain(std::env::var_os("PATH").iter().flat_map(|path| std::env::split_paths(path)))
        .find(|dir| dir.is_absolute() && dir.join("git.exe").is_file());
    let path = std::env::join_paths([system32, system_root.clone()].into_iter().chain(git))?;
    env.insert("PATH".into(), path.into_string().map_err(|_| anyhow::anyhow!("Windows PATH is not UTF-8"))?);
    env.insert("PATHEXT".into(), ".COM;.EXE;.BAT;.CMD".into());
    for (key, path) in [
        ("USERPROFILE", home),
        ("APPDATA", &roaming),
        ("LOCALAPPDATA", &local),
        ("TEMP", tmp),
        ("TMP", tmp),
        ("SystemRoot", &system_root),
        ("windir", &system_root),
        ("ComSpec", &shell),
    ] {
        env.insert(key.into(), path_text(path)?);
    }
    Ok(())
}

fn file_url(path: &Path) -> Result<reqwest::Url> {
    reqwest::Url::from_file_path(path_text(path)?)
        .map_err(|_| anyhow::anyhow!("could not construct desktop adapter URL"))
}

fn desktop_path(#[cfg(target_os = "macos")] run: &Path, #[cfg(not(target_os = "macos"))] _: &Path) -> Result<String> {
    const SYSTEM_PATH: &str = "/usr/bin:/bin:/usr/sbin:/sbin";
    #[cfg(target_os = "macos")]
    {
        use std::process::Command;

        let git_works = |path: &Path| {
            path.is_file()
                && Command::new(path)
                    .arg("--version")
                    .env_remove("DEVELOPER_DIR")
                    .output()
                    .is_ok_and(|output| output.status.success() && output.stdout.starts_with(b"git version "))
        };
        let alternate_gits = [Path::new("/opt/homebrew/bin/git"), Path::new("/usr/local/bin/git")];
        if alternate_gits.iter().any(|git| git.is_file()) {
            let has_selected_git = Command::new("/usr/bin/xcode-select")
                .arg("--print-path")
                .env_remove("DEVELOPER_DIR")
                .output()
                .ok()
                .filter(|output| output.status.success())
                .and_then(|output| String::from_utf8(output.stdout).ok())
                .is_some_and(|path| Path::new(path.trim_end()).join("usr/bin/git").is_file());
            if !(has_selected_git && git_works(Path::new("/usr/bin/git"))) {
                if let Some(git) = alternate_gits.iter().find(|git| git_works(git)) {
                    // Keep the desktop's restricted PATH, exposing only the alternative Git.
                    let bin = run.join("git-bin");
                    launch::private_dir(&bin)?;
                    std::os::unix::fs::symlink(git, bin.join("git"))?;
                    return Ok(format!("{}:{SYSTEM_PATH}", path_text(&bin)?));
                }
            }
        }
    }
    Ok(SYSTEM_PATH.into())
}

pub(crate) fn publish(directory: &Path, name: &str, content: &[u8]) -> Result<()> {
    let staged: PathBuf = directory.join(format!(".{name}.{}", crate::id::new("file")));
    let result =
        launch::write_private(&staged, content).and_then(|()| Ok(std::fs::rename(&staged, directory.join(name))?));
    if result.is_err() {
        let _ = std::fs::remove_file(staged);
    }
    result
}

pub(crate) fn path_text(path: &Path) -> Result<String> {
    let path = path.to_str().context("desktop path is not UTF-8")?;
    #[cfg(windows)]
    {
        // canonicalize() uses extended Windows path prefixes that Electron and file URLs do not consume.
        if let Some(unc) = path.strip_prefix(r"\\?\UNC\") {
            return Ok(format!(r"\\{unc}"));
        }
        if let Some(drive) = path.strip_prefix(r"\\?\").filter(|path| path.as_bytes().get(1) == Some(&b':')) {
            return Ok(drive.into());
        }
    }
    Ok(path.into())
}

pub(crate) fn workspace_hash(path: &str) -> String {
    crate::capture::hex(&Sha256::digest(path.as_bytes()))
}

#[cfg(all(test, windows))]
#[test]
fn deepseek_uses_private_windows_profile_and_loadable_adapter_urls() {
    let root = tempfile::tempdir().unwrap();
    let home = root.path().join("OneX #qa");
    let cwd = root.path().join("workspace");
    launch::private_dir(&cwd).unwrap();
    let home = {
        launch::private_dir(&home).unwrap();
        home.canonicalize().unwrap()
    };
    let request = Request {
        owner: "test-device",
        home: &home,
        agent: "deepseek-desktop",
        entry: &home.join("DeepSeek.exe"),
        cwd: &cwd,
        token: "local-control-test-token",
        model_bearer: None,
        router: "127.0.0.1:19876",
        model: "contract-model",
        deepseek_models: &[DeepSeekModel::new("contract-model".into(), AgentProtocol::Chat, false, None, None)],
        tools: &[],
    };
    let prepared = prepare(&request, None).unwrap();
    let state = &prepared.launch;
    assert_eq!(state.env["USERPROFILE"], state.env["HOME"]);
    assert_eq!(state.env["TEMP"], state.env["TMP"]);
    assert!(Path::new(&state.env["ComSpec"]).is_file());
    let home = Path::new(&state.env["HOME"]);
    assert_eq!(Path::new(&state.env["APPDATA"]), home.join("AppData/Roaming"));
    assert_eq!(Path::new(&state.env["LOCALAPPDATA"]), home.join("AppData/Local"));
    assert!(state.args.contains(&"--no-proxy-server".into()));
    assert!(state.args.contains(&format!("--user-data-dir={}", state.env["DSH_DESKTOP_USER_DATA_DIR"])));
    assert!(!state.env.values().any(|value| value.contains(request.token)));
    let patch_path = state.config_dir.join("profiles/desktop/cordis.patch.yml");
    let patch = std::fs::read_to_string(patch_path).unwrap();
    assert!(!patch.contains(request.token));
    let patch: serde_json::Value = serde_json::from_str(&patch).unwrap();
    let plugin =
        |id| patch.as_array().unwrap().iter().map(|entry| &entry["insert"][0]).find(|entry| entry["id"] == id).unwrap();
    for (id, name) in
        [("onex-session-credentials", "onex-credentials.mjs"), ("onex-managed-session", "onex-desktop.mjs")]
    {
        let url = reqwest::Url::parse(plugin(id)["name"].as_str().unwrap()).unwrap();
        assert!(url.as_str().contains("OneX%20%23qa"));
        assert!(url.to_file_path().unwrap().ends_with(name));
        assert!(url.to_file_path().unwrap().is_file());
    }
    assert_eq!(plugin("onex-managed-session")["config"]["workspace"], path_text(&cwd.canonicalize().unwrap()).unwrap(),);
    assert!(prepare(&request, None).is_ok());
}

#[cfg(all(test, target_os = "macos", target_arch = "aarch64"))]
mod tests {
    use super::*;
    use base64::{Engine, engine::general_purpose::STANDARD};
    use std::os::unix::fs::PermissionsExt;

    #[test]
    fn workbuddy_uses_the_isolated_official_model_and_hook_configuration() {
        let root = tempfile::tempdir().unwrap();
        let workspace = root.path().join("work's space");
        launch::private_dir(&workspace).unwrap();
        let vendor = root.path().join("WorkBuddy.app/Contents/MacOS/Electron");
        launch::private_dir(vendor.parent().unwrap()).unwrap();
        std::fs::write(&vendor, []).unwrap();
        let request = Request {
            owner: "owner",
            home: root.path(),
            agent: "workbuddy",
            entry: &vendor,
            cwd: &workspace,
            token: "test-control",
            model_bearer: Some("test-model-only"),
            router: "127.0.0.1:19876",
            model: "contract-model",
            deepseek_models: &[],
            tools: &[],
        };
        let prepared = prepare(&request, None).unwrap();
        let launch = &prepared.launch;
        assert_eq!(launch.args.last().map(String::as_str), Some("--no-proxy-server"));
        assert_eq!(
            launch.env["NODE_OPTIONS"],
            format!("--require=\"{}\"", launch.run_dir.join("workbuddy.cjs").display())
        );
        assert_eq!(launch.env["WORKBUDDY_CLI_PREWARM_POOL_SIZE"], "0");
        assert_eq!(launch.env["CFFIXED_USER_HOME"], launch.env["HOME"]);
        assert!(Path::new(&launch.env["HOME"]).starts_with(root.path()));
        assert!(Path::new(&launch.env["WORKBUDDY_USER_DATA_DIR"]).starts_with(root.path()));
        let read_json =
            |file: &Path| serde_json::from_slice::<serde_json::Value>(&std::fs::read(file).unwrap()).unwrap();
        let config = Path::new(&launch.env["WORKBUDDY_CONFIG_DIR"]);
        let models = read_json(&config.join("models.json"));
        assert_eq!(models["availableModels"], json!([request.model]));
        assert_eq!(models["models"][0]["apiKey"], "${ONEX_WORKBUDDY_SESSION_MODEL_TOKEN}");
        assert_eq!(models["models"][0]["url"], "http://127.0.0.1:19876/v1/chat/completions");
        assert_eq!(models["models"].as_array().unwrap().len(), 1);
        assert!(!models.to_string().contains(request.token));
        let settings = read_json(&config.join("settings.json"));
        assert_eq!(settings["hooks"].as_object().unwrap().len(), 3);
        assert_eq!(settings["hooks"]["PostToolUse"], json!([]));
        let command = settings["hooks"]["UserPromptSubmit"][0]["hooks"][0]["command"].as_str().unwrap();
        assert!(command.contains(" workbuddy-hook "));
        assert!(command.contains(&std::env::current_exe().unwrap().display().to_string()));
        assert_eq!(settings["hooks"]["Stop"][0]["hooks"][0]["command"], command);
        assert!(!command.contains(request.token));
        assert!(!command.contains(request.model_bearer.unwrap()));
        let policy = read_json(&launch.run_dir.join("workbuddy-policy.json"));
        let credential = Path::new(policy["credential"].as_str().unwrap());
        assert!(credential.starts_with(&launch.run_dir));
        assert_eq!(std::fs::read_to_string(credential).unwrap(), request.token);
        assert_eq!(std::fs::metadata(credential).unwrap().permissions().mode() & 0o777, 0o600);

        let runtime = prepared.runtime.as_ref().unwrap().path().to_owned();
        assert_eq!(Path::new(&launch.env["TMPDIR"]), runtime);
        let mut vendor_settings = settings;
        vendor_settings["theme"] = json!("from-vendor");
        std::fs::write(config.join("settings.json"), serde_json::to_vec(&vendor_settings).unwrap()).unwrap();
        let raw =
            serde_json::to_vec(&json!({"files":[{"path":"hook.sh","data":STANDARD.encode("#!/bin/sh\nexit 0\n")}]}))
                .unwrap();
        let hook = serde_json::from_value(json!({
            "id":crate::id::new("tool"), "name":"probe", "version":"1.0.0", "kind":"hook",
            "agents":["workbuddy"], "os":"macos", "arch":"arm64", "entrypoint":"hook.sh", "args":[],
            "sha256":format!("{:x}",Sha256::digest(&raw)), "size":raw.len()
        }))
        .unwrap();
        let tools = [crate::tools::decode(&hook, &raw).unwrap()];
        let upgraded = Request { tools: &tools, ..request };
        let next = prepare(&upgraded, None).unwrap();
        assert_eq!(read_json(&config.join("settings.json"))["theme"], "from-vendor");
        let current_hooks = &read_json(&config.join("settings.json"))["hooks"];
        assert_eq!(current_hooks["Stop"], current_hooks["UserPromptSubmit"]);
        let post = current_hooks["PostToolUse"][0]["hooks"][0]["command"].as_str().unwrap();
        assert!(post.contains("-u ONEX_WORKBUDDY_SESSION_MODEL_TOKEN"));
        assert!(post.contains("managed-tools/hooks/probe/hook.sh"));
        assert_ne!(next.runtime.as_ref().unwrap().path(), runtime);
        drop(prepared);
        assert!(!runtime.exists());

        let override_file = workspace.join(".codebuddy/models.json");
        launch::private_dir(override_file.parent().unwrap()).unwrap();
        std::fs::write(&override_file, b"keep this user's settings").unwrap();
        let error = prepare(&request, None).err().unwrap();
        assert!(error.to_string().contains("project model override"));
        assert_eq!(std::fs::read(override_file).unwrap(), b"keep this user's settings");
    }
}
