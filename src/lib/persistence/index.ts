import { browserStore } from "./browser";
import { sqliteStore } from "./sqlite";
import type { Store } from "./types";

export type {
  Patch,
  Snapshot,
  Store,
  StoredAttachment,
  StoredVector,
} from "./types";
export { EMPTY_PATCH, PATCH_TABLES, isEmptyPatch } from "./types";
export { applyPatch } from "./patch";

/*
 * The single seam between the app and where its workspace is kept.
 *
 * Same arrangement as `adapter/`: one interface, two transports, and the choice
 * made once here from whether Tauri is present. Nothing above this file knows
 * whether a chat was saved to SQLite or to localStorage.
 */

/** Tauri injects this before any app code runs. */
function isDesktop(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

export const store: Store = isDesktop() ? sqliteStore : browserStore;

/** Where the workspace is kept, for anything that wants to say so plainly. */
export const STORE_STORAGE: Record<Store["kind"], string> = {
  sqlite: "um banco SQLite local",
  browser: "o localStorage deste navegador",
};
