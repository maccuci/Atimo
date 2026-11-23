/*
 * The seam between retrieval and the model that gives it meaning.
 *
 * Everything above this file asks two questions — "what does this text mean as
 * a vector" and "is that even available right now" — and neither answer depends
 * on where the model runs. Today it runs in-process, in Rust (`embeddings.rs`),
 * which is why the browser build answers `unavailable` and the app degrades to
 * lexical retrieval instead of to nothing.
 *
 * The awkward part of embeddings in this app is not the model, it is the
 * *timing*. `compose()` is synchronous and runs on a debounce while the user
 * types; embedding a query is an IPC call and a forward pass. Making the
 * composer async to accommodate that would put a round-trip on every keystroke,
 * which is the trade `documents.ts` already refused once for the same reason.
 *
 * So the query vector is cached and read synchronously, and warmed by whoever
 * knows a query is coming:
 *
 *   - the composer preview calls `primeQuery()` on the debounce it already has,
 *     and re-renders when `subscribe()` fires;
 *   - the send path `await`s `embedQuery()` before composing, because that one
 *     is the real prompt and it is worth one round-trip to get it right.
 *
 * A cache miss is not a failure — it is one render of lexical-only retrieval,
 * which is exactly what the app did before this module existed.
 */

const DESKTOP = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

async function core() {
  return import("@tauri-apps/api/core");
}

/**
 * Where the model runs, as one replaceable thing.
 *
 * `null` means there is nowhere for it to run — the browser build — and that is
 * a state the whole module is written around rather than an error it reports
 * once. Naming it also gives tests somewhere to stand: retrieval's ranking, its
 * fusion and its fallbacks are all worth testing, and none of them should need
 * a gigabyte of ONNX to do it.
 */
type Backend = (texts: string[], role: EmbedRole) => Promise<string[]>;

const tauriBackend: Backend = async (texts, role) => {
  const { invoke } = await core();
  return invoke<string[]>("embeddings_embed", { texts, role });
};

let backend: Backend | null = DESKTOP ? tauriBackend : null;

/**
 * Stand a deterministic embedder in for the model. Tests only.
 *
 * Passing `null` puts the real one back — or nothing, in a build that has no
 * real one. `resetEmbeddings()` does not touch this, so a suite installs it once
 * and clears its cache between cases.
 */
export function setEmbedderForTests(replacement: Backend | null): void {
  backend = replacement ?? (DESKTOP ? tauriBackend : null);
  publish(
    backend
      ? { state: "ready", model: "test", dims: 0 }
      : DESKTOP
        ? { state: "unloaded", model: "", dims: 0 }
        : NO_MODEL,
  );
}

/* ---------------------------------------------------------------------- */
/* Availability                                                            */
/* ---------------------------------------------------------------------- */

export type EmbeddingState = "unloaded" | "loading" | "ready" | "failed";

export interface EmbeddingStatus {
  state: EmbeddingState;
  /** Stamped on every stored vector, so an index from another model is ignored. */
  model: string;
  dims: number;
  /** Set when `state` is "failed" — the sentence the UI shows. */
  error?: string;
  /** The model is on this machine. False: loading it is a ~1.1GB download. */
  downloaded?: boolean;
}

/**
 * What the browser build reports.
 *
 * A page cannot load an ONNX model the way the desktop app does, and pretending
 * otherwise would mean every search in `bun run dev` waited on a call that was
 * never going to answer. Named the same way `adapter/web.ts` names its refusal:
 * a sentence, not a silence.
 */
const NO_MODEL: EmbeddingStatus = {
  state: "failed",
  model: "",
  dims: 0,
  error:
    "A busca por sentido precisa do app desktop — o navegador não roda o " +
    "modelo de embeddings. A busca volta a comparar palavras.",
};

let status: EmbeddingStatus = DESKTOP
  ? { state: "unloaded", model: "", dims: 0 }
  : NO_MODEL;

export function embeddingStatus(): EmbeddingStatus {
  return status;
}

/** True when a vector can be asked for at all. Callers branch on this once. */
export function embeddingsReady(): boolean {
  return status.state === "ready";
}

/**
 * Load the model, downloading it if this machine has never seen it.
 *
 * Called at startup and idempotent on the Rust side, so the cost is paid while
 * the user is reading the screen rather than by the first thing they search for.
 * A failure is recorded, not thrown: every caller of this module already has a
 * lexical path to fall back to, and an unhandled rejection at boot would be a
 * worse outcome than a search that matches words.
 */
export async function prepareEmbeddings(
  allowDownload = embeddingConsent() === "granted",
): Promise<EmbeddingStatus> {
  if (!DESKTOP || backend !== tauriBackend) return status;
  if (status.state === "loading" || status.state === "ready") return status;

  // Switched off: learn whether the model is on disk (the menu needs it), but
  // don't load it — Rust's prepare() would, whenever the files are there.
  if (embeddingConsent() === "declined") {
    try {
      const { invoke } = await core();
      const disk = await invoke<EmbeddingStatus>("embeddings_status");
      publish({ ...status, downloaded: disk.downloaded, state: "unloaded", error: undefined });
    } catch {
      /* the menu item stays hidden; search is lexical either way */
    }
    return status;
  }

  // "Loading" only once we know it will load — a declined, absent model must
  // not flash a spinner on every launch.
  if (allowDownload || status.downloaded) publish({ ...status, state: "loading" });
  try {
    const { invoke } = await core();
    publish(await invoke<EmbeddingStatus>("embeddings_prepare", { allowDownload }));
  } catch (error) {
    publish({
      ...status,
      state: "failed",
      error:
        error instanceof Error
          ? error.message
          : "the embedding model could not be loaded",
    });
  }
  return status;
}

/* ---------------------------------------------------------------------- */
/* Consent — the model is ~1.1GB, so it is downloaded only once asked.       */
/* ---------------------------------------------------------------------- */

const CONSENT_KEY = "atimo.embeddings.consent";

export type EmbeddingConsent = "granted" | "declined" | null;

export function embeddingConsent(): EmbeddingConsent {
  try {
    const value = localStorage.getItem(CONSENT_KEY);
    return value === "granted" || value === "declined" ? value : null;
  } catch {
    return null;
  }
}

function setConsent(value: "granted" | "declined"): void {
  try {
    localStorage.setItem(CONSENT_KEY, value);
  } catch {
    /* private mode: the choice lasts this session only */
  }
}

/** The user said yes: remember it and start the download. */
export function downloadEmbeddings(): Promise<EmbeddingStatus> {
  setConsent("granted");
  if (status.state === "failed") publish({ ...status, state: "unloaded" });
  return prepareEmbeddings(true);
}

/** The user said not now: stop asking. The setting stays reachable. */
export function declineEmbeddings(): void {
  setConsent("declined");
  notify();
}

/**
 * Switch smart search off. Search goes back to matching words at once; the
 * downloaded model stays on disk, so switching back on is instant.
 *
 * ponytail: the model stays loaded in Rust's memory until the app restarts;
 * add an `embeddings_unload` command if that RAM matters.
 */
export function disableEmbeddings(): void {
  setConsent("declined");
  queries.clear();
  publish({ ...status, state: "unloaded", error: undefined });
}

/** Off is a decision only the user makes; every embedding call honours it. */
function switchedOff(): boolean {
  return embeddingConsent() === "declined";
}

/* ---------------------------------------------------------------------- */
/* Notification                                                            */
/* ---------------------------------------------------------------------- */

type Listener = () => void;
const listeners = new Set<Listener>();

/**
 * Fires when a vector lands or the model's state changes.
 *
 * The one thing a synchronous cache cannot do is tell a React tree that the
 * answer it read a moment ago has improved. Without this, priming a query would
 * warm a cache nobody re-reads until the next keystroke, and the preview would
 * always be exactly one edit behind its own retrieval.
 */
export function subscribeEmbeddings(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function notify(): void {
  for (const listener of listeners) listener();
}

function publish(next: EmbeddingStatus): void {
  status = next;
  notify();
}

/* ---------------------------------------------------------------------- */
/* Vectors                                                                 */
/* ---------------------------------------------------------------------- */

/**
 * base64 of little-endian `f32` back into something the hot loop can read.
 *
 * The encoding is chosen in `embeddings.rs`; this is the other half of it. The
 * `Float32Array` view is over the decoded buffer directly rather than copied
 * element by element, which for a project's worth of passages is the difference
 * between one allocation and four hundred thousand.
 *
 * Every platform this app ships on is little-endian, which is what makes the
 * view legitimate rather than merely convenient.
 */
export function decodeVector(encoded: string): Float32Array {
  const binary = atob(encoded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new Float32Array(bytes.buffer, bytes.byteOffset, bytes.length / 4);
}

/**
 * Similarity between two vectors from this model, 0..1 after `relevance()`.
 *
 * A plain dot product, because the Rust side normalises before encoding. Cosine
 * with the square roots left in would be the same number and would run this loop
 * — which is the whole cost of a search — with two extra passes in it.
 */
export function dot(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length) return 0;
  let sum = 0;
  for (let i = 0; i < a.length; i++) sum += a[i]! * b[i]!;
  return sum;
}

/*
 * Calibration, and why it is relative rather than absolute.
 *
 * The first version of this was a fixed floor: subtract 0.75, divide by what is
 * left. It was wrong, and the measurement that says so is in `embeddings.rs`
 * (`unrelated_text_still_scores_high`). Against the small E5 this first shipped
 * with, one query scored:
 *
 *     "how does login work"  ->  session cookies   0.855   <- the answer
 *                                bananas ripening  0.790
 *                                Postgres vs Mongo 0.797
 *                                kitchen tiles     0.741
 *
 * Everything lives between 0.73 and 0.86. E5 packs its whole training set into a
 * narrow cone, so "how related are these" is not readable off one cosine — the
 * absolute value mostly says how long and how prose-like the two texts are. A
 * fixed floor gave the right answer 0.42 and a sentence about fruit 0.16, and in
 * Portuguese the gap between right and wrong closed to 0.015.
 *
 * What is readable is where a passage sits *relative to the rest of the corpus
 * for this query*. The median of a project's scores is that query's own
 * baseline, and it moves with the language, the length and the register of
 * whatever is being asked — which is precisely what the fixed constant could not
 * do.
 *
 * Two consequences of "relative", stated so nobody rediscovers them as bugs:
 *
 * Relative calibration measures *distinction within the project*, not relevance
 * in the abstract. In a project that is entirely about one topic, the median is
 * itself a relevant passage, and everything at or under it scores zero here no
 * matter how on-topic it is — the semantic half goes quiet and the lexical 35%
 * carries retrieval, which is the same designed degradation as having no
 * vectors at all. That is the trade: a scheme that can tell "outstanding" from
 * "unremarkable" inside any one project cannot also promise that "unremarkable
 * in a relevant project" outranks it being drowned. Ranking above the median is
 * preserved either way, and the budget selects from the top.
 *
 * And the calibration cannot widen a separation the model never produced. On
 * the small E5, Portuguese answers cleared Portuguese noise by 0.015 — inside
 * `SEMANTIC_MARGIN` — so calibration stopped noise from scoring 0.26 but could
 * not push the answer far from it either. That is a model property, gated in
 * Rust by `portuguese_answer_clears_its_corpus_baseline`, and it is the reason
 * the model is `multilingual-e5-base` rather than small.
 */

/**
 * How far above its project's median a passage must sit to read as a full match.
 *
 * From the same measurement: a genuine answer clears the median by 0.06–0.08,
 * and the spread of the noise around it is ±0.03. Wider would flatten real hits
 * toward zero; narrower would promote the top of the noise.
 *
 * A constant, deliberately, where scaling by the corpus's own spread (MAD, IQR)
 * would look more principled. The failure case decides it: in a corpus where
 * *nothing* answers the query, the spread is tiny, and dividing by it would
 * stretch the top of the noise to 1.0 — the calibration would manufacture a
 * winner precisely when the honest answer is "no match here". Against a fixed
 * margin, a corpus of noise has nothing clearing median + 0.08 and everything
 * scores near zero, which is the truth. The cost is that the margin is a model
 * property measured per family, not derived — which is what the Rust probes pin.
 */
const SEMANTIC_MARGIN = 0.08;

/**
 * The absolute floor, kept only for corpora too small to have a distribution.
 *
 * A median over three passages is not a baseline, it is one of the three
 * passages. At and below `MIN_BASELINE` the relative rule has nothing to stand
 * on, so it falls back to the crude one — which is wrong in the ways described
 * above, but wrong over a corpus small enough that everything in it is going to
 * be read anyway.
 */
const SIMILARITY_FLOOR = 0.78;

/** At or under this many passages, a median is just one of the passages. */
const MIN_BASELINE = 4;

/** Passages a project needs before its median is trusted outright. */
export const MIN_SAMPLE = 8;

/**
 * What a corpus establishes for one query: its median, and how far to trust it.
 *
 * `weight` fades the median rule in between `MIN_BASELINE` and `MIN_SAMPLE`
 * instead of switching at a threshold. The switch was visible: the eighth
 * passage arriving in a project flipped every score from the floor rule to the
 * median rule in one keystroke, and the Context panel's bars jumped for a
 * reason no user could be expected to guess. A young project's scores now walk
 * from the crude scale to the calibrated one as its corpus earns the
 * distribution the calibration needs.
 */
export interface Baseline {
  median: number;
  /** 0..1 — the blend between the absolute floor and the median rule. */
  weight: number;
}

/**
 * One cosine, against the baseline its corpus set for this query.
 *
 * `baseline` is `null` for a corpus at or below `MIN_BASELINE`, which selects
 * the absolute fallback outright; between there and `MIN_SAMPLE` the two rules
 * are mixed by the baseline's weight. Each rule is clamped before mixing, so
 * the result reads 0..1 on the one scale everything downstream — the composer's
 * thresholds, the palette's floor, the score bars — already reads.
 */
export function relevance(similarity: number, baseline: Baseline | null): number {
  const floor = clamp01(
    (similarity - SIMILARITY_FLOOR) / (1 - SIMILARITY_FLOOR),
  );
  if (baseline === null) return floor;

  const relative = clamp01((similarity - baseline.median) / SEMANTIC_MARGIN);
  return baseline.weight * relative + (1 - baseline.weight) * floor;
}

function clamp01(value: number): number {
  return value <= 0 ? 0 : value >= 1 ? 1 : value;
}

/**
 * The median of a set of similarities — a query's own idea of "unremarkable".
 *
 * Median rather than mean because the thing being measured is the *bulk* of the
 * corpus, and a handful of genuine matches at the top would drag a mean up into
 * the range they are supposed to stand out from. Sorted in place on a copy: the
 * caller's array is a scratch buffer either way, but that is not a property this
 * function should assume.
 */
export function baselineOf(similarities: number[]): Baseline | null {
  const count = similarities.length;
  if (count <= MIN_BASELINE) return null;

  const sorted = [...similarities].sort((a, b) => a - b);
  const middle = sorted.length >> 1;
  const median =
    sorted.length % 2
      ? sorted[middle]!
      : (sorted[middle - 1]! + sorted[middle]!) / 2;

  return {
    median,
    weight: Math.min(1, (count - MIN_BASELINE) / (MIN_SAMPLE - MIN_BASELINE)),
  };
}

/**
 * How much of a hybrid score the vectors are worth.
 *
 * Hybrid rather than pure vectors, and the lexical half is not a fallback that
 * happens to still be wired up — it is the half that carries the things
 * embeddings are structurally bad at. A model trained on prose
 * puts `useReducer` and `useCallback` in nearly the same place, and it has never
 * seen `p-atimo` or `ERR_MODULE_NOT_FOUND` at all. Someone searching for an
 * identifier wants the string, not its neighbourhood.
 *
 * So: meaning leads, words vote. A passage with no shared terms and a strong
 * vector still scores 0.65, well clear of every threshold downstream — which is
 * the "session cookies" / "login flow" case this whole layer exists for — and a
 * passage that carries an exact identifier the model cannot represent still
 * scores 0.35 and survives.
 */
const SEMANTIC_WEIGHT = 0.65;

/**
 * One relevance from the two halves.
 *
 * `semantic` is `null` when there is nothing to compare against — the model is
 * still loading, this project's vectors have not landed, the build is the
 * browser one. That is not a zero: scoring it as one would rank every result in
 * the app at a third of its true relevance and quietly drop the weaker two
 * thirds under the composer's thresholds. With no vector, the words are the
 * whole answer, exactly as they were before this layer existed.
 */
export function fuse(lexical: number, semantic: number | null): number {
  if (semantic === null) return lexical;
  return SEMANTIC_WEIGHT * semantic + (1 - SEMANTIC_WEIGHT) * lexical;
}

/* ---------------------------------------------------------------------- */
/* Embedding                                                               */
/* ---------------------------------------------------------------------- */

/**
 * E5 was trained with a word in front of every input, and the asymmetry is what
 * lets a short question land near a long answer. The Rust side adds it; this
 * type is how the caller says which side of that pair it is on, and getting it
 * wrong degrades retrieval without failing.
 */
export type EmbedRole = "query" | "passage";

/**
 * Embed a batch of passages, in the order given.
 *
 * Returns the encoded form rather than `Float32Array`s: the caller is the
 * reindexer, and what it does with these is write them to SQLite, where they go
 * as the same base64 string. Decoding here would be a round trip through floats
 * that nobody reads.
 */
export async function embedPassages(texts: string[]): Promise<string[] | null> {
  if (!texts.length) return [];
  if (!backend || switchedOff()) return null;

  try {
    const encoded = await backend(texts, "passage");
    if (status.state !== "ready") publish({ ...status, state: "ready" });
    return encoded;
  } catch (error) {
    publish({
      ...status,
      state: "failed",
      error:
        error instanceof Error ? error.message : "this text could not be embedded",
    });
    return null;
  }
}

/* ---------------------------------------------------------------------- */
/* The query cache                                                         */
/* ---------------------------------------------------------------------- */

/**
 * Queries whose vectors we are holding.
 *
 * Bounded because the key is a prompt draft, so typing a sentence produces one
 * entry per keystroke, and an unbounded map would hold every intermediate state
 * of every prompt for the life of the session. Oldest-out: the useful entries
 * are the recent ones, and the composer re-primes anything it still wants.
 */
const MAX_QUERIES = 64;

const queries = new Map<string, Float32Array>();
/** Queries already in flight, so a burst of callers shares one round-trip. */
const inFlight = new Map<string, Promise<Float32Array | null>>();

/** Same normalisation on both sides, so "  Auth " and "auth" are one entry. */
function keyOf(query: string): string {
  return query.trim().toLowerCase().replace(/\s+/g, " ");
}

/**
 * The vector for a query, if we already have it.
 *
 * Synchronous by design — this is what lets `compose()` stay synchronous. `null`
 * means "not yet", not "never": the caller falls back to lexical scoring for
 * this pass, and `subscribeEmbeddings` tells it when to look again.
 */
export function cachedQuery(query: string): Float32Array | null {
  if (status.state !== "ready") return null;
  return queries.get(keyOf(query)) ?? null;
}

/**
 * Embed a query, or hand back the one already embedded.
 *
 * Awaited by the send path, which is the one caller that cannot afford to
 * retrieve against a cache miss — the composition it produces is the actual
 * prompt, and a turn that quietly went out with lexical-only context is
 * indistinguishable afterwards from one that had nothing to find.
 */
export async function embedQuery(query: string): Promise<Float32Array | null> {
  const key = keyOf(query);
  if (!key) return null;

  const cached = queries.get(key);
  if (cached) return cached;

  const pending = inFlight.get(key);
  if (pending) return pending;
  // Before the request, not inside it: with no await, its finally ran before inFlight.set, and the
  // settled null stayed there, so this query never got a vector once the model loaded.
  if (!backend || switchedOff()) return null;

  const request = (async (): Promise<Float32Array | null> => {
    try {
      const [encoded] = await backend([query], "query");
      if (!encoded) return null;

      const vector = decodeVector(encoded);
      remember(key, vector);
      if (status.state !== "ready") publish({ ...status, state: "ready" });
      else notify();
      return vector;
    } catch (error) {
      publish({
        ...status,
        state: "failed",
        error:
          error instanceof Error
            ? error.message
            : "this search could not be embedded",
      });
      return null;
    } finally {
      inFlight.delete(key);
    }
  })();

  inFlight.set(key, request);
  return request;
}

/**
 * Warm a query without waiting for it.
 *
 * For the callers that render on a debounce: they read `cachedQuery` now, get
 * lexical-only retrieval for this pass, and are told to render again when the
 * vector lands. Fire-and-forget rather than ignored — `embedQuery` records its
 * own failures, so there is nothing left here to handle.
 */
export function primeQuery(query: string): void {
  if (!embeddingsReady()) return;
  void embedQuery(query);
}

function remember(key: string, vector: Float32Array): void {
  if (queries.size >= MAX_QUERIES) {
    const oldest = queries.keys().next().value;
    if (oldest !== undefined) queries.delete(oldest);
  }
  queries.set(key, vector);
}

/**
 * Forget every cached query. Tests, and a model change under our feet.
 *
 * Leaves `status` and the backend alone: a suite installs its embedder once and
 * clears this between cases, and clearing the status here would put the module
 * back to "unloaded" while a perfectly good model was still installed.
 */
export function resetEmbeddings(): void {
  queries.clear();
  inFlight.clear();
}

/** Encode a vector the way the Rust side does, for tests and for `decodeVector`. */
export function encodeVector(values: number[]): string {
  const norm = Math.sqrt(values.reduce((sum, v) => sum + v * v, 0));
  const scale = norm > 0 ? 1 / norm : 0;

  const floats = new Float32Array(values.length);
  for (let i = 0; i < values.length; i++) floats[i] = values[i]! * scale;

  const bytes = new Uint8Array(floats.buffer);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}
