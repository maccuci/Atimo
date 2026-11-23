import { EMPTY_PATCH, PATCH_TABLES, isEmptyPatch, store } from "./persistence";
import type { Patch, Snapshot } from "./persistence";
import { upsertSlice, type Row } from "./persistence/patch";
import { publishWorkspace } from "./workspace";
import { prepareEmbeddings } from "./embeddings";
import { forgetMissingProjects, reindexProject } from "./vectors";
import {
  CHATS,
  DECISIONS,
  DOCUMENTS,
  MEMORY,
  MESSAGES,
  PROJECTS,
  TIMELINE,
  WORKSPACES,
} from "./mock-data";
import { useStore } from "./store";
import { uid } from "./utils";
import type { Workspace } from "./types";

/*
 * Keeping the store, the database and the retrieval graph in agreement.
 *
 * The obvious way to persist a zustand store is to call `save()` at the end of
 * every action. It is also the way that rots: there are a dozen actions that
 * touch a chat today, `send()` alone mutates three collections, and the failure
 * mode of forgetting one is invisible — the app works perfectly until a reload.
 *
 * So nothing here is called from an action. One subscriber watches the store,
 * works out what changed by reference identity, and writes that. Adding an
 * action later persists correctly without knowing this file exists.
 *
 * Reference identity is enough because the reducers are already immutable: they
 * rebuild the array and copy only the rows they touch, so a row whose object
 * identity survived a transition provably did not change. That makes the diff
 * an O(rows) pass of pointer compares rather than a deep comparison of every
 * message in the workspace on every keystroke.
 */

/**
 * How long a change waits for company before being written.
 *
 * A streaming turn rewrites the assistant's message on every animation frame —
 * around sixty store transitions a second, all touching the same row. Batching
 * them turns that into two writes a second of one row each, and because a patch
 * carries the row's *current* value rather than a delta, coalescing loses
 * nothing at all.
 */
const FLUSH_DELAY_MS = 400;

/**
 * How long the vector index waits before catching up.
 *
 * Much longer than the write debounce, and for a different reason. Persisting is
 * cheap and urgent — a row not on disk is work at risk. Embedding is neither: it
 * is CPU-bound inference the user can hear on a laptop fan, and nothing is lost
 * by it being a few seconds behind. Re-embedding a message on every frame of a
 * streaming turn would be the single most expensive thing this app does, in
 * service of indexing text that is still being written.
 *
 * It also has to be *after* the write. Vectors carry a foreign key to their
 * project, so a first message in a brand-new project cannot be indexed until
 * that project row exists — which is why the scan is chained onto `flush()`
 * rather than merely delayed by longer than it.
 */
const REINDEX_DELAY_MS = 2_000;

/** The slices this module persists, and their key on both sides. */
const SLICES = PATCH_TABLES;

type Slice = (typeof SLICES)[number];

/** The store fields the diff reads, narrowed to what it needs. */
type Watched = Pick<Snapshot, Slice>;

export interface SyncHandle {
  /** Write anything still pending, now. */
  flush: () => Promise<void>;
  /**
   * Stop watching and drain the pending write.
   *
   * Async on purpose: a remount that loads from disk before this resolves is
   * how a finished turn gets replaced by the empty placeholder the first frame
   * of `send` already flushed.
   */
  stop: () => Promise<void>;
}

/**
 * Load the workspace, hand it to the app, then keep it saved.
 *
 * Returns once the store is hydrated, so the caller can render real data rather
 * than a frame of empty state followed by a swap.
 */
/**
 * The running subscriber, for the one caller that needs to force a write.
 *
 * Uploading a document is the case: its chunks are written by a direct call, and
 * they carry a foreign key to the document row that only this subscriber writes.
 * Everything else is happy to be written on the debounce.
 */
let active: SyncHandle | null = null;

/**
 * The in-flight `stop()` drain, kept after `active` is cleared so a remounting
 * `startSync` can still wait for the previous write to land.
 */
let stopping: Promise<void> = Promise.resolve();

/** Write anything pending, now. Resolves once it has actually landed. */
export async function flushWorkspace(): Promise<void> {
  await active?.flush();
}

export async function startSync(): Promise<SyncHandle> {
  // Strict Mode and HMR remount the App effect: the previous subscriber is
  // stopped and a new one starts. Drain that stop (and any flush it started
  // after clearing `active`) before reading the database, otherwise hydrate
  // can overwrite live memory with a snapshot one write behind.
  if (active) await active.stop();
  else await stopping;

  const restored = await load();
  const alreadyHydrated = useStore.getState().hydrated;

  // A remount mid-session must not throw away in-memory transcript that is
  // ahead of disk. First boot is the only time hydrate-from-load is correct.
  if (!alreadyHydrated) {
    useStore.getState().hydrate(restored ?? EMPTY_SNAPSHOT);
    if (restored) {
      /*
       * Browser snapshots from before workspaces became real state have no
       * parent rows. Hydration reconstructs those parents from the projects so
       * they remain visible; write them back once before the subscriber starts,
       * otherwise the first new workspace patch would apply to an old snapshot
       * and replace the reconstructed fixture rows.
       */
      const restoredIds = new Set(restored.workspaces.map((w) => w.id));
      const hydratedWorkspaces = useStore.getState().workspaces;
      if (hydratedWorkspaces.some((w) => !restoredIds.has(w.id))) {
        try {
          await store.apply({
            ...EMPTY_PATCH,
            workspaces: hydratedWorkspaces,
          });
        } catch (error) {
          console.error("could not migrate workspace metadata", error);
        }
      }
    }
    // Nothing has ever been written here, so there is no workspace to open — only
    // a question about what one should contain. `initializeWorkspace` answers it.
    if (!restored) useStore.getState().beginOnboarding();
  }

  let previous = watched(useStore.getState());
  publish(previous);

  /*
   * The embedding model, warmed while the user is still reading the screen.
   *
   * Deliberately not awaited: on a machine that has never run this build it is a
   * ~1.1GB download, and blocking the app on it would trade a working
   * lexical-only search for a spinner. When it lands, the open project is
   * indexed and every reader starts fusing in the semantic half on its next
   * pass — see `subscribeEmbeddings`.
   */
  void prepareEmbeddings().then(() => {
    void reindexProject(useStore.getState().projectId);
  });

  let pending: Patch = { ...EMPTY_PATCH };
  let timer: ReturnType<typeof setTimeout> | null = null;
  /** Set while a write is in flight, so patches never overtake each other. */
  let writing: Promise<void> = Promise.resolve();

  const flush = (): Promise<void> => {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
    if (isEmptyPatch(pending)) return writing;

    const batch = pending;
    pending = { ...EMPTY_PATCH };

    // Chained rather than concurrent: two patches touching the same row must
    // land in the order they were produced, or a stale value wins.
    writing = writing
      .then(() => store.apply(batch))
      .catch((error) => {
        // A failed write must not take the app down with it — the workspace is
        // still correct in memory, and the next patch will carry these rows
        // again if they change. Losing the log entry would be worse.
        console.error("could not save the workspace", error);
      });

    return writing;
  };

  /** Projects whose text has moved since the index last caught up. */
  const behind = new Set<string>();
  let reindexTimer: ReturnType<typeof setTimeout> | null = null;

  const scheduleReindex = (projects: Iterable<string>) => {
    for (const id of projects) behind.add(id);
    if (!behind.size || reindexTimer !== null) return;

    reindexTimer = setTimeout(() => {
      reindexTimer = null;
      const catching = [...behind];
      behind.clear();
      // Chained onto the write, not merely delayed past it: a vector carries a
      // foreign key to its project, and a first message in a brand-new project
      // has nothing to hang off until that row has landed.
      void flush().then(() =>
        Promise.all(catching.map((id) => reindexProject(id))),
      );
    }, REINDEX_DELAY_MS);
  };

  const unsubscribe = useStore.subscribe((state) => {
    const next = watched(state);
    const changes = diff(previous, next);
    previous = next;
    if (!changes) return;

    // Retrieval reads the graph synchronously on the next keystroke, so it is
    // published immediately — only the database write is allowed to wait.
    publish(next);
    merge(pending, changes);

    // The index is derived state, so it is maintained here rather than by each
    // action remembering to — the same argument this whole module makes about
    // persistence, and the same failure mode if it were not: a conversation that
    // is simply never found, which nobody reports because nothing looks broken.
    //
    // Worked out by difference rather than from the patch's delete lists,
    // because a project can leave two ways: named, or cascaded away with its
    // workspace — and `diff` deliberately does not list the second, since the
    // database cascade already covers it. Reproducing that reasoning here is
    // exactly how the two would drift.
    forgetMissingProjects(next.projects.map((project) => project.id));
    scheduleReindex(touchedProjects(changes, next));

    // The delay is there for one reason: a streaming turn rewrites the same
    // message row sixty times a second. Everything else a user does is
    // deliberate and rare, so it should not inherit that delay — a rename or a
    // delete followed straight away by quitting the app must already be saved.
    if (deliberate(changes)) {
      void flush();
    } else if (timer === null) {
      timer = setTimeout(() => void flush(), FLUSH_DELAY_MS);
    }
  });

  /*
   * Last chance to write, for the case the debounce is still holding something.
   *
   * `pagehide` covers a reload or a navigation; `visibilitychange` covers the
   * window being hidden or minimised, which on the desktop is the signal that
   * arrives before a quit. Neither is guaranteed on a hard kill, which is the
   * other half of why deliberate changes are written straight away rather than
   * relying on being flushed later.
   */
  const onHide = () => void flush();
  const onVisibility = () => {
    if (document.visibilityState === "hidden") void flush();
  };
  window.addEventListener("pagehide", onHide);
  document.addEventListener("visibilitychange", onVisibility);

  const handle: SyncHandle = {
    flush,
    stop: () => {
      unsubscribe();
      if (reindexTimer !== null) clearTimeout(reindexTimer);
      window.removeEventListener("pagehide", onHide);
      document.removeEventListener("visibilitychange", onVisibility);
      if (active === handle) active = null;
      stopping = flush();
      return stopping;
    },
  };

  active = handle;
  return handle;
}

/**
 * Whether a patch holds anything a user did on purpose.
 *
 * Message rows are the only thing a stream touches, so a patch made of nothing
 * but messages is mid-turn output and can wait. Anything else — a new chat, a
 * rename, a delete, an accepted memory entry — is an action, and actions are
 * written at once.
 */
export function deliberate(patch: Patch): boolean {
  if (
    patch.deletedWorkspaces.length ||
    patch.deletedProjects.length ||
    patch.deletedChats.length
  ) {
    return true;
  }
  return SLICES.some(
    (slice) => slice !== "messages" && patch[slice].length > 0,
  );
}

/**
 * The projects whose retrievable text this patch moved.
 *
 * Only the collections the vector corpus is built from — a renamed project or a
 * timeline event changes nothing anyone can search for, and reindexing on those
 * would put a forward pass behind every rename.
 *
 * Messages name a chat rather than a project, so they are resolved through the
 * chats the store currently holds. A message whose chat is gone resolves to
 * nothing, which is correct: the cascade has already taken its vectors.
 */
function touchedProjects(patch: Patch, state: Watched): Set<string> {
  const projects = new Set<string>();

  for (const rows of [patch.memory, patch.decisions, patch.documents]) {
    for (const row of rows) projects.add(row.projectId);
  }
  for (const chat of patch.chats) projects.add(chat.projectId);

  if (patch.messages.length || patch.deletedChats.length) {
    const owning = new Map(state.chats.map((chat) => [chat.id, chat.projectId]));
    for (const message of patch.messages) {
      const project = owning.get(message.chatId);
      if (project) projects.add(project);
    }
    // A deleted chat's messages are gone from the store, so its project cannot
    // be resolved the same way — and its passages have to be dropped by someone.
    // The open project is the only one a user can delete a chat from.
    for (const _ of patch.deletedChats) {
      const open = useStore.getState().projectId;
      if (open) projects.add(open);
    }
  }

  // A document deleted on its own leaves chunk vectors that no cascade reaches:
  // the project is still there, so nothing in SQL knows those rows are orphans.
  if (patch.deletedDocuments.length) {
    const open = useStore.getState().projectId;
    if (open) projects.add(open);
  }

  return projects;
}

/* ---------------------------------------------------------------------- */

/**
 * The stored workspace, or null when this install has never written one.
 *
 * Null is a real answer here rather than a reason to substitute something: the
 * fixtures used to be written silently on first run, which meant a new user
 * opened the app onto four projects and a dozen conversations that were not
 * theirs, containing assistant replies no model had produced. Being unable to
 * tell demo content from your own is worse than having none, so the choice is
 * now asked rather than made.
 *
 * A failure to read is deliberately indistinguishable from an empty database. It
 * is not a good outcome either way, and the alternative — starting anyway on a
 * workspace nothing can save — quietly loses whatever the user does next.
 */
async function load(): Promise<Snapshot | null> {
  try {
    return await store.load();
  } catch (error) {
    console.error("could not load the workspace", error);
    return null;
  }
}

/** What the store holds before setup has been answered. */
const EMPTY_SNAPSHOT: Snapshot = {
  workspaces: [],
  projects: [],
  chats: [],
  messages: [],
  memory: [],
  decisions: [],
  timeline: [],
  documents: [],
};

/**
 * The demo workspace: the fixtures, written only when someone asks for them.
 *
 * They are first-run *content*, not runtime state, which is why this is the only
 * place they reach the store and why nothing reads them again afterwards.
 */
const DEMO: Snapshot = {
  workspaces: WORKSPACES,
  projects: PROJECTS,
  chats: CHATS,
  messages: MESSAGES,
  memory: MEMORY,
  decisions: DECISIONS,
  timeline: TIMELINE,
  documents: DOCUMENTS,
};

/**
 * Write a workspace this install has never had, then open the app onto it.
 *
 * Both stores treat `seed` as the marker that the workspace exists — SQLite
 * writes a row in `meta`, and the browser store refuses to apply a patch to
 * something it has never written — so this has to run, and has to finish, before
 * the subscriber's first patch is worth anything.
 *
 * Hydrating after the write rather than before is what makes a failure safe to
 * report: if the seed throws, the caller learns before the user has typed
 * anything into a workspace that cannot be saved.
 *
 * Separate from `initializeWorkspace` because there are two ways to arrive at a
 * first workspace and only one of them is a choice between fixtures: restoring a
 * backup onto a fresh install lands here too, and it must write the marker for
 * the same reason. Keeping the rule in one function is what stops the second
 * path from being the one that forgets it.
 */
export async function seedWorkspace(snapshot: Snapshot): Promise<void> {
  await store.seed(snapshot);

  const state = useStore.getState();
  state.hydrate(snapshot);
  state.completeOnboarding();
}

/** Write the workspace a first run decided on, then open the app onto it. */
export async function initializeWorkspace(
  choice: "demo" | "clean",
  projectName?: string,
): Promise<void> {
  await seedWorkspace(choice === "demo" ? DEMO : cleanSnapshot(projectName));
}

/**
 * A workspace with one empty project in it.
 *
 * One rather than none, because every path that sends a message needs a project
 * to hang the chat off, and a first run that answers the first prompt with a
 * modal asking for a project name has spent the user's opening gesture on
 * paperwork. Naming it is the whole of setup, so the name comes from them.
 */
function cleanSnapshot(projectName?: string): Snapshot {
  const name = projectName?.trim() || "Meu projeto";
  const workspace: Workspace = {
    id: uid("ws"),
    name: "Meu workspace",
  };
  return {
    ...EMPTY_SNAPSHOT,
    workspaces: [workspace],
    projects: [
      {
        id: uid("p"),
        workspaceId: workspace.id,
        name,
        description: "",
        instructions: "",
        memoryTokens: 0,
      },
    ],
  };
}

function watched(state: Watched): Watched {
  return {
    workspaces: state.workspaces,
    projects: state.projects,
    chats: state.chats,
    messages: state.messages,
    memory: state.memory,
    decisions: state.decisions,
    timeline: state.timeline,
    documents: state.documents,
  };
}

/** Hand retrieval the current graph. */
function publish(state: Watched) {
  publishWorkspace({
    workspaces: state.workspaces,
    projects: state.projects,
    chats: state.chats,
    messages: state.messages,
    memory: state.memory,
    decisions: state.decisions,
    documents: state.documents,
  });
}

/* ---------------------------------------------------------------------- */
/* The diff                                                                */
/* ---------------------------------------------------------------------- */

/**
 * What changed between two store states, or null when nothing did.
 *
 * Only owning entities report deletions. Messages leave with their chat, a
 * project takes its chats, memory, decisions and timeline, and a workspace takes
 * its projects — in every case the store's cascade is what removes the children,
 * so listing them here would mean writing rows the same batch is about to delete.
 *
 * Within a project, memory and the decision log stay append-only by design: a
 * project's record of why it made a choice is not something a later turn should
 * be able to quietly retract. Deleting the project is the one thing that can,
 * because at that point there is nothing left for the record to be about.
 */
export function diff(before: Watched, after: Watched): Patch | null {
  let changed = false;
  const patch: Patch = { ...EMPTY_PATCH };

  for (const slice of SLICES) {
    if (collectChanged(patch, before, after, slice)) changed = true;
  }

  /** Chats the project cascade will take, so nothing else has to name them. */
  const cascaded = new Set<string>();
  /** Documents it will take too, for the same reason. */
  const documentsOfDeletedProjects = new Set<string>();
  /** Projects the workspace cascade will take. */
  const cascadedProjects = new Set<string>();

  const deletedWorkspaces = removedIds(before.workspaces, after.workspaces);
  if (deletedWorkspaces.length) {
    patch.deletedWorkspaces = deletedWorkspaces;
    changed = true;

    const gone = new Set(deletedWorkspaces);
    for (const project of before.projects) {
      if (gone.has(project.workspaceId)) cascadedProjects.add(project.id);
    }
    for (const chat of before.chats) {
      if (cascadedProjects.has(chat.projectId)) cascaded.add(chat.id);
    }
    for (const doc of before.documents) {
      if (cascadedProjects.has(doc.projectId)) {
        documentsOfDeletedProjects.add(doc.id);
      }
    }

    patch.projects = patch.projects.filter((p) => !gone.has(p.workspaceId));
    patch.chats = patch.chats.filter((c) => !cascadedProjects.has(c.projectId));
    patch.messages = patch.messages.filter((m) => !cascaded.has(m.chatId));
    patch.memory = patch.memory.filter((m) => !cascadedProjects.has(m.projectId));
    patch.decisions = patch.decisions.filter((d) => !cascadedProjects.has(d.projectId));
    patch.timeline = patch.timeline.filter((t) => !cascadedProjects.has(t.projectId));
    patch.documents = patch.documents.filter(
      (d) => !cascadedProjects.has(d.projectId),
    );
  }

  const deletedProjects = removedIds(before.projects, after.projects).filter(
    (id) => !cascadedProjects.has(id),
  );

  if (deletedProjects.length) {
    patch.deletedProjects = deletedProjects;
    changed = true;

    const gone = new Set(deletedProjects);
    for (const chat of before.chats) {
      if (gone.has(chat.projectId)) cascaded.add(chat.id);
    }
    for (const doc of before.documents) {
      if (gone.has(doc.projectId)) documentsOfDeletedProjects.add(doc.id);
    }

    // Everything the project owned goes with it, so nothing belonging to it may
    // ride along as an upsert — a row written after the parent is deleted either
    // violates the foreign key or resurrects what the batch just removed.
    patch.chats = patch.chats.filter((c) => !gone.has(c.projectId));
    patch.messages = patch.messages.filter((m) => !cascaded.has(m.chatId));
    patch.memory = patch.memory.filter((m) => !gone.has(m.projectId));
    patch.decisions = patch.decisions.filter((d) => !gone.has(d.projectId));
    patch.timeline = patch.timeline.filter((t) => !gone.has(t.projectId));
    patch.documents = patch.documents.filter((d) => !gone.has(d.projectId));
  }

  // A cascaded chat is not a deletion in its own right: the row goes either way,
  // and naming it here would have one batch describe the same delete twice.
  const deletedChats = removedIds(before.chats, after.chats).filter(
    (id) => !cascaded.has(id),
  );
  if (deletedChats.length) {
    patch.deletedChats = deletedChats;
    changed = true;

    // A message whose chat is gone must not be written back. The store deletes
    // both in one transition, so this only guards the case where an earlier
    // frame of the same batch already queued the message — but that case is
    // exactly what a streaming turn interrupted by a delete produces.
    const gone = new Set(deletedChats);
    patch.messages = patch.messages.filter((m) => !gone.has(m.chatId));
  }

  /*
   * Documents, the only deletable entity that is not an owner.
   *
   * The only one that is not an owner, and the only one whose deletion frees
   * anything substantial — its chunks go with it through a foreign key. Same
   * exclusion as a cascaded chat: one taken by its project is already covered.
   */
  const deletedDocuments = removedIds(before.documents, after.documents).filter(
    (id) => !documentsOfDeletedProjects.has(id),
  );
  if (deletedDocuments.length) {
    patch.deletedDocuments = deletedDocuments;
    changed = true;
  }

  return changed ? patch : null;
}

/**
 * Put one collection's changed rows on the patch. True when it found any.
 *
 * Generic over the key for the same reason `upsertSlice` is: TypeScript cannot
 * narrow `Patch[Slice]` to a single element type, and a plain `patch[slice] =`
 * inside the loop collapses into an intersection of every entity at once.
 */
function collectChanged<K extends Slice>(
  patch: Patch,
  before: Watched,
  after: Watched,
  slice: K,
): boolean {
  // The common case by far: the reducer did not touch this collection, so one
  // pointer compare settles it.
  if (before[slice] === after[slice]) return false;

  // Identity, not equality: the reducers copy a row only when they change it,
  // so a surviving pointer is proof the row is untouched.
  const known = new Set<Row>(before[slice]);
  const rows = after[slice].filter((row) => !known.has(row));
  if (!rows.length) return false;

  patch[slice] = rows as Patch[K];
  return true;
}

/** Ids present before and absent after. By id, since the row object is gone. */
function removedIds<T extends { id: string }>(
  before: readonly T[],
  after: readonly T[],
): string[] {
  if (before === after) return [];
  const present = new Set(after.map((row) => row.id));
  return before.filter((row) => !present.has(row.id)).map((row) => row.id);
}

/** Fold a patch into the pending one, letting later rows win. */
export function merge(into: Patch, from: Patch): Patch {
  // Same rule the store applies: replace a queued row rather than queueing it
  // twice, so a turn that streams for a minute does not accumulate a thousand
  // copies of the same message.
  for (const slice of SLICES) upsertSlice(into, from, slice);

  if (from.deletedWorkspaces.length) {
    const deleted = new Set([
      ...into.deletedWorkspaces,
      ...from.deletedWorkspaces,
    ]);
    into.deletedWorkspaces = [...deleted];

    const doomedProjects = new Set(
      into.projects
        .filter((project) => deleted.has(project.workspaceId))
        .map((project) => project.id),
    );
    const doomedChats = new Set(
      into.chats
        .filter((chat) => doomedProjects.has(chat.projectId))
        .map((chat) => chat.id),
    );
    const doomedDocuments = new Set(
      into.documents
        .filter((document) => doomedProjects.has(document.projectId))
        .map((document) => document.id),
    );
    into.workspaces = into.workspaces.filter(
      (workspace) => !deleted.has(workspace.id),
    );
    into.projects = into.projects.filter(
      (project) => !doomedProjects.has(project.id),
    );
    into.chats = into.chats.filter((chat) => !doomedProjects.has(chat.projectId));
    into.messages = into.messages.filter((message) => !doomedChats.has(message.chatId));
    into.memory = into.memory.filter(
      (entry) => !doomedProjects.has(entry.projectId),
    );
    into.decisions = into.decisions.filter(
      (decision) => !doomedProjects.has(decision.projectId),
    );
    into.timeline = into.timeline.filter(
      (event) => !doomedProjects.has(event.projectId),
    );
    into.documents = into.documents.filter(
      (document) => !doomedProjects.has(document.projectId),
    );
    into.deletedProjects = into.deletedProjects.filter(
      (id) => !doomedProjects.has(id),
    );
    into.deletedChats = into.deletedChats.filter((id) => !doomedChats.has(id));
    into.deletedDocuments = into.deletedDocuments.filter(
      (id) => !doomedDocuments.has(id),
    );
  }

  if (from.deletedProjects.length) {
    const deleted = new Set([...into.deletedProjects, ...from.deletedProjects]);
    into.deletedProjects = [...deleted];

    /*
     * A project deleted after its rows were queued. Everything queued for it is
     * dropped, including rows queued for its chats — the cascade will remove
     * them, and writing them first would either trip the foreign key or bring
     * back what the same transaction is deleting.
     *
     * The queued chats are the only place the chat→project mapping still exists
     * once the store has moved on, which is why the chat filter runs before the
     * ids are needed for the message filter.
     */
    const doomedChats = new Set(
      into.chats.filter((c) => deleted.has(c.projectId)).map((c) => c.id),
    );
    const doomedDocuments = new Set(
      into.documents.filter((d) => deleted.has(d.projectId)).map((d) => d.id),
    );
    into.projects = into.projects.filter((p) => !deleted.has(p.id));
    into.chats = into.chats.filter((c) => !deleted.has(c.projectId));
    into.messages = into.messages.filter((m) => !doomedChats.has(m.chatId));
    into.memory = into.memory.filter((m) => !deleted.has(m.projectId));
    into.decisions = into.decisions.filter((d) => !deleted.has(d.projectId));
    into.timeline = into.timeline.filter((t) => !deleted.has(t.projectId));
    into.documents = into.documents.filter((d) => !deleted.has(d.projectId));
    // Documents the project cascade now covers: naming them again would have one
    // batch describe the same delete twice.
    into.deletedDocuments = into.deletedDocuments.filter(
      (id) => !doomedDocuments.has(id),
    );
    // A chat listed for deletion whose project is now going too: the cascade
    // covers it, so the explicit delete is redundant.
    into.deletedChats = into.deletedChats.filter((id) => !doomedChats.has(id));
  }

  if (from.deletedChats.length) {
    const deleted = new Set([...into.deletedChats, ...from.deletedChats]);
    into.deletedChats = [...deleted];
    // A chat deleted after its rows were queued: drop them, and drop the chat
    // row itself, so the batch does not re-create what it is about to remove.
    into.chats = into.chats.filter((chat) => !deleted.has(chat.id));
    into.messages = into.messages.filter((m) => !deleted.has(m.chatId));
  }

  if (from.deletedDocuments.length) {
    const deleted = new Set([
      ...into.deletedDocuments,
      ...from.deletedDocuments,
    ]);
    into.deletedDocuments = [...deleted];
    // A document deleted after its row was queued: drop the upsert, or the batch
    // re-creates what it is about to remove.
    into.documents = into.documents.filter((doc) => !deleted.has(doc.id));
  }

  return into;
}
