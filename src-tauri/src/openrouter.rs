//! OpenRouter adapter.
//!
//! One provider, one gateway: OpenRouter fronts Anthropic, OpenAI, Google, xAI
//! and the rest behind a single key and a single OpenAI-shaped API, which is
//! exactly the shape the PRD's "Model Adapter" box needs — models stay
//! interchangeable and nothing above this file names a vendor.
//!
//! Streaming is server-sent events. We parse them here rather than in the
//! webview because the key lives in the OS keychain (see `credentials`), and
//! because a cancelled turn should stop the HTTP body, not just stop painting.

use std::borrow::Cow;
use std::sync::{Arc, OnceLock};

use futures_util::StreamExt;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::ipc::Channel;

use crate::cancel::Cancel;
use crate::effort::Effort;

pub const PROVIDER: &str = "openrouter";

const BASE: &str = "https://openrouter.ai/api/v1";
const APP_URL: &str = "https://atimo.app";
const APP_TITLE: &str = "Atimo";

fn client() -> &'static reqwest::Client {
    static CLIENT: OnceLock<reqwest::Client> = OnceLock::new();
    CLIENT.get_or_init(|| {
        reqwest::Client::builder()
            .user_agent(concat!("Atimo/", env!("CARGO_PKG_VERSION")))
            .build()
            .expect("failed to build HTTP client")
    })
}

fn key() -> Result<String, String> {
    crate::credentials::read(PROVIDER)
        .ok_or_else(|| "No OpenRouter key stored. Connect a key first.".to_string())
}

/* ---------------------------------------------------------------------- */
/* Catalog                                                                 */
/* ---------------------------------------------------------------------- */

/// A model as the UI needs it: prices already normalised to USD per **1M**
/// tokens (OpenRouter quotes per-token strings), and capabilities flattened
/// into the three flags the picker actually renders.
#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct CatalogEntry {
    pub id: String,
    pub name: String,
    /// Slug prefix — `anthropic`, `openai`, `x-ai`… The UI maps it to a brand mark.
    pub vendor: String,
    pub context_length: u32,
    pub cost_in: f64,
    pub cost_out: f64,
    /// Input price for a cached prefix, when the model supports one.
    ///
    /// Worth carrying rather than dropping: this app prepends the same project
    /// memory to every turn in a project, which is exactly a cacheable prefix,
    /// and the cached rate runs 10–120x under the normal input rate. For
    /// Atimo's own usage pattern it is often the more honest input price.
    pub cost_cache_read: Option<f64>,
    pub cost_cache_write: Option<f64>,
    pub max_output: Option<u32>,
    pub supports_vision: bool,
    /// Accepts documents (PDFs) as message parts rather than as pasted text.
    ///
    /// Separate from `supports_vision` because the two are genuinely different
    /// capabilities on the same axis: a model can read an image and still reject
    /// a `file` part, and sending one to it fails the whole turn rather than
    /// degrading. The composer refuses the attachment instead.
    pub supports_files: bool,
    pub supports_audio: bool,
    pub supports_tools: bool,
    pub supports_reasoning: bool,
    /// Unix seconds; the picker sorts newest-first inside a vendor.
    pub created: i64,
    pub description: String,
}

/// OpenRouter quotes prices per token as a string ("0.000003"). Per 1M tokens
/// is the unit every cost surface in this app already speaks.
///
/// Only the per-token fields go through here. `image`, `request` and
/// `web_search` are also in the `pricing` object but are priced per image, per
/// request and per thousand results — scaling those by a million would produce
/// a confidently wrong number, so they are left alone rather than guessed at.
fn price_per_million(pricing: Option<&Value>, field: &str) -> Option<f64> {
    pricing
        .and_then(|p| p.get(field))
        .and_then(|v| v.as_str())
        .and_then(|s| s.parse::<f64>().ok())
        .map(|per_token| per_token * 1_000_000.0)
}

/// A price that is genuinely absent, not merely zero. Free models really do
/// quote `"0"`, and collapsing the two would hide that.
fn optional_price(pricing: Option<&Value>, field: &str) -> Option<f64> {
    price_per_million(pricing, field).filter(|p| *p > 0.0)
}

fn parse_entry(model: &Value) -> Option<CatalogEntry> {
    let id = model.get("id")?.as_str()?.to_string();
    let vendor = id.split('/').next().unwrap_or("other").to_string();

    let architecture = model.get("architecture");
    let input_modalities: Vec<&str> = architecture
        .and_then(|a| a.get("input_modalities"))
        .and_then(|v| v.as_array())
        .map(|arr| arr.iter().filter_map(|m| m.as_str()).collect())
        .unwrap_or_default();

    let supported: Vec<&str> = model
        .get("supported_parameters")
        .and_then(|v| v.as_array())
        .map(|arr| arr.iter().filter_map(|p| p.as_str()).collect())
        .unwrap_or_default();

    let top_provider = model.get("top_provider");
    let context_length = model
        .get("context_length")
        .and_then(|v| v.as_u64())
        .or_else(|| {
            top_provider
                .and_then(|t| t.get("context_length"))
                .and_then(|v| v.as_u64())
        })
        .unwrap_or(0) as u32;

    // `name` arrives as "Anthropic: Claude Sonnet 4"; the vendor is already
    // carried by the icon and the group header, so drop the prefix.
    let raw_name = model
        .get("name")
        .and_then(|v| v.as_str())
        .unwrap_or(&id)
        .to_string();
    let name = raw_name
        .split_once(": ")
        .map(|(_, rest)| rest.to_string())
        .unwrap_or(raw_name);

    Some(CatalogEntry {
        id,
        name,
        vendor,
        context_length,
        cost_in: price_per_million(model.get("pricing"), "prompt").unwrap_or(0.0),
        cost_out: price_per_million(model.get("pricing"), "completion").unwrap_or(0.0),
        cost_cache_read: optional_price(model.get("pricing"), "input_cache_read"),
        cost_cache_write: optional_price(model.get("pricing"), "input_cache_write"),
        max_output: top_provider
            .and_then(|t| t.get("max_completion_tokens"))
            .and_then(|v| v.as_u64())
            .map(|v| v as u32),
        supports_vision: input_modalities.contains(&"image"),
        supports_files: input_modalities.contains(&"file"),
        supports_audio: input_modalities.contains(&"audio"),
        supports_tools: supported.contains(&"tools"),
        supports_reasoning: supported.contains(&"reasoning")
            || supported.contains(&"include_reasoning"),
        created: model.get("created").and_then(|v| v.as_i64()).unwrap_or(0),
        description: model
            .get("description")
            .and_then(|v| v.as_str())
            .unwrap_or_default()
            .to_string(),
    })
}

pub async fn catalog() -> Result<Vec<CatalogEntry>, String> {
    // The catalog endpoint is public. Sending the key when we have one keeps
    // the response consistent with what the account can actually reach.
    let mut request = client().get(format!("{BASE}/models"));
    if let Some(k) = crate::credentials::read(PROVIDER) {
        request = request.bearer_auth(k);
    }

    let response = request
        .send()
        .await
        .map_err(|e| format!("could not reach OpenRouter: {e}"))?;

    if !response.status().is_success() {
        return Err(describe_failure(response).await);
    }

    let body: Value = response
        .json()
        .await
        .map_err(|e| format!("malformed catalog response: {e}"))?;

    let models = body
        .get("data")
        .and_then(|d| d.as_array())
        .ok_or("catalog response had no `data` array")?;

    // A single unparseable entry must not cost the user the whole catalog.
    Ok(models.iter().filter_map(parse_entry).collect())
}

/* ---------------------------------------------------------------------- */
/* Account                                                                 */
/* ---------------------------------------------------------------------- */

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Account {
    pub label: String,
    /// USD spent on this key.
    pub usage: f64,
    /// Credit ceiling, when the key has one.
    pub limit: Option<f64>,
    pub is_free_tier: bool,
}

/// `GET /key`'s `data`, as OpenRouter sends it. A normal inference key may read
/// it (`/credits` would need a management key, so the balance stays unknown).
pub async fn usage() -> Result<Value, String> {
    let response = client()
        .get(format!("{BASE}/key"))
        .bearer_auth(key()?)
        .send()
        .await
        .map_err(|e| format!("could not reach OpenRouter: {e}"))?;

    if !response.status().is_success() {
        return Err(describe_failure(response).await);
    }

    let mut body: Value = response
        .json()
        .await
        .map_err(|e| format!("malformed key response: {e}"))?;
    Ok(match body.get_mut("data") {
        Some(data) => data.take(),
        None => body,
    })
}

pub async fn account() -> Result<Account, String> {
    let data = &usage().await?;

    Ok(Account {
        label: data
            .get("label")
            .and_then(|v| v.as_str())
            .unwrap_or("OpenRouter key")
            .to_string(),
        usage: data.get("usage").and_then(|v| v.as_f64()).unwrap_or(0.0),
        limit: data.get("limit").and_then(|v| v.as_f64()),
        is_free_tier: data
            .get("is_free_tier")
            .and_then(|v| v.as_bool())
            .unwrap_or(false),
    })
}

/* ---------------------------------------------------------------------- */
/* Chat                                                                    */
/* ---------------------------------------------------------------------- */

/// What a message carries: prose, or the parts array that adds attachments.
///
/// Untagged, and `Text` first, so the wire form is exactly what each case needs
/// — a plain JSON string for the overwhelming majority of turns, an array only
/// when something is attached. That matters beyond tidiness: a turn with no
/// attachments produces a request byte-identical to the one this adapter sent
/// before multimodal content existed, so nothing about the ordinary path is
/// riding on a shape the provider only accepts on some models.
#[derive(Deserialize, Serialize, Clone, Debug)]
#[serde(untagged)]
pub enum MessageContent {
    Text(String),
    /// OpenAI-shaped content parts (`text`, `image_url`, `file`, `input_audio`).
    /// Passed through opaquely: the frontend builds them against the model's
    /// advertised modalities, and re-declaring the union here would be a second
    /// source of truth that only ever falls behind the first.
    Parts(Vec<Value>),
}

impl MessageContent {
    /// The message as plain text, for a transport that cannot carry parts.
    ///
    /// Borrows in the common case and only allocates for a parts array, which is
    /// the rarer one. Attachments become a named placeholder rather than being
    /// dropped: a CLI that silently lost the image would answer a question about
    /// a picture it was never shown.
    pub fn as_text(&self) -> Cow<'_, str> {
        match self {
            Self::Text(text) => Cow::Borrowed(text),
            Self::Parts(parts) => {
                let mut out: Vec<Cow<'_, str>> = Vec::with_capacity(parts.len());
                for part in parts {
                    match part.get("type").and_then(Value::as_str) {
                        Some("text") => {
                            if let Some(text) = part.get("text").and_then(Value::as_str) {
                                out.push(Cow::Borrowed(text));
                            }
                        }
                        Some(other) => out.push(Cow::Owned(format!("[{other} attachment]"))),
                        None => continue,
                    }
                }
                Cow::Owned(out.join("\n\n"))
            }
        }
    }

    /// Whether this message attaches a document, which is what decides whether
    /// the file-parser plugin has anything to do.
    pub fn has_file_part(&self) -> bool {
        match self {
            Self::Text(_) => false,
            Self::Parts(parts) => parts
                .iter()
                .any(|part| part.get("type").and_then(Value::as_str) == Some("file")),
        }
    }
}

impl From<String> for MessageContent {
    fn from(text: String) -> Self {
        Self::Text(text)
    }
}

impl From<&str> for MessageContent {
    fn from(text: &str) -> Self {
        Self::Text(text.to_string())
    }
}

#[derive(Deserialize, Serialize, Clone, Debug)]
pub struct ChatMessage {
    pub role: String,
    pub content: MessageContent,
}

#[derive(Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ChatRequest {
    pub model: String,
    pub messages: Vec<ChatMessage>,
    pub temperature: Option<f32>,
    pub max_tokens: Option<u32>,
    /// How OpenRouter should turn an attached PDF into tokens: `native` for a
    /// model that reads documents itself, `pdf-text` for plain extraction,
    /// `mistral-ocr` for scans. Only sent when a message actually attaches one.
    ///
    /// Stated rather than left to the default because the default is not free —
    /// OpenRouter falls back to OCR at $2 per thousand pages for models with no
    /// native document input, and a silent per-page charge is not something an
    /// attachment button should be able to trigger. The frontend picks the
    /// engine from the model's own capabilities; see `attachments.ts`.
    #[serde(default)]
    pub pdf_engine: Option<String>,
    /// How hard to think. `#[serde(default)]` so a payload from before this
    /// field existed still deserializes — and lands on `Auto`, which sends
    /// nothing and reproduces the old request exactly.
    #[serde(default)]
    pub effort: Effort,
    /// Prefer the highest-throughput provider. OpenRouter only — maps to
    /// `provider.sort: "throughput"` (the `:nitro` shortcut). Default false
    /// so older payloads keep sending the same request.
    #[serde(default)]
    pub fast: bool,
}

/// What the frontend receives, in order: zero or more `reasoning`/`delta`
/// events, then `usage`, then exactly one terminal `done` or `error`.
#[derive(Serialize, Clone, Debug)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum StreamEvent {
    /// First byte arrived — the UI swaps "composing" for a live cursor here.
    Open,
    /// Bytes arrived that carry no text (keepalives, hidden thinking,
    /// signatures). Lets the frontend tell a slow model from a dead stream.
    Alive,
    Delta {
        text: String,
    },
    /// Reasoning tokens from models that expose them, kept separate from the
    /// answer so they can be rendered (or hidden) on their own.
    Reasoning {
        text: String,
    },
    /// The model's real limits, once the provider has named them.
    ///
    /// Only the CLI adapter sends this, because only it has an id whose window
    /// the catalog cannot know in advance: `claude-cli/default` resolves to
    /// whatever the user configured, and Opus's window is five times Sonnet's.
    /// A catalog entry seeded at a conservative floor is corrected here rather
    /// than left to under-report for the life of the session.
    Limits {
        /// The catalog id this describes — not the provider's internal name,
        /// so the frontend can look it up without a second mapping.
        model: String,
        context_length: u32,
        max_output: Option<u32>,
    },
    /// Subscription windows as the CLI itself reported them during the turn
    /// (Claude Code's `rate_limit_event.rate_limit_info`), passed through
    /// untouched: the frontend owns the one parser for every provider's shape.
    RateLimits {
        info: Value,
    },
    Usage {
        prompt_tokens: u32,
        completion_tokens: u32,
        #[serde(skip_serializing_if = "Option::is_none")]
        cached_prompt_tokens: Option<u32>,
        /// USD, as billed by OpenRouter — authoritative, unlike a local estimate.
        cost: Option<f64>,
    },
    Done {
        finish_reason: Option<String>,
        /// True when the user stopped it; partial text stays on screen.
        cancelled: bool,
    },
    Error {
        message: String,
    },
}

/// DeepSeek also reports cache hits outside `prompt_tokens_details`.
pub(crate) fn cached_prompt_tokens(usage: &Value) -> Option<u32> {
    usage
        .pointer("/prompt_tokens_details/cached_tokens")
        .filter(|value| !value.is_null())
        .or_else(|| usage.get("prompt_cache_hit_tokens"))
        .and_then(Value::as_u64)
        .and_then(|tokens| u32::try_from(tokens).ok())
}

/// "error decoding response body" alone hides why the stream died; the cause
/// (reset, unexpected EOF, …) is further down the source chain.
pub(crate) fn interrupted(error: &(dyn std::error::Error + 'static)) -> String {
    let mut message = format!("stream interrupted: {error}");
    let mut source = error.source();
    while let Some(cause) = source {
        message.push_str(&format!(": {cause}"));
        source = cause.source();
    }
    message
}

/// Throttled `Alive`: at most one per 15 s, so a busy stream adds no traffic.
pub(crate) struct Heartbeat(std::time::Instant);

impl Heartbeat {
    pub(crate) fn new() -> Self {
        Self(std::time::Instant::now())
    }
    pub(crate) fn beat(&mut self, channel: &Channel<StreamEvent>) {
        if self.0.elapsed() >= std::time::Duration::from_secs(15) {
            self.0 = std::time::Instant::now();
            let _ = channel.send(StreamEvent::Alive);
        }
    }
}

/// Turn a non-2xx response into the clearest sentence we can manage. OpenRouter
/// nests the useful part under `error.message`; falling back to the raw body
/// beats showing a bare status code.
async fn describe_failure(response: reqwest::Response) -> String {
    let status = response.status();
    let body = response.text().await.unwrap_or_default();

    let detail = serde_json::from_str::<Value>(&body)
        .ok()
        .and_then(|v| {
            v.get("error")
                .and_then(|e| e.get("message"))
                .and_then(|m| m.as_str())
                .map(str::to_string)
        })
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| body.chars().take(200).collect());

    match status.as_u16() {
        401 => "OpenRouter rejected the key. Check that it is still valid.".into(),
        402 => format!("Out of OpenRouter credits. {detail}"),
        429 => "Rate limited by OpenRouter. Wait a moment and retry.".into(),
        _ if detail.is_empty() => format!("OpenRouter returned {status}"),
        _ => format!("OpenRouter returned {status}: {detail}"),
    }
}

/// Pull one SSE frame's JSON payload out of a `data:` line, or `None` for
/// keepalive comments and the `[DONE]` sentinel.
fn payload_of(line: &str) -> Option<&str> {
    let rest = line.strip_prefix("data:")?.trim();
    (!rest.is_empty() && rest != "[DONE]").then_some(rest)
}

pub async fn stream_chat(request: ChatRequest, channel: Channel<StreamEvent>, cancel: Arc<Cancel>) {
    let result = tokio::select! {
        _ = cancel.cancelled() => {
            let _ = channel.send(StreamEvent::Done { finish_reason: None, cancelled: true });
            return;
        },
        result = tokio::time::timeout(std::time::Duration::from_secs(15 * 60), run_stream(request, &channel, cancel.clone())) => {
            result.unwrap_or_else(|_| Err("Tempo limite da resposta excedido (15 min). Tente novamente.".into()))
        },
    };
    if let Err(message) = result {
        let _ = channel.send(StreamEvent::Error { message });
    }
}

async fn run_stream(
    request: ChatRequest,
    channel: &Channel<StreamEvent>,
    cancel: Arc<Cancel>,
) -> Result<(), String> {
    let key = key()?;

    let mut body = json!({
        "model": request.model,
        "messages": request.messages
            .iter()
            .map(|m| json!({ "role": m.role, "content": m.content }))
            .collect::<Vec<_>>(),
        "stream": true,
        // Without this the final chunk carries no usage, and the cost readout
        // in the transcript would have to be guessed from string length.
        "stream_options": { "include_usage": true },
    });
    if let Some(t) = request.temperature {
        body["temperature"] = json!(t);
    }
    if let Some(m) = request.max_tokens {
        body["max_tokens"] = json!(m);
    }
    if let Some(reasoning) = request.effort.openrouter() {
        body["reasoning"] = reasoning;
    }
    // Exactly the `:nitro` model-suffix shortcut — keep the catalog id intact
    // so context metering still resolves the model the user picked.
    if request.fast {
        body["provider"] = json!({ "sort": "throughput" });
    }
    // Only when a document is actually attached. Declaring the plugin on every
    // request would enable a paid extraction path for turns that carry nothing
    // to extract.
    if let Some(engine) = request.pdf_engine.as_deref() {
        if request.messages.iter().any(|m| m.content.has_file_part()) {
            body["plugins"] = json!([{ "id": "file-parser", "pdf": { "engine": engine } }]);
        }
    }

    let response = client()
        .post(format!("{BASE}/chat/completions"))
        .bearer_auth(key)
        .header("HTTP-Referer", APP_URL)
        .header("X-Title", APP_TITLE)
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("could not reach OpenRouter: {e}"))?;

    if !response.status().is_success() {
        return Err(describe_failure(response).await);
    }

    let _ = channel.send(StreamEvent::Open);

    let mut stream = response.bytes_stream();
    let mut buffer = String::new();
    let mut finish_reason: Option<String> = None;
    let mut heartbeat = Heartbeat::new();

    while let Some(chunk) = stream.next().await {
        heartbeat.beat(channel);
        if cancel.is_cancelled() {
            // Dropping the stream closes the connection, so a stopped turn
            // stops being billed rather than merely stops being painted.
            let _ = channel.send(StreamEvent::Done {
                finish_reason: finish_reason.take(),
                cancelled: true,
            });
            return Ok(());
        }

        let bytes = chunk.map_err(|e| interrupted(&e))?;
        buffer.push_str(&String::from_utf8_lossy(&bytes));

        // Frames are separated by a blank line; anything after the last one is
        // a partial frame and has to wait for more bytes.
        while let Some(split) = buffer.find("\n\n") {
            let frame = buffer[..split].to_string();
            buffer.drain(..split + 2);

            for line in frame.lines() {
                let Some(payload) = payload_of(line) else {
                    continue;
                };
                let Ok(event) = serde_json::from_str::<Value>(payload) else {
                    continue;
                };

                // Errors can arrive mid-stream, after a 200.
                if let Some(message) = event
                    .get("error")
                    .and_then(|e| e.get("message"))
                    .and_then(|m| m.as_str())
                {
                    return Err(message.to_string());
                }

                if let Some(choice) = event.get("choices").and_then(|c| c.get(0)) {
                    if let Some(delta) = choice.get("delta") {
                        if let Some(text) = delta.get("reasoning").and_then(|v| v.as_str()) {
                            if !text.is_empty() {
                                let _ = channel.send(StreamEvent::Reasoning {
                                    text: text.to_string(),
                                });
                            }
                        }
                        if let Some(text) = delta.get("content").and_then(|v| v.as_str()) {
                            if !text.is_empty() {
                                let _ = channel.send(StreamEvent::Delta {
                                    text: text.to_string(),
                                });
                            }
                        }
                    }
                    if let Some(reason) = choice.get("finish_reason").and_then(|v| v.as_str()) {
                        finish_reason = Some(reason.to_string());
                    }
                }

                if let Some(usage) = event.get("usage") {
                    let _ = channel.send(StreamEvent::Usage {
                        prompt_tokens: usage
                            .get("prompt_tokens")
                            .and_then(|v| v.as_u64())
                            .unwrap_or(0) as u32,
                        completion_tokens: usage
                            .get("completion_tokens")
                            .and_then(|v| v.as_u64())
                            .unwrap_or(0) as u32,
                        cached_prompt_tokens: cached_prompt_tokens(usage),
                        cost: usage.get("cost").and_then(|v| v.as_f64()),
                    });
                }
            }
        }
    }

    let _ = channel.send(StreamEvent::Done {
        finish_reason,
        cancelled: false,
    });
    Ok(())
}

/* ---------------------------------------------------------------------- */

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cache_usage_preserves_unknown_and_measured_zero() {
        assert_eq!(cached_prompt_tokens(&json!({})), None);
        assert_eq!(
            cached_prompt_tokens(&json!({ "prompt_tokens_details": { "cached_tokens": 0 } })),
            Some(0)
        );
        assert_eq!(
            cached_prompt_tokens(
                &json!({ "prompt_tokens_details": { "cached_tokens": 12 }, "prompt_cache_hit_tokens": 20 })
            ),
            Some(12)
        );
        assert_eq!(
            cached_prompt_tokens(
                &json!({ "prompt_tokens_details": { "cached_tokens": null }, "prompt_cache_hit_tokens": 20 })
            ),
            Some(20)
        );
        assert_eq!(
            cached_prompt_tokens(&json!({ "prompt_cache_hit_tokens": -1 })),
            None
        );
    }

    #[test]
    fn usage_omits_unreported_cache_tokens() {
        let usage = StreamEvent::Usage {
            prompt_tokens: 12,
            completion_tokens: 34,
            cached_prompt_tokens: None,
            cost: None,
        };
        assert!(serde_json::to_value(usage)
            .unwrap()
            .get("cachedPromptTokens")
            .is_none());
    }

    /// The event shapes are a contract with `src/lib/adapter/types.ts`. Nothing
    /// in the type system spans that gap, and a silent rename here would show
    /// up as a chat that streams nothing — so pin the JSON.
    #[test]
    fn stream_events_match_the_typescript_union() {
        assert_eq!(
            serde_json::to_value(StreamEvent::Delta { text: "hi".into() }).unwrap(),
            json!({ "type": "delta", "text": "hi" })
        );

        assert_eq!(
            serde_json::to_value(StreamEvent::Usage {
                prompt_tokens: 12,
                completion_tokens: 34,
                cached_prompt_tokens: Some(8),
                cost: Some(0.0005),
            })
            .unwrap(),
            json!({
                "type": "usage",
                "promptTokens": 12,
                "completionTokens": 34,
                "cachedPromptTokens": 8,
                "cost": 0.0005
            })
        );

        assert_eq!(
            serde_json::to_value(StreamEvent::Done {
                finish_reason: Some("stop".into()),
                cancelled: false,
            })
            .unwrap(),
            json!({ "type": "done", "finishReason": "stop", "cancelled": false })
        );

        assert_eq!(
            serde_json::to_value(StreamEvent::Open).unwrap(),
            json!({ "type": "open" })
        );
    }

    #[test]
    fn chat_request_accepts_the_camel_case_payload_the_webview_sends() {
        let request: ChatRequest = serde_json::from_value(json!({
            "model": "anthropic/claude-sonnet-4",
            "messages": [{ "role": "user", "content": "hello" }],
            "maxTokens": 512
        }))
        .expect("payload should deserialize");

        assert_eq!(request.model, "anthropic/claude-sonnet-4");
        assert_eq!(request.max_tokens, Some(512));
        assert_eq!(request.messages[0].role, "user");
        assert_eq!(request.messages[0].content.as_text(), "hello");
        // Older payloads omit `fast`; defaulting to false keeps those requests
        // byte-identical to before the field existed.
        assert!(!request.fast);
        assert_eq!(request.pdf_engine, None);
    }

    #[test]
    fn a_message_without_attachments_still_serialises_as_a_bare_string() {
        let message = ChatMessage {
            role: "user".into(),
            content: MessageContent::Text("hello".into()),
        };

        assert_eq!(
            serde_json::to_value(&message).unwrap(),
            json!({ "role": "user", "content": "hello" })
        );
    }

    #[test]
    fn content_parts_round_trip_untouched() {
        let request: ChatRequest = serde_json::from_value(json!({
            "model": "anthropic/claude-sonnet-4",
            "messages": [{
                "role": "user",
                "content": [
                    { "type": "text", "text": "what is in this?" },
                    { "type": "image_url", "image_url": { "url": "data:image/png;base64,AAA" } }
                ]
            }]
        }))
        .expect("a multimodal payload should deserialize");

        // Passed through verbatim — the provider, not this adapter, is the one
        // that has to recognise every part shape.
        assert_eq!(
            serde_json::to_value(&request.messages[0]).unwrap(),
            json!({
                "role": "user",
                "content": [
                    { "type": "text", "text": "what is in this?" },
                    { "type": "image_url", "image_url": { "url": "data:image/png;base64,AAA" } }
                ]
            })
        );
    }

    #[test]
    fn parts_flatten_to_text_with_attachments_named_not_dropped() {
        let content = MessageContent::Parts(vec![
            json!({ "type": "text", "text": "describe this" }),
            json!({ "type": "image_url", "image_url": { "url": "data:image/png;base64,AAA" } }),
        ]);

        assert_eq!(content.as_text(), "describe this\n\n[image_url attachment]");
    }

    #[test]
    fn only_a_file_part_asks_for_the_pdf_parser() {
        let with_file = MessageContent::Parts(vec![json!({
            "type": "file",
            "file": { "filename": "spec.pdf", "file_data": "data:application/pdf;base64,AAA" }
        })]);
        assert!(with_file.has_file_part());

        let with_image = MessageContent::Parts(vec![json!({
            "type": "image_url",
            "image_url": { "url": "data:image/png;base64,AAA" }
        })]);
        assert!(!with_image.has_file_part());
        assert!(!MessageContent::Text("hello".into()).has_file_part());
    }

    #[test]
    fn chat_request_accepts_fast_from_the_webview() {
        let request: ChatRequest = serde_json::from_value(json!({
            "model": "anthropic/claude-sonnet-4",
            "messages": [{ "role": "user", "content": "hello" }],
            "fast": true
        }))
        .expect("payload should deserialize");

        assert!(request.fast);
    }

    #[test]
    fn catalog_entry_normalises_prices_to_dollars_per_million() {
        let entry = parse_entry(&json!({
            "id": "anthropic/claude-sonnet-4",
            "name": "Anthropic: Claude Sonnet 4",
            "created": 1_700_000_000i64,
            "context_length": 200_000,
            "pricing": {
                "prompt": "0.000003",
                "completion": "0.000015",
                "input_cache_read": "0.0000003",
                // Priced per image, not per token — must not be scaled.
                "image": "0.0048",
                "request": "0"
            },
            "architecture": { "input_modalities": ["text", "image", "file"] },
            "supported_parameters": ["tools", "reasoning"],
            "top_provider": { "max_completion_tokens": 8192 }
        }))
        .expect("a well-formed model should parse");

        assert_eq!(entry.vendor, "anthropic");
        // The vendor prefix is already carried by the icon and group header.
        assert_eq!(entry.name, "Claude Sonnet 4");
        assert!((entry.cost_in - 3.0).abs() < 1e-9);
        assert!((entry.cost_out - 15.0).abs() < 1e-9);
        assert!((entry.cost_cache_read.unwrap() - 0.3).abs() < 1e-9);
        // Quoted as absent, not as zero — the model has no cache-write price.
        assert_eq!(entry.cost_cache_write, None);
        assert_eq!(entry.max_output, Some(8192));
        assert!(entry.supports_vision);
        assert!(entry.supports_files);
        // Listed modalities only — a model that reads images is not thereby a
        // model that accepts audio.
        assert!(!entry.supports_audio);
        assert!(entry.supports_tools);
        assert!(entry.supports_reasoning);
    }

    #[test]
    fn catalog_entry_survives_a_model_with_almost_nothing_on_it() {
        let entry = parse_entry(&json!({ "id": "someone/mystery-model" }))
            .expect("an id is the only thing genuinely required");

        assert_eq!(entry.context_length, 0);
        assert_eq!(entry.cost_in, 0.0);
        assert_eq!(entry.cost_cache_read, None);
        assert!(!entry.supports_tools);
        assert!(!entry.supports_files);
        assert!(!entry.supports_audio);

        // No id, no entry — that one really is unusable.
        assert!(parse_entry(&json!({ "name": "nameless" })).is_none());
    }

    #[test]
    fn sse_lines_that_are_not_payloads_are_skipped() {
        assert_eq!(payload_of("data: {\"a\":1}"), Some("{\"a\":1}"));
        // OpenRouter sends comment frames as keepalive during long waits.
        assert_eq!(payload_of(": OPENROUTER PROCESSING"), None);
        assert_eq!(payload_of("data: [DONE]"), None);
        assert_eq!(payload_of("event: message"), None);
        assert_eq!(payload_of(""), None);
    }

    #[test]
    fn interrupted_names_the_root_cause() {
        #[derive(Debug)]
        struct Outer(std::io::Error);
        impl std::fmt::Display for Outer {
            fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
                f.write_str("error decoding response body")
            }
        }
        impl std::error::Error for Outer {
            fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
                Some(&self.0)
            }
        }
        let error = Outer(std::io::Error::new(std::io::ErrorKind::ConnectionReset, "connection reset by peer"));
        assert_eq!(
            interrupted(&error),
            "stream interrupted: error decoding response body: connection reset by peer"
        );
    }
}
