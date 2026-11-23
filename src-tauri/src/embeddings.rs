//! Meaning, as a vector. The half of "semantic search" that was still a stub.
//!
//! The PRD's claim is "not keyword matching, meaning matching", and until this
//! module existed the app answered that claim with term overlap and a table of
//! seven synonyms — so a conversation about `session cookies` was invisible to a
//! search for `login flow`, and the Context Composer chose what to inject by the
//! same measure.
//!
//! **Local, not a gateway call.** Three reasons, in the order they matter:
//!
//! 1. The composer runs on a debounce while the user types, and the send path
//!    embeds the prompt before every turn. A hosted embedding endpoint would put
//!    a network round-trip on that path and a line item on every keystroke.
//! 2. Nothing here needs an account. `cli_agent.rs` already draws that line for
//!    the model itself; drawing it differently for retrieval would mean a user
//!    with a Claude subscription and no API key has a search box that does not
//!    work.
//! 3. The rest of the app works offline — SQLite, the keychain, the local CLIs.
//!    Retrieval is the last thing that should need a connection.
//!
//! The cost is honest and worth stating: the model is downloaded on first use
//! (~1.1GB) and inference is CPU-bound. Both are paid once per machine and once
//! per corpus change respectively, rather than per query.

use std::path::PathBuf;
use std::sync::Mutex;

use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine as _;
use fastembed::{EmbeddingModel, TextEmbedding, TextInitOptions};
use serde::{Deserialize, Serialize};

/// The model, named once.
///
/// Multilingual rather than the stronger English-only `bge` line, because
/// Atimo indexes whatever its owner writes, and a retrieval layer that goes
/// quiet the moment someone works in their own language is not a smaller
/// feature — it is a broken one, and it breaks silently, which is worse.
///
/// Base rather than small, and that was measured, not assumed. On
/// `multilingual-e5-small` the Portuguese probe put a genuine answer 0.015
/// above unrelated noise — inside the calibration margin the frontend scales
/// by, so the semantic half of every Portuguese query rounded to nothing and
/// the lexical half quietly carried the product's whole claim. On base the
/// same probe measures the answer +0.039 over its corpus median against
/// +0.016 for the best noise: a real match reads at about half the margin and
/// noise at a fifth of it. Honestly stated: Portuguese still separates less
/// than English (+0.077) — that is the model family, not the calibration —
/// and `portuguese_answer_clears_its_corpus_baseline` pins what base actually
/// delivers so a future swap cannot quietly hand it back.
///
/// The cost is honest: ~1.1GB downloaded once (the small model was 470MB —
/// this is 2.4x, not 10x), and 768 dimensions, which doubles the in-memory
/// index to ~3MB per thousand passages. Both are still paid once, not per
/// query.
const MODEL: EmbeddingModel = EmbeddingModel::MultilingualE5Base;

/// Written into every stored vector so a model change is detectable rather than
/// silently mixed. Vectors from two models share a space only by coincidence —
/// bumping this is what makes an index built by the old model read as "not
/// indexed yet" and rebuild itself, instead of ranking by noise.
pub const MODEL_ID: &str = "multilingual-e5-base";

pub const DIMS: usize = 768;

/// Tokens the model reads before it stops reading.
///
/// The tail of anything longer is invisible to retrieval, which is why the
/// frontend splits chats and documents into passages before they get here
/// rather than handing over whole messages and hoping.
const MAX_LENGTH: usize = 512;

/// Texts per forward pass. The default is 256, which for 512-token inputs is a
/// working set big enough to matter on a laptop; the corpus is embedded in the
/// background either way, so a smaller batch costs latency nobody is waiting on.
const BATCH: usize = 64;

/// E5 was trained with these two words in front of every input, and it is not
/// decoration: the asymmetry is what lets a short question and a long answer
/// land near each other. Embedding a query as a passage measurably degrades
/// retrieval, and does so without failing.
#[derive(Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum Role {
    Query,
    Passage,
}

impl Role {
    fn prefix(self) -> &'static str {
        match self {
            Role::Query => "query: ",
            Role::Passage => "passage: ",
        }
    }
}

#[derive(Serialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum State {
    /// Never asked for. The model has not been downloaded or read from disk.
    Unloaded,
    Loading,
    Ready,
    /// Tried and could not. The frontend falls back to lexical retrieval and
    /// says so rather than returning nothing.
    Failed,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    pub state: State,
    /// Matches what is stamped on stored vectors, so the frontend can discard
    /// an index built by a different model instead of querying across two
    /// unrelated spaces.
    pub model: &'static str,
    pub dims: usize,
    /// Set when `state` is `Failed` — the sentence the UI shows.
    pub error: Option<String>,
    /// The model's files are already on this machine, so loading is local and
    /// needs no consent. False means the next load is a ~1.1GB download.
    pub downloaded: bool,
}

/// The loaded model, plus what to tell anyone who asks about it.
///
/// Two locks rather than one, and deliberately: `model` is held for the whole of
/// an embed call, which for a corpus batch is seconds, and a status read that
/// queued behind it would mean the UI could not say "still loading" during the
/// only period anyone wants to know.
pub struct Embeddings {
    cache_dir: PathBuf,
    model: Mutex<Option<TextEmbedding>>,
    state: Mutex<Status>,
}

impl Embeddings {
    /// Register the model's home. Nothing is read or downloaded here — the
    /// first launch of a user who never opens the search box should not spend
    /// a gigabyte of their connection on this.
    pub fn new(cache_dir: PathBuf) -> Self {
        Self {
            cache_dir,
            model: Mutex::new(None),
            state: Mutex::new(Status {
                state: State::Unloaded,
                model: MODEL_ID,
                dims: DIMS,
                error: None,
                downloaded: false,
            }),
        }
    }

    /// Whether fastembed's cache already holds this model. Checked by folder
    /// rather than by loading, because loading is what triggers the download.
    fn on_disk(&self) -> bool {
        std::fs::read_dir(self.cache_dir.join("models--intfloat--multilingual-e5-base"))
            .map(|mut entries| entries.next().is_some())
            .unwrap_or(false)
    }

    pub fn status(&self) -> Status {
        let downloaded = self.on_disk();
        match self.state.lock() {
            Ok(status) => Status { downloaded, ..status.clone() },
            // A poisoned status lock means a previous load panicked. Reporting
            // that as `Failed` is both true and actionable; propagating a lock
            // error to the UI is neither.
            Err(poisoned) => {
                let mut status = poisoned.into_inner().clone();
                status.state = State::Failed;
                status.error = Some("the embedding model crashed while loading".into());
                status
            }
        }
    }

    fn set_state(&self, state: State, error: Option<String>) {
        if let Ok(mut status) = self.state.lock() {
            status.state = state;
            status.error = error;
        }
    }

    /// Load the model. Downloads it only when `allow_download` is set — the
    /// user agreed to spend ~1.1GB on it — otherwise a machine without the
    /// files stays `Unloaded` and retrieval stays lexical.
    ///
    /// Idempotent and safe to call from anywhere: the model lock is what
    /// serialises concurrent callers, so a burst at startup loads once and the
    /// rest wait rather than each pulling their own copy.
    pub fn prepare(&self, allow_download: bool) -> Status {
        let mut slot = match self.model.lock() {
            Ok(slot) => slot,
            Err(_) => {
                self.set_state(
                    State::Failed,
                    Some("the embedding model crashed while loading".into()),
                );
                return self.status();
            }
        };

        if slot.is_some() {
            self.set_state(State::Ready, None);
            return self.status();
        }

        if !allow_download && !self.on_disk() {
            self.set_state(State::Unloaded, None);
            return self.status();
        }

        self.set_state(State::Loading, None);

        let options = TextInitOptions::new(MODEL)
            .with_cache_dir(self.cache_dir.clone())
            .with_max_length(MAX_LENGTH)
            // Left at every core: this is a background job whose whole purpose
            // is to finish before the user searches again, and the alternative
            // to using the cores is the user waiting on a stale index.
            .with_show_download_progress(false);

        match TextEmbedding::try_new(options) {
            Ok(model) => {
                *slot = Some(model);
                self.set_state(State::Ready, None);
            }
            Err(error) => {
                // The two ways this realistically fails are "no network on the
                // first run" and "no room for the model", and both are things
                // the user can act on — so the reason is carried through rather
                // than flattened into "embeddings unavailable".
                self.set_state(
                    State::Failed,
                    Some(format!("could not load the embedding model: {error}")),
                );
            }
        }

        self.status()
    }

    /// Embed a batch, in the order given.
    ///
    /// Each vector comes back as base64 of its `f32` components, little-endian.
    /// Not an array of numbers: 768 floats as JSON is about 14KB of digits per
    /// row, which for a project's worth of passages is megabytes of parsing on
    /// the one call that is supposed to be cheap. Base64 is 4KB and decodes
    /// into a `Float32Array` in one step on the other side.
    ///
    /// Normalised here rather than there, so cosine similarity in the frontend
    /// is a dot product and the hot loop has no square roots in it.
    pub fn embed(&self, texts: &[String], role: Role) -> Result<Vec<String>, String> {
        if texts.is_empty() {
            return Ok(Vec::new());
        }

        // Never a download: embedding happens in the background (reindex), and
        // that must not be what spends a gigabyte without asking.
        let status = self.prepare(false);
        if status.state != State::Ready {
            return Err(status
                .error
                .unwrap_or_else(|| "the embedding model is not available".into()));
        }

        let mut slot = self
            .model
            .lock()
            .map_err(|_| "the embedding model crashed while loading".to_string())?;
        let model = slot
            .as_mut()
            .ok_or_else(|| "the embedding model is not available".to_string())?;

        let prefixed: Vec<String> = texts
            .iter()
            .map(|text| format!("{}{text}", role.prefix()))
            .collect();

        let vectors = model
            .embed(&prefixed, Some(BATCH))
            .map_err(|e| format!("could not embed this text: {e}"))?;

        Ok(vectors.iter().map(|vector| encode(vector)).collect())
    }
}

/// One vector, normalised, as base64 little-endian `f32`.
///
/// A zero vector is left alone rather than divided by its norm — it cannot
/// happen with a real model, and the reason to write the branch is that the
/// alternative is a silent `NaN` propagating into every similarity score the
/// frontend computes against it.
fn encode(vector: &[f32]) -> String {
    let norm = vector.iter().map(|v| v * v).sum::<f32>().sqrt();
    let scale = if norm > 0.0 { 1.0 / norm } else { 0.0 };

    let mut bytes = Vec::with_capacity(vector.len() * 4);
    for value in vector {
        bytes.extend_from_slice(&(value * scale).to_le_bytes());
    }
    BASE64.encode(bytes)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Decode what `encode` produced, for assertions only.
    fn decode(encoded: &str) -> Vec<f32> {
        let bytes = BASE64.decode(encoded).unwrap();
        bytes
            .chunks_exact(4)
            .map(|c| f32::from_le_bytes([c[0], c[1], c[2], c[3]]))
            .collect()
    }

    #[test]
    fn encoding_normalises_so_cosine_is_a_dot_product() {
        let decoded = decode(&encode(&[3.0, 4.0]));
        assert!((decoded[0] - 0.6).abs() < 1e-6);
        assert!((decoded[1] - 0.8).abs() < 1e-6);
    }

    #[test]
    fn encoding_a_zero_vector_does_not_produce_nan() {
        // Dividing by the norm here is the obvious code and puts NaN into every
        // similarity the frontend computes against this row, for the rest of the
        // session, with nothing to point at.
        assert!(decode(&encode(&[0.0, 0.0])).iter().all(|v| *v == 0.0));
    }

    #[test]
    fn encoding_round_trips_at_the_models_width() {
        let vector: Vec<f32> = (0..DIMS).map(|i| i as f32).collect();
        assert_eq!(decode(&encode(&vector)).len(), DIMS);
    }

    #[test]
    fn a_query_and_a_passage_are_prefixed_differently() {
        // E5's asymmetry is the reason short questions match long answers at
        // all. Embedding both sides the same way degrades retrieval without
        // failing, which is the kind of regression only a test catches.
        assert_ne!(Role::Query.prefix(), Role::Passage.prefix());
    }

    #[test]
    fn an_unprepared_model_reports_unloaded_rather_than_failed() {
        // First launch must not look like breakage: nothing has been downloaded
        // because nothing has asked for it yet.
        let embeddings = Embeddings::new(std::env::temp_dir().join("atimo-test-models"));
        assert_eq!(embeddings.status().state, State::Unloaded);
        assert_eq!(embeddings.status().model, MODEL_ID);
    }

    /// Decode and score, the way the frontend does. Assertions only.
    fn similarity(a: &str, b: &str) -> f32 {
        let (x, y) = (decode(a), decode(b));
        x.iter().zip(&y).map(|(p, q)| p * q).sum()
    }

    /*
     * The real model, against the real claim.
     *
     * `#[ignore]`d because it downloads ~1.1GB the first time it runs, and a
     * suite that needs the network is a suite people stop running. Everything
     * above this point is the plumbing and holds without it; this is the one
     * thing that cannot be checked any other way, because "does this model put
     * these two sentences near each other" is a question about the weights.
     *
     *     cargo test -- --ignored --nocapture
     */
    #[test]
    #[ignore = "downloads the model"]
    fn the_model_puts_the_same_idea_in_the_same_place() {
        let embeddings = Embeddings::new(std::env::temp_dir().join("atimo-models"));
        assert_eq!(embeddings.prepare(true).state, State::Ready);

        let passages = embeddings
            .embed(
                &[
                    "The session cookie is issued on the auth callback and read on every \
                     request after it, which is what keeps someone signed in."
                        .into(),
                    "The p95 sits at 640ms and almost all of it is the fan-out to the \
                     pricing service."
                        .into(),
                ],
                Role::Passage,
            )
            .unwrap();

        let query = embeddings
            .embed(&["how does login work".into()], Role::Query)
            .unwrap();

        let auth = similarity(&query[0], &passages[0]);
        let speed = similarity(&query[0], &passages[1]);

        println!("auth {auth:.3}  speed {speed:.3}  floor {}", 0.78);

        // The whole point: "login" appears in neither passage, and the one about
        // cookies is still the answer. Term overlap scores both at zero.
        assert!(
            auth > speed,
            "login should be nearer the auth passage: {auth} vs {speed}"
        );
        // And it has to clear the small-corpus floor `relevance()` falls back
        // to, or a young project reads its best match as no match at all.
        assert!(auth > 0.78, "auth similarity {auth} is under the floor");
    }

    #[test]
    #[ignore = "downloads the model"]
    fn the_model_reads_the_language_its_owner_writes_in() {
        // Why the model is multilingual and not the stronger English-only
        // `bge` line: a workspace written in Portuguese must be searchable in
        // Portuguese, and the English-only model fails this silently rather
        // than loudly.
        let embeddings = Embeddings::new(std::env::temp_dir().join("atimo-models"));
        assert_eq!(embeddings.prepare(true).state, State::Ready);

        let passages = embeddings
            .embed(
                &[
                    "O cookie de sessão é emitido no callback de autenticação e lido em \
                     toda requisição seguinte."
                        .into(),
                    "A latência p95 está em 640ms, quase toda no fan-out para o serviço \
                     de preços."
                        .into(),
                ],
                Role::Passage,
            )
            .unwrap();

        let query = embeddings
            .embed(&["como funciona o login".into()], Role::Query)
            .unwrap();

        let auth = similarity(&query[0], &passages[0]);
        let speed = similarity(&query[0], &passages[1]);

        println!("pt auth {auth:.3}  speed {speed:.3}");
        assert!(auth > speed, "{auth} vs {speed}");
        assert!(auth > 0.78, "auth similarity {auth} is under the floor");
    }

    /*
     * Why the frontend calibrates against a *distribution* rather than a
     * constant, in one table.
     *
     * This was a printing probe, and what it printed changed the design. The
     * first version of `relevance()` in `embeddings.ts` subtracted a fixed 0.75
     * — a number picked from the literature rather than from this model — and
     * these are the similarities that number was supposed to separate.
     */
    #[test]
    #[ignore = "downloads the model"]
    fn unrelated_text_still_scores_high() {
        let e = Embeddings::new(std::env::temp_dir().join("atimo-models"));
        assert_eq!(e.prepare(true).state, State::Ready);

        let passages = e
            .embed(
                &[
                    "The session cookie is issued on the auth callback and read on every \
                     request after it, which is what keeps someone signed in."
                        .into(),
                    "Bananas ripen faster next to apples because of the ethylene the \
                     apples give off."
                        .into(),
                    "The kitchen renovation is finished; the tiles arrived on Tuesday and \
                     the sink on Friday."
                        .into(),
                ],
                Role::Passage,
            )
            .unwrap();

        let query = e
            .embed(&["how does login work".into()], Role::Query)
            .unwrap();

        let auth = similarity(&query[0], &passages[0]);
        let fruit = similarity(&query[0], &passages[1]);
        let tiles = similarity(&query[0], &passages[2]);

        println!("auth {auth:.3}  fruit {fruit:.3}  tiles {tiles:.3}");

        // The ordering is right, which is why relative calibration works...
        assert!(auth > fruit && fruit > tiles);

        // ...and the absolute values are useless, which is why it has to be.
        // A sentence about fruit is not 79% of an answer to a question about
        // authentication — but that is what any fixed floor near 0.75 would
        // report, and the composer's thresholds would let it through.
        assert!(
            fruit > 0.7,
            "if the noise floor has moved below 0.7, the fixed-floor calibration \
             this test rules out may be worth revisiting: fruit scored {fruit}"
        );
        assert!(
            auth - fruit < 0.15,
            "the whole range is narrow; a spread this small is why the frontend \
             normalises against the corpus median: {auth} vs {fruit}"
        );
    }

    /*
     * The gate the model swap has to pass, in the language it was swapped for.
     *
     * On `multilingual-e5-small`, this kind of corpus put a genuine answer
     * 0.015 above unrelated noise — inside the 0.08 margin the frontend's
     * calibration scales by, so a Portuguese workspace got a semantic half that
     * rounded to nothing and never said so. What base measurably delivers here:
     *
     *     answer      0.847   (+0.039 over the median)
     *     best noise  0.824   (+0.016 — the Postgres decision, nearest register)
     *     median      0.807
     *
     * The thresholds below are that measurement with a little headroom, not an
     * aspiration: they exist so a future model swap that hands the Portuguese
     * regression back fails here, whatever its English benchmarks say. Under
     * the frontend margin these numbers read as answer ≈ 0.49, noise ≈ 0.20 —
     * a real match at half strength, which is the honest state of Portuguese
     * on this family, and roughly triple the separation small managed.
     */
    #[test]
    #[ignore = "downloads the model"]
    fn portuguese_answer_clears_its_corpus_baseline() {
        let e = Embeddings::new(std::env::temp_dir().join("atimo-models"));
        assert_eq!(e.prepare(true).state, State::Ready);

        // Eight passages, like a real project: one answer, seven about other
        // things, across the registers a workspace actually holds — prose,
        // notes, numbers.
        let passages = e
            .embed(
                &[
                    "O cookie de sessão é emitido no callback de autenticação e lido em \
                     toda requisição seguinte, e é isso que mantém alguém conectado."
                        .into(),
                    "Bananas amadurecem mais rápido perto de maçãs por causa do etileno \
                     que as maçãs liberam."
                        .into(),
                    "A reforma da cozinha terminou; os azulejos chegaram na terça e a \
                     pia na sexta."
                        .into(),
                    "A latência p95 está em 640ms, quase toda no fan-out para o serviço \
                     de preços."
                        .into(),
                    "Escolhemos Postgres em vez de Mongo porque o esquema é relacional \
                     e as consultas são joins."
                        .into(),
                    "A reunião de planejamento ficou para quinta-feira às 10h, na sala \
                     grande do segundo andar."
                        .into(),
                    "O frete para a região sul subiu 12% no trimestre e o prazo médio \
                     passou de quatro para seis dias."
                        .into(),
                    "A previsão para o fim de semana é de chuva forte no litoral e \
                     ventos de até 60km/h."
                        .into(),
                ],
                Role::Passage,
            )
            .unwrap();

        let query = e
            .embed(&["como funciona o login".into()], Role::Query)
            .unwrap();

        let mut scores: Vec<f32> = passages.iter().map(|p| similarity(&query[0], p)).collect();
        let answer = scores[0];
        let noise = scores[1..].iter().cloned().fold(f32::MIN, f32::max);

        for (at, score) in scores.iter().enumerate() {
            println!("pt corpus [{at}] {score:.3}");
        }

        scores.sort_by(|a, b| a.partial_cmp(b).unwrap());
        let median = (scores[3] + scores[4]) / 2.0;

        println!(
            "pt answer {answer:.3}  best noise {noise:.3}  median {median:.3}  \
             margins: answer {:+.3}  noise {:+.3}",
            answer - median,
            noise - median
        );

        // The ordering, which even the small model got right...
        assert!(answer > noise, "answer {answer} vs noise {noise}");

        // ...and the separation, which it did not. 0.08 is SEMANTIC_MARGIN in
        // `embeddings.ts`; the numbers pinned here are what base measured
        // (+0.039 / +0.016), with headroom for runtime drift rather than hope.
        assert!(
            answer - median >= 0.03,
            "the answer only clears the Portuguese corpus median by {:.3}; \
             base measured +0.039, so retrieval in Portuguese has regressed — \
             this is the small-model bug back again",
            answer - median
        );
        assert!(
            noise - median < 0.025,
            "unrelated Portuguese noise clears the median by {:.3} against a \
             measured +0.016 — the composer's thresholds will start letting \
             Portuguese noise through",
            noise - median
        );
    }

    #[test]
    fn embedding_nothing_is_not_an_error_and_does_not_load_the_model() {
        // The reindex loop calls this with whatever is stale, which is usually
        // nothing. Loading a gigabyte to answer "no work to do" would put a
        // download behind an idle tick.
        let embeddings = Embeddings::new(std::env::temp_dir().join("atimo-test-models"));
        assert_eq!(embeddings.embed(&[], Role::Passage).unwrap().len(), 0);
        assert_eq!(embeddings.status().state, State::Unloaded);
    }

    #[test]
    fn without_consent_a_missing_model_is_not_downloaded() {
        let dir = std::env::temp_dir().join("atimo-test-models-consent");
        let _ = std::fs::remove_dir_all(&dir);
        let embeddings = Embeddings::new(dir.clone());
        let status = embeddings.prepare(false);
        assert_eq!(status.state, State::Unloaded);
        assert!(!status.downloaded);
        // And embedding does not sneak the download in either.
        assert!(embeddings.embed(&["oi".into()], Role::Query).is_err());
        assert!(!dir.join("models--intfloat--multilingual-e5-base").exists());
    }
}
