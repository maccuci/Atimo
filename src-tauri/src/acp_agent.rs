//! Browser/account authentication stays in the vendor CLI, like Synara's ACP
//! adapters. No OAuth tokens or credential files are read by this module.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};

use serde_json::{json, Value};
use tauri::ipc::Channel;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader, Lines};
use tokio::process::{Child, ChildStdin, ChildStdout};

use crate::cancel::Cancel;
use crate::cli_agent::{model_arg, render, require, Agent};
use crate::openrouter::{ChatRequest, StreamEvent};

#[derive(Clone)]
pub(crate) struct SessionInfo {
    pub current_model: Option<String>,
    pub models: Vec<(String, String)>,
}

struct Client {
    agent: Agent,
    child: Child,
    stdin: ChildStdin,
    lines: Lines<BufReader<ChildStdout>>,
    stderr: tokio::task::JoinHandle<()>,
    directory: PathBuf,
    next_id: u64,
}

impl Drop for Client {
    fn drop(&mut self) {
        self.stderr.abort();
        let _ = self.child.start_kill();
        let _ = std::fs::remove_dir_all(&self.directory);
    }
}

impl Client {
    fn spawn(agent: Agent, bin: &Path) -> Result<Self, String> {
        use std::sync::atomic::{AtomicU64, Ordering};
        static NEXT: AtomicU64 = AtomicU64::new(0);
        let directory = std::env::temp_dir().join(format!(
            "atimo-acp-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        #[cfg_attr(not(unix), allow(unused_mut))]
        let mut options = std::fs::DirBuilder::new();
        #[cfg(unix)]
        std::os::unix::fs::DirBuilderExt::mode(&mut options, 0o700);
        options
            .create(&directory)
            .map_err(|e| format!("could not create the chat workspace: {e}"))?;
        let child = crate::cli_agent::command(bin)
            .args(agent.acp_args())
            .env("NO_BROWSER", "true")
            .env("NO_OPEN_BROWSER", "1")
            .env("BROWSER", "false")
            .current_dir(&directory)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true)
            .spawn();
        let mut child = match child {
            Ok(child) => child,
            Err(error) => {
                let _ = std::fs::remove_dir_all(&directory);
                return Err(format!("could not start {}: {error}", agent.label()));
            }
        };
        let stdin = child.stdin.take().ok_or("CLI stdin unavailable")?;
        let stdout = child.stdout.take().ok_or("CLI stdout unavailable")?;
        let stderr = child.stderr.take().ok_or("CLI stderr unavailable")?;
        // Drain without logging: a full pipe blocks the CLI, and auth notices
        // can include a browser URL or device code that should stay private.
        let stderr = tokio::spawn(async move {
            let mut lines = BufReader::new(stderr).lines();
            while let Ok(Some(_)) = lines.next_line().await {}
        });
        Ok(Self {
            agent,
            child,
            stdin,
            lines: BufReader::new(stdout).lines(),
            stderr,
            directory,
            next_id: 0,
        })
    }

    async fn write(&mut self, message: Value) -> Result<(), String> {
        let mut bytes = serde_json::to_vec(&message).map_err(|e| e.to_string())?;
        bytes.push(b'\n');
        self.stdin
            .write_all(&bytes)
            .await
            .map_err(|e| format!("CLI connection closed: {e}"))
    }

    async fn call(
        &mut self,
        method: &str,
        params: Value,
        channel: Option<&Channel<StreamEvent>>,
    ) -> Result<Value, String> {
        self.next_id += 1;
        let id = self.next_id;
        self.write(json!({"jsonrpc": "2.0", "id": id, "method": method, "params": params}))
            .await?;
        loop {
            let line = self
                .lines
                .next_line()
                .await
                .map_err(|e| format!("CLI stream interrupted: {e}"))?
                .ok_or("The CLI closed its ACP connection. Update it and detect again.")?;
            let Ok(message) = serde_json::from_str::<Value>(&line) else {
                continue;
            };
            if let Some(channel) = channel {
                let _ = channel.send(StreamEvent::Alive);
                if let Some(event) = stream_event(&message) {
                    let _ = channel.send(event);
                }
            }
            if message.get("method").is_some() {
                if let Some(reply) = client_reply(&message) {
                    self.write(reply).await?;
                }
                continue;
            }
            if message["id"].as_u64() != Some(id) {
                continue;
            }
            if let Some(error) = message.get("error") {
                return Err(error["message"]
                    .as_str()
                    .unwrap_or("CLI request failed")
                    .to_string());
            }
            return message
                .get("result")
                .cloned()
                .ok_or_else(|| "CLI returned no ACP result".into());
        }
    }

    async fn connect(&mut self) -> Result<Value, String> {
        let initialized = self.call("initialize", json!({
            "protocolVersion": 1,
            "clientInfo": {"name": "atimo", "version": env!("CARGO_PKG_VERSION")},
            "clientCapabilities": {"fs": {"readTextFile": false, "writeTextFile": false}, "terminal": false}
        }), None).await?;
        let params = json!({"cwd": self.directory.to_string_lossy(), "mcpServers": []});
        match self.call("session/new", params.clone(), None).await {
            Ok(session) => validate_session(session),
            Err(error) => {
                // Only cached credentials are safe during Detect or Send.
                // Interactive OAuth/device methods belong to terminal login.
                // Cursor supports headless cached login under cursor_login,
                // which Synara also invokes on demand with _meta.headless.
                let cached = initialized["authMethods"]
                    .as_array()
                    .is_some_and(|methods| {
                        methods.iter().any(|method| method["id"] == "cached_token")
                    });
                if !auth_required(&error) {
                    return Err(error);
                }
                let auth = if self.agent == Agent::CursorCli {
                    json!({"methodId": "cursor_login", "_meta": {"headless": true}})
                } else if cached {
                    json!({"methodId": "cached_token"})
                } else {
                    return Err(error);
                };
                self.call("authenticate", auth, None).await?;
                self.call("session/new", params, None)
                    .await
                    .and_then(validate_session)
            }
        }
    }
}

fn validate_session(session: Value) -> Result<Value, String> {
    if session["sessionId"]
        .as_str()
        .is_none_or(|id| id.trim().is_empty())
    {
        return Err("CLI returned no session id".into());
    }
    let has_model_config = session["configOptions"].as_array().is_some_and(|options| {
        options
            .iter()
            .any(|o| o["category"] == "model" || o["id"] == "model")
    });
    let info = model_choices(&session);
    if has_model_config && info.current_model.is_none() && info.models.is_empty() {
        return Err("No authenticated model is configured. Complete the CLI login first.".into());
    }
    Ok(session)
}

fn auth_required(message: &str) -> bool {
    let message = message.to_lowercase();
    ["auth", "login", "log in", "sign in", "credential", "token"]
        .iter()
        .any(|word| message.contains(word))
}

// Tool permissions are always denied: these connections answer chat turns.
// Filesystem and terminal requests stay unsupported even if a CLI asks anyway.
fn client_reply(message: &Value) -> Option<Value> {
    let id = message.get("id")?;
    if message["method"] == "session/request_permission" {
        Some(json!({"jsonrpc": "2.0", "id": id, "result": {"outcome": {"outcome": "cancelled"}}}))
    } else {
        Some(
            json!({"jsonrpc": "2.0", "id": id, "error": {"code": -32601, "message": "This chat client does not expose files, tools or terminals"}}),
        )
    }
}

fn stream_event(message: &Value) -> Option<StreamEvent> {
    if message["method"] != "session/update" {
        return None;
    }
    let update = &message["params"]["update"];
    if update["content"]["type"] != "text" {
        return None;
    }
    let text = update["content"]["text"].as_str()?.to_string();
    match update["sessionUpdate"].as_str()? {
        "agent_message_chunk" => Some(StreamEvent::Delta { text }),
        "agent_thought_chunk" => Some(StreamEvent::Reasoning { text }),
        _ => None,
    }
}

fn model_choices(session: &Value) -> SessionInfo {
    let mut models = Vec::new();
    if let Some(available) = session["models"]["availableModels"].as_array() {
        for model in available {
            if let Some(id) = model["modelId"].as_str() {
                models.push((
                    id.to_string(),
                    model["name"].as_str().unwrap_or(id).to_string(),
                ));
            }
        }
    }
    let mut current_model = session["models"]["currentModelId"]
        .as_str()
        .filter(|s| !s.trim().is_empty())
        .map(str::to_string);
    // Newer ACP versions put model choices into configOptions instead.
    if let Some(options) = session["configOptions"].as_array() {
        for option in options
            .iter()
            .filter(|o| o["category"] == "model" || o["id"] == "model")
        {
            current_model = option["currentValue"]
                .as_str()
                .filter(|s| !s.trim().is_empty())
                .map(str::to_string)
                .or(current_model);
            collect_options(&option["options"], &mut models);
        }
    }
    models.sort_by(|a, b| a.0.cmp(&b.0));
    models.dedup_by(|a, b| a.0 == b.0);
    SessionInfo {
        current_model,
        models,
    }
}

fn collect_options(options: &Value, models: &mut Vec<(String, String)>) {
    if let Some(options) = options.as_array() {
        for option in options {
            if let Some(id) = option["value"].as_str().filter(|s| !s.trim().is_empty()) {
                models.push((
                    id.to_string(),
                    option["name"].as_str().unwrap_or(id).to_string(),
                ));
            } else {
                collect_options(&option["options"], models);
            }
        }
    }
}

/// Probe, account and catalog each ask for the same session in one connect
/// (and Settings probes every CLI on open). Reuse a recent success instead of
/// spawning the CLI again; failures are never cached so Detect retries at once.
fn setup_cache() -> &'static Mutex<HashMap<Agent, (Instant, SessionInfo)>> {
    static CACHE: OnceLock<Mutex<HashMap<Agent, (Instant, SessionInfo)>>> = OnceLock::new();
    CACHE.get_or_init(Default::default)
}

const SETUP_TTL: Duration = Duration::from_secs(60);

pub(crate) async fn setup(agent: Agent, bin: &Path) -> Result<SessionInfo, String> {
    if let Some((at, info)) = setup_cache().lock().ok().and_then(|c| c.get(&agent).cloned()) {
        if at.elapsed() < SETUP_TTL {
            return Ok(info);
        }
    }
    let info = setup_uncached(agent, bin).await?;
    if let Ok(mut cache) = setup_cache().lock() {
        cache.insert(agent, (Instant::now(), info.clone()));
    }
    Ok(info)
}

async fn setup_uncached(agent: Agent, bin: &Path) -> Result<SessionInfo, String> {
    let run = async {
        let mut client = Client::spawn(agent, bin)?;
        let session = client.connect().await?;
        Ok(model_choices(&session))
    };
    tokio::time::timeout(Duration::from_secs(30), run)
        .await
        .unwrap_or_else(|_| Err("CLI detection timed out (30s).".into()))
        .map_err(|error: String| {
            format!(
                "{}: {error} Run `{}` in a terminal, then press Detect.",
                agent.label(),
                agent.login_command()
            )
        })
}

pub(crate) async fn stream_chat(
    agent: Agent,
    request: ChatRequest,
    channel: Channel<StreamEvent>,
    cancel: Arc<Cancel>,
) {
    let run = async {
        let mut client = Client::spawn(agent, &require(agent)?)?;
        let session = tokio::time::timeout(Duration::from_secs(30), client.connect())
            .await
            .map_err(|_| "CLI connection timed out (30s)".to_string())??;
        let session_id = session["sessionId"]
            .as_str()
            .ok_or("CLI returned no session id")?;
        // Cursor opens sessions in "agent" mode (tools, edits). This is a chat
        // turn, so prefer the CLI's own Q&A mode when it offers one.
        let ask_mode = session["configOptions"].as_array().and_then(|options| {
            options.iter().find(|o| {
                o["category"] == "mode"
                    && o["options"]
                        .as_array()
                        .is_some_and(|values| values.iter().any(|v| v["value"] == "ask"))
            })
        });
        if let Some(config_id) = ask_mode.and_then(|o| o["id"].as_str()) {
            // Not fatal: tool permissions are still denied either way.
            let _ = client
                .call(
                    "session/set_config_option",
                    json!({"sessionId": session_id, "configId": config_id, "value": "ask"}),
                    None,
                )
                .await;
        }
        if let Some(model) = model_arg(agent, &request.model) {
            // Use configOptions when advertised, otherwise the original ACP method.
            let config = session["configOptions"].as_array().and_then(|options| {
                options
                    .iter()
                    .find(|o| o["category"] == "model" || o["id"] == "model")
            });
            if let Some(config_id) = config.and_then(|c| c["id"].as_str()) {
                client
                    .call(
                        "session/set_config_option",
                        json!({"sessionId": session_id, "configId": config_id, "value": model}),
                        None,
                    )
                    .await?;
            } else {
                client
                    .call(
                        "session/set_model",
                        json!({"sessionId": session_id, "modelId": model}),
                        None,
                    )
                    .await?;
            }
        }
        let (system, prompt) = render(&request.messages);
        let prompt = match system {
            Some(system) => format!("{system}\n\n{prompt}"),
            None => prompt,
        };
        let _ = channel.send(StreamEvent::Open);
        let result = client
            .call(
                "session/prompt",
                json!({"sessionId": session_id, "prompt": [{"type": "text", "text": prompt}]}),
                Some(&channel),
            )
            .await?;
        let _ = channel.send(StreamEvent::Done {
            finish_reason: result["stopReason"].as_str().map(str::to_string),
            cancelled: false,
        });
        Ok::<(), String>(())
    };
    // Dropping the future kills the CLI, including during startup/model selection.
    let result = tokio::select! {
        biased;
        _ = cancel.cancelled() => {
            let _ = channel.send(StreamEvent::Done { finish_reason: None, cancelled: true });
            return;
        }
        result = tokio::time::timeout(Duration::from_secs(15 * 60), run) =>
            result.unwrap_or_else(|_| Err("Tempo limite da resposta excedido (15 min).".into())),
    };
    if let Err(error) = result {
        let message = if auth_required(&error) {
            format!(
                "{}: {error} Run `{}` in a terminal and detect again.",
                agent.label(),
                agent.login_command()
            )
        } else {
            format!("{}: {error}", agent.label())
        };
        let _ = channel.send(StreamEvent::Error { message });
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn model_lists_support_both_acp_shapes() {
        let old = model_choices(
            &json!({"models": {"currentModelId": "a", "availableModels": [{"modelId": "a", "name": "Alpha"}]}}),
        );
        assert_eq!(old.current_model.as_deref(), Some("a"));
        assert_eq!(old.models, vec![("a".into(), "Alpha".into())]);
        let new = model_choices(
            &json!({"configOptions": [{"id": "model", "category": "model", "currentValue": "b", "options": [{"group": "Models", "options": [{"value": "b", "name": "Beta"}]}]}]}),
        );
        assert_eq!(new.current_model.as_deref(), Some("b"));
        assert_eq!(new.models, vec![("b".into(), "Beta".into())]);
    }

    #[test]
    fn unsolicited_browser_authentication_is_never_approved() {
        let response = client_reply(&json!({"id": "browser", "method": "authenticate", "params": {"url": "https://example.com"}})).unwrap();
        assert_eq!(response["error"]["code"], -32601);
        assert!(client_reply(&json!({"method": "session/update"})).is_none());
    }

    #[test]
    fn a_cli_without_a_configured_model_is_not_reported_as_authenticated() {
        let session = json!({"sessionId": "s", "configOptions": [{"id": "model", "category": "model", "currentValue": "", "options": []}]});
        assert!(validate_session(session).unwrap_err().contains("login"));
        assert!(validate_session(json!({})).is_err());
    }

    #[cfg(unix)]
    fn fixture() -> PathBuf {
        Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/acp-agent.py")
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn cached_login_and_prompt_work_while_tools_are_denied() {
        let mut client = Client::spawn(Agent::GrokCli, &fixture()).unwrap();
        let session = tokio::time::timeout(Duration::from_secs(5), client.connect())
            .await
            .unwrap()
            .unwrap();
        assert_eq!(
            model_choices(&session).models,
            vec![("test-model".into(), "Test Model".into())]
        );
        let events = Arc::new(Mutex::new(Vec::new()));
        let captured = events.clone();
        let channel = Channel::new(move |event| {
            let tauri::ipc::InvokeResponseBody::Json(text) = event else {
                panic!("JSON event expected")
            };
            captured
                .lock()
                .unwrap()
                .push(serde_json::from_str::<Value>(&text).unwrap());
            Ok(())
        });
        let result = tokio::time::timeout(
            Duration::from_secs(5),
            client.call(
                "session/prompt",
                json!({"sessionId": "test-session", "prompt": [{"type": "text", "text": "Hi"}]}),
                Some(&channel),
            ),
        )
        .await
        .unwrap()
        .unwrap();
        assert_eq!(result["stopReason"], "end_turn");
        let events = events.lock().unwrap();
        assert!(events
            .iter()
            .any(|e| e["type"] == "reasoning" && e["text"] == "Thinking"));
        assert!(events
            .iter()
            .any(|e| e["type"] == "delta" && e["text"] == "Hello"));
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn dropping_a_pending_turn_kills_the_cli() {
        let mut client = Client::spawn(Agent::CursorCli, &fixture()).unwrap();
        let pid = client.child.id().unwrap();
        let directory = client.directory.clone();
        let pending = async move { client.call("test/hang", json!({}), None).await };
        assert!(tokio::time::timeout(Duration::from_millis(100), pending)
            .await
            .is_err());
        assert!(!directory.exists());
        tokio::time::timeout(Duration::from_secs(2), async {
            loop {
                let running = tokio::process::Command::new("kill")
                    .args(["-0", &pid.to_string()])
                    .stdout(Stdio::null())
                    .stderr(Stdio::null())
                    .status()
                    .await
                    .unwrap()
                    .success();
                if !running {
                    break;
                }
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .expect("cancelled CLI must exit");
    }

    #[tokio::test]
    #[ignore = "checks installed vendor CLIs and account/network state; no prompts or paid calls"]
    async fn installed_acp_clis_can_initialize_without_a_prompt() {
        for agent in [
            Agent::CursorCli,
            Agent::GeminiCli,
            Agent::GrokCli,
            Agent::KimiCli,
            Agent::DevinCli,
        ] {
            let Ok(bin) = require(agent) else { continue };
            match setup(agent, &bin).await {
                Ok(info) => eprintln!(
                    "{}: authenticated, {} models",
                    agent.label(),
                    info.models.len()
                ),
                Err(error) => eprintln!("{}: {error}", agent.label()),
            }
        }
    }
}
