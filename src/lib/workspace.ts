import {
  CHATS,
  DECISIONS,
  DOCUMENTS,
  MEMORY,
  MESSAGES,
  PROJECTS,
  WORKSPACES,
} from "./mock-data";
import type {
  Chat,
  Decision,
  Document,
  MemoryEntry,
  Message,
  Project,
  Workspace,
} from "./types";

/*
 * The workspace graph, as retrieval reads it.
 *
 * Reference resolution, the Context Composer and semantic search all need to
 * answer "what does this project currently hold?" — and all three used to
 * answer it by importing the seed arrays from `mock-data` directly. That was
 * harmless while nothing could change: the fixtures *were* the workspace.
 *
 * Once a chat can be renamed, deleted, or restored from SQLite, it stops being
 * harmless. A chat created this session would not be `@chat()`-referenceable, a
 * memory entry the user just accepted would never be injected, and a deleted
 * chat would keep answering searches — because the retrieval side was still
 * reading a frozen copy while the store moved on.
 *
 * So this module is the one seam between the two. The store publishes the live
 * graph here on every change; retrieval reads it through `workspace()` and
 * never learns whether it came from SQLite, the seed, or a test.
 *
 * The seed is the *default*, not a special case: a unit test that imports
 * `compose()` and asks about "Architecture" gets the fixtures, exactly as
 * before, without booting a store or a database.
 */

export interface WorkspaceGraph {
  workspaces: Workspace[];
  projects: Project[];
  chats: Chat[];
  messages: Message[];
  memory: MemoryEntry[];
  documents: Document[];
  decisions: Decision[];
}

const SEED: WorkspaceGraph = {
  workspaces: WORKSPACES,
  projects: PROJECTS,
  chats: CHATS,
  messages: MESSAGES,
  memory: MEMORY,
  documents: DOCUMENTS,
  decisions: DECISIONS,
};

let current: WorkspaceGraph = SEED;

/**
 * Bumped on every publish.
 *
 * Resolution is memoized — the composer prices every visible autocomplete
 * candidate on each keystroke, so resolving `@chat("Architecture")` from
 * scratch every time would be wasteful. The cache was safe only because the
 * seed could not change; now it keys on this counter instead, which is the
 * cheapest correct invalidation available: one integer compare per lookup, and
 * no way for a stale entry to survive a rename.
 */
let version = 0;

/** The graph retrieval should read right now. */
export function workspace(): WorkspaceGraph {
  return current;
}

/** Identity of the current graph, for callers that cache across calls. */
export function workspaceVersion(): number {
  return version;
}

/**
 * Hand retrieval a new graph.
 *
 * Called from one place — the store subscriber in `sync.ts` — so there is a
 * single answer to "when does retrieval see a change?", rather than one answer
 * per action that happens to remember to publish.
 */
export function publishWorkspace(next: WorkspaceGraph): void {
  current = next;
  version += 1;
}

/** Drop back to the fixtures. Tests that publish need a way back. */
export function resetWorkspace(): void {
  current = SEED;
  version += 1;
}
