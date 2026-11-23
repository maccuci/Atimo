import { store } from "./persistence";
import type { StoredVector } from "./persistence/types";
import { ensureIndex, projectChunks } from "./documents";
import { workspace } from "./workspace";
import {
  baselineOf,
  dot,
  decodeVector,
  embedPassages,
  embeddingStatus,
  embeddingsReady,
  MIN_SAMPLE,
  relevance,
} from "./embeddings";
import type { Baseline } from "./embeddings";

/*
 * The vector index — what "meaning matching" actually reads.
 *
 * Three things about its shape, and each is a decision the alternatives make
 * worse:
 *
 * **The unit is a passage, not an entity.** A chat is embedded as the
 * paragraphs its messages are made of, a document as the chunks it was split
 * into. One vector for a whole conversation is an average of everything that was
 * ever said in it, which is a point in space that means nothing in particular —
 * and the model only reads 512 tokens anyway, so the rest of the transcript
 * would not be in there even in principle. An entity's score is the best of its
 * passages, which is what "this chat has the answer in it somewhere" means.
 *
 * **The index is incremental, keyed on a fingerprint of the exact text.** A
 * project rescanned after one new message embeds one passage. Without that, the
 * end of every turn would re-embed the whole project, and inference is CPU-bound
 * — the user would hear it.
 *
 * **Vectors are resident per project, like the chunks.** They are far smaller
 * than the text they stand for (3KB a passage), which is what makes the
 * cross-project case affordable: `ensureWorkspaceVectors()` loads all of them,
 * and that is the "shared knowledge across projects" half of the product
 * working rather than being a sentence in the PRD.
 */

export type VectorKind = "chunk" | "passage";

/** One embedded passage, as the index holds it. */
interface Unit {
  kind: VectorKind;
  /** The chunk, message, memory entry or decision this passage belongs to. */
  ownerId: string;
  fingerprint: string;
  vector: Float32Array;
}

/** Unit id -> unit, for one project. */
type ProjectVectors = Map<string, Unit>;

const indexes = new Map<string, ProjectVectors>();

/** Projects whose load is in flight, so a burst of callers shares one read. */
const loading = new Map<string, Promise<void>>();

/**
 * How many times a project's corpus has been replaced under our feet.
 *
 * Same device as `documents.ts`, for the same race and one more: a reindex is a
 * sequence of awaited batches, and a project deleted halfway through it would
 * otherwise have the remaining batches write vectors for rows that are gone —
 * which the foreign key would refuse, loudly, in the middle of an idle tick.
 */
const generations = new Map<string, number>();

/* ---------------------------------------------------------------------- */
/* The corpus                                                              */
/* ---------------------------------------------------------------------- */

/**
 * Below this, a paragraph is packed with the ones after it.
 *
 * A minimum rather than a target, which is the opposite of how `chunkText` packs
 * a document, and the difference is what a transcript is made of. A file's
 * paragraphs are all prose; a conversation's include "Yes.", "ok", and a bare
 * URL — and a vector for "Yes." is a point that means nothing and sits close to
 * every other short affirmation in the workspace. Packing those with their
 * neighbours gives them the context that makes them mean something, while a
 * paragraph that is already a thought is left as one.
 */
const MIN_PASSAGE_CHARS = 120;

/**
 * Past this, one paragraph is cut rather than kept whole.
 *
 * The model reads 512 tokens and stops. A wall of text embedded whole is text
 * whose second half is not in the index at all, and nothing about the result
 * would say so.
 */
const MAX_CHARS = 1_600;

const PARAGRAPH = /\n\s*\n/;

/**
 * Text, as the passages it will be embedded as.
 *
 * Exported because two sides have to agree on it: the index is *built* from
 * these, and `chatExtract` ranks the same units when it decides what a named
 * chat contributes. Two splitters would mean the extract asking the index about
 * passages that do not exist in it — retrieval that is merely a bit worse, which
 * is the kind of bug nobody reports. The same argument `indexTerms` makes for
 * the lexical half.
 */
export function passagesOf(text: string): string[] {
  const passages: string[] = [];
  let buffer: string[] = [];
  let size = 0;

  const flush = () => {
    if (!buffer.length) return;
    const body = buffer.join("\n\n").trim();
    buffer = [];
    size = 0;
    if (body) passages.push(body);
  };

  for (const raw of text.split(PARAGRAPH)) {
    const block = raw.trim();
    if (!block) continue;

    if (block.length > MAX_CHARS) {
      flush();
      for (let at = 0; at < block.length; at += MAX_CHARS) {
        passages.push(block.slice(at, at + MAX_CHARS));
      }
      continue;
    }

    // Flushed *before* appending, so a paragraph that already stands on its own
    // is never merged into the one after it — only the short ones accumulate.
    if (size >= MIN_PASSAGE_CHARS) flush();
    buffer.push(block);
    size += block.length;
  }

  flush();
  return passages;
}

/** The index's name for one passage of one message. Built in both places. */
export function passageId(messageId: string, at: number): string {
  return `passage:${messageId}#${at}`;
}

const CHUNK_PREFIX = "chunk:";

/** The index's name for one document chunk. */
function chunkUnitId(chunkId: string): string {
  return `${CHUNK_PREFIX}${chunkId}`;
}

/** A passage the corpus wants indexed, before it has a vector. */
interface Wanted {
  kind: VectorKind;
  ownerId: string;
  text: string;
  fingerprint: string;
}

/**
 * Everything in one project that retrieval should be able to reach by meaning.
 *
 * Read off the live graph rather than accumulated as things happen, and that is
 * the point: a corpus derived on demand cannot drift from the workspace, where
 * one built by remembering to call an `onMessageAdded` from eleven places
 * eventually does — and the symptom is a conversation that is simply never found,
 * which nobody reports because nothing looks broken.
 */
function corpusOf(projectId: string): Map<string, Wanted> {
  const wanted = new Map<string, Wanted>();
  const { chats, messages } = workspace();

  const add = (id: string, kind: VectorKind, ownerId: string, text: string) => {
    const body = text.trim();
    if (!body) return;
    wanted.set(id, { kind, ownerId, text: body, fingerprint: fingerprint(body) });
  };

  // Owned by the *document*, not by the chunk. A chunk is a slice of a file,
  // and nothing outside this index knows or should know that it exists — so the
  // entity a chunk's score lifts to is the file, and `chunkScores` is what reads
  // the finer granularity back out when a caller genuinely needs it.
  for (const chunk of projectChunks(projectId)) {
    add(chunkUnitId(chunk.id), "chunk", chunk.documentId, chunk.text);
  }

  /*
   * Only the turns that stand for something.
   *
   * The same three exclusions `chatPassages` applies, because the index and the
   * extract have to agree about what a conversation contains: a pending message
   * has no content yet and would be re-embedded on the next scan anyway, a failed
   * one has none at all, and a panel turn contributes the answer that *became*
   * the conversation rather than the drafts that were rejected.
   */
  const owning = new Set(
    chats.filter((chat) => chat.projectId === projectId).map((chat) => chat.id),
  );
  for (const message of messages) {
    if (!owning.has(message.chatId)) continue;
    if (message.pending || message.error) continue;
    if (message.turnId && message.canonical !== true) continue;

    const passages = passagesOf(message.content);
    for (let at = 0; at < passages.length; at++) {
      add(passageId(message.id, at), "passage", message.id, passages[at]!);
    }
  }

  return wanted;
}

/**
 * A cheap, stable hash of the text that was embedded. FNV-1a, with the length
 * mixed in.
 *
 * Not cryptographic and does not need to be: the cost of a collision is one
 * passage whose vector describes an older version of itself, and the cost of a
 * real hash is running it over every byte of every message on every scan.
 */
function fingerprint(text: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return `${(hash >>> 0).toString(36)}.${text.length.toString(36)}`;
}

/* ---------------------------------------------------------------------- */
/* Loading                                                                 */
/* ---------------------------------------------------------------------- */

/**
 * Make sure a project's stored vectors are in memory.
 *
 * Idempotent and cheap to call often. A failure leaves the project indexed as
 * empty rather than unindexed, so retrieval degrades to lexical instead of
 * retrying a broken read on every keystroke — the same bargain `ensureIndex`
 * strikes for the document text.
 */
export async function ensureVectors(projectId: string): Promise<void> {
  if (!projectId || indexes.has(projectId)) return;

  const inFlight = loading.get(projectId);
  if (inFlight) return inFlight;

  const generation = generations.get(projectId) ?? 0;
  const current = () => (generations.get(projectId) ?? 0) === generation;

  const load = (async () => {
    try {
      // Filtered by model on the SQL side: rows written by a previous model
      // answer distances in a space this one does not share, so they read as
      // "not indexed yet" and the corpus is rebuilt rather than ranked by noise.
      const rows = await store.loadVectors(projectId, embeddingStatus().model);
      if (!current()) return;

      const index: ProjectVectors = new Map();
      for (const row of rows) {
        // Rows left over from the retired memory/decision kinds.
        if (row.kind !== "chunk" && row.kind !== "passage") continue;
        index.set(row.id, {
          kind: row.kind as VectorKind,
          ownerId: row.ownerId,
          fingerprint: row.fingerprint,
          vector: decodeVector(row.vector),
        });
      }
      indexes.set(projectId, index);
    } catch (error) {
      console.error("could not load the search index for this project", error);
      if (current()) indexes.set(projectId, new Map());
    } finally {
      if (current()) loading.delete(projectId);
    }
  })();

  loading.set(projectId, load);
  return load;
}

/**
 * Load every project's vectors.
 *
 * The cross-project case — "build this the way we build the other one" — is the
 * shared-knowledge half of the product, and it is only affordable because a
 * vector is a fraction of the text it stands for: a thousand passages is 3MB,
 * where the same passages as text are the megabytes `documents.ts` is careful
 * to keep out of memory.
 */
export async function ensureWorkspaceVectors(): Promise<void> {
  await Promise.all(workspace().projects.map((p) => ensureVectors(p.id)));
}

/* ---------------------------------------------------------------------- */
/* Reindexing                                                              */
/* ---------------------------------------------------------------------- */

/** Passages per forward pass. Matched to the batch size on the Rust side. */
const BATCH = 64;

/** Reindexes in flight, so a burst of triggers does not run the scan twice. */
const scanning = new Map<string, Promise<void>>();

/**
 * Projects whose corpus changed while their own scan was running.
 *
 * A turn finishing triggers a reindex; the next one can finish before the first
 * scan does. Without this the second trigger is dropped as a duplicate and its
 * messages stay unindexed until something unrelated schedules another scan.
 */
const dirty = new Set<string>();

/**
 * Bring a project's index up to date with its text.
 *
 * Safe to call on anything that changes the corpus, and cheap when nothing did:
 * the common case is a diff that finds no work and returns without touching the
 * model. Errors are logged, not thrown — every caller of this is a side effect
 * of something the user actually asked for (sending a turn, uploading a file),
 * and none of them should fail because the index is behind.
 */
export async function reindexProject(projectId: string): Promise<void> {
  if (!projectId || !embeddingsReady()) return;

  const running = scanning.get(projectId);
  if (running) {
    dirty.add(projectId);
    return running;
  }

  const scan = (async () => {
    try {
      do {
        dirty.delete(projectId);
        await scanOnce(projectId);
      } while (dirty.has(projectId));
    } catch (error) {
      console.error("could not update the search index", error);
    } finally {
      scanning.delete(projectId);
    }
  })();

  scanning.set(projectId, scan);
  return scan;
}

async function scanOnce(projectId: string): Promise<void> {
  /*
   * The document text first, and this is load-bearing rather than tidy.
   *
   * `projectChunks` answers "no chunks" for a project whose text has not been
   * read back out of SQLite yet — which is indistinguishable, to the diff below,
   * from a project whose files were all deleted. Scanning before that read lands
   * would therefore drop every chunk vector in the project as stale, and then
   * re-embed all of them on the next scan. Awaiting it makes "no chunks" mean
   * what it says.
   */
  await Promise.all([ensureIndex(projectId), ensureVectors(projectId)]);

  const generation = generations.get(projectId) ?? 0;
  const current = () => (generations.get(projectId) ?? 0) === generation;

  const index = indexes.get(projectId);
  if (!index || !current()) return;

  const wanted = corpusOf(projectId);

  // Passages the index holds that the project no longer contains: a message
  // edited into fewer paragraphs, a document re-uploaded shorter. No cascade
  // reaches these — the owning row is still there — and left behind they are
  // quotable text the workspace does not have.
  const stale: string[] = [];
  for (const id of index.keys()) if (!wanted.has(id)) stale.push(id);

  // Everything whose text is new or has changed since it was embedded.
  const pending: Array<{ id: string; wanted: Wanted }> = [];
  for (const [id, entry] of wanted) {
    if (index.get(id)?.fingerprint === entry.fingerprint) continue;
    pending.push({ id, wanted: entry });
  }

  if (stale.length) {
    for (const id of stale) index.delete(id);
    await store.dropVectors(stale);
    if (!current()) return;
  }

  const model = embeddingStatus().model;

  for (let at = 0; at < pending.length; at += BATCH) {
    const batch = pending.slice(at, at + BATCH);
    const encoded = await embedPassages(batch.map((p) => p.wanted.text));
    // The model became unavailable mid-scan, or the project did. Either way the
    // work already written stands and the rest is picked up by the next scan —
    // the fingerprints are what make that resumable rather than a restart.
    if (!encoded || !current()) return;

    const rows: StoredVector[] = [];
    for (let i = 0; i < batch.length; i++) {
      const { id, wanted: entry } = batch[i]!;
      const vector = encoded[i];
      if (!vector) continue;

      index.set(id, {
        kind: entry.kind,
        ownerId: entry.ownerId,
        fingerprint: entry.fingerprint,
        vector: decodeVector(vector),
      });
      rows.push({
        id,
        projectId,
        kind: entry.kind,
        ownerId: entry.ownerId,
        model,
        fingerprint: entry.fingerprint,
        vector,
      });
    }

    // Written per batch rather than once at the end: a long first index of a
    // real workspace is minutes of inference, and a crash or a quit in the
    // middle of it should cost the current batch, not all of them.
    await store.putVectors(rows);
    if (!current()) return;
  }
}

/* ---------------------------------------------------------------------- */
/* Reading                                                                 */
/* ---------------------------------------------------------------------- */

/**
 * Everything one project's vectors have to say about one query.
 *
 * One pass, not one per kind. The callers each want three or four of these maps
 * — the composer wants chunks, messages and memory; the palette wants all of
 * them — and asking for them separately walked the whole index once per kind on
 * a function that runs on every keystroke. The filtering was never the cost; the
 * dot products are, and they are the same dot products either way.
 *
 * Scores are the *best* of an owner's passages, never an average, and that is
 * the whole reason passages are the unit: a conversation that answered the
 * question in one paragraph and then talked about something else for an hour is
 * a conversation that answered the question. An average would rank it below a
 * short chat that is vaguely on topic throughout, which is exactly backwards.
 */
export interface ProjectScores {
  /** By unit id — the finest granularity, for ranking a chat's own passages. */
  unit: Map<string, number>;
  /** By message id. Lift to a chat by taking the best of its messages. */
  passage: Map<string, number>;
  /** By document id — which file to surface. */
  document: Map<string, number>;
  /** By chunk id — which passages of that file to inject. */
  chunk: Map<string, number>;
}

function noScores(): ProjectScores {
  return {
    unit: new Map(),
    passage: new Map(),
    document: new Map(),
    chunk: new Map(),
  };
}

export function scoreProject(
  projectId: string,
  query: Float32Array,
): ProjectScores {
  const scores = noScores();
  const index = indexes.get(projectId);
  if (!index) return scores;

  /*
   * Two passes, because the calibration is relative.
   *
   * A cosine from this model is not readable on its own — see the note above
   * `relevance`. What it means depends on where the rest of this project's
   * passages landed for this same query, so every raw similarity has to exist
   * before any of them can be turned into a score.
   *
   * The cost is one extra walk of an array of numbers, against a pass that is
   * already doing a 768-wide dot product per unit. It does not register.
   */
  const raw: number[] = [];
  const units: Array<[string, Unit]> = [];
  const byKind = new Map<VectorKind, number[]>();
  for (const entry of index) {
    const similarity = dot(entry[1].vector, query);
    raw.push(similarity);
    units.push(entry);
    const sims = byKind.get(entry[1].kind);
    if (sims) sims.push(similarity);
    else byKind.set(entry[1].kind, [similarity]);
  }

  /*
   * A baseline per kind, because the kinds are not drawn from one distribution.
   *
   * The E5 cosine drifts with the length and register of the text — that is the
   * measured fact the whole calibration answers — and the kinds differ in
   * exactly those: a memory entry is two telegraphic lines, a document chunk is
   * 220 tokens of prose. One pooled median sits wherever the populous kind put
   * it and mis-centres the minority: a project that is mostly long documents
   * reads every short memory entry as below-baseline, however apt.
   *
   * A kind speaks for itself once it holds a full distribution (`MIN_SAMPLE`);
   * until then the project's pooled baseline stands in — a slightly wrong
   * centre being better than none, and better than a "median" of three numbers.
   */
  const pooled = baselineOf(raw);
  const baselines = new Map<VectorKind, Baseline | null>();
  for (const [kind, sims] of byKind) {
    baselines.set(kind, sims.length >= MIN_SAMPLE ? baselineOf(sims) : pooled);
  }

  for (let i = 0; i < units.length; i++) {
    const [unitId, unit] = units[i]!;
    const score = relevance(raw[i]!, baselines.get(unit.kind) ?? pooled);
    scores.unit.set(unitId, score);

    // Chunks are the one kind read at both granularities: by document, to say
    // which file is worth surfacing, and by chunk, to say which paragraphs of it
    // to actually send.
    if (unit.kind === "chunk") {
      scores.chunk.set(unitId.slice(CHUNK_PREFIX.length), score);
    }

    const best = scores[unit.kind === "chunk" ? "document" : unit.kind];
    if (score > (best.get(unit.ownerId) ?? 0)) best.set(unit.ownerId, score);
  }
  return scores;
}

/**
 * True when this project has vectors to score against at all.
 *
 * The question every caller has to ask before fusing, because "no vectors here"
 * and "nothing here is relevant" are the same zero and must not be treated the
 * same way — see the `null` case in `fuse`. A project whose index has not landed
 * should be ranked by its words, not by its words at a third of their weight.
 */
export function hasVectors(projectId: string): boolean {
  return (indexes.get(projectId)?.size ?? 0) > 0;
}

/* ---------------------------------------------------------------------- */
/* Invalidation                                                            */
/* ---------------------------------------------------------------------- */

/**
 * Forget a project — it was deleted, or its text was replaced.
 *
 * Bumps the generation as well as dropping the index, so a scan or a load that
 * is mid-flight neither writes its results nor keeps embedding against a corpus
 * that has been replaced underneath it.
 */
export function forgetVectors(projectId: string): void {
  generations.set(projectId, (generations.get(projectId) ?? 0) + 1);
  indexes.delete(projectId);
  loading.delete(projectId);
  dirty.delete(projectId);
}

/**
 * Drop every resident index whose project is no longer in the workspace.
 *
 * By difference rather than by name, because a project leaves two ways — deleted
 * outright, or cascaded away with its workspace — and only the first is ever
 * named in a patch. The rows in SQLite go either way through the foreign key;
 * this is the in-memory copy, which is the one no cascade reaches.
 */
export function forgetMissingProjects(alive: Iterable<string>): void {
  const live = new Set(alive);
  for (const projectId of [...indexes.keys(), ...loading.keys()]) {
    if (!live.has(projectId)) forgetVectors(projectId);
  }
}

/** Tests publish their own workspaces; this puts the index back. */
export function resetVectors(): void {
  indexes.clear();
  loading.clear();
  generations.clear();
  scanning.clear();
  dirty.clear();
}
