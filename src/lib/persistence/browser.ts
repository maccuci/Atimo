import { applyPatch } from "./patch";
import type {
  Patch,
  Snapshot,
  Store,
  StoredAttachment,
  StoredVector,
} from "./types";
import type { DocumentChunk } from "../types";

/*
 * Browser store — development only.
 *
 * `bun run dev` opens the frontend at localhost:1420 with no Rust process
 * behind it, so there is no SQLite to talk to. Rather than leave the whole
 * seam dead in that mode, this keeps the workspace in localStorage under the
 * same interface.
 *
 * It is genuinely weaker than the desktop path — a few megabytes of quota, one
 * synchronous read-modify-write per patch, and no transaction — which is why
 * `kind` is exposed rather than hidden: a caller that wants to say where the
 * data lives can.
 */

/** Versioned so a future shape change can be detected rather than mis-parsed. */
const STORAGE_KEY = "atimo.workspace.v1";

/**
 * Chunks, under their own key.
 *
 * Same separation the SQLite store gets from a second table, and for the same
 * reason: the workspace is read and rewritten on every patch, and folding file
 * text into it would make each of those a megabyte of JSON.
 */
const CHUNKS_KEY = "atimo.chunks.v1";

/**
 * Vectors, under their own key again.
 *
 * Mostly theatre in this store: a browser page has no Rust process behind it,
 * so `embeddings.ts` reports the model unavailable and nothing ever writes here.
 * The methods exist so the interface has one shape rather than two, and so that
 * a `bun run dev` session which somehow does get vectors keeps them.
 */
const VECTORS_KEY = "atimo.vectors.v1";

/**
 * Attachment bytes, under their own key.
 *
 * The weakest corner of an already-weak store, and worth naming rather than
 * discovering: localStorage is a handful of megabytes in total, and one
 * screenshot is a meaningful fraction of that. A write that does not fit throws
 * like the workspace's does — an attachment silently lost is a prompt that reads
 * differently on reload than it did when it was sent.
 */
const ATTACHMENTS_KEY = "atimo.attachments.v1";

function read(): Snapshot | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<Snapshot>;
    // A snapshot missing a collection is a snapshot from an older shape. Fill
    // the gaps rather than handing the app an undefined it will map over.
    return {
      workspaces: parsed.workspaces ?? [],
      projects: parsed.projects ?? [],
      chats: parsed.chats ?? [],
      messages: parsed.messages ?? [],
      memory: parsed.memory ?? [],
      decisions: parsed.decisions ?? [],
      timeline: parsed.timeline ?? [],
      documents: parsed.documents ?? [],
    };
  } catch {
    // Corrupt JSON reads as "nothing stored", which re-seeds rather than
    // leaving the app with no workspace at all.
    return null;
  }
}

function write(snapshot: Snapshot) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(snapshot));
  } catch (error) {
    // Quota or private mode. Worth surfacing rather than swallowing: unlike a
    // dropped preference, a dropped workspace loses the user's work.
    throw new Error(
      `could not save the workspace to this browser's storage: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

/** Chunks by document id. Keyed that way because that is how they are written. */
function readChunks(): Record<string, DocumentChunk[]> {
  try {
    const raw = localStorage.getItem(CHUNKS_KEY);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    return parsed && typeof parsed === "object"
      ? (parsed as Record<string, DocumentChunk[]>)
      : {};
  } catch {
    return {};
  }
}

function writeChunks(chunks: Record<string, DocumentChunk[]>) {
  try {
    localStorage.setItem(CHUNKS_KEY, JSON.stringify(chunks));
  } catch (error) {
    throw new Error(
      `could not save the document to this browser's storage: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

/** Vectors by id, which is how they are written and dropped. */
function readVectors(): Record<string, StoredVector> {
  try {
    const raw = localStorage.getItem(VECTORS_KEY);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    return parsed && typeof parsed === "object"
      ? (parsed as Record<string, StoredVector>)
      : {};
  } catch {
    return {};
  }
}

/**
 * Swallowed rather than thrown, unlike the workspace and the chunks.
 *
 * A vector that fails to save is a passage that gets re-embedded on the next
 * scan — the index is derived state, recoverable from the workspace at any time.
 * Failing the write would turn a cache miss into an error the user has to read.
 */
function writeVectors(vectors: Record<string, StoredVector>) {
  try {
    localStorage.setItem(VECTORS_KEY, JSON.stringify(vectors));
  } catch (error) {
    console.error("could not save the search index to this browser", error);
  }
}

/** Attachments by id, which is how they are written and cascaded away. */
function readAttachments(): Record<string, StoredAttachment> {
  try {
    const raw = localStorage.getItem(ATTACHMENTS_KEY);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    return parsed && typeof parsed === "object"
      ? (parsed as Record<string, StoredAttachment>)
      : {};
  } catch {
    return {};
  }
}

function writeAttachments(attachments: Record<string, StoredAttachment>) {
  try {
    localStorage.setItem(ATTACHMENTS_KEY, JSON.stringify(attachments));
  } catch (error) {
    throw new Error(
      `could not save the attachment to this browser's storage: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

export const browserStore: Store = {
  kind: "browser",

  async load() {
    return read();
  },

  async seed(snapshot: Snapshot) {
    write(snapshot);
  },

  async apply(patch: Patch) {
    // Nothing stored yet means the seed has not run; applying a diff on top of
    // an empty workspace would persist a fragment of one.
    const current = read();
    if (!current) return;

    const next = applyPatch(current, patch);
    write(next);

    /*
     * The cascade SQLite gets for free, by hand.
     *
     * Chunks are the one thing outside the snapshot, so `applyPatch` cannot
     * reach them — and a document whose row is gone but whose text is not would
     * leave the store growing by the size of every file ever deleted.
     *
     * Worked out by difference rather than from the patch's delete lists: a
     * document can also leave with its project, and reproducing that reasoning
     * here is how the two would drift.
     */
    if (
      patch.deletedDocuments.length ||
      patch.deletedProjects.length ||
      patch.deletedWorkspaces.length
    ) {
      const alive = new Set(next.documents.map((doc) => doc.id));
      const chunks = readChunks();
      let dropped = false;
      for (const documentId of Object.keys(chunks)) {
        if (alive.has(documentId)) continue;
        delete chunks[documentId];
        dropped = true;
      }
      if (dropped) writeChunks(chunks);

      // Vectors hang off the project, which is the cascade SQLite gives them —
      // one foreign key that reaches every kind of passage at once. Same
      // by-difference reasoning: a project can also leave with its workspace.
      const liveProjects = new Set(next.projects.map((project) => project.id));
      const vectors = readVectors();
      let stale = false;
      for (const [id, vector] of Object.entries(vectors)) {
        if (liveProjects.has(vector.projectId)) continue;
        delete vectors[id];
        stale = true;
      }
      if (stale) writeVectors(vectors);
    }

    /*
     * Attachments cascade from a different direction, so they get their own
     * check: their parent is a message, and a message leaves whenever its chat
     * does — which a project or a workspace delete also causes, two levels up.
     *
     * Worked out against the surviving message ids for the same reason the
     * chunks are worked out against surviving documents: `applyPatch` has
     * already resolved every one of those paths, and re-deriving them here is
     * how the two would drift.
     */
    if (
      patch.deletedChats.length ||
      patch.deletedProjects.length ||
      patch.deletedWorkspaces.length
    ) {
      const alive = new Set(next.messages.map((message) => message.id));
      const attachments = readAttachments();
      let orphaned = false;
      for (const [id, attachment] of Object.entries(attachments)) {
        if (alive.has(attachment.messageId)) continue;
        delete attachments[id];
        orphaned = true;
      }
      // Swallowed, unlike the write path: this is reclaiming space, and failing
      // a delete that already happened in the snapshot would report the chat as
      // still there.
      if (orphaned) {
        try {
          writeAttachments(attachments);
        } catch (error) {
          console.error("could not drop the attachments of a deleted chat", error);
        }
      }
    }
  },

  async loadChunks(projectId: string) {
    const stored = readChunks();
    const found: DocumentChunk[] = [];
    for (const chunks of Object.values(stored)) {
      for (const chunk of chunks) {
        if (chunk.projectId === projectId) found.push(chunk);
      }
    }
    // Same order the SQL gives: by document, then by position within it.
    return found.sort(
      (a, b) =>
        a.documentId.localeCompare(b.documentId) || a.index - b.index,
    );
  },

  async putChunks(documentId: string, chunks: DocumentChunk[]) {
    const stored = readChunks();
    // Replace rather than merge: re-uploading a file under the same id produces
    // a different number of chunks, and merging would keep the tail of the old
    // one as text the document no longer contains.
    stored[documentId] = chunks;
    writeChunks(stored);
  },

  async loadVectors(projectId: string, model: string) {
    return Object.values(readVectors()).filter(
      (vector) => vector.projectId === projectId && vector.model === model,
    );
  },

  async putVectors(vectors: StoredVector[]) {
    if (!vectors.length) return;
    const stored = readVectors();
    // Upsert, never clear — vectors arrive one passage at a time, so a batch
    // says nothing about the rows it left out. See `dropVectors`.
    for (const vector of vectors) stored[vector.id] = vector;
    writeVectors(stored);
  },

  async dropVectors(ids: string[]) {
    if (!ids.length) return;
    const stored = readVectors();
    let dropped = false;
    for (const id of ids) {
      if (!(id in stored)) continue;
      delete stored[id];
      dropped = true;
    }
    if (dropped) writeVectors(stored);
  },

  async loadAttachments(chatId: string) {
    return Object.values(readAttachments()).filter(
      (attachment) => attachment.chatId === chatId,
    );
  },

  async putAttachments(attachments: StoredAttachment[]) {
    if (!attachments.length) return;
    const stored = readAttachments();
    // Upsert, never clear: a batch is one message's files, and the rest of the
    // chat's are not being described by it.
    for (const attachment of attachments) stored[attachment.id] = attachment;
    writeAttachments(stored);
  },
};
