//! Prepare the managed Codex profile and pin its loopback Responses provider.

use std::collections::{BTreeMap, HashSet};
use std::io::ErrorKind;
use std::path::Path;

use anyhow::{Context, Result, bail};
use onex_core::ws::ModelLimits;
use serde_json::{Value, json};

use crate::launch::{self, Launch, Request};

#[path = "codex_history.rs"]
mod history;
pub(crate) use history::{HistoryLease, RestoredHistory, prefix_digest, restore_history};

// The native resume picker uses a provider ID. Keep the ID independent of the
// launch while the provider config, router token, and tools stay private.
pub(super) const PROVIDER: &str = "onex";

pub(crate) fn prepare(r: &Request) -> Result<Launch> {
    prepare_with_models(r, &[], &BTreeMap::new())
}

pub(crate) fn prepare_with_models(
    r: &Request,
    model_choices: &[String],
    model_limits: &BTreeMap<String, ModelLimits>,
) -> Result<Launch> {
    if !r.program.is_absolute() {
        bail!("agent executable path must be absolute: {}", r.program.display());
    }
    if !r.cwd.is_absolute() || !r.cwd.is_dir() {
        bail!("working directory not found: {}", r.cwd.display());
    }
    validate_project(r.cwd)?;
    #[cfg(target_os = "macos")]
    require_absent(Path::new("/etc/codex"))?;

    let launch_id = crate::id::new("lch");
    let profile = r.home.join("agents/codex/profiles").join(&launch_id);
    let config_dir = profile.join("codex");
    let home = profile.join("home");
    let tmp = profile.join("tmp");
    let run_dir = r.home.join("run").join(&launch_id);
    for dir in [&profile, &config_dir, &home, &tmp, &run_dir] {
        launch::private_dir(dir)?;
    }

    let catalog = config_dir.join("models.json");
    let catalog_path = catalog.to_str().context("Codex model catalog path must be UTF-8")?;
    let mut seen = HashSet::new();
    let entries: Vec<_> = std::iter::once(r.model)
        .chain(model_choices.iter().map(String::as_str))
        .filter(|model| seen.insert(*model))
        .enumerate()
        .map(|(priority, model)| model_entry(model, priority, model_limits.get(model)))
        .collect();
    launch::write_private(&catalog, &serde_json::to_vec(&json!({ "models": entries }))?)?;

    let suffix = launch_id.trim_start_matches("lch_");
    let token_name = format!("ONEX_CODEX_TOKEN_{suffix}");
    let provider_key = format!("model_providers.{PROVIDER}");
    let settings = [
        ("model".into(), quote(r.model)),
        ("model_provider".into(), quote(PROVIDER)),
        ("model_catalog_json".into(), quote(catalog_path)),
        (format!("{provider_key}.name"), quote("OneX")),
        (format!("{provider_key}.base_url"), quote(&format!("http://{}/v1", r.router_addr))),
        (format!("{provider_key}.env_key"), quote(&token_name)),
        (format!("{provider_key}.wire_api"), quote("responses")),
        (format!("{provider_key}.request_max_retries"), "0".into()),
        (format!("{provider_key}.stream_max_retries"), "0".into()),
        (format!("{provider_key}.requires_openai_auth"), "false".into()),
        (format!("{provider_key}.supports_websockets"), "false".into()),
        ("check_for_update_on_startup".into(), "false".into()),
        ("web_search".into(), quote("disabled")),
        ("project_doc_max_bytes".into(), "0".into()),
        ("project_root_markers".into(), "[\".git\"]".into()),
        ("features.plugins".into(), "false".into()),
        ("shell_environment_policy.exclude".into(), "[\"ONEX_CODEX_TOKEN_*\"]".into()),
    ];
    let settings: Vec<String> = settings.into_iter().map(|(key, value)| format!("{key} = {value}")).collect();
    let temporary = config_dir.join("config.pending");
    launch::write_private(&temporary, settings.join("\n").as_bytes())?;
    std::fs::rename(&temporary, config_dir.join("config.toml")).context("publish Codex configuration")?;
    let args = settings.into_iter().flat_map(|setting| ["-c".into(), setting]).collect();

    let mut env = launch::terminal_env(r.client_env);
    for (key, dir) in [
        ("HOME", &home),
        ("CODEX_HOME", &config_dir),
        ("TMPDIR", &tmp),
        ("XDG_CONFIG_HOME", &home.join("config")),
        ("XDG_DATA_HOME", &home.join("data")),
        ("XDG_CACHE_HOME", &home.join("cache")),
        ("XDG_STATE_HOME", &home.join("state")),
    ] {
        env.insert(key.into(), dir.to_string_lossy().into_owned());
    }
    #[cfg(windows)]
    for (key, dir) in [
        ("USERPROFILE", &home),
        ("APPDATA", &home.join("Roaming")),
        ("LOCALAPPDATA", &home.join("Local")),
        ("TEMP", &tmp),
        ("TMP", &tmp),
    ] {
        env.insert(key.into(), dir.to_string_lossy().into_owned());
    }
    env.insert(token_name, r.local_token.into());
    env.insert("NO_PROXY".into(), "localhost,127.0.0.1,::1".into());
    env.insert("no_proxy".into(), "localhost,127.0.0.1,::1".into());

    Ok(Launch {
        launch_id,
        session_id: launch::uuid_v4(),
        program: r.program.into(),
        args,
        env,
        cwd: r.cwd.into(),
        config_dir,
        run_dir,
    })
}

fn model_entry(model: &str, priority: usize, limits: Option<&ModelLimits>) -> Value {
    let mut entry = json!({
        "slug": model,
        "display_name": model,
        "base_instructions": "Help the user with their coding tasks.",
        "supported_reasoning_levels": [],
        "shell_type": "shell_command",
        "visibility": "list",
        "supported_in_api": true,
        "priority": priority,
        "support_verbosity": false,
        "truncation_policy": { "mode": "tokens", "limit": 10000 },
        "experimental_supported_tools": [],
    });
    if let Some(limits) = limits {
        entry["context_window"] = json!(limits.context_window);
        entry["max_context_window"] = json!(limits.context_window);
        // Codex's native catalog has no field for the signed output limit.
        if let Some(output) = limits.max_output_tokens {
            entry["description"] = json!(format!("最大输出 {output} Token"));
        }
    }
    entry
}

pub(crate) fn quote(value: &str) -> String {
    // JSON string escapes used here are valid TOML basic string escapes.
    serde_json::to_string(value).expect("string serialization").replace('\u{7f}', "\\u007f")
}

fn require_absent(path: &Path) -> Result<()> {
    match std::fs::symlink_metadata(path) {
        Ok(_) => bail!("Codex 受管启动无法使用外部配置或技能目录 {}", path.display()),
        Err(error) if error.kind() == ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error).with_context(|| format!("检查 {}", path.display())),
    }
}

fn require_no_workspace_config(path: &Path) -> Result<()> {
    match std::fs::symlink_metadata(path) {
        Ok(metadata) => {
            // Workspaces can contain an unused .codex directory. Only a real,
            // empty directory has no configuration, hooks or rules to load.
            if metadata.is_dir()
                && std::fs::read_dir(path).with_context(|| format!("检查 {}", path.display()))?.next().is_none()
            {
                return Ok(());
            }
            bail!("Codex 受管启动无法使用外部配置或技能目录 {}", path.display())
        }
        Err(error) if error.kind() == ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error).with_context(|| format!("检查 {}", path.display())),
    }
}

pub(crate) fn validate_project(cwd: &Path) -> Result<()> {
    let canonical = cwd.canonicalize()?;
    let git_root = canonical.ancestors().find(|ancestor| std::fs::symlink_metadata(ancestor.join(".git")).is_ok());
    let project = git_root.unwrap_or(&canonical);
    for dir in canonical.ancestors().take_while(|dir| dir.starts_with(project)) {
        require_no_workspace_config(&dir.join(".codex"))?;
        require_absent(&dir.join(".agents/skills"))?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn profile_isolation_and_token_exclusion_are_per_launch() {
        let home = tempfile::tempdir().unwrap();
        let project = tempfile::tempdir().unwrap();
        let client = [("CODEX_HOME".into(), "personal".into()), ("OPENAI_API_KEY".into(), "personal".into())].into();
        let request = Request {
            agent: "codex",
            home: home.path(),
            router_addr: "127.0.0.1:1",
            local_token: "fake-onex-launch-token",
            model: "model-alias",
            program: &std::env::current_exe().unwrap(),
            cwd: project.path(),
            client_env: &client,
        };
        let first = prepare(&request).unwrap();
        let second = prepare(&request).unwrap();
        let token_name =
            |profile: &Launch| profile.env.keys().find(|key| key.starts_with("ONEX_CODEX_TOKEN_")).unwrap().clone();
        assert_ne!(first.config_dir, second.config_dir);
        assert_ne!(token_name(&first), token_name(&second));
        let config = std::fs::read_to_string(first.config_dir.join("config.toml")).unwrap();
        assert!(config.contains(&token_name(&first)));
        assert!(config.contains("shell_environment_policy.exclude"));
        assert!(!config.contains(request.local_token));
        assert!(first.args.iter().all(|arg| !arg.contains(request.local_token)));
        assert!(!first.env.contains_key("OPENAI_API_KEY"));
    }

    #[test]
    fn model_catalog_contains_only_launch_choices_and_their_signed_limits() {
        let home = tempfile::tempdir().unwrap();
        let project = tempfile::tempdir().unwrap();
        let request = Request {
            agent: "codex",
            home: home.path(),
            router_addr: "127.0.0.1:1",
            local_token: "fake-onex-launch-token",
            model: "default-model",
            program: &std::env::current_exe().unwrap(),
            cwd: project.path(),
            client_env: &BTreeMap::new(),
        };
        let choices = ["other-model".into(), "default-model".into(), "other-model".into()];
        let signed_limits = ModelLimits {
            context_window: 262_144.try_into().unwrap(),
            max_output_tokens: Some(16_384.try_into().unwrap()),
        };
        let limits = [("default-model".into(), signed_limits), ("unroutable".into(), signed_limits)].into();
        let launch = prepare_with_models(&request, &choices, &limits).unwrap();
        let catalog = launch.config_dir.join("models.json");
        let setting = format!("model_catalog_json = {}", quote(catalog.to_str().unwrap()));
        let config = std::fs::read_to_string(launch.config_dir.join("config.toml")).unwrap();
        assert!(config.lines().any(|line| line == setting));
        assert!(launch.args.windows(2).any(|pair| pair == ["-c", &setting]));

        let json: Value = serde_json::from_slice(&std::fs::read(catalog).unwrap()).unwrap();
        let models = json["models"].as_array().unwrap();
        assert_eq!(models.len(), 2);
        assert_eq!(models[0]["slug"], "default-model");
        assert_eq!(models[0]["context_window"], 262_144);
        assert_eq!(models[0]["max_context_window"], 262_144);
        assert_eq!(models[0]["description"], "最大输出 16384 Token");
        assert_eq!(models[1]["slug"], "other-model");
        assert!(models[1].get("context_window").is_none());
        assert!(models[1].get("description").is_none());
    }

    #[test]
    fn project_config_is_detected_at_git_root() {
        let parent = tempfile::tempdir().unwrap();
        let project = parent.path().join("project");
        let cwd = project.join("nested");
        std::fs::create_dir_all(&cwd).unwrap();
        std::fs::create_dir(parent.path().join(".codex")).unwrap();
        std::fs::write(project.join(".git"), b"gitdir: x").unwrap();
        validate_project(&cwd).unwrap();
        std::fs::create_dir(project.join(".codex")).unwrap();
        std::fs::create_dir(cwd.join(".codex")).unwrap();
        validate_project(&cwd).unwrap();
        std::fs::write(project.join(".codex/config.toml"), b"model = 'workspace-model'").unwrap();
        assert!(validate_project(&cwd).is_err());
    }

    #[cfg(unix)]
    #[test]
    fn symlinked_project_config_and_workspace_skills_are_still_rejected() {
        let workspace = tempfile::tempdir().unwrap();
        let external = tempfile::tempdir().unwrap();
        let project_config = workspace.path().join(".codex");
        std::os::unix::fs::symlink(external.path(), &project_config).unwrap();
        assert!(validate_project(workspace.path()).is_err());
        std::fs::remove_file(project_config).unwrap();
        std::fs::create_dir_all(workspace.path().join(".agents/skills")).unwrap();
        assert!(validate_project(workspace.path()).is_err());
    }
}
