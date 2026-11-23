import type {
  Chat,
  Decision,
  Document,
  DocumentChunk,
  MemoryEntry,
  Message,
  Project,
  TimelineEvent,
  Workspace,
} from "../types";

/*
 * The contract between the app and wherever the workspace is kept.
 *
 * These types mirror `src-tauri/src/db.rs` exactly — the Rust side deserialises
 * straight into them. Both stores (SQLite on the desktop, localStorage in the
 * browser) speak this shape, so nothing above this seam learns which one it got.
 */

/**
 * The persisted half of the workspace.
 *
 * Workspaces are persisted alongside projects. They used to be fixtures only,
 * which meant a workspace created at runtime could appear until reload and then
 * leave its projects with nowhere to render. Keeping the parent collection in
 * the same snapshot makes creation, hydration and backup agree on one graph.
 *
 * `projects` is real state twice over: accepting a knowledge candidate moves a
 * project's `memoryTokens`, and its `instructions` are the base context every
 * chat under it inherits.
 *
 * `documents` carries metadata only. Their text is in `DocumentChunk` rows,
 * which are deliberately *not* here: this snapshot is read whole on every launch
 * and diffed on every store transition, and file text is the one thing in the
 * workspace big enough for that to matter. Chunks load per project instead, and
 * only when retrieval is about to want them.
 */
export interface Snapshot {
  workspaces: Workspace[];
  projects: Project[];
  chats: Chat[];
  messages: Message[];
  memory: MemoryEntry[];
  decisions: Decision[];
  timeline: TimelineEvent[];
  documents: Document[];
}

/**
 * A batch of changes: rows to write, plus the entities that are gone.
 *
 * Rows are upserts rather than inserts-or-updates, because the caller is a diff
 * of two store snapshots and genuinely does not know which a given row is.
 *
 * Only the entities that own others can be deleted, and each is listed by
 * id alone. There is no `deletedMessages` or `deletedMemory`: neither can be
 * removed on its own — a message leaves with its chat, a memory entry with its
 * project — and the cascade is what removes them. Adding the fields would invite
 * a caller to believe otherwise.
 */
export interface Patch extends Snapshot {
  deletedWorkspaces: string[];
  deletedProjects: string[];
  deletedChats: string[];
  /**
   * Documents removed on their own.
   *
   * Documents are the only deletable entity here that is not an owner. A file is
   * something a user uploads by mistake and wants gone, unlike a message — which
   * leaves with its chat — so it needs to be nameable here. Its chunks go with
   * it through the same cascade that takes a chat's transcript.
   */
  deletedDocuments: string[];
}

export const EMPTY_PATCH: Patch = {
  workspaces: [],
  projects: [],
  chats: [],
  messages: [],
  memory: [],
  decisions: [],
  timeline: [],
  documents: [],
  deletedWorkspaces: [],
  deletedProjects: [],
  deletedChats: [],
  deletedDocuments: [],
};

/** The collections a patch can carry rows for, in dependency order. */
export const PATCH_TABLES = [
  "workspaces",
  "projects",
  "chats",
  "messages",
  "memory",
  "decisions",
  "timeline",
  "documents",
] as const satisfies readonly (keyof Snapshot)[];

export type PatchTable = (typeof PATCH_TABLES)[number];

export function isEmptyPatch(patch: Patch): boolean {
  return (
    patch.deletedWorkspaces.length === 0 &&
    patch.deletedProjects.length === 0 &&
    patch.deletedChats.length === 0 &&
    patch.deletedDocuments.length === 0 &&
    PATCH_TABLES.every((table) => patch[table].length === 0)
  );
}

/**
 * One embedded passage, exactly as `db.rs` stores it.
 *
 * The unit is a passage, not an entity: a chat is embedded as the paragraphs its
 * messages are made of, a document as its chunks, a memory entry or decision as
 * itself. `ownerId` is what the passage belongs to, so one deleted message drops
 * its vectors without anyone parsing the id back apart.
 *
 * `model` is on every row because two embedding models share a vector space only
 * by coincidence — a read that mixed them would rank by noise rather than fail.
 * `fingerprint` is a hash of the exact text embedded, which is what makes
 * reindexing incremental: a project rescanned after one new message re-embeds
 * one passage.
 *
 * `vector` is base64 of little-endian `f32`, already unit length, so similarity
 * in `vectors.ts` is a dot product with no square roots in the loop. Base64
 * rather than `number[]` because 768 floats spelled out in JSON is ~14KB a row,
 * and a project is thousands of rows.
 */
export interface StoredVector {
  id: string;
  projectId: string;
  kind: string;
  ownerId: string;
  model: string;
  fingerprint: string;
  vector: string;
}

/**
 * One attachment's bytes, exactly as `db.rs` stores it.
 *
 * Off the snapshot for the same reason `DocumentChunk` is, only more so: a
 * single screenshot outweighs a year of somebody's transcripts, and the snapshot
 * is read whole at launch and diffed on every store transition. The message row
 * keeps the metadata a transcript has to draw; this keeps the payload.
 *
 * `data` is a `data:` URL. That is the form the provider takes and the form an
 * `<img src>` takes, so neither consumer re-encodes it — and it carries its own
 * media type, so the row does not have to repeat one the message already holds.
 */
export interface StoredAttachment {
  id: string;
  messageId: string;
  /** Denormalised from the message, so a chat's bytes load in one query. */
  chatId: string;
  data: string;
}

export interface Store {
  /** Where the workspace is kept, for the UI to state honestly. */
  readonly kind: "sqlite" | "browser";
  /** The stored workspace, or null when nothing has ever been written. */
  load(): Promise<Snapshot | null>;
  /** Write the fixtures and mark the store initialised. First run only. */
  seed(snapshot: Snapshot): Promise<void>;
  /** Commit one batch of changes. */
  apply(patch: Patch): Promise<void>;

  /*
   * Chunks, kept off the snapshot on purpose — see `Snapshot`.
   *
   * A separate pair of calls rather than another slice of the patch, because
   * their write pattern is nothing like the rest of the workspace: they are
   * written once when a file is uploaded and never edited, so routing them
   * through a diff that runs on every keystroke would be all cost and no use.
   */

  /** Every chunk in one project, ordered by document then position. */
  loadChunks(projectId: string): Promise<DocumentChunk[]>;
  /** Write one document's chunks, replacing whatever it had. */
  putChunks(documentId: string, chunks: DocumentChunk[]): Promise<void>;

  /*
   * Vectors, also off the snapshot, and for a third write pattern again.
   *
   * Chunks are written once per upload as a set. Vectors are written
   * incrementally — a project rescanned after one new message sends one row —
   * so `putVectors` upserts and never clears, and what is genuinely stale is
   * named by `dropVectors` instead of inferred from what a batch omitted.
   */

  /** Every vector in one project that `model` wrote. */
  loadVectors(projectId: string, model: string): Promise<StoredVector[]>;
  /** Upsert a batch. Rows not named here are left alone. */
  putVectors(vectors: StoredVector[]): Promise<void>;
  /** Forget passages that no longer exist. */
  dropVectors(ids: string[]): Promise<void>;

  /*
   * Attachment bytes, off the snapshot for the third time — and with a fourth
   * write pattern. Chunks are replaced per document, vectors are upserted
   * incrementally and dropped by name; these are written once when a prompt is
   * sent and never touched again. Nothing deletes one on its own: an attachment
   * leaves with the message it was sent with, which leaves with its chat, and
   * the cascade is what removes it.
   */

  /** Every attachment in one chat, in the order they were sent. */
  loadAttachments(chatId: string): Promise<StoredAttachment[]>;
  /** Write a batch. Must run after the messages that own them are committed. */
  putAttachments(attachments: StoredAttachment[]): Promise<void>;
}
