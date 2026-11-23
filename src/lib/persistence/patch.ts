import { PATCH_TABLES, type Patch, type PatchTable, type Snapshot } from "./types";

/*
 * What applying a patch means, as a pure function.
 *
 * The SQLite store expresses these rules in SQL — `ON CONFLICT DO UPDATE`, a
 * foreign key cascade, `ORDER BY rowid`. The browser store has no SQL, so it
 * needs the same rules written out, and having them in one tested function is
 * what keeps the two stores from quietly disagreeing about, say, whether an
 * upsert moves a row to the end.
 */

/** A row that a patch can carry. Everything persisted is keyed by `id`. */
export interface Row {
  id: string;
}

export function applyPatch(snapshot: Snapshot, patch: Patch): Snapshot {
  const next: Snapshot = { ...snapshot };

  /*
   * Deletes first, matching the store: a batch that removes a chat and also
   * carries a stale row for one of its messages must not leave the message
   * behind.
   *
   * Workspaces before projects, then projects before chats, because each cascade
   * reaches messages through the next level. Doing it the other way round would
   * leave deleted descendants behind without their parent to identify them.
   */
  const orphanedProjects = new Set<string>();
  const orphanedChats = new Set<string>();

  if (patch.deletedWorkspaces.length) {
    const gone = new Set(patch.deletedWorkspaces);
    next.workspaces = next.workspaces.filter(
      (workspace) => !gone.has(workspace.id),
    );
    for (const project of next.projects) {
      if (gone.has(project.workspaceId)) orphanedProjects.add(project.id);
    }
    next.projects = next.projects.filter(
      (project) => !orphanedProjects.has(project.id),
    );
    for (const chat of next.chats) {
      if (orphanedProjects.has(chat.projectId)) orphanedChats.add(chat.id);
    }
    next.memory = next.memory.filter(
      (entry) => !orphanedProjects.has(entry.projectId),
    );
    next.decisions = next.decisions.filter(
      (decision) => !orphanedProjects.has(decision.projectId),
    );
    next.timeline = next.timeline.filter(
      (event) => !orphanedProjects.has(event.projectId),
    );
    next.documents = next.documents.filter(
      (document) => !orphanedProjects.has(document.projectId),
    );
  }

  if (patch.deletedProjects.length) {
    const gone = new Set(patch.deletedProjects);
    next.projects = next.projects.filter((project) => !gone.has(project.id));

    // The cascade, by hand. Two levels deep: chats hang off the project, and
    // messages hang off those chats.
    for (const chat of next.chats) {
      if (gone.has(chat.projectId)) orphanedChats.add(chat.id);
    }
    next.memory = next.memory.filter((entry) => !gone.has(entry.projectId));
    next.decisions = next.decisions.filter((d) => !gone.has(d.projectId));
    next.timeline = next.timeline.filter((event) => !gone.has(event.projectId));
    next.documents = next.documents.filter((doc) => !gone.has(doc.projectId));
  }

  if (patch.deletedChats.length || orphanedChats.size) {
    const gone = new Set([...patch.deletedChats, ...orphanedChats]);
    next.chats = next.chats.filter((chat) => !gone.has(chat.id));
    next.messages = next.messages.filter((message) => !gone.has(message.chatId));
  }

  // Not folded into the project cascade above: a document can also be deleted on
  // its own, which is the common case — a file uploaded by mistake.
  if (patch.deletedDocuments.length) {
    const gone = new Set(patch.deletedDocuments);
    next.documents = next.documents.filter((doc) => !gone.has(doc.id));
  }

  for (const table of PATCH_TABLES) upsertSlice(next, patch, table);

  /*
   * A caller normally removes cascaded rows before producing a patch, but this
   * final guard also prevents a stale descendant carried in the same batch from
   * being re-created by the upsert pass above.
   */
  const deletedWorkspaceIds = new Set(patch.deletedWorkspaces);
  const deletedProjectIds = new Set([
    ...patch.deletedProjects,
    ...orphanedProjects,
  ]);
  for (const project of next.projects) {
    if (deletedWorkspaceIds.has(project.workspaceId)) {
      deletedProjectIds.add(project.id);
    }
  }
  next.workspaces = next.workspaces.filter(
    (workspace) => !deletedWorkspaceIds.has(workspace.id),
  );
  next.projects = next.projects.filter(
    (project) => !deletedProjectIds.has(project.id),
  );

  for (const chat of next.chats) {
    if (deletedProjectIds.has(chat.projectId)) orphanedChats.add(chat.id);
  }
  const deletedChatIds = new Set([...patch.deletedChats, ...orphanedChats]);
  next.chats = next.chats.filter(
    (chat) =>
      !deletedChatIds.has(chat.id) && !deletedProjectIds.has(chat.projectId),
  );
  next.messages = next.messages.filter(
    (message) => !deletedChatIds.has(message.chatId),
  );
  next.memory = next.memory.filter(
    (entry) => !deletedProjectIds.has(entry.projectId),
  );
  next.decisions = next.decisions.filter(
    (decision) => !deletedProjectIds.has(decision.projectId),
  );
  next.timeline = next.timeline.filter(
    (event) => !deletedProjectIds.has(event.projectId),
  );
  const deletedDocumentIds = new Set(patch.deletedDocuments);
  next.documents = next.documents.filter(
    (document) =>
      !deletedDocumentIds.has(document.id) &&
      !deletedProjectIds.has(document.projectId),
  );

  return next;
}

/**
 * Fold one collection of `from` into `into`.
 *
 * Generic over the key rather than looping over a union inline: TypeScript
 * cannot narrow `Snapshot[PatchTable]` to a single element type, so a direct
 * `into[table] = f(into[table])` collapses into an intersection of every entity
 * at once. Naming the key as a type parameter keeps both sides on the same one.
 */
export function upsertSlice<K extends PatchTable>(
  into: Snapshot,
  from: Snapshot,
  table: K,
): void {
  const rows = from[table];
  if (!rows.length) return;
  into[table] = upsertRows(into[table], rows) as Snapshot[K];
}

/**
 * Replace rows that exist, append the ones that do not.
 *
 * In place, not remove-then-append: for messages the array order *is* the
 * transcript order, and the assistant placeholder is rewritten on every frame
 * of a stream. Appending on update would walk it to the end of the conversation
 * as it typed.
 */
export function upsertRows(
  existing: readonly Row[],
  rows: readonly Row[],
): Row[] {
  const incoming = new Map(rows.map((row) => [row.id, row]));
  const merged: Row[] = [];

  for (const row of existing) {
    const replacement = incoming.get(row.id);
    if (replacement) {
      merged.push(replacement);
      incoming.delete(row.id);
    } else {
      merged.push(row);
    }
  }

  // Whatever is left never existed, so it is new and belongs at the end.
  for (const row of incoming.values()) merged.push(row);

  return merged;
}
