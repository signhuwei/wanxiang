//! Download approved, immutable tool bundles and stage them inside one managed launch.
use std::collections::{BTreeMap, BTreeSet};
use std::path::{Path, PathBuf};
use std::time::Duration;

use anyhow::{Context, Result, bail, ensure};
use base64::Engine;
use base64::engine::general_purpose::STANDARD;
use futures_util::StreamExt;
use onex_core::ws::ToolRelease;
use serde::Deserialize;
use serde_json::json;
use sha2::{Digest, Sha256};

const WIRE_LIMIT: u64 = 24 * 1024 * 1024;
const DECODED_LIMIT: usize = 16 * 1024 * 1024;
const MAX_FILES: usize = 256;
const MAX_RELEASES: usize = 64;
const TOTAL_WIRE_LIMIT: u64 = 96 * 1024 * 1024;
const TOOL_AGENTS: &[&str] = &["claude-code", "codex", "kimi-code"];

fn supports_target(tool: &ToolRelease, os: &str, arch: &str) -> bool {
    let platform = match os {
        "darwin" => "macos",
        "win32" => "windows",
        other => other,
    };
    tool.os.as_deref().is_none_or(|target| target == platform)
        && tool.arch.as_deref().is_none_or(|target| target == arch)
}

pub(crate) fn select<'a>(tools: &'a [ToolRelease], agent: &str, os: &str, arch: &str) -> Vec<&'a ToolRelease> {
    let mut selected: Vec<_> = tools
        .iter()
        .filter(|tool| tool.agents.iter().any(|name| name == agent) && supports_target(tool, os, arch))
        .collect();
    selected.sort_by(|a, b| a.id.cmp(&b.id));
    selected
}

pub(crate) struct Bundle {
    kind: String,
    name: String,
    entrypoint: Option<String>,
    args: Vec<String>,
    files: Vec<(String, Vec<u8>)>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct WireBundle {
    files: Vec<WireFile>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct WireFile {
    path: String,
    data: String,
}

fn portable_component(component: &str) -> bool {
    let raw = component.as_bytes();
    if raw.is_empty()
        || raw.len() > 80
        || !(raw[0].is_ascii_alphanumeric() || raw[0] == b'_')
        || !raw.iter().all(|byte| byte.is_ascii_alphanumeric() || b"._-".contains(byte))
        || component.ends_with('.')
    {
        return false;
    }
    let stem = component.split('.').next().unwrap_or("").to_ascii_uppercase();
    let serial_device = (stem.starts_with("COM") || stem.starts_with("LPT"))
        && stem.len() == 4
        && matches!(stem.as_bytes()[3], b'0'..=b'9');
    !matches!(stem.as_str(), "CON" | "PRN" | "AUX" | "NUL") && !serial_device
}

fn portable_path(path: &str) -> bool {
    path.len() <= 240 && path.split('/').all(portable_component)
}

fn validate_release(tool: &ToolRelease) -> Result<()> {
    let valid_id = tool
        .id
        .strip_prefix("tool_")
        .is_some_and(|id| id.len() == 26 && id.bytes().all(|byte| b"0123456789ABCDEFGHJKMNPQRSTVWXYZ".contains(&byte)));
    ensure!(valid_id, "invalid managed tool identity");
    let version = tool.version.as_bytes();
    ensure!(
        !version.is_empty()
            && version.len() <= 64
            && version[0].is_ascii_alphanumeric()
            && version.iter().all(|byte| byte.is_ascii_alphanumeric() || b"._-".contains(byte)),
        "invalid managed tool version"
    );
    let mut agents = BTreeSet::new();
    ensure!(
        !tool.agents.is_empty()
            && tool.agents.iter().all(|agent| TOOL_AGENTS.contains(&agent.as_str()) && agents.insert(agent)),
        "invalid managed tool agents"
    );
    let name = tool.name.as_bytes();
    ensure!(
        portable_component(&tool.name)
            && name.len() <= 48
            && (name[0].is_ascii_lowercase() || name[0].is_ascii_digit())
            && name.iter().all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || *byte == b'-'),
        "invalid managed tool name"
    );
    ensure!(
        tool.size > 0
            && tool.size <= WIRE_LIMIT
            && tool.sha256.len() == 64
            && tool.sha256.bytes().all(|ch| ch.is_ascii_digit() || (b'a'..=b'f').contains(&ch)),
        "invalid managed tool digest or size"
    );
    match (&*tool.kind, tool.os.as_deref(), tool.arch.as_deref(), tool.entrypoint.as_deref()) {
        ("skill", None, None, None) if tool.args.is_empty() => {}
        ("hook", Some("macos"), Some("arm64" | "x64"), Some(path))
            if portable_path(path) && tool.args.is_empty() && tool.agents == ["claude-code"] => {}
        ("mcp", Some("macos" | "windows"), Some("arm64" | "x64"), Some(path)) if portable_path(path) => {
            ensure!(
                tool.args.len() <= 32
                    && tool
                        .args
                        .iter()
                        .all(|arg| { arg.len() <= 256 && !arg.bytes().any(|byte| byte.is_ascii_control()) })
                    && serde_json::to_vec(&tool.args)?.len() <= 4096,
                "invalid managed MCP arguments"
            );
            if cfg!(windows) || tool.os.as_deref() == Some("windows") {
                ensure!(path.to_ascii_lowercase().ends_with(".exe"), "managed Windows MCP requires an executable");
            }
        }
        _ => bail!("invalid managed tool launch metadata"),
    }
    Ok(())
}

fn validate_selection<'a>(releases: impl IntoIterator<Item = &'a ToolRelease>) -> Result<()> {
    let mut seen = BTreeSet::new();
    let mut total = 0;
    for release in releases {
        total += release.size;
        ensure!(total <= TOTAL_WIRE_LIMIT, "managed tool releases exceed their aggregate size limit");
        ensure!(seen.insert((&release.kind, &release.name)), "duplicate managed tool name");
    }
    Ok(())
}

pub(crate) fn validate_device_releases(tools: &[ToolRelease], os: &str, arch: &str) -> Result<()> {
    ensure!(tools.len() <= MAX_RELEASES, "too many managed tool releases");
    let mut ids = BTreeSet::new();
    for tool in tools {
        validate_release(tool)?;
        ensure!(
            ids.insert(&tool.id) && supports_target(tool, os, arch),
            "managed tool is repeated or targets another device"
        );
    }
    for agent in TOOL_AGENTS {
        validate_selection(select(tools, agent, os, arch))?;
    }
    Ok(())
}

fn decode(tool: &ToolRelease, raw: &[u8]) -> Result<Bundle> {
    ensure!(raw.len() as u64 == tool.size, "managed tool size mismatch");
    ensure!(format!("{:x}", Sha256::digest(raw)) == tool.sha256, "managed tool digest mismatch");
    let WireBundle { files } = serde_json::from_slice(raw).context("invalid managed tool bundle")?;
    ensure!(!files.is_empty() && files.len() <= MAX_FILES, "invalid managed tool file count");

    let mut nodes = BTreeMap::<String, (&str, bool)>::new();
    for file in &files {
        let path = file.path.as_str();
        ensure!(portable_path(path), "invalid managed tool path");
        for end in path.match_indices('/').map(|(i, _)| i).chain(std::iter::once(path.len())) {
            let name = &path[..end];
            let is_file = end == path.len();
            if let Some((previous, was_file)) = nodes.insert(name.to_ascii_lowercase(), (name, is_file)) {
                ensure!(previous == name && !was_file && !is_file, "conflicting managed tool paths");
            }
        }
    }
    let required = tool.entrypoint.as_deref().unwrap_or("SKILL.md");
    ensure!(files.iter().any(|file| file.path == required), "managed tool entrypoint missing");

    let mut decoded = Vec::with_capacity(files.len());
    let mut size = 0;
    for WireFile { path, data } in files {
        let bytes = STANDARD.decode(data).context("invalid managed tool file encoding")?;
        size += bytes.len();
        ensure!(size <= DECODED_LIMIT, "decoded managed tool exceeds its size limit");
        if path == required {
            ensure!(!bytes.is_empty(), "managed tool entrypoint is empty");
            if tool.kind == "skill" {
                let markdown = std::str::from_utf8(&bytes).context("managed skill must be UTF-8")?;
                ensure!(!markdown.trim().is_empty() && !markdown.contains('\0'), "invalid managed skill content");
            }
        }
        decoded.push((path, bytes));
    }
    Ok(Bundle {
        kind: tool.kind.clone(),
        name: tool.name.clone(),
        entrypoint: tool.entrypoint.clone(),
        args: tool.args.clone(),
        files: decoded,
    })
}

pub(crate) async fn download(origin: &str, token: &str, releases: &[ToolRelease]) -> Result<Vec<Bundle>> {
    if releases.is_empty() {
        return Ok(Vec::new());
    }
    let base = crate::ipc::normalize_origin(origin).context("invalid OneX Server origin")?;
    let url = reqwest::Url::parse(&base)?;
    let loopback =
        url.scheme() == "http" && matches!(url.host_str(), Some("127.0.0.1" | "localhost" | "[::1]" | "::1"));
    ensure!(url.scheme() == "https" || loopback, "managed tool download requires HTTPS");
    let mut builder = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .connect_timeout(Duration::from_secs(10))
        .timeout(Duration::from_secs(90));
    if loopback {
        builder = builder.no_proxy();
    }
    let client = builder.build()?;

    ensure!(releases.len() <= MAX_RELEASES, "too many managed tool releases");
    for release in releases {
        validate_release(release)?;
    }
    validate_selection(releases)?;
    let mut tools = Vec::with_capacity(releases.len());
    for tool in releases {
        let response = client
            .get(format!("{base}/v1/edge/tool-artifacts/{}", tool.id))
            .bearer_auth(token)
            .send()
            .await
            .map_err(reqwest::Error::without_url)?;
        ensure!(response.status().is_success(), "managed tool download failed: HTTP {}", response.status());
        ensure!(response.content_length().is_none_or(|size| size == tool.size), "managed tool size mismatch");
        let mut raw = Vec::with_capacity(tool.size as usize);
        let mut stream = response.bytes_stream();
        while let Some(chunk) = stream.next().await {
            let chunk = chunk.map_err(reqwest::Error::without_url)?;
            ensure!(raw.len() as u64 + chunk.len() as u64 <= tool.size, "managed tool exceeds its declared size");
            raw.extend_from_slice(&chunk);
        }
        tools.push(decode(tool, &raw)?);
    }
    Ok(tools)
}

struct Mcp {
    name: String,
    command: PathBuf,
    args: Vec<String>,
}

fn install(bundles: &[Bundle], executable_root: &Path, skills: &Path) -> Result<Vec<Mcp>> {
    let mut servers = Vec::new();
    for bundle in bundles {
        let destination = match bundle.kind.as_str() {
            "skill" => skills.join(&bundle.name),
            "hook" => executable_root.join("hooks").join(&bundle.name),
            _ => executable_root.join("mcp").join(&bundle.name),
        };
        crate::launch::private_dir(destination.parent().context("managed tool parent missing")?)?;
        std::fs::create_dir(&destination).context("create managed tool directory")?;
        for (relative, bytes) in &bundle.files {
            let path = destination.join(relative);
            crate::launch::private_dir(path.parent().context("managed tool file parent missing")?)?;
            crate::launch::write_private(&path, bytes)?;
            #[cfg(unix)]
            if bundle.entrypoint.as_deref() == Some(relative.as_str()) && bundle.kind != "skill" {
                use std::os::unix::fs::PermissionsExt;
                std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o700))?;
            }
        }
        if bundle.kind == "mcp" {
            let relative = bundle.entrypoint.as_deref().context("missing managed MCP entrypoint")?;
            servers.push(Mcp {
                name: bundle.name.clone(),
                command: destination.join(relative),
                args: bundle.args.clone(),
            });
        }
    }
    Ok(servers)
}

fn path_text(path: &Path) -> Result<&str> {
    path.to_str().context("managed tool path must be UTF-8")
}

fn mcp_environment(launch: &crate::launch::Launch) -> BTreeMap<String, String> {
    let mut env = ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "OPENAI_API_KEY"]
        .into_iter()
        .map(|key| (key.to_owned(), String::new()))
        .collect::<BTreeMap<_, _>>();
    for key in launch.env.keys().filter(|key| key.starts_with("ONEX_CODEX_TOKEN_")) {
        env.insert(key.clone(), String::new());
    }
    env
}

fn mcp_json(servers: &[Mcp], env: &BTreeMap<String, String>) -> Result<Vec<u8>> {
    let mut configuration = serde_json::Map::new();
    for server in servers {
        configuration.insert(
            server.name.clone(),
            json!({
                "command": path_text(&server.command)?, "args": server.args, "env": env,
            }),
        );
    }
    Ok(serde_json::to_vec(&json!({ "mcpServers": configuration }))?)
}

fn replace_argument(args: &mut [String], option: &str, value: String) -> Result<()> {
    let offset = args.iter().position(|arg| arg == option).context("managed tool launch flag missing")?;
    *args.get_mut(offset + 1).context("managed tool launch value missing")? = value;
    Ok(())
}

pub(crate) struct SearchLaunch<'a> {
    pub releases: &'a [onex_core::ws::SearchTool],
    pub capability: &'a str,
    pub socket: &'a Path,
}

/// Only called on a new, private launch before passing its arguments to the CLI.
pub(crate) fn apply(
    agent: &str,
    launch: &mut crate::launch::Launch,
    bundles: &[Bundle],
    search: Option<SearchLaunch<'_>>,
) -> Result<()> {
    if bundles.is_empty() && search.is_none() {
        return Ok(());
    }
    let root = launch.run_dir.join("managed-tools");
    crate::launch::private_dir(&root)?;
    let env = mcp_environment(launch);
    let has_skills = bundles.iter().any(|bundle| bundle.kind == "skill");
    let assets = root.join("plugin");
    let skills = match agent {
        "claude-code" => assets.join("skills"),
        "codex" => codex_skills_root(&launch.config_dir)?,
        _ => root.join("skills"),
    };
    let mut servers = install(bundles, &root, &skills)?;
    if let Some(search) = search {
        let program = std::env::current_exe().context("找不到 OneX 搜索工具执行程序")?;
        for release in search.releases {
            // Bundle names cannot contain underscores, so native tool event billing cannot see this as a paid stdio artifact.
            let name = format!("onex_search_{}", release.id.to_ascii_lowercase());
            let config = root.join(format!("{name}.json"));
            let payload = crate::hosted_search::McpConfig {
                socket: search.socket.to_owned(),
                launch_id: launch.launch_id.clone(),
                release_id: release.id.clone(),
                name: release.name.clone(),
                capability: search.capability.to_owned(),
            };
            crate::launch::write_private(&config, &serde_json::to_vec(&payload)?)?;
            servers.push(Mcp {
                name,
                command: program.clone(),
                args: vec!["tool-search-stdio".into(), path_text(&config)?.into()],
            });
        }
    }

    match agent {
        "claude-code" => {
            if !servers.is_empty() {
                let path = root.join("mcp.json");
                crate::launch::write_private(&path, &mcp_json(&servers, &env)?)?;
                replace_argument(&mut launch.args, "--mcp-config", path_text(&path)?.to_owned())?;
            }
            let mut hooks = Vec::new();
            for bundle in bundles.iter().filter(|bundle| bundle.kind == "hook") {
                let entry = bundle.entrypoint.as_deref().context("missing hook entrypoint")?;
                let path = root.join("hooks").join(&bundle.name).join(entry);
                let quoted = path_text(&path)?.replace(char::from(39), "'\\''");
                hooks.push(json!({"type": "command", "command": format!("env -u ANTHROPIC_API_KEY -u ANTHROPIC_AUTH_TOKEN -u OPENAI_API_KEY '{quoted}'")}));
            }
            if !hooks.is_empty() {
                let path = launch.run_dir.join("settings.json");
                let mut settings: serde_json::Value = serde_json::from_slice(&std::fs::read(&path)?)?;
                settings["hooks"] = json!({"PostToolUse": [{"hooks": hooks}]});
                crate::launch::write_private(&path, &serde_json::to_vec(&settings)?)?;
            }
            if has_skills {
                let manifest = assets.join(".claude-plugin");
                crate::launch::private_dir(&manifest)?;
                crate::launch::write_private(
                    &manifest.join("plugin.json"),
                    br#"{"name":"onex-managed","version":"1.0.0"}"#,
                )?;
                launch.args.extend(["--plugin-dir".to_owned(), path_text(&assets)?.to_owned()]);
            }
        }
        "codex" => {
            if !servers.is_empty() {
                use std::fmt::Write;
                let path = launch.config_dir.join("config.toml");
                let mut config = std::fs::read_to_string(&path)?;
                for server in &servers {
                    let command = crate::codex_launch::quote(path_text(&server.command)?);
                    write!(config, "\n\n[mcp_servers.{}]\ncommand = {command}\nargs = [", server.name)?;
                    for (index, arg) in server.args.iter().enumerate() {
                        let separator = if index == 0 { "" } else { ", " };
                        write!(config, "{separator}{}", crate::codex_launch::quote(arg))?;
                    }
                    config.push_str("]\nrequired = true\n[mcp_servers.");
                    config.push_str(&server.name);
                    config.push_str(".env]\n");
                    for name in env.keys() {
                        writeln!(config, "{} = \"\"", crate::codex_launch::quote(name))?;
                    }
                }
                // The private launch has not started, so no process can observe a partial config.
                crate::launch::write_private(&path, config.as_bytes())?;
            }
        }
        "kimi-code" => {
            if !servers.is_empty() {
                crate::launch::write_private(&launch.config_dir.join("mcp.json"), &mcp_json(&servers, &env)?)?;
            }
            if has_skills {
                replace_argument(&mut launch.args, "--skills-dir", path_text(&skills)?.to_owned())?;
            }
        }
        _ => bail!("managed tools are unsupported for this Agent"),
    }
    Ok(())
}

pub(crate) fn codex_skills_root(config_dir: &Path) -> Result<PathBuf> {
    if cfg!(windows) {
        return Ok(config_dir.join("skills"));
    }
    Ok(config_dir.parent().context("managed Codex profile missing")?.join("home/.agents/skills"))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture(kind: &str, name: &str, files: &[(&str, &str)]) -> (ToolRelease, Vec<u8>) {
        let files: Vec<_> =
            files.iter().map(|(path, bytes)| json!({ "path": path, "data": STANDARD.encode(bytes) })).collect();
        let raw = serde_json::to_vec(&json!({ "files": files })).unwrap();
        let mcp = kind == "mcp";
        (
            ToolRelease {
                id: if mcp { "tool_01M7WTAQK4C81842QVN6XQACSA" } else { "tool_01M7WTAQK4C81842QVN6XQACSB" }.into(),
                name: name.into(),
                kind: kind.into(),
                version: "1.0.0".into(),
                agents: vec!["claude-code".into(), "codex".into(), "kimi-code".into()],
                os: mcp.then(|| "windows".into()),
                arch: mcp.then(|| "x64".into()),
                entrypoint: mcp.then(|| "bin/probe.exe".into()),
                args: if mcp { vec!["alpha \"beta\"".into()] } else { vec![] },
                sha256: format!("{:x}", Sha256::digest(&raw)),
                size: raw.len() as u64,
            },
            raw,
        )
    }

    #[test]
    fn verifies_exact_bundle_bytes_and_entrypoint() {
        let (tool, mut bytes) = fixture("mcp", "marker", &[("bin/probe.exe", "inert test marker")]);
        validate_release(&tool).unwrap();
        assert!(decode(&tool, &bytes).is_ok());
        let last = bytes.len() - 1;
        bytes[last] ^= 1;
        assert!(decode(&tool, &bytes).err().unwrap().to_string().contains("digest mismatch"));
        bytes.pop();
        assert!(decode(&tool, &bytes).err().unwrap().to_string().contains("size mismatch"));
        let (tool, bytes) = fixture("skill", "sample", &[("nested/SKILL.md", "inert test marker")]);
        assert!(decode(&tool, &bytes).err().unwrap().to_string().contains("entrypoint missing"));
    }

    #[test]
    fn rejects_traversal_portable_device_names_and_colliding_paths() {
        for path in [
            "../outside",
            "/absolute",
            "with\\backslash",
            "deep/../x",
            "CON.txt",
            "deep/Lpt1",
            "COM0",
            "LPT0.txt",
            "C:/x",
            "trailing.",
            "empty//segment",
            ".hidden",
        ] {
            let (tool, bytes) = fixture("skill", "sample", &[("SKILL.md", "ok"), (path, "bad")]);
            assert!(decode(&tool, &bytes).is_err(), "{path}");
        }
        for (first, second) in [("a", "a/x"), ("a/x", "a"), ("A/x", "a/Y"), ("a/x", "a/X"), ("a/x", "a/x")] {
            let (tool, bytes) = fixture("skill", "sample", &[("SKILL.md", "ok"), (first, "bad"), (second, "bad")]);
            assert!(decode(&tool, &bytes).is_err(), "{first}, {second}");
        }
        let (tool, bytes) = fixture("skill", "sample", &[("SKILL.md", "ok"), ("a/x", "yes"), ("a/y", "yes")]);
        assert!(decode(&tool, &bytes).is_ok());
    }

    #[test]
    fn selects_tools_for_native_agent_and_platform_labels() {
        let (skill, _) = fixture("skill", "sample", &[("SKILL.md", "inert skill marker")]);
        let (windows, _) = fixture("mcp", "probe", &[("bin/probe.exe", "inert MCP marker")]);
        let macos = ToolRelease {
            id: "tool_01M7WTAQK4C81842QVN6XQACSC".into(),
            os: Some("macos".into()),
            arch: Some("arm64".into()),
            ..windows.clone()
        };
        let releases = [skill, windows, macos];
        let selected = |agent, os, arch| {
            select(&releases, agent, os, arch).iter().map(|tool| tool.id.as_str()).collect::<Vec<_>>()
        };
        assert_eq!(selected("claude-code", "win32", "x64"), [&*releases[1].id, &*releases[0].id]);
        assert_eq!(selected("codex", "darwin", "arm64"), [&*releases[0].id, &*releases[2].id]);
        assert_eq!(selected("kimi-code", "darwin", "x64"), [&*releases[0].id]);
        assert!(selected("workbuddy-desktop", "darwin", "arm64").is_empty());
    }

    #[tokio::test]
    async fn downloads_exact_tool_bytes_with_device_auth_without_following_redirects() {
        use axum::{
            Router,
            http::{HeaderMap, StatusCode, header},
            response::Redirect,
            routing::get,
        };
        use std::sync::Arc;
        use std::sync::atomic::{AtomicBool, Ordering};

        let (tool, raw) = fixture("skill", "sample", &[("SKILL.md", "inert skill marker")]);
        let redirected = ToolRelease { id: "tool_01M7WTAQK4C81842QVN6XQACSD".into(), ..tool.clone() };
        let reached = Arc::new(AtomicBool::new(false));
        let recorded = reached.clone();
        let app = Router::new()
            .route(
                &format!("/v1/edge/tool-artifacts/{}", tool.id),
                get(move |headers: HeaderMap| async move {
                    if headers.get(header::AUTHORIZATION).and_then(|value| value.to_str().ok())
                        == Some("Bearer test-device")
                    {
                        Ok(raw)
                    } else {
                        Err(StatusCode::UNAUTHORIZED)
                    }
                }),
            )
            .route(
                &format!("/v1/edge/tool-artifacts/{}", redirected.id),
                get(|| async { Redirect::temporary("/elsewhere") }),
            )
            .route(
                "/elsewhere",
                get(move || async move {
                    recorded.store(true, Ordering::Relaxed);
                }),
            );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let origin = format!("http://{}", listener.local_addr().unwrap());
        let task = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });

        let output = download(&origin, "test-device", std::slice::from_ref(&tool)).await.unwrap();
        assert_eq!(output[0].files[0].1, b"inert skill marker");
        let error = download(&origin, "wrong-device", std::slice::from_ref(&tool)).await.err().unwrap();
        assert!(error.to_string().contains("401"));
        let error = download(&origin, "test-device", &[redirected]).await.err().unwrap();
        assert!(error.to_string().contains("307"));
        assert!(!reached.load(Ordering::Relaxed));
        task.abort();
    }

    #[cfg(unix)]
    #[test]
    fn claude_post_tool_hook_executes_only_the_installed_entry_in_the_private_launch() {
        let (mut tool, bytes) =
            fixture("mcp", "hook", &[("bin/probe", "#!/bin/sh\n[ -z \"$ANTHROPIC_API_KEY\" ] && echo hook-fired\n")]);
        tool.kind = "hook".into();
        tool.os = Some("macos".into());
        tool.agents = vec!["claude-code".into()];
        tool.args.clear();
        tool.entrypoint = Some("bin/probe".into());
        validate_release(&tool).unwrap();
        let bundle = decode(&tool, &bytes).unwrap();
        let tmp = tempfile::tempdir().unwrap();
        let home = tmp.path().join("user's space");
        let program = std::env::current_exe().unwrap();
        let mut launch = crate::launch::prepare(&crate::launch::Request {
            agent: "claude-code",
            home: &home,
            cwd: tmp.path(),
            router_addr: "127.0.0.1:33030",
            program: &program,
            model: "managed",
            local_token: "local-token",
            client_env: &BTreeMap::new(),
        })
        .unwrap();
        apply("claude-code", &mut launch, &[bundle], None).unwrap();
        let settings: serde_json::Value =
            serde_json::from_slice(&std::fs::read(launch.run_dir.join("settings.json")).unwrap()).unwrap();
        assert_eq!(settings["model"], "managed");
        let command = settings["hooks"]["PostToolUse"][0]["hooks"][0]["command"].as_str().unwrap();
        let result = std::process::Command::new("/bin/sh")
            .args(["-c", command])
            .env("ANTHROPIC_API_KEY", "local-token")
            .output()
            .unwrap();
        assert!(result.status.success());
        assert_eq!(result.stdout, b"hook-fired\n");
        crate::launch::finish(&home, &launch.launch_id).unwrap();
        assert!(!launch.run_dir.exists());
    }

    #[test]
    fn native_tools_are_rendered_in_each_private_launch() {
        let (skill, skill_bytes) =
            fixture("skill", "sample", &[("SKILL.md", "inert skill marker"), ("reference/notes.md", "reference")]);
        let (mcp, mcp_bytes) = fixture("mcp", "probe", &[("bin/probe.exe", "inert MCP marker")]);
        let tools = vec![decode(&skill, &skill_bytes).unwrap(), decode(&mcp, &mcp_bytes).unwrap()];
        let root = tempfile::tempdir().unwrap();
        let home = root.path().join("isolated");
        let cwd = root.path().join("workspace");
        std::fs::create_dir(&cwd).unwrap();
        let client_env = BTreeMap::new();
        let program = std::env::current_exe().unwrap();
        let secret = "router-only-launch-token";
        let hosted = [onex_core::ws::SearchTool {
            id: "tool_01M7YV31G92NTSZM04NQKFV5Z7".into(),
            name: "approved-search".into(),
            agents: vec!["claude-code".into(), "codex".into(), "kimi-code".into()],
        }];
        for agent in ["claude-code", "codex", "kimi-code"] {
            let mut launch = crate::launch::prepare(&crate::launch::Request {
                agent,
                home: &home,
                cwd: &cwd,
                router_addr: "127.0.0.1:33030",
                program: &program,
                model: "approved",
                local_token: secret,
                client_env: &client_env,
            })
            .unwrap();
            let socket = home.join("onexd.sock");
            apply(
                agent,
                &mut launch,
                &tools,
                Some(SearchLaunch { releases: &hosted, capability: "search-only", socket: &socket }),
            )
            .unwrap();
            let arg = |flag: &str| launch.args.windows(2).find(|pair| pair[0] == flag).unwrap()[1].clone();
            let (skill_root, config) = match agent {
                "claude-code" => {
                    assert!(launch.args.iter().any(|flag| flag == "--strict-mcp-config"));
                    let plugin = PathBuf::from(arg("--plugin-dir"));
                    assert!(plugin.join(".claude-plugin/plugin.json").is_file());
                    (plugin.join("skills"), PathBuf::from(arg("--mcp-config")))
                }
                "codex" => (codex_skills_root(&launch.config_dir).unwrap(), launch.config_dir.join("config.toml")),
                "kimi-code" => (PathBuf::from(arg("--skills-dir")), launch.config_dir.join("mcp.json")),
                _ => unreachable!(),
            };
            let skill_file = skill_root.join("sample/SKILL.md");
            assert_eq!(std::fs::read_to_string(&skill_file).unwrap(), "inert skill marker");
            let config = std::fs::read_to_string(&config).unwrap();
            if agent == "codex" {
                assert!(config.contains("[mcp_servers.probe]"));
                assert!(config.contains("args = [\"alpha \\\"beta\\\"\"]"));
                let variable = launch.env.keys().find(|key| key.starts_with("ONEX_CODEX_TOKEN_")).unwrap();
                assert!(config.contains(&format!("\"{variable}\" = \"\"")));
            } else {
                let configuration: serde_json::Value = serde_json::from_str(&config).unwrap();
                assert_eq!(configuration["mcpServers"]["probe"]["args"], json!(["alpha \"beta\""]));
                assert_eq!(configuration["mcpServers"]["probe"]["env"]["ANTHROPIC_API_KEY"], "");
            }
            assert!(!config.contains(secret));
            assert!(config.contains("onex_search_tool_01m7yv31g92ntszm04nqkfv5z7"));
            assert!(config.contains("tool-search-stdio"));
            assert!(!config.contains("search-only"));
            let search_file = launch.run_dir.join("managed-tools/onex_search_tool_01m7yv31g92ntszm04nqkfv5z7.json");
            let search_config: serde_json::Value =
                serde_json::from_slice(&std::fs::read(search_file).unwrap()).unwrap();
            assert_eq!(search_config["launch_id"], launch.launch_id);
            assert_eq!(search_config["capability"], "search-only");
            assert_eq!(search_config["release_id"], hosted[0].id);
            assert!(search_config.get("endpoint").is_none());
            assert!(search_config.get("secret").is_none());
            let mcp_file = launch.run_dir.join("managed-tools/mcp/probe/bin/probe.exe");
            assert_eq!(std::fs::read_to_string(&mcp_file).unwrap(), "inert MCP marker");
            assert!(!cwd.join("skills").exists());
            crate::launch::finish(&home, &launch.launch_id).unwrap();
            assert!(!mcp_file.exists());
            assert!(!skill_file.exists());
        }
    }
}
