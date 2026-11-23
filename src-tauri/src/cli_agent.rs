//! Local agent CLIs as a provider.
//!
//! Anthropic and OpenAI both ship a first-party CLI that is already signed in
//! on the user's machine, and both vendors treat *running their own CLI* as a
//! supported thing to do. What is not supported is lifting the subscription
//! token out of that CLI and calling the API with it directly: Anthropic began
//! rejecting those tokens outside Claude Code in January 2026 and wrote the ban
//! into its terms in February, and OpenAI has never published permission for
//! the equivalent against `auth.openai.com` — it merely has not blocked it yet.
//!
//! So this module never reads a token. It does not touch the keychain, it does
//! not open `~/.codex/auth.json`, and it has no OAuth client id. It spawns the
//! CLI the user already installed, hands it a prompt on argv, and reads what
//! comes back on stdout. Authentication is the CLI's business, exactly as it is
//! when the user runs it from a shell.
//!
//! The consequence to keep in mind: cost is whatever the user's subscription
//! already covers, so no per-token price is reported anywhere in this file.
//! Inventing one would be a number the user is not being charged.

use std::borrow::Cow;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::{Arc, Mutex, OnceLock};

use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::ipc::Channel;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::Command;

use crate::cancel::Cancel;
use crate::openrouter::{Account, CatalogEntry, ChatMessage, ChatRequest, StreamEvent};

/// Every CLI the app runs goes through here. The release build is a GUI
/// process with no console, so on Windows each console child (codex.exe, or the
/// cmd.exe behind an npm `codex.cmd` shim) would otherwise get a console window
/// of its own. `CREATE_NO_WINDOW` gives it a hidden one, and the shells the
/// agent spawns inherit it instead of opening more.
pub(crate) fn command(bin: impl AsRef<std::ffi::OsStr>) -> Command {
    #[cfg_attr(not(windows), allow(unused_mut))]
    let mut command = Command::new(bin);
    #[cfg(windows)]
    command.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    command
}

/// Which CLI. The wire names match `ProviderKey` in `src/lib/adapter/types.ts`.
#[derive(Deserialize, Serialize, Clone, Copy, PartialEq, Eq, Hash, Debug)]
#[serde(rename_all = "kebab-case")]
#[expect(clippy::enum_variant_names, reason = "Names serialize directly to the existing TypeScript *-cli provider ids")]
pub enum Agent {
    ClaudeCli,
    CodexCli,
    CursorCli,
    GeminiCli,
    GrokCli,
    KimiCli,
    DevinCli,
}

impl Agent {
    fn binary(self) -> &'static str {
        match self {
            Agent::ClaudeCli => "claude",
            Agent::CodexCli => "codex",
            Agent::CursorCli => "cursor-agent",
            Agent::GeminiCli => "gemini",
            Agent::GrokCli => "grok",
            Agent::KimiCli => "kimi",
            Agent::DevinCli => "devin",
        }
    }

    /// How the user refers to it, for error messages and the connect sheet.
    pub fn label(self) -> &'static str {
        match self {
            Agent::ClaudeCli => "Claude Code",
            Agent::CodexCli => "Codex CLI",
            Agent::CursorCli => "Cursor Agent",
            Agent::GeminiCli => "Gemini CLI",
            Agent::GrokCli => "Grok Build",
            Agent::KimiCli => "Kimi Code",
            Agent::DevinCli => "Devin CLI",
        }
    }

    /// The catalog id prefix, which is also the command the user has to run to
    /// sign in.
    pub(crate) fn slug(self) -> &'static str {
        match self {
            Agent::ClaudeCli => "claude-cli",
            Agent::CodexCli => "codex-cli",
            Agent::CursorCli => "cursor-cli",
            Agent::GeminiCli => "gemini-cli",
            Agent::GrokCli => "grok-cli",
            Agent::KimiCli => "kimi-cli",
            Agent::DevinCli => "devin-cli",
        }
    }

    pub fn login_command(self) -> &'static str {
        match self {
            Agent::ClaudeCli => "claude auth login",
            Agent::CodexCli => "codex login",
            Agent::CursorCli => "cursor-agent login",
            Agent::GeminiCli => "gemini",
            Agent::GrokCli => "grok login",
            Agent::KimiCli => "kimi login",
            Agent::DevinCli => "devin auth login",
        }
    }

    pub(crate) fn uses_acp(self) -> bool {
        !matches!(self, Agent::ClaudeCli | Agent::CodexCli)
    }

    pub(crate) fn acp_args(self) -> &'static [&'static str] {
        match self {
            Agent::GeminiCli => &["--experimental-acp"],
            Agent::GrokCli => &["--permission-mode", "default", "agent", "--no-leader", "stdio"],
            _ => &["acp"],
        }
    }
}

/* ---------------------------------------------------------------------- */
/* Finding the binary                                                      */
/* ---------------------------------------------------------------------- */

/*
 * A bundled `.app` launched from Finder does not inherit the login shell's
 * PATH — macOS hands it `/usr/bin:/bin:/usr/sbin:/sbin` and nothing else. Both
 * CLIs install outside that set for almost every user, so resolving them from
 * PATH alone works in `bun run tauri dev` and then fails for everyone who
 * double-clicks the app. That asymmetry is the entire reason this section
 * exists rather than a single `which` call.
 */

fn home() -> Option<PathBuf> {
    std::env::var_os("HOME")
        .or_else(|| std::env::var_os("USERPROFILE"))
        .map(PathBuf::from)
}

/// Every directory worth looking in, PATH first so a user who deliberately put
/// a particular build ahead of the others still gets it.
fn search_dirs() -> Vec<PathBuf> {
    let mut dirs: Vec<PathBuf> = std::env::var_os("PATH")
        .map(|path| std::env::split_paths(&path).collect())
        .unwrap_or_default();

    if let Some(home) = home() {
        // The installers, in rough order of how often they are the answer.
        for suffix in [
            ".local/bin",             // both CLIs' native installer
            ".claude/local",          // Claude Code's older local install
            ".codex/bin",             // Codex's native install
            ".kimi-code/bin",
            ".local/share/devin/bin",
            ".bun/bin",               //
            ".volta/bin",             //
            ".npm-global/bin",        // npm prefix override
            ".cargo/bin",             //
            "bin",                    //
            "AppData/Local/Programs", // Windows
        ] {
            dirs.push(home.join(suffix));
        }

        // Version managers keep one bin directory per installed runtime, and
        // which of them holds the CLI is not knowable without looking.
        for manager in [".nvm/versions/node", ".fnm/node-versions"] {
            let root = home.join(manager);
            let Ok(entries) = std::fs::read_dir(&root) else {
                continue;
            };
            for entry in entries.flatten() {
                dirs.push(entry.path().join("bin"));
                // fnm nests one level deeper.
                dirs.push(entry.path().join("installation").join("bin"));
            }
        }
    }

    dirs.extend(
        ["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin"]
            .into_iter()
            .map(PathBuf::from),
    );

    dirs
}

/// Executable file names to try in each directory. Windows needs the shim
/// extensions; npm installs both CLIs as a `.cmd` there.
fn candidates(binary: &str) -> Vec<String> {
    if cfg!(windows) {
        vec![
            format!("{binary}.cmd"),
            format!("{binary}.exe"),
            binary.to_string(),
        ]
    } else {
        vec![binary.to_string()]
    }
}

fn is_executable(path: &Path) -> bool {
    let Ok(meta) = std::fs::metadata(path) else {
        return false;
    };
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        meta.is_file() && meta.permissions().mode() & 0o111 != 0
    }
    #[cfg(not(unix))]
    {
        meta.is_file()
    }
}

/// Resolved paths, so a turn does not re-stat forty directories.
///
/// Only successes are cached. A miss stays uncached deliberately: installing
/// the CLI and pressing the button again is the obvious recovery, and caching
/// "absent" would make it not work until the app restarted.
fn cache() -> &'static Mutex<HashMap<Agent, PathBuf>> {
    static CACHE: OnceLock<Mutex<HashMap<Agent, PathBuf>>> = OnceLock::new();
    CACHE.get_or_init(Default::default)
}

fn locate(agent: Agent) -> Option<PathBuf> {
    if let Ok(cache) = cache().lock() {
        if let Some(hit) = cache.get(&agent) {
            if is_executable(hit) {
                return Some(hit.clone());
            }
        }
    }

    let names = candidates(agent.binary());
    for dir in search_dirs() {
        for name in &names {
            let path = dir.join(name);
            if is_executable(&path) {
                if let Ok(mut cache) = cache().lock() {
                    cache.insert(agent, path.clone());
                }
                return Some(path);
            }
        }
    }
    None
}

pub(crate) fn require(agent: Agent) -> Result<PathBuf, String> {
    locate(agent).ok_or_else(|| {
        format!(
            "{} is not installed, or Atimo cannot see it on PATH.",
            agent.label()
        )
    })
}

/* ---------------------------------------------------------------------- */
/* Probing                                                                 */
/* ---------------------------------------------------------------------- */

/// What the connect sheet is allowed to know about a local CLI.
///
/// Note what is absent: no token, no expiry, nothing derived from a credential.
/// `account` is whatever the CLI itself prints about who is signed in.
#[derive(Serialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct AgentProbe {
    pub installed: bool,
    /// Where it was found, so a user with two installs can tell which one runs.
    pub path: Option<String>,
    pub version: Option<String>,
    pub logged_in: bool,
    /// How the CLI says it is authenticated — `claude.ai`, `ChatGPT`, an API key.
    pub method: Option<String>,
    pub account: Option<String>,
    pub plan: Option<String>,
    /// The model the CLI is configured to use, when it will say.
    pub model: Option<String>,
    /// The shell command that fixes `logged_in: false`.
    pub login_command: String,
    /// One sentence naming what is wrong, or `None` when nothing is.
    pub problem: Option<String>,
}

/// Run a short command and collect it. Used only for `--version` and the two
/// login-status subcommands, none of which reach the network for a model.
async fn capture(bin: &Path, args: &[&str]) -> Result<(String, String, bool), String> {
    let output = command(bin)
        .args(args)
        .stdin(Stdio::null())
        .kill_on_drop(true)
        .output()
        .await
        .map_err(|e| format!("could not run {}: {e}", bin.display()))?;

    Ok((
        String::from_utf8_lossy(&output.stdout).trim().to_string(),
        String::from_utf8_lossy(&output.stderr).trim().to_string(),
        output.status.success(),
    ))
}

pub async fn probe(agent: Agent) -> AgentProbe {
    let mut probe = AgentProbe {
        login_command: agent.login_command().to_string(),
        ..Default::default()
    };

    let Some(path) = locate(agent) else {
        probe.problem = Some(format!(
            "{} was not found. Install it, then press Detect again.",
            agent.label()
        ));
        return probe;
    };

    probe.installed = true;
    probe.path = Some(path.display().to_string());

    match capture(&path, &["--version"]).await {
        Ok((stdout, _, true)) if !stdout.is_empty() => {
            probe.version = Some(stdout.lines().next().unwrap_or_default().to_string());
        }
        Ok((_, stderr, _)) => {
            probe.problem = Some(if stderr.is_empty() {
                format!("{} did not report a version.", agent.label())
            } else {
                format!("{}: {stderr}", agent.label())
            });
            return probe;
        }
        Err(message) => {
            probe.problem = Some(message);
            return probe;
        }
    }

    match agent {
        Agent::ClaudeCli => probe_claude(&path, &mut probe).await,
        Agent::CodexCli => probe_codex(&path, &mut probe).await,
        agent => match crate::acp_agent::setup(agent, &path).await {
            Ok(session) => {
                probe.logged_in = true;
                probe.method = Some(agent.label().to_string());
                probe.model = session.current_model;
            }
            Err(problem) => probe.problem = Some(problem),
        },
    }

    if !probe.logged_in && probe.problem.is_none() {
        probe.problem = Some(format!(
            "{} is installed but not signed in. Run `{}` in a terminal, then press Detect.",
            agent.label(),
            agent.login_command()
        ));
    }

    probe
}

/// `claude auth status` prints JSON and costs nothing — no model is called.
async fn probe_claude(path: &Path, probe: &mut AgentProbe) {
    let Ok((stdout, stderr, _)) = capture(path, &["auth", "status"]).await else {
        probe.problem = Some("Could not ask Claude Code who is signed in.".into());
        return;
    };

    let Ok(status) = serde_json::from_str::<Value>(&stdout) else {
        // An older CLI without `auth status` is still usable; it just cannot
        // answer this, so say so rather than claiming it is signed out.
        probe.problem = Some(if stderr.is_empty() {
            "This build of Claude Code does not support `claude auth status`. Update it, or connect a key instead.".into()
        } else {
            format!("Claude Code: {stderr}")
        });
        return;
    };

    probe.logged_in = status
        .get("loggedIn")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    probe.method = str_field(&status, "authMethod");
    probe.account = str_field(&status, "email").or_else(|| str_field(&status, "orgName"));
    probe.plan = str_field(&status, "subscriptionType");
}

/// `codex login status` prints a sentence, not JSON — "Logged in using ChatGPT"
/// or a line saying it is not. Exit status carries the same answer, so the text
/// is only used for the *method*, which is the part worth showing.
async fn probe_codex(path: &Path, probe: &mut AgentProbe) {
    let Ok((stdout, stderr, ok)) = capture(path, &["login", "status"]).await else {
        probe.problem = Some("Could not ask Codex who is signed in.".into());
        return;
    };

    let line = if stdout.is_empty() { &stderr } else { &stdout };
    probe.logged_in = ok && line.to_lowercase().contains("logged in");
    if probe.logged_in {
        probe.method = line
            .rsplit_once(" using ")
            .map(|(_, method)| method.trim().to_string())
            .or_else(|| Some(line.trim().to_string()));
    }
    probe.model = codex_configured_model();
}

fn str_field(value: &Value, key: &str) -> Option<String> {
    value
        .get(key)
        .and_then(Value::as_str)
        .map(str::to_string)
        .filter(|s| !s.is_empty())
}

/// The `model` line from `~/.codex/config.toml`.
///
/// Read rather than assumed because Codex model names turn over fast enough
/// that any list shipped here would be wrong within a release — and because
/// running Codex with `--ignore-user-config` (which is what keeps a chat turn
/// from loading the user's MCP servers and plugins) throws away the default
/// unless we can pass it back explicitly.
///
/// Hand-scanned instead of parsed: this is one scalar at the top of the file,
/// and a TOML dependency to read it would be the larger cost. Keys under a
/// `[table]` header are skipped so `[profiles.foo] model = …` cannot win.
fn codex_home() -> Option<PathBuf> {
    match std::env::var_os("CODEX_HOME") {
        Some(dir) => Some(PathBuf::from(dir)),
        None => Some(home()?.join(".codex")),
    }
}

/// The catalog the Codex CLI itself fetched for this account, from
/// `models_cache.json`: (slug, display name, context window), in its priority
/// order, `visibility: "list"` only — the same set its own picker shows.
///
/// Read from the CLI's own cache rather than spawning `codex app-server` and
/// calling `model/list`: same data, no extra process. A missing or stale file
/// just means the picker falls back to the default entry.
fn codex_cached_models() -> Vec<(String, String, Option<u32>)> {
    let Some(text) = codex_home().and_then(|h| std::fs::read_to_string(h.join("models_cache.json")).ok()) else {
        return Vec::new();
    };
    parse_codex_models(&text)
}

fn parse_codex_models(text: &str) -> Vec<(String, String, Option<u32>)> {
    let Ok(cache) = serde_json::from_str::<Value>(text) else {
        return Vec::new();
    };
    let mut models: Vec<&Value> = cache["models"]
        .as_array()
        .map(|m| m.iter().filter(|m| m["visibility"] == "list").collect())
        .unwrap_or_default();
    models.sort_by_key(|m| m["priority"].as_i64().unwrap_or(i64::MAX));
    models
        .into_iter()
        .filter_map(|m| {
            let slug = m["slug"].as_str().filter(|s| !s.is_empty())?;
            let name = m["display_name"].as_str().unwrap_or(slug);
            let window = m["context_window"].as_u64().and_then(|w| u32::try_from(w).ok());
            Some((slug.to_string(), name.to_string(), window))
        })
        .collect()
}

fn codex_configured_model() -> Option<String> {
    let path = codex_home()?.join("config.toml");

    let text = std::fs::read_to_string(path).ok()?;
    for line in text.lines() {
        let line = line.trim();
        if line.starts_with('[') {
            return None; // past the top-level table; no `model` was set
        }
        let Some(value) = line.strip_prefix("model") else {
            continue;
        };
        let Some(value) = value.trim_start().strip_prefix('=') else {
            continue; // `model_reasoning_effort`, `model_provider`, …
        };
        let value = value.trim().trim_matches(['"', '\''].as_slice());
        if !value.is_empty() {
            return Some(value.to_string());
        }
    }
    None
}

pub async fn account(agent: Agent) -> Result<Account, String> {
    let probe = probe(agent).await;
    if let Some(problem) = probe.problem {
        return Err(problem);
    }

    // `usage`/`limit` stay at zero and null on purpose. The turn is paid for by
    // a subscription the CLI already holds, and neither CLI exposes a balance
    // this app could report without making one up.
    Ok(Account {
        label: match (&probe.plan, &probe.account) {
            (Some(plan), Some(account)) => format!("{} · {account}", title_case(plan)),
            (Some(plan), None) => title_case(plan),
            (None, Some(account)) => account.clone(),
            (None, None) => probe
                .method
                .clone()
                .unwrap_or_else(|| agent.label().to_string()),
        },
        usage: 0.0,
        limit: None,
        is_free_tier: false,
    })
}

/// The Codex account's limit windows and credits, read the way Codex's own IDE
/// clients read them: `account/rateLimits/read` over `codex app-server`. The CLI
/// makes the request with its own login, so no token passes through here, and
/// no model is called.
pub async fn codex_usage() -> Result<Value, String> {
    let bin = require(Agent::CodexCli)?;
    let mut child = command(&bin)
        .arg("app-server")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .current_dir(std::env::temp_dir())
        .kill_on_drop(true)
        .spawn()
        .map_err(|e| format!("could not start Codex CLI: {e}"))?;

    // Held open until the answer arrives: the server exits on stdin EOF.
    let mut stdin = child.stdin.take().ok_or("child produced no stdin")?;
    let requests = [
        serde_json::json!({ "id": 1, "method": "initialize", "params": {
            "clientInfo": { "name": "atimo", "title": "Atimo", "version": env!("CARGO_PKG_VERSION") },
            "capabilities": null,
        } }),
        serde_json::json!({ "method": "initialized" }),
        serde_json::json!({ "id": 2, "method": "account/rateLimits/read", "params": { "excludeResetCreditDetails": true } }),
    ];
    for request in requests {
        stdin
            .write_all(format!("{request}\n").as_bytes())
            .await
            .map_err(|e| format!("could not talk to Codex CLI: {e}"))?;
    }

    let mut lines = BufReader::new(child.stdout.take().ok_or("child produced no stdout")?).lines();
    let answer = async {
        while let Some(line) = lines.next_line().await.map_err(|e| e.to_string())? {
            let Ok(mut message) = serde_json::from_str::<Value>(&line) else { continue };
            if message["id"] != 2 {
                continue; // notifications, and the initialize reply
            }
            if let Some(error) = message.get("error") {
                return Err(error["message"].as_str().unwrap_or("Codex refused the usage read").to_string());
            }
            return Ok(message["result"].take());
        }
        Err("Codex CLI exited before reporting usage".to_string())
    };
    tokio::time::timeout(std::time::Duration::from_secs(20), answer)
        .await
        .map_err(|_| "Codex CLI took too long to report usage".to_string())?
}

fn title_case(value: &str) -> String {
    let mut chars = value.chars();
    match chars.next() {
        Some(first) => first.to_uppercase().collect::<String>() + chars.as_str(),
        None => String::new(),
    }
}

/* ---------------------------------------------------------------------- */
/* Catalog                                                                 */
/* ---------------------------------------------------------------------- */

/*
 * Claude Code has no command that lists models, but `--model` takes full ids.
 * The list below was checked against the CLI (each id answered a turn, and the
 * window/output come from its `modelUsage`) on 2026-11-12. A retired id fails
 * with the CLI's own error; `default` keeps working whatever ships next.
 * Codex ids turn over fast, so its list is whatever the CLI last cached for
 * this account, after a default entry for what the user configured.
 *
 * Every entry prices at zero because a subscription turn is not billed per
 * token. `contextLength` is a floor used by the context meter, not a promise.
 */

/// The window to assume before a turn has told us better.
///
/// 200k is the floor across every model either CLI can currently reach, so a
/// wrong guess here under-promises rather than over-promises — the context
/// meter warns early instead of letting a turn overflow. `StreamEvent::Limits`
/// replaces it with the real number the moment the CLI states one.
const ASSUMED_CONTEXT: u32 = 200_000;

pub(crate) fn entry(
    id: &str,
    name: &str,
    vendor: &str,
    context_length: u32,
    max_output: Option<u32>,
    created: i64,
) -> CatalogEntry {
    CatalogEntry {
        id: id.to_string(),
        name: name.to_string(),
        vendor: vendor.to_string(),
        context_length,
        cost_in: 0.0,
        cost_out: 0.0,
        cost_cache_read: None,
        cost_cache_write: None,
        max_output,
        // A CLI turn is one prompt string on an argv, so there is nowhere for an
        // attachment to travel — and tools are switched off, so the agent cannot
        // read one off disk either. The composer refuses attachments for these
        // providers rather than sending a prompt that describes a missing file.
        supports_vision: false,
        supports_files: false,
        supports_audio: false,
        supports_tools: false,
        supports_reasoning: true,
        created,
        description: String::new(),
    }
}

pub async fn catalog(agent: Agent) -> Result<Vec<CatalogEntry>, String> {
    let slug = agent.slug();
    Ok(match agent {
        Agent::ClaudeCli => vec![
            // The default resolves to whatever the user set in their CLI, which
            // is not knowable until a turn runs — so it starts at the floor and
            // corrects itself.
            entry(
                &format!("{slug}/default"),
                "Claude Code default",
                slug,
                ASSUMED_CONTEXT,
                None,
                101,
            ),
        ]
        .into_iter()
        .chain(
            // (id, name, window, max output), newest first.
            [
                ("claude-fable-5-2", "Claude Fable 5.2", 1_000_000, 128_000),
                ("claude-opus-5-5", "Claude Opus 5.5", 1_000_000, 128_000),
                ("claude-sonnet-5-5", "Claude Sonnet 5.5", 1_000_000, 128_000),
                ("claude-haiku-5-5", "Claude Haiku 5.5", 1_000_000, 128_000),
                ("claude-fable-5", "Claude Fable 5", 1_000_000, 64_000),
                ("claude-opus-5", "Claude Opus 5", 1_000_000, 64_000),
                ("claude-sonnet-5", "Claude Sonnet 5", 1_000_000, 64_000),
                ("claude-haiku-4-5", "Claude Haiku 4.5", 200_000, 32_000),
            ]
            .into_iter()
            .enumerate()
            .map(|(i, (id, name, window, output))| {
                entry(&format!("{slug}/{id}"), name, slug, window, Some(output), 100 - i as i64)
            }),
        )
        .collect(),
        Agent::CodexCli => {
            let configured = codex_configured_model();
            let name = match &configured {
                Some(model) => format!("Codex default ({model})"),
                None => "Codex default".to_string(),
            };
            let listed = codex_cached_models();
            let count = listed.len() as i64;
            std::iter::once(entry(&format!("{slug}/default"), &name, slug, ASSUMED_CONTEXT, None, count + 1))
                .chain(listed.into_iter().enumerate().map(|(i, (id, name, window))| {
                    entry(&format!("{slug}/{id}"), &name, slug, window.unwrap_or(ASSUMED_CONTEXT), None, count - i as i64)
                }))
                .collect()
        }
        agent => {
            let session = crate::acp_agent::setup(agent, &require(agent)?).await?;
            // shortcut: ACP has no standard token limits; replace the 32k floor when the CLI advertises them.
            let mut models = vec![entry(&format!("{slug}/default"), &format!("{} default", agent.label()), slug, 32_768, None, i64::MAX)];
            models[0].supports_reasoning = false;
            for (id, name) in session.models {
                if id == "default" { continue; }
                let mut model = entry(&format!("{slug}/{id}"), &name, slug, 32_768, None, 0);
                model.supports_reasoning = false;
                models.push(model);
            }
            models
        }
    })
}

/// `claude-cli/opus` → `Some("opus")`; the `default` entry → `None`, which
/// means "pass no `--model` and let the CLI use whatever it is set to".
pub(crate) fn model_arg(agent: Agent, id: &str) -> Option<String> {
    let alias = id.strip_prefix(agent.slug())?.trim_start_matches('/');
    (!alias.is_empty() && alias != "default").then(|| alias.to_string())
}

/* ---------------------------------------------------------------------- */
/* Chat                                                                    */
/* ---------------------------------------------------------------------- */

/// Split the conversation into what each CLI can carry.
///
/// A CLI turn takes one prompt string, not a message array, so history has to
/// be rendered into text. The role tags are explicit rather than a bare
/// concatenation because without them a two-turn conversation reads to the
/// model as one long user message, and it answers the wrong question.
pub(crate) fn render(messages: &[ChatMessage]) -> (Option<String>, String) {
    let mut system: Vec<Cow<'_, str>> = Vec::new();
    let mut turns: Vec<&ChatMessage> = Vec::new();

    for message in messages {
        if message.role == "system" {
            system.push(message.content.as_text());
        } else {
            turns.push(message);
        }
    }

    let system = (!system.is_empty()).then(|| system.join("\n\n"));

    // The common case — a single question — should reach the model as exactly
    // that, with no scaffolding for it to comment on.
    let prompt = match turns.as_slice() {
        [only] if only.role == "user" => only.content.as_text().into_owned(),
        _ => {
            let mut out = String::from(
                "Below is a conversation in progress. Continue it: reply with the \
                 assistant's next message only, and do not repeat the tags.\n",
            );
            for turn in turns {
                out.push_str(&format!(
                    "\n<{role}>\n{content}\n</{role}>\n",
                    role = turn.role,
                    content = turn.content.as_text().trim()
                ));
            }
            out.push_str("\n<assistant>\n");
            out
        }
    };

    (system, prompt)
}

/// Build the argv for one turn.
///
/// Both commands are shaped by the same intent: this is a chat app, not a
/// coding agent. Tools, sandboxes, session files, project config and MCP
/// servers are all switched off, so a turn cannot touch the user's disk, cannot
/// pick up a `CLAUDE.md` from whatever directory the app happens to be in, and
/// does not leave a session behind.
/// Claude reads its system prompt from `system_file` and the turn from stdin:
/// an integration review can be ~700 KB, past what argv allows (1 MB total on
/// macOS, 32 KB on Windows). Codex still takes `prompt` as its last argument.
fn args_for(
    agent: Agent,
    request: &ChatRequest,
    system_file: Option<&Path>,
    prompt: &str,
) -> Vec<String> {
    let mut args: Vec<String> = Vec::new();
    let push = |args: &mut Vec<String>, values: &[&str]| {
        args.extend(values.iter().map(|v| v.to_string()));
    };

    match agent {
        Agent::ClaudeCli => {
            push(
                &mut args,
                &[
                    "--print",
                    "--output-format",
                    "stream-json",
                    // stream-json refuses to emit the event stream without it.
                    "--verbose",
                    // Token-level deltas rather than one block at the end.
                    "--include-partial-messages",
                    // No tools: nothing to approve, nothing to execute.
                    "--tools",
                    "",
                    "--no-session-persistence",
                    "--strict-mcp-config",
                    // Ignore user/project/local settings — hooks and status
                    // lines belong to the user's terminal, not to this app.
                    "--setting-sources",
                    "",
                ],
            );
            if let Some(path) = system_file {
                // Replaces Claude Code's coding-agent prompt rather than
                // appending to it: Atimo composes its own context, and the
                // agent preamble would fight it.
                push(&mut args, &["--system-prompt-file", &path.to_string_lossy()]);
            }
            if let Some(model) = model_arg(agent, &request.model) {
                push(&mut args, &["--model", &model]);
            }
            if let Some(effort) = request.effort.claude_flag() {
                push(&mut args, &["--effort", effort]);
            }
        }
        Agent::CodexCli => {
            push(
                &mut args,
                &[
                    "exec",
                    "--json",
                    "--skip-git-repo-check",
                    "--sandbox",
                    "read-only",
                    "--ephemeral",
                ],
            );
            // Codex has no flag to replace its system prompt, so the model it
            // runs is chosen here and the rest of the user's config is left
            // out: no MCP servers, no plugins, no project overrides for a
            // window that is only asking a question.
            // When there is nothing to pass back, their config stays loaded so
            // the run still lands on the model they chose.
            if let Some(model) = model_arg(agent, &request.model).or_else(codex_configured_model) {
                push(&mut args, &["--ignore-user-config", "--model", &model]);
            }
            // Codex has no effort flag; it is a config key, overridable per run.
            if let Some(effort) = request.effort.codex_value() {
                push(
                    &mut args,
                    &["-c", &format!("model_reasoning_effort=\"{effort}\"")],
                );
            }
            args.push(prompt.to_string());
        }
        _ => args.extend(agent.acp_args().iter().map(|s| s.to_string())),
    }

    args
}

pub async fn stream_chat(
    agent: Agent,
    request: ChatRequest,
    channel: Channel<StreamEvent>,
    cancel: Arc<Cancel>,
) {
    if agent.uses_acp() {
        crate::acp_agent::stream_chat(agent, request, channel, cancel).await;
        return;
    }
    if let Err(message) = run_stream(agent, request, &channel, cancel).await {
        let _ = channel.send(StreamEvent::Error { message });
    }
}

async fn run_stream(
    agent: Agent,
    request: ChatRequest,
    channel: &Channel<StreamEvent>,
    cancel: Arc<Cancel>,
) -> Result<(), String> {
    let bin = require(agent)?;
    let (system, prompt) = render(&request.messages);
    let claude = matches!(agent, Agent::ClaudeCli);
    let system_file = match (claude, &system) {
        (true, Some(text)) => Some(TempFile::write(text)?),
        _ => None,
    };
    let args = args_for(agent, &request, system_file.as_ref().map(|f| f.0.as_path()), &prompt);

    let mut child = command(&bin)
        .args(&args)
        // Claude reads the turn from stdin. Codex gets it closed, not
        // inherited: it waits on a terminal stdin, and a GUI has no one to type.
        .stdin(if claude { Stdio::piped() } else { Stdio::null() })
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        // A neutral directory, so neither CLI discovers project instructions
        // from wherever the app was launched.
        .current_dir(std::env::temp_dir())
        // Backstop for the paths that return early — the child must not
        // outlive the turn and keep spending the user's quota.
        .kill_on_drop(true)
        .spawn()
        .map_err(|e| format!("could not start {}: {e}", agent.label()))?;

    if let Some(mut stdin) = child.stdin.take() {
        // Own task: the child may start writing before it has read everything.
        tokio::spawn(async move {
            let _ = stdin.write_all(prompt.as_bytes()).await;
        });
    }
    let stdout = child.stdout.take().ok_or("child produced no stdout")?;
    let stderr = child.stderr.take().ok_or("child produced no stderr")?;

    // Drained on its own task: a full stderr pipe blocks the child, and the
    // text is the only diagnostic worth having when the CLI refuses a turn.
    let stderr_task = tokio::spawn(async move {
        let mut collected = String::new();
        let mut lines = BufReader::new(stderr).lines();
        while let Ok(Some(line)) = lines.next_line().await {
            if collected.len() < 4_000 {
                collected.push_str(line.trim());
                collected.push('\n');
            }
        }
        collected
    });

    let mut lines = BufReader::new(stdout).lines();
    let mut state = TurnState {
        model_id: request.model.clone(),
        ..Default::default()
    };

    let mut heartbeat = crate::openrouter::Heartbeat::new();
    loop {
        let line = tokio::select! {
            // Stop must not wait for the next line. A local agent can think for
            // a long time between them, and the process has to die now.
            _ = cancel.cancelled() => {
                let _ = child.start_kill();
                let _ = child.wait().await;
                stderr_task.abort();
                let _ = channel.send(StreamEvent::Done {
                    finish_reason: state.finish_reason.take(),
                    cancelled: true,
                });
                return Ok(());
            }
            line = lines.next_line() => line.map_err(|e| format!("stream interrupted: {e}"))?,
        };

        let Some(line) = line else { break };
        heartbeat.beat(channel);
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        // Both CLIs print the odd human-readable notice among the JSONL. A line
        // that does not parse is noise, not a failed turn.
        let Ok(event) = serde_json::from_str::<Value>(line) else {
            continue;
        };

        match agent {
            Agent::ClaudeCli => handle_claude(&event, channel, &mut state)?,
            Agent::CodexCli => handle_codex(&event, channel, &mut state)?,
            _ => return Err("ACP agent reached the legacy stream reader".into()),
        }
    }

    let status = child
        .wait()
        .await
        .map_err(|e| format!("{} did not exit cleanly: {e}", agent.label()))?;
    let stderr = stderr_task.await.unwrap_or_default();

    if !status.success() && !state.saw_output {
        return Err(describe_exit(agent, &stderr));
    }

    let _ = channel.send(StreamEvent::Done {
        finish_reason: state.finish_reason.or(Some("stop".into())),
        cancelled: false,
    });
    Ok(())
}

/// A private file that lives exactly as long as the turn, on every exit path.
struct TempFile(PathBuf);

impl TempFile {
    fn write(text: &str) -> Result<Self, String> {
        use std::sync::atomic::{AtomicU64, Ordering};
        static NEXT: AtomicU64 = AtomicU64::new(0);
        let name = format!("atimo-system-{}-{}.txt", std::process::id(), NEXT.fetch_add(1, Ordering::Relaxed));
        let path = std::env::temp_dir().join(name);
        let mut options = std::fs::OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        std::os::unix::fs::OpenOptionsExt::mode(&mut options, 0o600);
        use std::io::Write;
        options
            .open(&path)
            .and_then(|mut f| f.write_all(text.as_bytes()))
            .map_err(|e| format!("could not stage the system prompt: {e}"))?;
        Ok(Self(path))
    }
}

impl Drop for TempFile {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.0);
    }
}

#[derive(Default)]
struct TurnState {
    opened: bool,
    /// True once any answer text has been forwarded. A non-zero exit *after*
    /// a complete answer (a CLI that fails on teardown) must not throw the
    /// answer away.
    saw_output: bool,
    finish_reason: Option<String>,
    /// The catalog id this turn was sent to — `claude-cli/opus`, not the
    /// vendor's internal `claude-opus-5`. Carried so a `Limits` event can name
    /// the entry the frontend actually has to correct.
    model_id: String,
}

impl TurnState {
    fn open(&mut self, channel: &Channel<StreamEvent>) {
        if !self.opened {
            self.opened = true;
            let _ = channel.send(StreamEvent::Open);
        }
    }
}

/// Turn the CLI's own words into something a user can act on. The two failures
/// that actually happen are "not signed in" and "out of quota", and both are
/// buried in prose the CLI wrote for a terminal.
fn describe_exit(agent: Agent, stderr: &str) -> String {
    let lower = stderr.to_lowercase();
    if lower.contains("not logged in")
        || lower.contains("unauthorized")
        || lower.contains("authentication")
        || lower.contains("please run")
    {
        return format!(
            "{} is not signed in. Run `{}` in a terminal, then try again.",
            agent.label(),
            agent.login_command()
        );
    }
    if lower.contains("rate limit") || lower.contains("usage limit") || lower.contains("quota") {
        return format!(
            "{} has hit its plan limit. It resets on the schedule of your subscription.",
            agent.label()
        );
    }

    let detail: String = stderr
        .lines()
        .rev()
        .find(|line| !line.trim().is_empty())
        .unwrap_or_default()
        .chars()
        .take(300)
        .collect();

    if detail.is_empty() {
        format!("{} exited without producing an answer.", agent.label())
    } else {
        format!("{}: {detail}", agent.label())
    }
}

/* ---- Claude Code: `--output-format stream-json` ------------------------ */

fn handle_claude(
    event: &Value,
    channel: &Channel<StreamEvent>,
    state: &mut TurnState,
) -> Result<(), String> {
    match event.get("type").and_then(Value::as_str) {
        Some("system") => {
            if event.get("subtype").and_then(Value::as_str) == Some("init") {
                state.open(channel);
            }
        }
        // The plan's 5-hour and weekly windows, in Claude Code's own output.
        // The only usage read that needs no token: there is no `claude usage`.
        Some("rate_limit_event") => {
            if let Some(info) = event.get("rate_limit_info").filter(|v| v.is_object()) {
                let _ = channel.send(StreamEvent::RateLimits { info: info.clone() });
            }
        }
        Some("stream_event") => {
            let Some(inner) = event.get("event") else {
                return Ok(());
            };
            if inner.get("type").and_then(Value::as_str) == Some("content_block_delta") {
                let Some(delta) = inner.get("delta") else {
                    return Ok(());
                };
                match delta.get("type").and_then(Value::as_str) {
                    Some("text_delta") => {
                        if let Some(text) = delta.get("text").and_then(Value::as_str) {
                            if !text.is_empty() {
                                state.saw_output = true;
                                let _ = channel.send(StreamEvent::Delta { text: text.into() });
                            }
                        }
                    }
                    Some("thinking_delta") => {
                        if let Some(text) = delta.get("thinking").and_then(Value::as_str) {
                            if !text.is_empty() {
                                let _ = channel.send(StreamEvent::Reasoning { text: text.into() });
                            }
                        }
                    }
                    _ => {}
                }
            }
        }
        Some("result") => {
            state.finish_reason = event
                .get("stop_reason")
                .and_then(Value::as_str)
                .map(str::to_string);

            // `modelUsage` is keyed by the model that actually answered, which
            // is the only place the resolved window for `…/default` is stated.
            // One entry per model used; a turn that did not switch models has
            // exactly one, so the first is the answer.
            if let Some((_, limits)) = event
                .get("modelUsage")
                .and_then(Value::as_object)
                .and_then(|models| models.iter().next())
            {
                let context_length = u64_at(limits, "contextWindow") as u32;
                if context_length > 0 {
                    let _ = channel.send(StreamEvent::Limits {
                        model: state.model_id.clone(),
                        context_length,
                        max_output: limits
                            .get("maxOutputTokens")
                            .and_then(Value::as_u64)
                            .map(|v| v as u32),
                    });
                }
            }

            if let Some(usage) = event.get("usage") {
                let _ = channel.send(StreamEvent::Usage {
                    // Cached and freshly-written prefix tokens were both read as
                    // input; leaving them out would under-report the turn by an
                    // order of magnitude on any project with memory attached.
                    prompt_tokens: (u64_at(usage, "input_tokens")
                        + u64_at(usage, "cache_read_input_tokens")
                        + u64_at(usage, "cache_creation_input_tokens"))
                        as u32,
                    completion_tokens: u64_at(usage, "output_tokens") as u32,
                    cached_prompt_tokens: usage
                        .get("cache_read_input_tokens")
                        .and_then(Value::as_u64)
                        .and_then(|n| u32::try_from(n).ok()),
                    // `total_cost_usd` is on this event, and it is deliberately
                    // dropped: it prices the turn as if it had gone through the
                    // API. On a subscription the user is charged none of it, and
                    // showing it would be an invoice for money nobody is paying.
                    cost: None,
                });
            }

            if event.get("is_error").and_then(Value::as_bool) == Some(true) {
                let message = event
                    .get("result")
                    .and_then(Value::as_str)
                    .filter(|m| !m.is_empty())
                    .unwrap_or("Claude Code reported an error");
                return Err(message.to_string());
            }
        }
        _ => {}
    }
    Ok(())
}

/* ---- Codex: `exec --json` --------------------------------------------- */

fn handle_codex(
    event: &Value,
    channel: &Channel<StreamEvent>,
    state: &mut TurnState,
) -> Result<(), String> {
    match event.get("type").and_then(Value::as_str) {
        Some("thread.started" | "turn.started") => state.open(channel),

        // Codex reports a finished item, not a token stream — `exec --json` has
        // no delta events. The whole message arrives at once, which the store's
        // frame batching handles the same way it handles a fast stream.
        Some("item.completed" | "item.updated") => {
            let Some(item) = event.get("item") else {
                return Ok(());
            };
            let text = item
                .get("text")
                .and_then(Value::as_str)
                .filter(|t| !t.is_empty());
            let Some(text) = text else { return Ok(()) };

            match item.get("type").and_then(Value::as_str) {
                Some("agent_message") => {
                    state.saw_output = true;
                    let _ = channel.send(StreamEvent::Delta { text: text.into() });
                }
                Some("reasoning") => {
                    let _ = channel.send(StreamEvent::Reasoning { text: text.into() });
                }
                _ => {}
            }
        }

        Some("turn.completed") => {
            state.finish_reason = Some("stop".into());
            if let Some(usage) = event.get("usage") {
                let _ = channel.send(StreamEvent::Usage {
                    prompt_tokens: (u64_at(usage, "input_tokens")
                        + u64_at(usage, "cached_input_tokens")
                        + u64_at(usage, "cache_write_input_tokens"))
                        as u32,
                    completion_tokens: u64_at(usage, "output_tokens") as u32,
                    cached_prompt_tokens: usage
                        .get("cached_input_tokens")
                        .and_then(Value::as_u64)
                        .and_then(|n| u32::try_from(n).ok()),
                    // Subscription turn — see the note in the Claude handler.
                    cost: None,
                });
            }
        }

        Some("turn.failed" | "error") => {
            let message = event
                .pointer("/error/message")
                .or_else(|| event.get("message"))
                .and_then(Value::as_str)
                .filter(|m| !m.is_empty())
                .unwrap_or("Codex reported an error");
            return Err(message.to_string());
        }

        _ => {}
    }
    Ok(())
}

fn u64_at(value: &Value, key: &str) -> u64 {
    value.get(key).and_then(Value::as_u64).unwrap_or(0)
}

/* ---------------------------------------------------------------------- */

#[cfg(test)]
mod tests {
    use super::*;
    use crate::effort::Effort;

    fn message(role: &str, content: &str) -> ChatMessage {
        ChatMessage {
            role: role.into(),
            content: content.into(),
        }
    }

    fn request(model: &str) -> ChatRequest {
        request_with(model, Effort::Auto)
    }

    fn request_with(model: &str, effort: Effort) -> ChatRequest {
        ChatRequest {
            model: model.into(),
            messages: vec![message("user", "hello")],
            temperature: None,
            max_tokens: None,
            effort,
            fast: false,
            pdf_engine: None,
        }
    }

    /// The wire names are shared with `ProviderKey` in TypeScript, and nothing
    /// in either type system spans that gap.
    #[test]
    fn agent_names_match_the_typescript_provider_keys() {
        for (agent, name) in [
            (Agent::CursorCli, "cursor-cli"),
            (Agent::GeminiCli, "gemini-cli"),
            (Agent::GrokCli, "grok-cli"),
            (Agent::KimiCli, "kimi-cli"),
            (Agent::DevinCli, "devin-cli"),
        ] {
            assert_eq!(serde_json::to_value(agent).unwrap(), serde_json::json!(name));
        }
        assert_eq!(
            serde_json::to_value(Agent::ClaudeCli).unwrap(),
            serde_json::json!("claude-cli")
        );
        assert_eq!(
            serde_json::to_value(Agent::CodexCli).unwrap(),
            serde_json::json!("codex-cli")
        );
    }

    #[test]
    fn a_lone_question_reaches_the_model_unwrapped() {
        let (system, prompt) = render(&[message("user", "What is a graph?")]);
        assert_eq!(system, None);
        assert_eq!(prompt, "What is a graph?");
    }

    #[test]
    fn system_messages_are_lifted_out_and_history_is_tagged() {
        let (system, prompt) = render(&[
            message("system", "Be terse."),
            message("user", "First"),
            message("assistant", "Second"),
            message("user", "Third"),
        ]);

        assert_eq!(system.as_deref(), Some("Be terse."));
        assert!(!prompt.contains("Be terse."));
        // Without the tags the model reads three turns as one question.
        assert!(prompt.contains("<user>\nFirst\n</user>"));
        assert!(prompt.contains("<assistant>\nSecond\n</assistant>"));
        assert!(prompt.trim_end().ends_with("<assistant>"));
    }

    /// The composer refuses attachments for these providers, so a parts array
    /// should never reach here. If one ever does, the prompt has to say a file
    /// was left out rather than read as a question about nothing — a CLI turn is
    /// one argv string and there is nowhere for the bytes to go.
    #[test]
    fn an_attachment_that_cannot_travel_is_named_in_the_prompt() {
        let (_, prompt) = render(&[ChatMessage {
            role: "user".into(),
            content: crate::openrouter::MessageContent::Parts(vec![
                serde_json::json!({ "type": "text", "text": "what is this?" }),
                serde_json::json!({
                    "type": "image_url",
                    "image_url": { "url": "data:image/png;base64,AAA" }
                }),
            ]),
        }]);

        assert!(prompt.contains("what is this?"));
        assert!(prompt.contains("[image_url attachment]"));
        // And certainly not a megabyte of base64 on a command line.
        assert!(!prompt.contains("base64"));
    }

    #[test]
    fn the_default_entry_passes_no_model_flag() {
        assert_eq!(model_arg(Agent::ClaudeCli, "claude-cli/default"), None);
        assert_eq!(
            model_arg(Agent::ClaudeCli, "claude-cli/opus").as_deref(),
            Some("opus")
        );
        // An id belonging to another provider must never select a model here.
        assert_eq!(model_arg(Agent::ClaudeCli, "anthropic/claude-opus-4"), None);
    }

    /// A turn is a chat turn: no tools, no session file, no project settings.
    /// Losing any of these silently turns a question into a coding agent
    /// running in whatever directory the app was launched from.
    #[test]
    fn claude_args_disable_tools_sessions_and_project_settings() {
        let args = args_for(
            Agent::ClaudeCli,
            &request("claude-cli/sonnet"),
            Some(Path::new("/tmp/system.txt")),
            "hello",
        );

        let pair = |flag: &str| {
            args.iter()
                .position(|a| a == flag)
                .and_then(|i| args.get(i + 1))
                .cloned()
        };

        assert_eq!(pair("--tools").as_deref(), Some(""));
        assert_eq!(pair("--setting-sources").as_deref(), Some(""));
        assert_eq!(pair("--output-format").as_deref(), Some("stream-json"));
        assert_eq!(pair("--model").as_deref(), Some("sonnet"));
        assert_eq!(pair("--system-prompt-file").as_deref(), Some("/tmp/system.txt"));
        assert!(args.iter().any(|a| a == "--no-session-persistence"));
        assert!(args.iter().any(|a| a == "--strict-mcp-config"));
        // The turn goes through stdin, never argv: a review can exceed ARG_MAX.
        assert!(!args.iter().any(|a| a == "hello"));
    }

    #[test]
    fn codex_args_run_read_only_and_leave_no_session() {
        let args = args_for(
            Agent::CodexCli,
            &request("codex-cli/default"),
            None,
            "hello",
        );

        assert_eq!(args.first().map(String::as_str), Some("exec"));
        assert!(args.iter().any(|a| a == "--json"));
        assert!(args.iter().any(|a| a == "--ephemeral"));
        assert!(args.iter().any(|a| a == "--skip-git-repo-check"));
        let sandbox = args
            .iter()
            .position(|a| a == "--sandbox")
            .and_then(|i| args.get(i + 1));
        assert_eq!(sandbox.map(String::as_str), Some("read-only"));
        assert_eq!(args.last().map(String::as_str), Some("hello"));
    }

    #[test]
    fn effort_reaches_each_cli_in_its_own_dialect() {
        let claude = args_for(
            Agent::ClaudeCli,
            &request_with("claude-cli/opus", Effort::High),
            None,
            "hello",
        );
        let flag = claude
            .iter()
            .position(|a| a == "--effort")
            .and_then(|i| claude.get(i + 1));
        assert_eq!(flag.map(String::as_str), Some("high"));

        // Codex takes it as a config override, and the value must be quoted —
        // `-c` parses the right-hand side as TOML, so a bare word is not a
        // string and the run fails on a type error rather than a bad enum.
        let codex = args_for(
            Agent::CodexCli,
            &request_with("codex-cli/default", Effort::Max),
            None,
            "hello",
        );
        assert!(
            codex.iter().any(|a| a == "model_reasoning_effort=\"max\""),
            "codex args should carry a quoted effort override: {codex:?}"
        );

        // Auto is the default and must add nothing at all.
        let untouched = args_for(Agent::ClaudeCli, &request("claude-cli/opus"), None, "hello");
        assert!(!untouched.iter().any(|a| a == "--effort"));
    }

    /// The bug this catalog change exists to fix: a 1M-window model whose
    /// context meter said 200k, so four fifths of the window the user pays for
    /// looked unavailable.
    #[test]
    fn opus_carries_its_real_million_token_window() {
        let models = tauri::async_runtime::block_on(catalog(Agent::ClaudeCli)).unwrap();
        let opus = models
            .iter()
            .find(|m| m.id == "claude-cli/claude-opus-5-5")
            .expect("opus should be in the catalog");
        assert_eq!(opus.context_length, 1_000_000);
        assert_eq!(opus.max_output, Some(128_000));

        // The default resolves to whatever the user configured, so it starts at
        // the floor and is corrected by `Limits` on the first turn.
        let default = models
            .iter()
            .find(|m| m.id == "claude-cli/default")
            .expect("default should be in the catalog");
        assert_eq!(default.context_length, ASSUMED_CONTEXT);
    }

    /// `…/default` cannot be sized in advance, so the turn has to say. Without
    /// this the seeded floor would stand for the whole session.
    #[test]
    fn the_result_event_corrects_the_context_window() {
        use std::sync::mpsc;

        let (tx, rx) = mpsc::channel();
        let channel = Channel::new(move |body| {
            let _ = tx.send(format!("{body:?}"));
            Ok(())
        });

        let mut state = TurnState {
            model_id: "claude-cli/default".into(),
            ..Default::default()
        };

        handle_claude(
            &serde_json::json!({
                "type": "result",
                "stop_reason": "end_turn",
                "modelUsage": {
                    "claude-opus-5": { "contextWindow": 1_000_000, "maxOutputTokens": 64_000 }
                }
            }),
            &channel,
            &mut state,
        )
        .unwrap();

        let sent = rx.recv().expect("a limits event should have been sent");
        // Named by catalog id, not by the vendor's internal name — the
        // frontend has no map from one to the other.
        assert!(sent.contains("claude-cli/default"), "got {sent}");
        assert!(sent.contains("1000000"), "got {sent}");
    }

    #[test]
    fn catalog_ids_carry_the_agent_prefix_and_no_price() {
        let models = tauri::async_runtime::block_on(catalog(Agent::ClaudeCli)).unwrap();
        assert!(models.iter().any(|m| m.id == "claude-cli/default"));
        assert!(models.iter().any(|m| m.id == "claude-cli/claude-opus-5-5"));
        // Full ids pass straight through as `--model`.
        assert_eq!(model_arg(Agent::ClaudeCli, "claude-cli/claude-opus-5-5").as_deref(), Some("claude-opus-5-5"));
        for model in &models {
            assert_eq!(model.vendor, "claude-cli");
            // A subscription turn is not billed per token; quoting a rate here
            // would put a price on the transcript that nobody is charged.
            assert_eq!(model.cost_in, 0.0);
            assert_eq!(model.cost_out, 0.0);
        }
    }

    #[test]
    fn claude_text_deltas_become_delta_events_and_thinking_stays_separate() {
        // Shape captured from `claude -p --output-format stream-json`.
        let mut state = TurnState::default();
        let event = serde_json::json!({
            "type": "stream_event",
            "event": {
                "type": "content_block_delta",
                "delta": { "type": "text_delta", "text": "hi" }
            }
        });

        let channel = Channel::new(|_| Ok(()));
        handle_claude(&event, &channel, &mut state).unwrap();
        assert!(state.saw_output);

        // Reasoning must not count as answer text: a turn that produced only
        // thinking has produced no answer, and the exit check depends on that.
        let mut state = TurnState::default();
        let thinking = serde_json::json!({
            "type": "stream_event",
            "event": {
                "type": "content_block_delta",
                "delta": { "type": "thinking_delta", "thinking": "hmm" }
            }
        });
        handle_claude(&thinking, &channel, &mut state).unwrap();
        assert!(!state.saw_output);
    }

    #[test]
    fn claude_rate_limit_windows_reach_the_frontend_untouched() {
        use std::sync::mpsc;

        let (tx, rx) = mpsc::channel();
        let channel = Channel::new(move |body| {
            let _ = tx.send(format!("{body:?}"));
            Ok(())
        });
        // Shape captured from Claude Code 2.1.330 on 2026-11-22.
        let event = serde_json::json!({
            "type": "rate_limit_event",
            "rate_limit_info": {
                "status": "allowed", "resetsAt": 1795401000, "rateLimitType": "five_hour",
                "unifiedWindows": {
                    "five_hour": { "utilization": 0.31, "resetsAt": 1795401000, "status": "allowed" },
                    "seven_day": { "utilization": 0.3, "resetsAt": 1795456800, "status": "allowed" }
                }
            }
        });
        handle_claude(&event, &channel, &mut TurnState::default()).unwrap();

        let sent = rx.recv().expect("a rateLimits event should have been sent");
        assert!(sent.contains("rateLimits") && sent.contains("seven_day"), "{sent}");
    }

    #[tokio::test]
    #[ignore = "asks the installed, signed-in Codex CLI for its limits; no model is called"]
    async fn codex_app_server_reports_the_plan_windows() {
        let usage = codex_usage().await.expect("codex usage");
        assert!(usage["rateLimits"]["primary"]["usedPercent"].is_number(), "{usage}");
    }

    #[test]
    fn a_claude_result_marked_as_an_error_fails_the_turn() {
        let channel = Channel::new(|_| Ok(()));
        let mut state = TurnState::default();
        let event = serde_json::json!({
            "type": "result",
            "subtype": "error_during_execution",
            "is_error": true,
            "result": "Credit balance is too low"
        });

        let error = handle_claude(&event, &channel, &mut state).unwrap_err();
        assert_eq!(error, "Credit balance is too low");
    }

    #[test]
    fn codex_agent_messages_become_deltas_and_reasoning_stays_separate() {
        let channel = Channel::new(|_| Ok(()));
        let mut state = TurnState::default();

        // Shape captured from `codex exec --json`.
        handle_codex(
            &serde_json::json!({
                "type": "item.completed",
                "item": { "id": "item_0", "type": "agent_message", "text": "hi" }
            }),
            &channel,
            &mut state,
        )
        .unwrap();
        assert!(state.saw_output);

        let mut state = TurnState::default();
        handle_codex(
            &serde_json::json!({
                "type": "item.completed",
                "item": { "id": "item_1", "type": "reasoning", "text": "thinking" }
            }),
            &channel,
            &mut state,
        )
        .unwrap();
        assert!(!state.saw_output);
    }

    /// Cached input is still input. Dropping it reports a turn with a large
    /// project context attached as if it had cost a few hundred tokens.
    #[test]
    fn codex_usage_counts_cached_input_as_prompt_tokens() {
        use std::sync::mpsc;

        let (tx, rx) = mpsc::channel();
        let channel = Channel::new(move |body| {
            let _ = tx.send(format!("{body:?}"));
            Ok(())
        });

        let mut state = TurnState::default();
        handle_codex(
            &serde_json::json!({
                "type": "turn.completed",
                "usage": {
                    "input_tokens": 100,
                    "cached_input_tokens": 900,
                    "cache_write_input_tokens": 0,
                    "output_tokens": 42
                }
            }),
            &channel,
            &mut state,
        )
        .unwrap();

        let sent = rx.recv().expect("a usage event should have been sent");
        assert!(sent.contains("1000"), "prompt tokens should be 100 + 900");
        assert!(sent.contains("42"));
    }

    #[test]
    fn a_signed_out_cli_is_reported_as_signed_out_not_as_a_crash() {
        let message = describe_exit(
            Agent::CodexCli,
            "Error: Not logged in. Please run `codex login`.",
        );
        assert!(message.contains("not signed in"));
        assert!(message.contains("codex login"));

        let limited = describe_exit(
            Agent::ClaudeCli,
            "Usage limit reached for this 5-hour block",
        );
        assert!(limited.contains("plan limit"));
    }

    /// Discovery and the two status parsers, against the real CLIs.
    ///
    /// Skips rather than fails when the tool is not installed — this has to
    /// stay green on a CI box with neither. What it does catch is the failure
    /// that unit tests structurally cannot: the day `claude auth status` stops
    /// printing JSON, or `codex login status` rewords its one line, the app
    /// would report a signed-in user as signed out and there would be nothing
    /// in the logs to say why.
    #[test]
    fn a_locally_installed_cli_probes_as_installed() {
        for agent in [Agent::ClaudeCli, Agent::CodexCli] {
            if locate(agent).is_none() {
                eprintln!("skipping {}: not installed here", agent.label());
                continue;
            }

            let probe = tauri::async_runtime::block_on(probe(agent));
            assert!(probe.installed, "{} should report installed", agent.label());
            assert!(
                probe.version.is_some(),
                "{} should report a version",
                agent.label()
            );
            // Signed in or not is the user's business, but the two must agree:
            // a probe that claims neither a login nor a problem tells the
            // connect sheet nothing it can show.
            assert!(
                probe.logged_in || probe.problem.is_some(),
                "{} reported neither a login nor a reason",
                agent.label()
            );
            if probe.logged_in {
                assert!(
                    probe.method.is_some(),
                    "{} said it is signed in but not how",
                    agent.label()
                );
            }
        }
    }

    #[test]
    fn the_codex_cache_lists_visible_models_in_priority_order() {
        let cache = r#"{"models":[
            {"slug":"b","display_name":"B","visibility":"list","priority":2,"context_window":500000},
            {"slug":"hidden","visibility":"hide","priority":0},
            {"slug":"a","display_name":"A","visibility":"list","priority":1}
        ]}"#;
        assert_eq!(
            parse_codex_models(cache),
            vec![("a".into(), "A".into(), None), ("b".into(), "B".into(), Some(500_000))]
        );
        assert!(parse_codex_models("not json").is_empty());
    }

    /// The scan must not pick up `model_reasoning_effort`, and must not reach
    /// into `[profiles.x]` for a key that does not apply to the default run.
    #[test]
    fn the_codex_model_scan_reads_only_the_top_level_key() {
        let dir = std::env::temp_dir().join(format!("atimo-codex-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(
            dir.join("config.toml"),
            "model_reasoning_effort = \"high\"\nmodel = \"gpt-5.6-terra\"\n\n[profiles.other]\nmodel = \"wrong\"\n",
        )
        .unwrap();

        std::env::set_var("CODEX_HOME", &dir);
        let found = codex_configured_model();
        std::env::remove_var("CODEX_HOME");
        std::fs::remove_dir_all(&dir).ok();

        assert_eq!(found.as_deref(), Some("gpt-5.6-terra"));
    }
}
