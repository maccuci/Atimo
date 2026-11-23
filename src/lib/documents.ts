import { store } from "./persistence";
import { fuse } from "./embeddings";
import { estimateTokens } from "./tokens";
import { uid } from "./utils";
import { ARCHIVE_EXTENSIONS, XML_EXTENSIONS, MAX_ARCHIVE_BYTES, integrationChunks, isArchive, isXml, readArchive, readXml, type IntegrationSource } from "./integration-files";
import type { Document, DocumentChunk, DocumentKind } from "./types";

/*
 * Uploaded files: reading them, cutting them up, and finding the pieces again.
 *
 * Two decisions shape everything here, and both come from the same place — the
 * PRD's "Smart Context Injection", which is the claim that Atimo sends the
 * relevant part rather than the whole thing.
 *
 * **Documents go in as chunks, not as files.** A forty-page brief has three
 * relevant paragraphs. Injecting all forty pages costs the window, buries the
 * three, and is exactly the copy-paste behaviour the product exists to replace.
 *
 * **The index is built once, at upload.** `compose()` runs on a debounce while
 * the user types, so anything it does is effectively per-keystroke. Scoring by
 * `text.includes(term)` over every document would be a scan of the whole
 * project's files on each one; scoring against an inverted index is a Map lookup
 * per term and a walk of only the chunks that actually contain one.
 */

/* ---------------------------------------------------------------------- */
/* Reading a file                                                          */
/* ---------------------------------------------------------------------- */

/**
 * Extensions we can read, and what to call them.
 *
 * An allowlist rather than a "not binary" check. The failure mode of guessing
 * wrong is a document full of mojibake that retrieval will happily quote at a
 * model, and there is no way to notice that from inside the app — whereas being
 * told "PDF is not supported yet" is a fact the user can act on.
 */
const EXTENSIONS: Record<string, DocumentKind> = {
  ...Object.fromEntries([...XML_EXTENSIONS, ...ARCHIVE_EXTENSIONS].map((ext) => [ext, "code" as const])),
  md: "markdown",
  markdown: "markdown",
  mdx: "markdown",
  txt: "text",
  text: "text",
  rst: "text",
  log: "text",
  csv: "data",
  tsv: "data",
  json: "data",
  jsonl: "data",
  yaml: "data",
  yml: "data",
  toml: "data",
  ini: "data",
  env: "data",
  ts: "code",
  tsx: "code",
  js: "code",
  jsx: "code",
  mjs: "code",
  cjs: "code",
  rs: "code",
  py: "code",
  go: "code",
  rb: "code",
  java: "code",
  kt: "code",
  swift: "code",
  c: "code",
  h: "code",
  cpp: "code",
  hpp: "code",
  cs: "code",
  php: "code",
  sh: "code",
  bash: "code",
  zsh: "code",
  sql: "code",
  html: "code",
  css: "code",
  scss: "code",
  vue: "code",
  svelte: "code",
};

/**
 * Bytes past which a file is refused.
 *
 * Not about disk — it is about what happens after: every byte is chunked,
 * indexed and held in memory for as long as the project is open. Ten megabytes
 * of log file would index into tens of thousands of chunks and win nothing,
 * because the answer is never "all of it".
 */
export const MAX_FILE_BYTES = 2 * 1024 * 1024;

export interface ReadFile {
  name: string;
  kind: DocumentKind;
  text: string;
  bytes: number;
  sources?: IntegrationSource[];
}

/** Why a file was refused, in words the user can act on. */
export class UnreadableFile extends Error {}

export function extensionOf(name: string): string {
  const at = name.lastIndexOf(".");
  return at === -1 ? "" : name.slice(at + 1).toLowerCase();
}

export function isReadable(name: string): boolean {
  return extensionOf(name) in EXTENSIONS;
}

/** A comma-separated `accept` for a file input, from the same one list. */
export const ACCEPT_ATTRIBUTE = Object.keys(EXTENSIONS)
  .map((ext) => `.${ext}`)
  .join(",");

export async function readFile(file: File): Promise<ReadFile> {
  const kind = EXTENSIONS[extensionOf(file.name)];
  if (!kind) {
    throw new UnreadableFile(
      extensionOf(file.name) === "pdf"
        ? `${file.name} é um PDF — por enquanto só formatos de texto.`
        : `${file.name} não é um formato de texto que o Atimo lê ainda.`,
    );
  }

  const limit = isArchive(file.name) ? MAX_ARCHIVE_BYTES : MAX_FILE_BYTES;
  if (file.size > limit) {
    throw new UnreadableFile(
      `${file.name} tem ${Math.round(file.size / 1024)} KB — o limite é ${
        limit / 1024 / 1024
      } MB.`,
    );
  }

  if (isArchive(file.name) || isXml(file.name)) {
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      const sources = isArchive(file.name) ? readArchive(bytes) : [readXml(file.name, bytes)];
      return {
        name: file.name, kind, bytes: file.size, sources,
        text: sources.map((source) => `${source.path}${source.reason ? `: ${source.reason}` : ""}`).join("\n"),
      };
    } catch (error) {
      throw new UnreadableFile(`${file.name}: ${error instanceof Error ? error.message : "não foi possível ler os arquivos da integração"}`);
    }
  }

  const text = await file.text();

  // A NUL byte in what claims to be text means the extension lied, or the file
  // is truncated. Either way, decoding it further produces confident nonsense.
  if (text.includes("\u0000")) {
    throw new UnreadableFile(`${file.name} não parece ser texto.`);
  }

  if (!text.trim()) {
    throw new UnreadableFile(`${file.name} está vazio.`);
  }

  return { name: file.name, kind, text, bytes: file.size };
}

/* ---------------------------------------------------------------------- */
/* Chunking                                                                */
/* ---------------------------------------------------------------------- */

/** Roughly 220 tokens — small enough to be specific, big enough to be an idea. */
const TARGET_CHARS = 900;

/** Past this, a single paragraph is split rather than kept whole. */
const MAX_CHARS = 1_600;

const HEADING = /^#{1,6}\s+(.+)$/;

/**
 * Split a document into retrievable pieces.
 *
 * Packed by paragraph rather than cut at a fixed offset: a chunk that starts
 * mid-sentence reads as noise to the model and scores badly for the reader too,
 * because the terms that would have matched are split across the boundary.
 *
 * Each chunk carries the heading it fell under. That costs a few tokens and buys
 * two things — the model gets told what section it is reading, instead of a
 * paragraph with no referent, and the heading's words become part of what the
 * chunk matches on, so a query naming a section finds its body.
 */
export function chunkText(
  text: string,
  documentId: string,
  projectId: string,
): DocumentChunk[] {
  const chunks: DocumentChunk[] = [];
  const blocks = text.split(/\n\s*\n/);

  let heading = "";
  let buffer: string[] = [];
  let size = 0;

  const flush = () => {
    if (!buffer.length) return;
    const body = buffer.join("\n\n").trim();
    buffer = [];
    size = 0;
    if (!body) return;

    // The heading is not repeated when the chunk opens with it anyway.
    const withContext =
      heading && !body.startsWith("#") ? `${heading}\n\n${body}` : body;

    chunks.push({
      id: uid("k"),
      documentId,
      projectId,
      index: chunks.length,
      text: withContext,
      tokens: estimateTokens(withContext),
    });
  };

  for (const raw of blocks) {
    const block = raw.trim();
    if (!block) continue;

    const match = block.match(HEADING);
    if (match) {
      // A new section starts a new chunk: packing the tail of one section with
      // the head of the next produces a chunk that is about neither.
      flush();
      heading = match[1]!.trim();
    }

    if (block.length > MAX_CHARS) {
      flush();
      for (let at = 0; at < block.length; at += MAX_CHARS) {
        buffer = [block.slice(at, at + MAX_CHARS)];
        size = MAX_CHARS;
        flush();
      }
      continue;
    }

    if (size + block.length > TARGET_CHARS) flush();
    buffer.push(block);
    size += block.length;
  }

  flush();
  return chunks;
}

/** The opening of a document, for lists and cards. Never what retrieval scores. */
export function excerptOf(text: string): string {
  return text.replace(/\s+/g, " ").trim().slice(0, 220);
}

/* ---------------------------------------------------------------------- */
/* The index                                                               */
/* ---------------------------------------------------------------------- */

const STOPWORDS = new Set([
  "the", "and", "for", "with", "that", "this", "from", "into", "your", "you",
  "are", "was", "how", "why", "what", "when", "where", "should", "would",
  "could", "will", "can", "our", "use", "using", "about", "have", "has", "not",
  "but", "all", "any", "its", "were", "they", "them", "their", "than", "then",
]);

/**
 * The tokens a piece of text is indexed and queried by.
 *
 * One function for both sides on purpose: an index built with a different
 * tokenizer than the query uses is an index that silently misses, and the
 * symptom — retrieval that is merely a bit worse — is one nobody reports.
 */
export function indexTerms(text: string): string[] {
  const terms: string[] = [];
  for (const word of text.toLowerCase().split(/[^a-z0-9]+/)) {
    if (word.length > 2 && !STOPWORDS.has(word)) terms.push(word);
  }
  return terms;
}

interface ProjectIndex {
  chunks: DocumentChunk[];
  /** term -> positions in `chunks`. The whole point of this module. */
  postings: Map<string, number[]>;
  /** documentId -> positions in `chunks`, for resolving `@document()`. */
  byDocument: Map<string, number[]>;
}

/**
 * Built indexes, by project.
 *
 * Per project rather than for the whole workspace: chunks are the largest thing
 * the app holds, and a user works in one project at a time. Bounding the
 * resident set to the open project is what keeps a workspace with fifty
 * documents from costing the same as one with five.
 */
const indexes = new Map<string, ProjectIndex>();

/** Projects whose load is in flight, so a burst of callers shares one read. */
const loading = new Map<string, Promise<void>>();

/**
 * How many times a project's text has been replaced under our feet.
 *
 * A load reads chunks over IPC and builds the index when they come back, so
 * there is a window in which the rows it is describing stop being the rows in
 * the database — a restore writes a whole project's text while the index for
 * that project is still being read. Without this the stale result lands *after*
 * the invalidation, and the project spends the rest of the session retrieving
 * nothing from files that are sitting right there in the list.
 *
 * Compared rather than locked: the read is allowed to finish, its result is
 * simply not adopted if the world moved on.
 */
const generations = new Map<string, number>();

function emptyIndex(): ProjectIndex {
  return { chunks: [], postings: new Map(), byDocument: new Map() };
}

function add(index: ProjectIndex, chunk: DocumentChunk): void {
  const at = index.chunks.length;
  index.chunks.push(chunk);

  const owned = index.byDocument.get(chunk.documentId);
  if (owned) owned.push(at);
  else index.byDocument.set(chunk.documentId, [at]);

  // Deduplicated per chunk: a term appearing eight times in one paragraph should
  // not put that paragraph in the postings list eight times.
  for (const term of new Set(indexTerms(chunk.text))) {
    const postings = index.postings.get(term);
    if (postings) postings.push(at);
    else index.postings.set(term, [at]);
  }
}

function build(chunks: DocumentChunk[]): ProjectIndex {
  const index = emptyIndex();
  for (const chunk of chunks) add(index, chunk);
  return index;
}

/**
 * Make sure a project's chunks are in memory.
 *
 * Idempotent and safe to call often — the store selecting a project calls it,
 * and so does every upload. Concurrent callers share the one read rather than
 * each starting their own.
 *
 * A failure leaves the project indexed as empty rather than unindexed, so
 * retrieval degrades to "this project's files contribute nothing" instead of
 * retrying a broken read on every keystroke.
 */
export async function ensureIndex(projectId: string): Promise<void> {
  if (!projectId || indexes.has(projectId)) return;

  const inFlight = loading.get(projectId);
  if (inFlight) return inFlight;

  const generation = generations.get(projectId) ?? 0;

  /** True while nothing has replaced this project's text since we started. */
  const current = () => (generations.get(projectId) ?? 0) === generation;

  const load = (async () => {
    try {
      const chunks = await store.loadChunks(projectId);
      if (current()) indexes.set(projectId, build(chunks));
    } catch (error) {
      console.error("could not load the documents for this project", error);
      if (current()) indexes.set(projectId, emptyIndex());
    } finally {
      // Only while the slot is still ours. `forgetProject` clears it so the next
      // caller starts a fresh read rather than joining this obsolete one, and
      // deleting unconditionally would evict that replacement.
      if (current()) loading.delete(projectId);
    }
  })();

  loading.set(projectId, load);
  return load;
}

/**
 * Add a freshly uploaded document to an index that is already built.
 *
 * Cheaper than invalidating: re-reading the project would fetch every chunk of
 * every other document back out of SQLite to learn something we are holding in
 * our hand. Skipped when the project is not indexed yet — `ensureIndex` will
 * read these rows along with the rest.
 */
export function indexDocument(projectId: string, chunks: DocumentChunk[]): void {
  const index = indexes.get(projectId);
  if (!index) return;
  for (const chunk of chunks) add(index, chunk);
}

/**
 * Drop a document from its project's index.
 *
 * Rebuilds rather than splicing. The postings lists hold positions into
 * `chunks`, so removing an element from the middle would invalidate every
 * position after it — and a "cheap" delete that leaves the index quietly
 * pointing at the wrong paragraphs is worse than an O(n) rebuild of something
 * that happens when a user clicks delete.
 */
export function forgetDocument(projectId: string, documentId: string): void {
  const index = indexes.get(projectId);
  if (!index) return;
  indexes.set(
    projectId,
    build(index.chunks.filter((chunk) => chunk.documentId !== documentId)),
  );
}

/**
 * Forget a whole project — it was deleted, or its text was replaced.
 *
 * Drops the read in flight along with the built index. Both halves matter: a
 * restore invalidates the index *because* it just wrote different chunks, so a
 * load started before it must neither be adopted nor joined by the next caller.
 */
export function forgetProject(projectId: string): void {
  generations.set(projectId, (generations.get(projectId) ?? 0) + 1);
  indexes.delete(projectId);
  loading.delete(projectId);
}

/** Tests publish their own workspaces; this puts the index back. */
export function resetIndexes(): void {
  indexes.clear();
  loading.clear();
  generations.clear();
}

/**
 * A project's chunks, for the vector index to embed.
 *
 * The one reader outside this module, and it reads rather than re-fetches on
 * purpose: `vectors.ts` needs the same text `searchChunks` scores, and going
 * back to SQLite for it would mean the two could disagree about what a project
 * contains for as long as a load takes.
 */
export function projectChunks(projectId: string): DocumentChunk[] {
  return indexes.get(projectId)?.chunks ?? [];
}

export interface ScoredChunk {
  chunk: DocumentChunk;
  /** 0..1 — how well this chunk answers the query. */
  score: number;
}

/**
 * Semantic scores by chunk id, from `vectors.ts`. Empty when there is nothing to
 * compare against — the model is still loading, or this is the browser build.
 */
export type SemanticScores = ReadonlyMap<string, number>;

const NO_VECTORS: SemanticScores = new Map();

/**
 * The chunks of a project that best answer a query.
 *
 * Synchronous, and returns nothing for a project whose index has not landed
 * yet. That window is one project switch wide and closes on its own; making the
 * whole composer async to close it would mean every keystroke awaited a
 * database, which is a far worse trade than one early turn where a file did not
 * contribute.
 *
 * The candidate set is the *union* of the two halves, and that is the entire
 * point of the semantic one. The postings walk finds chunks that share a word;
 * the vectors find chunks that share a meaning, and a chunk about session
 * cookies shares no word at all with "how does login work". Scoring only the
 * lexical candidates and calling it hybrid would have kept exactly the failure
 * this replaced — the vectors would decide the order of results the words had
 * already agreed to.
 *
 * Scores come in rather than being computed here: the vector index is loaded and
 * queried by `vectors.ts`, and having this module reach into it would make the
 * two mutually dependent to save one argument.
 */
export function searchChunks(
  projectId: string,
  terms: string[],
  limit = 4,
  semantic: SemanticScores = NO_VECTORS,
): ScoredChunk[] {
  const index = indexes.get(projectId);
  if (!index) return [];
  if (!terms.length && !semantic.size) return [];

  // Distinct query terms per chunk, by position. A Map keyed on the position
  // rather than a scan of `chunks` — the candidate set is usually a handful.
  const hits = new Map<number, number>();
  for (const term of new Set(terms)) {
    const postings = index.postings.get(term);
    if (!postings) continue;
    for (const at of postings) hits.set(at, (hits.get(at) ?? 0) + 1);
  }

  const scored: ScoredChunk[] = [];
  const seen = new Set<number>();

  for (const [at, matched] of hits) {
    const chunk = index.chunks[at];
    if (!chunk) continue;
    seen.add(at);
    const lexical = terms.length ? matched / terms.length : 0;
    scored.push({
      chunk,
      score: fuse(lexical, semantic.size ? (semantic.get(chunk.id) ?? 0) : null),
    });
  }

  // The other half of the union: chunks the words missed entirely. Walked over
  // `chunks` rather than over `semantic` because that map spans the whole
  // project's passages, and only the chunk-kind ones belong to this index.
  if (semantic.size) {
    for (let at = 0; at < index.chunks.length; at++) {
      if (seen.has(at)) continue;
      const chunk = index.chunks[at]!;
      const meaning = semantic.get(chunk.id);
      if (!meaning) continue;
      scored.push({ chunk, score: fuse(0, meaning) });
    }
  }

  return scored
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score || a.chunk.index - b.chunk.index)
    .slice(0, limit);
}

/**
 * A named document's own chunks, best-first for the query when there is one.
 *
 * `@document("Spec")` names the file, not a passage, so with no query terms the
 * answer is the opening — which is where a document says what it is. With terms,
 * the relevant passages come first, because someone who names a file *and* asks
 * about migrations wants the migration section, not page one.
 */
export function documentChunks(
  projectId: string,
  documentId: string,
  terms: string[] = [],
  limit = 4,
  semantic: SemanticScores = NO_VECTORS,
): DocumentChunk[] {
  const index = indexes.get(projectId);
  const positions = index?.byDocument.get(documentId);
  if (!index || !positions?.length) return [];

  const chunks = positions
    .map((at) => index.chunks[at])
    .filter((chunk): chunk is DocumentChunk => chunk !== undefined);

  if (!terms.length && !semantic.size) return chunks.slice(0, limit);

  const wanted = new Set(terms);
  const scored = chunks.map((chunk) => {
    let matched = 0;
    for (const term of new Set(indexTerms(chunk.text))) {
      if (wanted.has(term)) matched += 1;
    }
    // Same fusion the project-wide search uses, so naming a file and searching
    // across the project rank its passages the same way. Nothing is more
    // confusing than a document that answers a question when it is found and
    // does not when it is named.
    const lexical = wanted.size ? matched / wanted.size : 0;
    return {
      chunk,
      score: fuse(lexical, semantic.size ? (semantic.get(chunk.id) ?? 0) : null),
    };
  });

  const best = scored
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score || a.chunk.index - b.chunk.index)
    .slice(0, limit)
    .map((s) => s.chunk);

  // A file named but not matched still goes in — the user asked for it by name.
  return best.length ? best : chunks.slice(0, limit);
}

/* ---------------------------------------------------------------------- */

/**
 * Turn a read file into the row and the chunks that go with it.
 *
 * Pure, so the store can write both halves and the tests can check the maths
 * without a database. The two are produced together because `tokens` and
 * `chunkCount` on the row are facts about the chunks — deriving them anywhere
 * else is how a document ends up priced at a length it does not have.
 */
export function toDocument(
  file: ReadFile,
  projectId: string,
): { document: Document; chunks: DocumentChunk[] } {
  const id = uid("doc");
  let integration;
  try {
    integration = file.sources ? integrationChunks(file.sources, file.name, id, projectId) : null;
  } catch (error) {
    throw new UnreadableFile(`${file.name}: ${error instanceof Error ? error.message : "não foi possível preparar a revisão da integração"}`);
  }
  const chunks = integration?.chunks ?? chunkText(file.text, id, projectId);

  return {
    document: {
      id,
      projectId,
      name: file.name,
      kind: file.kind,
      tokens: chunks.reduce((sum, chunk) => sum + chunk.tokens, 0),
      updatedAt: new Date().toISOString(),
      excerpt: excerptOf(file.text),
      bytes: file.bytes,
      chunkCount: chunks.length,
      ...(integration ? { review: integration.review } : {}),
    },
    chunks,
  };
}
