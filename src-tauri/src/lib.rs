mod cancel;
mod acp_agent;
mod cli_agent;
mod credentials;
mod db;
mod deepseek;
mod effort;
mod embeddings;
mod export;
mod openrouter;
mod research;
mod zai;

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use serde_json::value::RawValue;
use tauri::ipc::Channel;
use tauri::{Manager, State};

use cancel::Cancel;
use cli_agent::{Agent, AgentProbe};
use credentials::CredentialStatus;
use db::{Db, Patch, Snapshot, StoredAttachment, StoredVector};
use embeddings::{Embeddings, Role};
use openrouter::{Account, CatalogEntry, ChatRequest, StreamEvent};

/// In-flight turns, keyed by the id the frontend generated for the stream.
#[derive(Default)]
struct Streams(Mutex<HashMap<String, Arc<Cancel>>>);

/// Register a turn and hand back its stop signal.
fn begin(streams: &State<'_, Streams>, stream_id: &str) -> Result<Arc<Cancel>, String> {
    let signal = Arc::new(Cancel::default());
    streams
        .0
        .lock()
        .map_err(|_| "stream registry poisoned")?
        .insert(stream_id.to_string(), signal.clone());
    Ok(signal)
}

fn end(streams: &State<'_, Streams>, stream_id: &str) {
    if let Ok(mut registry) = streams.0.lock() {
        registry.remove(stream_id);
    }
}

/// Stop one turn, whichever provider is answering it.
///
/// One command rather than three: the registry is keyed by stream id alone, so
/// the provider was never needed to find the right signal, and three copies of
/// the same four lines was three places for them to drift apart.
#[tauri::command]
fn stream_cancel(stream_id: String, streams: State<'_, Streams>) {
    if let Ok(registry) = streams.0.lock() {
        if let Some(signal) = registry.get(&stream_id) {
            signal.trigger();
        }
    }
}

/* ---- credentials ------------------------------------------------------ */

#[tauri::command]
fn credential_set(provider: String, key: String) -> Result<CredentialStatus, String> {
    credentials::write(&provider, &key)?;
    Ok(credentials::status(&provider))
}

#[tauri::command]
fn credential_status(provider: String) -> CredentialStatus {
    credentials::status(&provider)
}

#[tauri::command]
fn credential_clear(provider: String) -> Result<CredentialStatus, String> {
    credentials::clear(&provider)?;
    Ok(credentials::status(&provider))
}

#[tauri::command]
fn credential_migrate_zai_coding() -> Result<(), String> {
    if credentials::read("zai-coding").is_none() {
        if let Some(key) = credentials::read("zai") {
            credentials::write("zai-coding", &key)?;
            credentials::clear("zai")?;
        }
    }
    Ok(())
}

/* ---- persistence ------------------------------------------------------ */

/*
 * SQLite work is blocking, so these run on the blocking pool rather than on the
 * async runtime's worker threads. The reads are milliseconds and the writes are
 * a handful of rows, but the sync loop commits a patch every few hundred
 * milliseconds while a turn streams — that is exactly the traffic that should
 * not share a thread with the SSE reader.
 */

#[tauri::command]
async fn db_load(db: State<'_, Db>) -> Result<Option<Snapshot>, String> {
    let db = db.inner().clone();
    blocking(move || db::load(&db)).await
}

#[tauri::command]
async fn db_seed(patch: Patch, db: State<'_, Db>) -> Result<(), String> {
    let db = db.inner().clone();
    blocking(move || db::seed(&db, &patch)).await
}

#[tauri::command]
async fn db_apply(patch: Patch, db: State<'_, Db>) -> Result<(), String> {
    let db = db.inner().clone();
    blocking(move || db::apply(&db, &patch)).await
}

/// Document text for one project. Separate from `db_load` on purpose — see the
/// `document_chunks` schema note in `db.rs`.
#[tauri::command]
async fn db_chunks_load(
    project_id: String,
    db: State<'_, Db>,
) -> Result<Vec<Box<RawValue>>, String> {
    let db = db.inner().clone();
    blocking(move || db::load_chunks(&db, &project_id)).await
}

#[tauri::command]
async fn db_chunks_put(
    document_id: String,
    chunks: Vec<serde_json::Value>,
    db: State<'_, Db>,
) -> Result<(), String> {
    let db = db.inner().clone();
    blocking(move || db::put_chunks(&db, &document_id, &chunks)).await
}

/// Every vector in one project that this model wrote. See `db::load_vectors`.
#[tauri::command]
async fn db_vectors_load(
    project_id: String,
    model: String,
    db: State<'_, Db>,
) -> Result<Vec<StoredVector>, String> {
    let db = db.inner().clone();
    blocking(move || db::load_vectors(&db, &project_id, &model)).await
}

#[tauri::command]
async fn db_vectors_put(vectors: Vec<StoredVector>, db: State<'_, Db>) -> Result<(), String> {
    let db = db.inner().clone();
    blocking(move || db::put_vectors(&db, &vectors)).await
}

#[tauri::command]
async fn db_vectors_drop(ids: Vec<String>, db: State<'_, Db>) -> Result<(), String> {
    let db = db.inner().clone();
    blocking(move || db::drop_vectors(&db, &ids)).await
}

/// The bytes of everything attached in one chat. Separate from `db_load` for the
/// same reason the chunks are — see the `attachment_blobs` schema note in `db.rs`.
#[tauri::command]
async fn db_attachments_load(
    chat_id: String,
    db: State<'_, Db>,
) -> Result<Vec<StoredAttachment>, String> {
    let db = db.inner().clone();
    blocking(move || db::load_attachments(&db, &chat_id)).await
}

#[tauri::command]
async fn db_attachments_put(
    attachments: Vec<StoredAttachment>,
    db: State<'_, Db>,
) -> Result<(), String> {
    let db = db.inner().clone();
    blocking(move || db::put_attachments(&db, &attachments)).await
}

/* ---- embeddings ------------------------------------------------------- */

/*
 * Blocking, like the database commands, and for a stronger reason: inference is
 * CPU-bound for as long as the batch takes, so leaving it on an async worker
 * would stall whatever stream shares that thread. `Embeddings` is `Sync` and the
 * model is behind its own lock, so the handle is cloned in as an `Arc` and the
 * work happens off the runtime entirely.
 */

/// Load the model; downloads it only with `allow_download` (the user agreed).
///
/// Separate from `embeddings_embed` so the frontend can start the download while
/// the user is doing something else, and so the first search is not the thing
/// that waits on a gigabyte.
#[tauri::command]
async fn embeddings_prepare(
    allow_download: bool,
    embeddings: State<'_, Arc<Embeddings>>,
) -> Result<embeddings::Status, String> {
    let embeddings = embeddings.inner().clone();
    blocking(move || Ok(embeddings.prepare(allow_download))).await
}

#[tauri::command]
fn embeddings_status(embeddings: State<'_, Arc<Embeddings>>) -> embeddings::Status {
    embeddings.status()
}

#[tauri::command]
async fn embeddings_embed(
    texts: Vec<String>,
    role: Role,
    embeddings: State<'_, Arc<Embeddings>>,
) -> Result<Vec<String>, String> {
    let embeddings = embeddings.inner().clone();
    blocking(move || embeddings.embed(&texts, role)).await
}

async fn blocking<T: Send + 'static>(
    work: impl FnOnce() -> Result<T, String> + Send + 'static,
) -> Result<T, String> {
    tauri::async_runtime::spawn_blocking(work)
        .await
        .map_err(|e| format!("database task failed: {e}"))?
}

/* ---- export ----------------------------------------------------------- */

/// Write an export beside the user's other downloads.
///
/// Blocking, like the database commands and for the same reason: a workspace
/// with a few large documents in it is megabytes of string, and the async
/// runtime's workers have a stream to read.
#[tauri::command]
async fn export_write(
    app: tauri::AppHandle,
    stem: String,
    format: export::Format,
    contents: String,
) -> Result<export::Written, String> {
    blocking(move || export::write(&app, &stem, format, &contents)).await
}

/* ---- openrouter ------------------------------------------------------- */

#[tauri::command]
async fn openrouter_catalog() -> Result<Vec<CatalogEntry>, String> {
    openrouter::catalog().await
}

#[tauri::command]
async fn openrouter_account() -> Result<Account, String> {
    openrouter::account().await
}

#[tauri::command]
async fn openrouter_chat(
    stream_id: String,
    request: ChatRequest,
    on_event: Channel<StreamEvent>,
    streams: State<'_, Streams>,
) -> Result<(), String> {
    let cancel = begin(&streams, &stream_id)?;
    openrouter::stream_chat(request, on_event, cancel).await;
    end(&streams, &stream_id);
    Ok(())
}

#[tauri::command]
async fn research_fetch(
    stream_id: String,
    request: research::ResearchRequest,
    streams: State<'_, Streams>,
) -> Result<serde_json::Value, String> {
    let cancel = begin(&streams, &stream_id)?;
    let result = research::fetch(request, cancel).await;
    end(&streams, &stream_id);
    result
}

#[tauri::command]
async fn oracle_doc(app: tauri::AppHandle, page: String) -> Result<String, String> {
    research::oracle_doc(page, app.path().app_cache_dir().ok()).await
}

/* ---- zai -------------------------------------------------------------- */

#[tauri::command]
async fn zai_catalog() -> Result<Vec<CatalogEntry>, String> {
    zai::catalog().await
}

#[tauri::command]
async fn zai_account(coding_plan: bool) -> Result<Account, String> {
    zai::account(coding_plan).await
}

#[tauri::command]
async fn zai_chat(
    stream_id: String,
    request: ChatRequest,
    on_event: Channel<StreamEvent>,
    coding_plan: bool,
    streams: State<'_, Streams>,
) -> Result<(), String> {
    let cancel = begin(&streams, &stream_id)?;
    zai::stream_chat(request, on_event, cancel, coding_plan).await;
    end(&streams, &stream_id);
    Ok(())
}

/* ---- deepseek --------------------------------------------------------- */

#[tauri::command]
async fn deepseek_catalog() -> Result<Vec<CatalogEntry>, String> {
    deepseek::catalog().await
}

#[tauri::command]
async fn deepseek_account() -> Result<Account, String> {
    deepseek::account().await
}

#[tauri::command]
async fn deepseek_chat(
    stream_id: String,
    request: ChatRequest,
    on_event: Channel<StreamEvent>,
    streams: State<'_, Streams>,
) -> Result<(), String> {
    let cancel = begin(&streams, &stream_id)?;
    deepseek::stream_chat(request, on_event, cancel).await;
    end(&streams, &stream_id);
    Ok(())
}

/* ---- local agent CLIs -------------------------------------------------- */

/*
 * These four are the subscription path, and the reason it is a *CLI* path is
 * spelled out at the top of `cli_agent.rs`: running the vendor's own signed-in
 * tool is supported by both vendors, and reusing its token is not. Nothing in
 * this section reads a credential, so there is no `credential_*` twin for it.
 */

/// Is the CLI installed, and does it say it is signed in? Costs nothing — no
/// model is called.
#[tauri::command]
async fn agent_probe(agent: Agent) -> AgentProbe {
    cli_agent::probe(agent).await
}

#[tauri::command]
async fn agent_account(agent: Agent) -> Result<Account, String> {
    cli_agent::account(agent).await
}

/// Plan limits and balances, raw — `src/lib/usage-limits.ts` parses every shape.
/// Claude Code is absent on purpose: its windows arrive inside each turn.
#[tauri::command]
async fn provider_usage(provider: String, coding_plan: bool) -> Result<serde_json::Value, String> {
    match provider.as_str() {
        "openrouter" => openrouter::usage().await,
        "zai" => zai::usage(coding_plan).await,
        "deepseek" => deepseek::usage().await,
        "codex-cli" => cli_agent::codex_usage().await,
        other => Err(format!("{other} does not report usage")),
    }
}

#[tauri::command]
async fn agent_catalog(agent: Agent) -> Result<Vec<CatalogEntry>, String> {
    cli_agent::catalog(agent).await
}

#[tauri::command]
async fn agent_chat(
    stream_id: String,
    agent: Agent,
    request: ChatRequest,
    on_event: Channel<StreamEvent>,
    streams: State<'_, Streams>,
) -> Result<(), String> {
    let cancel = begin(&streams, &stream_id)?;
    cli_agent::stream_chat(agent, request, on_event, cancel).await;
    end(&streams, &stream_id);
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_opener::init())
        .manage(Streams::default())
        .setup(|app| {
            // The database lives beside the app's other data, and cannot be
            // opened before the app handle exists to resolve that path — so it
            // is set up here rather than as a `Default` on state.
            let data_dir = app
                .path()
                .app_data_dir()
                .map_err(|e| format!("no app data directory: {e}"))?;
            app.manage(Db::open(data_dir.join("atimo.sqlite3"))?);
            // Beside the database rather than in the crate's cache default: the
            // model is user data in every sense that matters here — it is what
            // their workspace was indexed with, and uninstalling the app should
            // take it, not leave a gigabyte in a directory nobody will find.
            let embeddings = Arc::new(Embeddings::new(data_dir.join("models")));
            // Gives the ~1.1GB model back to the OS when nobody is searching.
            let idle = embeddings.clone();
            std::thread::spawn(move || loop {
                std::thread::sleep(std::time::Duration::from_secs(60));
                idle.unload_if_idle(embeddings::IDLE_UNLOAD);
            });
            app.manage(embeddings);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            credential_set,
            credential_status,
            credential_clear,
            credential_migrate_zai_coding,
            db_load,
            db_seed,
            db_apply,
            db_chunks_load,
            db_chunks_put,
            db_vectors_load,
            db_vectors_put,
            db_vectors_drop,
            db_attachments_load,
            db_attachments_put,
            embeddings_prepare,
            embeddings_status,
            embeddings_embed,
            export_write,
            openrouter_catalog,
            openrouter_account,
            openrouter_chat,
            research_fetch,
            oracle_doc,
            zai_catalog,
            zai_account,
            zai_chat,
            deepseek_catalog,
            deepseek_account,
            deepseek_chat,
            agent_probe,
            agent_account,
            agent_catalog,
            agent_chat,
            provider_usage,
            stream_cancel,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
