//! Prepare the managed Codex profile and pin its loopback Responses provider.

use std::io::ErrorKind;
use std::path::Path;

use anyhow::{Context, Result, bail};

use crate::launch::{self, Launch, Request};

pub(crate) fn prepare(r: &Request) -> Result<Launch> {
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

    let suffix = launch_id.trim_start_matches("lch_");
    let provider = format!("onex_{suffix}");
    let token_name = format!("ONEX_CODEX_TOKEN_{suffix}");
    let provider_key = format!("model_providers.{provider}");
    let settings = [
        ("model".into(), quote(r.model)),
        ("model_provider".into(), quote(&provider)),
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

fn quote(value: &str) -> String {
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

fn validate_project(cwd: &Path) -> Result<()> {
    let canonical = cwd.canonicalize()?;
    let git_root = canonical.ancestors().find(|ancestor| std::fs::symlink_metadata(ancestor.join(".git")).is_ok());
    let project = git_root.unwrap_or(&canonical);
    for dir in canonical.ancestors().take_while(|dir| dir.starts_with(project)) {
        require_absent(&dir.join(".codex"))?;
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
    fn project_config_is_detected_at_git_root() {
        let parent = tempfile::tempdir().unwrap();
        let project = parent.path().join("project");
        let cwd = project.join("nested");
        std::fs::create_dir_all(&cwd).unwrap();
        std::fs::create_dir(parent.path().join(".codex")).unwrap();
        std::fs::write(project.join(".git"), b"gitdir: x").unwrap();
        validate_project(&cwd).unwrap();
        std::fs::create_dir(project.join(".codex")).unwrap();
        assert!(validate_project(&cwd).is_err());
    }
}
