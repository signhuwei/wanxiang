//! Launch-local native files shared by the managed desktop adapters.

use std::{
    fs,
    io::ErrorKind,
    path::{Path, PathBuf},
};

use anyhow::{Context, Result, ensure};
use serde_json::{Map, Value, json};

use crate::{
    desktop_launch::path_text,
    launch,
    tools::{self, Bundle, Mcp},
};

pub(crate) struct PreparedTools {
    pub(crate) root: PathBuf,
    pub(crate) skills: PathBuf,
    pub(crate) mcp: Vec<Mcp>,
    hooks: Vec<PathBuf>,
}

const HOOK_COMMAND_PREFIX: &str = "/usr/bin/env -u ANTHROPIC_AUTH_TOKEN -u ANTHROPIC_API_KEY -u OPENAI_API_KEY -u CODEBUDDY_AUTH_TOKEN -u ONEX_WORKBUDDY_SESSION_MODEL_TOKEN ONEX_MANAGED_POST_TOOL_USE=1 ";

pub(crate) fn prepare(agent: &str, run: &Path, bundles: &[Bundle]) -> Result<PreparedTools> {
    let supported = tools::desktop_targets(cfg!(windows));
    ensure!(
        bundles.iter().all(|bundle| supported.get(agent).is_some_and(|kinds| kinds.contains(&bundle.kind))),
        "tool kind is not supported by this desktop adapter"
    );
    let root = private_subdirectory(run, "managed-tools")?;
    let skills = private_subdirectory(&root, "skills")?;
    let mcp = tools::install(bundles, &root, &skills)?;
    let hooks = bundles
        .iter()
        .filter(|bundle| bundle.kind == "hook")
        .map(|bundle| {
            let entry = bundle.entrypoint.as_deref().context("missing desktop hook entrypoint")?;
            Ok(root.join("hooks").join(&bundle.name).join(entry))
        })
        .collect::<Result<_>>()?;
    Ok(PreparedTools { root, skills, mcp, hooks })
}

pub(crate) fn private_subdirectory(parent: &Path, name: &str) -> Result<PathBuf> {
    ensure!(fs::symlink_metadata(parent)?.is_dir(), "desktop tool parent is not a private directory");
    let path = parent.canonicalize()?.join(name);
    match fs::symlink_metadata(&path) {
        Ok(meta) => ensure!(meta.is_dir(), "desktop tool directory must not be a link"),
        Err(error) if error.kind() == ErrorKind::NotFound => fs::create_dir(&path)?,
        Err(error) => return Err(error.into()),
    }
    launch::private_dir(&path)?;
    Ok(path)
}

impl PreparedTools {
    // The vendor user profile persists. Only the reserved pointer is replaced;
    // the verified files follow the lifetime of this launch's run directory.
    pub(crate) fn link_skills(&self, native: &Path) -> Result<()> {
        #[cfg(unix)]
        {
            let directory = private_subdirectory(native, "skills")?;
            let link = directory.join("__onex_managed__");
            let run_root = self.root.ancestors().nth(2).context("missing desktop tool run directory")?;
            match fs::symlink_metadata(&link) {
                Ok(meta) => {
                    ensure!(meta.file_type().is_symlink(), "managed skill catalogue conflicts with a local entry");
                    let previous = fs::read_link(&link)?;
                    let previous_launch =
                        previous.strip_prefix(run_root).ok().and_then(Path::parent).and_then(Path::parent);
                    ensure!(
                        previous.ends_with("managed-tools/skills")
                            && previous_launch.and_then(Path::to_str).is_some_and(launch::is_generated_launch_id),
                        "managed skill catalogue points outside a OneX launch"
                    );
                }
                Err(error) if error.kind() == ErrorKind::NotFound => {}
                Err(error) => return Err(error.into()),
            }
            let pending = directory.join(format!(".managed-skills-{}", crate::id::new("link")));
            std::os::unix::fs::symlink(&self.skills, &pending)?;
            fs::rename(&pending, &link).inspect_err(|_| {
                let _ = fs::remove_file(&pending);
            })?;
            Ok(())
        }
        #[cfg(not(unix))]
        anyhow::bail!("desktop native skill links are not supported on this operating system: {}", native.display());
    }

    pub(crate) fn write_mcp(&self, run: &Path) -> Result<PathBuf> {
        let mut servers = Map::<String, Value>::new();
        for server in &self.mcp {
            servers.insert(
                server.name.clone(),
                json!({
                    "type": "stdio", "command": path_text(&server.command)?, "args": server.args,
                    "env": tool_environment()
                }),
            );
        }
        let path = run.join("managed-mcp.json");
        launch::write_private(&path, &serde_json::to_vec(&json!({"mcpServers": servers}))?)?;
        Ok(path)
    }

    pub(crate) fn claude_mcp(&self) -> Result<Vec<Value>> {
        self.mcp
            .iter()
            .map(|server| {
                Ok(json!({
                    "name": server.name, "transport": "stdio", "command": path_text(&server.command)?,
                    "args": server.args, "env": tool_environment()
                }))
            })
            .collect()
    }

    pub(crate) fn insert_deepseek_mcp(&self, patch: &mut Vec<Value>) -> Result<()> {
        let mut names = std::collections::BTreeSet::new();
        let servers = self
            .mcp
            .iter()
            .map(|server| {
                let digest = crate::desktop_launch::workspace_hash(&server.name);
                let name = format!("onex-{}-{}", &server.name[..server.name.len().min(10)], &digest[..16]);
                ensure!(names.insert(name.clone()), "duplicate managed DeepSeek MCP namespace");
                let cwd = self.root.join("mcp").join(&server.name);
                Ok(json!({ "id": format!("onex-mcp-{name}"), "name": "@deepseek-ai/dsh-mcp-client",
                "config": { "transport": "stdio", "serverName": name, "command": path_text(&server.command)?,
                    "cwd": path_text(&cwd)?, "args": server.args, "env": tool_environment() } }))
            })
            .collect::<Result<Vec<_>>>()?;
        if !servers.is_empty() {
            patch.push(json!({"insert": servers}));
        }
        Ok(())
    }

    pub(crate) fn write_claude_hooks(&self, config: &Path) -> Result<()> {
        let path = config.join("settings.json");
        let mut settings: Map<String, Value> = match fs::symlink_metadata(&path) {
            Ok(meta) if meta.is_file() => serde_json::from_slice(&fs::read(&path)?)?,
            Err(error) if error.kind() == ErrorKind::NotFound => Default::default(),
            _ => anyhow::bail!("invalid Claude Code settings path"),
        };
        if self.hooks.is_empty() && !settings.contains_key("hooks") {
            return Ok(());
        }
        let hooks = settings
            .entry("hooks")
            .or_insert_with(|| json!({}))
            .as_object_mut()
            .context("invalid Claude Code hooks configuration")?;
        let post = hooks
            .entry("PostToolUse")
            .or_insert_with(|| json!([]))
            .as_array_mut()
            .context("invalid Claude Code PostToolUse configuration")?;
        post.retain(|entry| {
            !entry["hooks"][0]["command"].as_str().is_some_and(|command| command.starts_with(HOOK_COMMAND_PREFIX))
        });
        post.extend(self.post_tool_use()?);
        crate::desktop_launch::publish(config, "settings.json", &serde_json::to_vec_pretty(&settings)?)
    }

    pub(crate) fn post_tool_use(&self) -> Result<Vec<Value>> {
        self.hooks
            .iter()
            .map(|hook| {
                let command = format!("{HOOK_COMMAND_PREFIX}'{}'", path_text(hook)?.replace('\'', "'\\''"));
                Ok(json!({ "matcher":".*", "hooks":[{ "type":"command", "command":command }] }))
            })
            .collect()
    }
}

fn tool_environment() -> Value {
    json!({ "ANTHROPIC_AUTH_TOKEN": "", "ANTHROPIC_API_KEY": "", "OPENAI_API_KEY": "",
        "CODEBUDDY_AUTH_TOKEN": "", "ONEX_WORKBUDDY_SESSION_MODEL_TOKEN": "" })
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;

    #[test]
    fn deepseek_mcp_names_do_not_collide_with_short_release_names() {
        let long = "synthetic-managed-mcp-with-a-long-release-name";
        let short = format!("{}-{}", &long[..15], &crate::desktop_launch::workspace_hash(long)[..16]);
        let app = PreparedTools {
            root: PathBuf::from("/private/run/managed-tools"),
            skills: PathBuf::new(),
            hooks: vec![],
            mcp: [long, &short]
                .into_iter()
                .map(|name| Mcp { name: name.to_string(), command: PathBuf::from("/private/probe"), args: vec![] })
                .collect(),
        };
        let mut patch = vec![];
        app.insert_deepseek_mcp(&mut patch).unwrap();
        let servers = patch[0]["insert"].as_array().unwrap();
        assert_eq!(servers.len(), 2);
        assert_ne!(servers[0]["config"]["serverName"], servers[1]["config"]["serverName"]);
        assert!(servers.iter().all(|server| server["config"]["serverName"].as_str().unwrap().len() <= 32));
        assert_eq!(servers[0]["config"]["cwd"], format!("/private/run/managed-tools/mcp/{long}"));
    }

    #[test]
    fn revocation_replaces_only_the_managed_skill_catalogue() {
        let dir = tempfile::tempdir().unwrap();
        let run = dir.path().join("run");
        let old = run.join(crate::id::new("lch"));
        let next = run.join(crate::id::new("lch"));
        let profile = dir.path().join("vendor-profile");
        for path in [&old, &next, &profile] {
            launch::private_dir(path).unwrap();
        }
        let old_tools = prepare("workbuddy", &old, &[]).unwrap();
        let next_tools = prepare("workbuddy", &next, &[]).unwrap();
        let skill = private_subdirectory(&old_tools.skills, "hulu").unwrap().join("SKILL.md");
        fs::write(&skill, "old verified skill").unwrap();
        let personal = private_subdirectory(&profile, "skills").unwrap().join("personal.md");
        fs::write(&personal, "existing vendor resource").unwrap();
        let pointer = profile.join("skills/__onex_managed__");
        old_tools.link_skills(&profile).unwrap();
        assert_eq!(fs::read_to_string(pointer.join("hulu/SKILL.md")).unwrap(), "old verified skill");

        fs::remove_dir_all(&old).unwrap();
        next_tools.link_skills(&profile).unwrap();
        assert_eq!(fs::read_link(&pointer).unwrap(), next_tools.skills);
        assert!(!pointer.join("hulu").exists());
        assert_eq!(fs::read_to_string(personal).unwrap(), "existing vendor resource");

        fs::remove_file(&pointer).unwrap();
        std::os::unix::fs::symlink(dir.path(), &pointer).unwrap();
        assert!(old_tools.link_skills(&profile).is_err());
        assert_eq!(fs::read_link(&pointer).unwrap(), dir.path());
    }

    #[test]
    fn claude_post_tool_use_revocation_preserves_existing_hooks_and_prefs() {
        let dir = tempfile::tempdir().unwrap();
        let first = dir.path().join("first");
        let next = dir.path().join("next");
        let profile = dir.path().join("vendor-profile");
        for path in [&first, &next, &profile] {
            launch::private_dir(path).unwrap();
        }
        let mut first_tools = prepare("claude-desktop", &first, &[]).unwrap();
        let next_tools = prepare("claude-desktop", &next, &[]).unwrap();
        first_tools.hooks.push(first_tools.root.join("hooks/probe/mark"));
        let settings =
            json!({"theme":"dark", "hooks":{"PostToolUse":[{"hooks":[{"type":"command","command":"user-existing"}]}]}});
        let path = profile.join("settings.json");
        fs::write(&path, settings.to_string()).unwrap();
        first_tools.write_claude_hooks(&profile).unwrap();
        let projected: Value = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
        assert_eq!(projected["hooks"]["PostToolUse"].as_array().unwrap().len(), 2);
        assert!(
            projected["hooks"]["PostToolUse"][1]["hooks"][0]["command"]
                .as_str()
                .unwrap()
                .contains("ONEX_MANAGED_POST_TOOL_USE=1")
        );
        next_tools.write_claude_hooks(&profile).unwrap();
        let restored: Value = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
        assert_eq!(restored, settings);
    }
}
