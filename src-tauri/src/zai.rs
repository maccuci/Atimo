//! Z.AI (GLM) adapter.
//!
//! Same OpenAI-shaped contract as OpenRouter (`/chat/completions` + SSE),
//! different host. Catalog is static — Z.AI has no public models/pricing
//! endpoint comparable to OpenRouter's — so prices and windows come from
//! https://docs.z.ai/guides/overview/pricing.
//!
//! Two OpenAI-compatible bases:
//! - General API: `https://api.z.ai/api/paas/v4`
//! - Coding Plan: `https://api.z.ai/api/coding/paas/v4`
//!
//! The Anthropic-compatible Coding Plan path (`/api/anthropic`) is for Claude
//! Code only — Atimo speaks chat completions.

use std::sync::{Arc, OnceLock};

use futures_util::StreamExt;
use serde_json::{json, Value};
use tauri::ipc::Channel;

use crate::cancel::Cancel;
use crate::openrouter::{
    cached_prompt_tokens, Account, CatalogEntry, ChatRequest, Heartbeat, StreamEvent,
};

pub const PROVIDER: &str = "zai";

const BASE_GENERAL: &str = "https://api.z.ai/api/paas/v4";
const BASE_CODING: &str = "https://api.z.ai/api/coding/paas/v4";

fn base(coding_plan: bool) -> &'static str {
    if coding_plan {
        BASE_CODING
    } else {
        BASE_GENERAL
    }
}

pub(crate) fn client() -> &'static reqwest::Client {
    static CLIENT: OnceLock<reqwest::Client> = OnceLock::new();
    CLIENT.get_or_init(|| {
        reqwest::Client::builder()
            .user_agent(concat!("Atimo/", env!("CARGO_PKG_VERSION")))
            .build()
            .expect("failed to build HTTP client")
    })
}

fn key(coding_plan: bool) -> Result<String, String> {
    crate::credentials::read(if coding_plan { "zai-coding" } else { PROVIDER })
        .ok_or_else(|| "No Z.AI key stored. Connect a key first.".to_string())
}

/* ---------------------------------------------------------------------- */
/* Catalog                                                                 */
/* ---------------------------------------------------------------------- */

/// Built-in lineup. Ids are bare (`glm-5.2`) — that is what Z.AI expects in
/// the `model` field, unlike OpenRouter's `vendor/slug` form.
fn static_catalog() -> Vec<CatalogEntry> {
    // `created` is ordinal newest-first within the vendor group, not a real
    // unix timestamp — the picker only uses it for sort order.
    const VENDOR: &str = "zai";

    vec![
        // ponytail: GLM-5.4 has no docs.z.ai page yet (404 on 2026-11-23); id confirmed by
        // Z.AI for the Coding Plan, specs copied from GLM-5.3 until the page is published.
        entry(
            "glm-5.4",
            "GLM-5.4",
            VENDOR,
            1_000_000,
            1.4,
            4.4,
            Some(0.26),
            Some(128_000),
            false,
            true,
            true,
            54,
        ),
        entry(
            "glm-5.3",
            "GLM-5.3",
            VENDOR,
            1_000_000,
            1.4,
            4.4,
            Some(0.26),
            Some(128_000),
            false,
            true,
            true,
            53,
        ),
        // docs.z.ai/guides/llm/glm-5.3-flash (checked 2026-11-12): 1M context,
        // 128K output, image input, thinking always on. FlashX is the faster
        // paid tier of the same model; the -Legal variant is left out.
        entry(
            "glm-5.3-flashx",
            "GLM-5.3-FlashX",
            VENDOR,
            1_000_000,
            0.37,
            1.25,
            Some(0.075),
            Some(128_000),
            true,
            true,
            true,
            52,
        ),
        entry(
            "glm-5.3-flash",
            "GLM-5.3-Flash",
            VENDOR,
            1_000_000,
            0.15,
            0.5,
            Some(0.03),
            Some(128_000),
            true,
            true,
            true,
            51,
        ),
        entry(
            "glm-5.2",
            "GLM-5.2",
            VENDOR,
            1_000_000,
            1.4,
            4.4,
            Some(0.26),
            Some(128_000),
            false,
            true,
            true,
            50,
        ),
        entry(
            "glm-5.1",
            "GLM-5.1",
            VENDOR,
            200_000,
            1.4,
            4.4,
            Some(0.26),
            Some(128_000),
            false,
            true,
            true,
            49,
        ),
        entry(
            "glm-5",
            "GLM-5",
            VENDOR,
            200_000,
            1.0,
            3.2,
            Some(0.2),
            Some(128_000),
            false,
            true,
            true,
            48,
        ),
        entry(
            "glm-5-turbo",
            "GLM-5-Turbo",
            VENDOR,
            200_000,
            1.2,
            4.0,
            Some(0.24),
            Some(128_000),
            false,
            true,
            true,
            47,
        ),
        entry(
            "glm-4.7",
            "GLM-4.7",
            VENDOR,
            200_000,
            0.6,
            2.2,
            Some(0.11),
            Some(128_000),
            false,
            true,
            true,
            46,
        ),
        entry(
            "glm-4.7-flashx",
            "GLM-4.7-FlashX",
            VENDOR,
            200_000,
            0.07,
            0.4,
            Some(0.01),
            Some(128_000),
            false,
            true,
            true,
            45,
        ),
        entry(
            "glm-4.7-flash",
            "GLM-4.7-Flash",
            VENDOR,
            200_000,
            0.0,
            0.0,
            None,
            Some(128_000),
            false,
            true,
            true,
            44,
        ),
        entry(
            "glm-4.6",
            "GLM-4.6",
            VENDOR,
            200_000,
            0.6,
            2.2,
            Some(0.11),
            Some(128_000),
            false,
            true,
            true,
            43,
        ),
        entry(
            "glm-4.5",
            "GLM-4.5",
            VENDOR,
            128_000,
            0.6,
            2.2,
            Some(0.11),
            Some(96_000),
            false,
            true,
            true,
            42,
        ),
        entry(
            "glm-4.5-air",
            "GLM-4.5-Air",
            VENDOR,
            128_000,
            0.2,
            1.1,
            Some(0.03),
            Some(96_000),
            false,
            true,
            true,
            41,
        ),
        entry(
            "glm-4.5-flash",
            "GLM-4.5-Flash",
            VENDOR,
            200_000,
            0.0,
            0.0,
            None,
            Some(96_000),
            false,
            true,
            true,
            40,
        ),
        entry(
            "glm-5v-turbo",
            "GLM-5V-Turbo",
            VENDOR,
            200_000,
            1.2,
            4.0,
            Some(0.24),
            Some(16_000),
            true,
            true,
            true,
            39,
        ),
        entry(
            "glm-4.6v",
            "GLM-4.6V",
            VENDOR,
            128_000,
            0.3,
            0.9,
            Some(0.05),
            Some(16_000),
            true,
            true,
            true,
            38,
        ),
        entry(
            "glm-4.5v",
            "GLM-4.5V",
            VENDOR,
            64_000,
            0.6,
            1.8,
            Some(0.11),
            Some(16_000),
            true,
            true,
            true,
            37,
        ),
        entry(
            "glm-4.6v-flash",
            "GLM-4.6V-Flash",
            VENDOR,
            128_000,
            0.0,
            0.0,
            None,
            Some(16_000),
            true,
            true,
            false,
            36,
        ),
    ]
}

#[allow(clippy::too_many_arguments)]
fn entry(
    id: &str,
    name: &str,
    vendor: &str,
    context_length: u32,
    cost_in: f64,
    cost_out: f64,
    cost_cache_read: Option<f64>,
    max_output: Option<u32>,
    supports_vision: bool,
    supports_tools: bool,
    supports_reasoning: bool,
    created: i64,
) -> CatalogEntry {
    CatalogEntry {
        id: id.to_string(),
        name: name.to_string(),
        vendor: vendor.to_string(),
        context_length,
        cost_in,
        cost_out,
        cost_cache_read,
        cost_cache_write: None,
        max_output,
        supports_vision,
        // Z.AI's OpenAI-compatible endpoint takes images inline but has no
        // `file` part — documents go through a separate Files API this adapter
        // does not speak, so an attached PDF is refused rather than silently
        // sent as something the gateway will reject.
        supports_files: false,
        supports_audio: false,
        supports_tools,
        supports_reasoning,
        created,
        description: String::new(),
    }
}

pub async fn catalog() -> Result<Vec<CatalogEntry>, String> {
    Ok(static_catalog())
}

/* ---------------------------------------------------------------------- */
/* Account                                                                 */
/* ---------------------------------------------------------------------- */

pub async fn account(coding_plan: bool) -> Result<Account, String> {
    let key = key(coding_plan)?;
    let base = base(coding_plan);

    // Z.AI has no OpenRouter-style `/key` balance endpoint. A models list call
    // is enough to prove the key is accepted without spending tokens.
    let response = client()
        .get(format!("{base}/models"))
        .bearer_auth(&key)
        .header("Accept-Language", "en-US,en")
        .send()
        .await
        .map_err(|e| format!("could not reach Z.AI: {e}"))?;

    let status = response.status();
    if status.as_u16() == 401 || status.as_u16() == 403 {
        return Err(describe_failure("Z.AI", response).await);
    }
    // 404 / empty body still means the gateway saw a valid key — the public
    // models list is incomplete and sometimes absent for general accounts.
    if status.is_server_error() {
        return Err(describe_failure("Z.AI", response).await);
    }

    Ok(Account {
        label: if coding_plan {
            "Z.AI Coding Plan".to_string()
        } else {
            "Z.AI key".to_string()
        },
        usage: 0.0,
        limit: None,
        is_free_tier: false,
    })
}

/// The Coding Plan's quota windows, `data` as Z.AI sends it.
///
/// Not in the public API reference: this is the endpoint, and the raw-key
/// `Authorization` header, of Z.AI's own usage plugin (zai-org/zai-coding-plugins,
/// `glm-plan-usage`). Reading it spends no quota. The pay-as-you-go API has no
/// balance endpoint at all, so the general plan reports nothing.
pub async fn usage(coding_plan: bool) -> Result<Value, String> {
    if !coding_plan {
        return Err("Z.AI does not report usage for pay-as-you-go keys.".into());
    }
    let response = client()
        .get("https://api.z.ai/api/monitor/usage/quota/limit")
        .header("Authorization", key(true)?)
        .header("Accept-Language", "en-US,en")
        .send()
        .await
        .map_err(|e| format!("could not reach Z.AI: {e}"))?;
    if !response.status().is_success() {
        return Err(describe_failure("Z.AI", response).await);
    }
    let mut body: Value = response.json().await.map_err(|e| format!("malformed quota response: {e}"))?;
    match body.get_mut("data") {
        Some(data) if data.is_object() => Ok(data.take()),
        _ => Err(body["msg"].as_str().unwrap_or("Z.AI returned no quota").to_string()),
    }
}

/* ---------------------------------------------------------------------- */
/* Chat                                                                    */
/* ---------------------------------------------------------------------- */

/// Shared by every OpenAI-compatible gateway (`deepseek.rs` too); `label` names it in errors.
pub(crate) async fn describe_failure(label: &str, response: reqwest::Response) -> String {
    let status = response.status();
    let body = response.text().await.unwrap_or_default();

    let detail = serde_json::from_str::<Value>(&body)
        .ok()
        .and_then(|v| {
            v.get("error")
                .and_then(|e| e.get("message"))
                .and_then(|m| m.as_str())
                .map(str::to_string)
                .or_else(|| v.get("msg").and_then(|m| m.as_str()).map(str::to_string))
        })
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| body.chars().take(200).collect());

    match status.as_u16() {
        401 | 403 => format!("{label} rejected the key. Check that it is still valid."),
        402 => format!("Out of {label} credits. {detail}"),
        429 => format!("Rate limited by {label}. Wait a moment and retry."),
        _ if detail.is_empty() => format!("{label} returned {status}"),
        _ => format!("{label} returned {status}: {detail}"),
    }
}

fn payload_of(line: &str) -> Option<&str> {
    let rest = line.strip_prefix("data:")?.trim();
    (!rest.is_empty() && rest != "[DONE]").then_some(rest)
}

pub async fn stream_chat(
    request: ChatRequest,
    channel: Channel<StreamEvent>,
    cancel: Arc<Cancel>,
    coding_plan: bool,
) {
    guarded(
        &channel,
        cancel.clone(),
        run_stream(request, &channel, cancel.clone(), coding_plan),
    )
    .await;
}

/// Cancel + 15 min ceiling around one stream (silence is policed by the frontend), errors forwarded to the channel.
pub(crate) async fn guarded(
    channel: &Channel<StreamEvent>,
    cancel: Arc<Cancel>,
    run: impl std::future::Future<Output = Result<(), String>>,
) {
    let result = tokio::select! {
        _ = cancel.cancelled() => {
            let _ = channel.send(StreamEvent::Done { finish_reason: None, cancelled: true });
            return;
        },
        result = tokio::time::timeout(std::time::Duration::from_secs(15 * 60), run) => {
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
    coding_plan: bool,
) -> Result<(), String> {
    let key = key(coding_plan)?;
    let base = base(coding_plan);

    let mut body = json!({
        "model": request.model,
        "messages": request.messages
            .iter()
            .map(|m| json!({ "role": m.role, "content": m.content }))
            .collect::<Vec<_>>(),
        "stream": true,
    });
    if let Some(t) = request.temperature {
        body["temperature"] = json!(t);
    }
    if let Some(m) = request.max_tokens {
        body["max_tokens"] = json!(m);
    }
    // GLM-4.5 and up only — which is the whole static catalog above, so there
    // is no model here the field would be rejected for.
    if always_thinks(&request.model) {
        body["thinking"] = json!({"type": "enabled"});
        // Auto is medium: in evals/oracle (2026-11-10, cases 4-6 ×3) it matched max on the rubric
        // at about a third of the latency (~20 s vs ~60 s); high took as long as max.
        body["reasoning_effort"] = json!(match request.effort {
            crate::effort::Effort::Max => "max",
            crate::effort::Effort::High => "high",
            crate::effort::Effort::Auto | crate::effort::Effort::Medium => "medium",
            _ => "low",
        });
    } else if let Some(thinking) = request.effort.zai() {
        body["thinking"] = thinking;
    }

    stream_compatible(
        "Z.AI",
        &format!("{base}/chat/completions"),
        &key,
        &body,
        channel,
        cancel,
    )
    .await
}

/// The GLM-5.3+ families (5.3, -Flash, -FlashX, 5.4) accept only `thinking: enabled`
/// and takes the depth from `reasoning_effort` instead.
fn always_thinks(model: &str) -> bool {
    ["glm-5.3", "glm-5.4"]
        .iter()
        .any(|f| model == *f || model.starts_with(&format!("{f}-")))
}

/// POST an OpenAI-shaped `/chat/completions` body and pump its SSE into `channel`.
pub(crate) async fn stream_compatible(
    label: &str,
    url: &str,
    key: &str,
    body: &Value,
    channel: &Channel<StreamEvent>,
    cancel: Arc<Cancel>,
) -> Result<(), String> {
    let response = client()
        .post(url)
        .bearer_auth(key)
        .header("Accept-Language", "en-US,en")
        .json(body)
        .send()
        .await
        .map_err(|e| format!("could not reach {label}: {e}"))?;

    if !response.status().is_success() {
        return Err(describe_failure(label, response).await);
    }

    let _ = channel.send(StreamEvent::Open);

    let mut stream = response.bytes_stream();
    let mut buffer = String::new();
    let mut finish_reason: Option<String> = None;
    let mut heartbeat = Heartbeat::new();

    while let Some(chunk) = stream.next().await {
        heartbeat.beat(channel);
        if cancel.is_cancelled() {
            let _ = channel.send(StreamEvent::Done {
                finish_reason: finish_reason.take(),
                cancelled: true,
            });
            return Ok(());
        }

        let bytes = chunk.map_err(|e| crate::openrouter::interrupted(&e))?;
        buffer.push_str(&String::from_utf8_lossy(&bytes));

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

                if let Some(message) = event
                    .get("error")
                    .and_then(|e| e.get("message"))
                    .and_then(|m| m.as_str())
                {
                    return Err(message.to_string());
                }

                if let Some(choice) = event.get("choices").and_then(|c| c.get(0)) {
                    if let Some(delta) = choice.get("delta") {
                        // GLM reasoning may land under `reasoning_content`
                        // (Z.AI) or `reasoning` (OpenRouter-shaped proxies).
                        for key in ["reasoning_content", "reasoning"] {
                            if let Some(text) = delta.get(key).and_then(|v| v.as_str()) {
                                if !text.is_empty() {
                                    let _ = channel.send(StreamEvent::Reasoning {
                                        text: text.to_string(),
                                    });
                                }
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
                        // Neither Z.AI nor DeepSeek report USD on the usage object.
                        cost: None,
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn static_catalog_has_flagship_and_zai_vendor() {
        let catalog = static_catalog();
        let flagship = catalog
            .iter()
            .find(|m| m.id == "glm-5.3")
            .expect("glm-5.3 should ship in the static catalog");
        assert_eq!(flagship.vendor, "zai");
        assert_eq!(flagship.context_length, 1_000_000);
        assert!((flagship.cost_in - 1.4).abs() < 1e-9);
        assert!(flagship.supports_tools);
        assert!(flagship.supports_reasoning);
    }

    #[test]
    fn glm_5_3_flash_models_ship_and_always_think() {
        let catalog = static_catalog();
        for id in ["glm-5.3-flash", "glm-5.3-flashx"] {
            let model = catalog.iter().find(|m| m.id == id).expect("flash model present");
            assert_eq!(model.context_length, 1_000_000);
            assert!(model.supports_vision);
            assert!(always_thinks(id));
        }
        assert!(always_thinks("glm-5.3"));
        assert!(always_thinks("glm-5.4"));
        assert!(!always_thinks("glm-5.2"));
    }

    #[test]
    fn vision_models_are_flagged() {
        let catalog = static_catalog();
        let vision = catalog
            .iter()
            .find(|m| m.id == "glm-5v-turbo")
            .expect("vision model present");
        assert!(vision.supports_vision);
    }
}
