//! DeepSeek official API adapter.
//!
//! OpenAI-compatible (`https://api.deepseek.com/chat/completions` + SSE), so the
//! request/stream plumbing is the one `zai.rs` already has. Catalog is static,
//! from https://api-docs.deepseek.com/quick_start/pricing (2026-11-10).

use std::sync::Arc;

use serde_json::{json, Value};
use tauri::ipc::Channel;

use crate::cancel::Cancel;
use crate::effort::Effort;
use crate::openrouter::{Account, CatalogEntry, ChatRequest, StreamEvent};
use crate::zai::{client, describe_failure, guarded, stream_compatible};

pub const PROVIDER: &str = "deepseek";
const BASE: &str = "https://api.deepseek.com";
const LABEL: &str = "DeepSeek";

fn key() -> Result<String, String> {
    crate::credentials::read(PROVIDER)
        .ok_or_else(|| "No DeepSeek key stored. Connect a key first.".to_string())
}

/* ---- catalog ----------------------------------------------------------- */

// ponytail: peak-hour prices (off-peak is half) so cost ceilings never under-estimate.
fn entry(
    id: &str,
    name: &str,
    cost_in: f64,
    cost_out: f64,
    cache: f64,
    vision: bool,
    created: i64,
) -> CatalogEntry {
    CatalogEntry {
        id: id.to_string(),
        name: name.to_string(),
        vendor: PROVIDER.to_string(),
        context_length: 1_000_000,
        cost_in,
        cost_out,
        cost_cache_read: Some(cache),
        cost_cache_write: None,
        max_output: Some(384_000),
        supports_vision: vision,
        supports_files: false,
        supports_audio: false,
        supports_tools: true,
        supports_reasoning: true,
        created,
        description: String::new(),
    }
}

fn static_catalog() -> Vec<CatalogEntry> {
    vec![
        entry(
            "deepseek-v4-pro",
            "DeepSeek V4 Pro",
            1.32,
            3.96,
            0.044,
            false,
            2,
        ),
        entry(
            "deepseek-flash",
            "DeepSeek V4.1 Flash",
            0.30,
            1.20,
            0.006,
            true,
            1,
        ),
    ]
}

pub async fn catalog() -> Result<Vec<CatalogEntry>, String> {
    Ok(static_catalog())
}

/* ---- account ----------------------------------------------------------- */

/// `GET /user/balance`, as DeepSeek sends it.
pub async fn usage() -> Result<Value, String> {
    let response = client()
        .get(format!("{BASE}/user/balance"))
        .bearer_auth(key()?)
        .send()
        .await
        .map_err(|e| format!("could not reach DeepSeek: {e}"))?;
    if !response.status().is_success() {
        return Err(describe_failure(LABEL, response).await);
    }
    response.json().await.map_err(|e| e.to_string())
}

pub async fn account() -> Result<Account, String> {
    let body = usage().await?;
    let balance = body["balance_infos"]
        .as_array()
        .and_then(|list| list.first())
        .map(|b| {
            format!(
                " · {} {}",
                b["total_balance"].as_str().unwrap_or("?"),
                b["currency"].as_str().unwrap_or("")
            )
        })
        .unwrap_or_default();
    Ok(Account {
        label: format!("DeepSeek key{balance}"),
        usage: 0.0,
        limit: None,
        is_free_tier: false,
    })
}

/* ---- chat -------------------------------------------------------------- */

/// DeepSeek thinks by default (effort `high`). Its dial is low/high/max, so
/// medium folds into high; Off is the `thinking` switch.
fn reasoning(effort: Effort) -> Option<Value> {
    match effort {
        Effort::Auto => None,
        Effort::Off => Some(json!({ "thinking": { "type": "disabled" } })),
        Effort::Low => Some(json!({ "reasoning_effort": "low" })),
        Effort::Medium | Effort::High => Some(json!({ "reasoning_effort": "high" })),
        Effort::Max => Some(json!({ "reasoning_effort": "max" })),
    }
}

fn body_of(request: &ChatRequest) -> Value {
    let mut body = json!({
        "model": request.model,
        "messages": request.messages
            .iter()
            .map(|m| json!({ "role": m.role, "content": m.content }))
            .collect::<Vec<_>>(),
        "stream": true,
        "stream_options": { "include_usage": true },
    });
    if let Some(t) = request.temperature {
        body["temperature"] = json!(t);
    }
    if let Some(m) = request.max_tokens {
        body["max_tokens"] = json!(m);
    }
    if let Some(Value::Object(extra)) = reasoning(request.effort) {
        body.as_object_mut().unwrap().extend(extra);
    }
    body
}

pub async fn stream_chat(request: ChatRequest, channel: Channel<StreamEvent>, cancel: Arc<Cancel>) {
    let run = async {
        let body = body_of(&request);
        stream_compatible(
            LABEL,
            &format!("{BASE}/chat/completions"),
            &key()?,
            &body,
            &channel,
            cancel.clone(),
        )
        .await
    };
    guarded(&channel, cancel.clone(), run).await;
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn effort_maps_to_deepseek_vocabulary() {
        assert_eq!(reasoning(Effort::Auto), None);
        assert_eq!(
            reasoning(Effort::Off),
            Some(json!({ "thinking": { "type": "disabled" } }))
        );
        assert_eq!(
            reasoning(Effort::Medium),
            Some(json!({ "reasoning_effort": "high" }))
        );
        assert_eq!(
            reasoning(Effort::Max),
            Some(json!({ "reasoning_effort": "max" }))
        );
    }

    #[test]
    fn catalog_has_both_models() {
        let ids: Vec<_> = static_catalog().into_iter().map(|m| m.id).collect();
        assert_eq!(ids, ["deepseek-v4-pro", "deepseek-flash"]);
    }
}
