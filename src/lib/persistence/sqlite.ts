import type {
  Patch,
  Snapshot,
  Store,
  StoredAttachment,
  StoredVector,
} from "./types";
import type { DocumentChunk } from "../types";

/*
 * Desktop store — the real one.
 *
 * Every call crosses into Rust, where the workspace lives in SQLite under the
 * app's data directory. Keeping it there rather than in the webview is what
 * makes the writes transactional: a patch either lands whole or not at all, and
 * deleting a chat takes its transcript with it through a foreign key rather
 * than through two hopeful statements.
 *
 * `@tauri-apps/api` is imported lazily so a browser build never pulls it in.
 */

async function core() {
  return import("@tauri-apps/api/core");
}

export const sqliteStore: Store = {
  kind: "sqlite",

  async load() {
    const { invoke } = await core();
    return invoke<Snapshot | null>("db_load");
  },

  async seed(snapshot: Snapshot) {
    const { invoke } = await core();
    // Seeding is an upsert of every fixture plus the initialised marker, so the
    // command takes the same patch shape with nothing deleted.
    await invoke("db_seed", {
      patch: {
        ...snapshot,
        deletedWorkspaces: [],
        deletedProjects: [],
        deletedChats: [],
        deletedDocuments: [],
      },
    });
  },

  async apply(patch: Patch) {
    const { invoke } = await core();
    await invoke("db_apply", { patch });
  },

  async loadChunks(projectId: string) {
    const { invoke } = await core();
    return invoke<DocumentChunk[]>("db_chunks_load", { projectId });
  },

  async putChunks(documentId: string, chunks: DocumentChunk[]) {
    const { invoke } = await core();
    await invoke("db_chunks_put", { documentId, chunks });
  },

  async loadVectors(projectId: string, model: string) {
    const { invoke } = await core();
    return invoke<StoredVector[]>("db_vectors_load", { projectId, model });
  },

  async putVectors(vectors: StoredVector[]) {
    if (!vectors.length) return;
    const { invoke } = await core();
    await invoke("db_vectors_put", { vectors });
  },

  async dropVectors(ids: string[]) {
    if (!ids.length) return;
    const { invoke } = await core();
    await invoke("db_vectors_drop", { ids });
  },

  async loadAttachments(chatId: string) {
    const { invoke } = await core();
    return invoke<StoredAttachment[]>("db_attachments_load", { chatId });
  },

  async putAttachments(attachments: StoredAttachment[]) {
    if (!attachments.length) return;
    const { invoke } = await core();
    await invoke("db_attachments_put", { attachments });
  },
};
