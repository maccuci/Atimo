import {
  EXPORT_FORMAT,
  EXPORT_FORMAT_VERSION,
  type ExportDocument,
} from "./export";
import type { Snapshot } from "./persistence/types";
import type { Workspace } from "./types";

/*
 * Putting a workspace back.
 *
 * `export.ts` exists because a product that asks for months of project knowledge
 * has to answer "what if I lose it?". It only answers half of it: until this
 * module there was a way to write the file and no way to read one, which makes
 * the backup a thing you find out is useless at the moment you need it.
 *
 * Three decisions carry the feature.
 *
 * **Ids are kept, never remapped.** The file is a graph — a chat carries its
 * project, a message its chat, a decision what it supersedes, a fork the message
 * it branched at — and rewriting the ids means rewriting every one of those
 * edges, silently wrongly if one is missed. Keeping them makes the import an
 * upsert, which buys the two properties that matter: importing the same file
 * twice changes nothing the second time, and restoring a backup over a workspace
 * that drifted puts the file's version back rather than a duplicate beside it.
 *
 * **It adds; it never deletes.** A restore that wiped first would be the one
 * operation in the app that can destroy a workspace, triggered by picking the
 * wrong file. So a project in the workspace and not in the file survives the
 * import. The cost is that restoring an old backup does not undo work done
 * since — which is recoverable — instead of the reverse, which is not.
 *
 * **Validation covers exactly the foreign keys SQLite enforces, and nothing
 * else.** A chat whose project is missing from the file cannot be written at all
 * — `db_apply` would reject the whole transaction on the constraint, and the
 * user would get "FOREIGN KEY constraint failed" for what is really "this file
 * is incomplete". Soft links (`forkedFrom`, `supersedes`, `sourceChatId`) are
 * deliberately *not* checked: a single-project export legitimately points at
 * chats outside itself, and refusing that would make project exports unusable
 * for the case they exist for.
 *
 * Everything here is pure. Reading the bytes is `import-file.ts`; writing them
 * is `sync.ts`, which already owns the seed marker and the store.
 */

/** A file we will not import, with the reason in the user's terms. */
export class ImportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ImportError";
  }
}

/**
 * The collections a file carries, each with the row it hangs off.
 *
 * Mirrors `TABLES` in `src-tauri/src/db.rs`, in the same dependency order, for
 * the same reason that file generates its DDL from one list: a collection given
 * a parent in one place and not the other is a drift nobody notices until an
 * import fails against a constraint this side thought it had checked.
 *
 * `chunks` and `attachments` are here and not in `Snapshot` — document text and
 * attachment bytes travel in the file but not in the workspace snapshot, so each
 * is written through its own call.
 */
const COLLECTIONS = [
  { key: "workspaces", parent: null },
  { key: "projects", parent: { field: "workspaceId", of: "workspaces" } },
  { key: "chats", parent: { field: "projectId", of: "projects" } },
  { key: "messages", parent: { field: "chatId", of: "chats" } },
  { key: "memory", parent: { field: "projectId", of: "projects" } },
  { key: "decisions", parent: { field: "projectId", of: "projects" } },
  { key: "timeline", parent: { field: "projectId", of: "projects" } },
  { key: "documents", parent: { field: "projectId", of: "projects" } },
  { key: "chunks", parent: { field: "documentId", of: "documents" } },
  { key: "attachments", parent: { field: "messageId", of: "messages" } },
] as const;

/** The array-valued fields of an export document. */
type Collection = (typeof COLLECTIONS)[number]["key"];

/** How a collection is named when a message has to talk about it. */
const NOUN: Record<Collection, [singular: string, plural: string]> = {
  workspaces: ["workspace", "workspaces"],
  projects: ["projeto", "projetos"],
  chats: ["chat", "chats"],
  messages: ["mensagem", "mensagens"],
  memory: ["item de memória", "itens de memória"],
  decisions: ["decisão", "decisões"],
  timeline: ["evento", "eventos"],
  documents: ["documento", "documentos"],
  chunks: ["trecho de documento", "trechos de documento"],
  attachments: ["arquivo anexado", "arquivos anexados"],
};

export function count(n: number, of: Collection): string {
  const [singular, plural] = NOUN[of];
  return `${n} ${n === 1 ? singular : plural}`;
}

/* ---------------------------------------------------------------------- */
/* Reading the file                                                        */
/* ---------------------------------------------------------------------- */

/** What a file input should offer. Only the restorable half of an export. */
export const IMPORT_ACCEPT = ".json,application/json";

/**
 * A ceiling far above any real workspace, and far below a hang.
 *
 * `JSON.parse` on the main thread is the whole reason for it: a file this size
 * is already several years of transcripts, and anything much larger is a wrong
 * file whose failure would otherwise be an unresponsive window rather than a
 * sentence.
 */
export const MAX_IMPORT_BYTES = 64 * 1024 * 1024;

/**
 * A picked file, validated.
 *
 * There is no `import-file.ts` to match `export-file.ts` because there is
 * nothing platform-specific to put in it. Writing needed a seam — the desktop
 * build has a downloads folder and a file manager, the browser has neither —
 * but reading is a `<input type="file">` and `file.text()`, which behave the
 * same in the Tauri webview as they do in a browser. The composer's clip button
 * already relies on that.
 */
export async function readImportFile(file: File): Promise<ExportDocument> {
  if (file.size > MAX_IMPORT_BYTES) {
    throw new ImportError(
      `${file.name} tem ${Math.round(file.size / 1024 / 1024)} MB — maior que ` +
        `qualquer workspace que o Atimo grava, então provavelmente não é uma exportação.`,
    );
  }
  return parseImport(await file.text());
}

/**
 * Validate a file's text, or refuse it by name.
 *
 * Returns the same `ExportDocument` the writer produced, so the round trip is
 * checked by the compiler rather than by two structures kept in step by hand.
 */
export function parseImport(text: string): ExportDocument {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new ImportError(
      "Este arquivo não é JSON. A exportação em Markdown é para leitura, não " +
        "para restaurar — o arquivo a importar é o .json.",
    );
  }

  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new ImportError("Este arquivo não contém uma exportação do Atimo.");
  }

  const doc = raw as Record<string, unknown>;

  // Backups made before the rename to Atimo carry the old format name.
  if (doc.format !== EXPORT_FORMAT && doc.format !== "grapheno.workspace") {
    throw new ImportError(
      typeof doc.format === "string"
        ? `Este é um arquivo "${doc.format}", não uma exportação do Atimo.`
        : "Este arquivo não contém uma exportação do Atimo.",
    );
  }

  const version = typeof doc.version === "number" ? doc.version : 0;
  if (version > EXPORT_FORMAT_VERSION) {
    // Refused rather than attempted. A newer file may carry rows in shapes this
    // build would write back to the database half-understood, and a workspace
    // corrupted by a restore is the one outcome worse than a failed restore.
    throw new ImportError(
      `Este arquivo usa o formato de exportação ${version}, e esta versão do ` +
        `Atimo lê até o ${EXPORT_FORMAT_VERSION}. Atualize o app e tente de novo.`,
    );
  }

  const collections = readCollections(doc);
  reconstructWorkspaces(collections);
  checkParents(collections);

  return {
    format: EXPORT_FORMAT,
    version,
    exportedAt: typeof doc.exportedAt === "string" ? doc.exportedAt : "",
    app: typeof doc.app === "string" ? doc.app : "uma versão desconhecida",
    scope: readScope(doc.scope),
    label: typeof doc.label === "string" && doc.label.trim() ? doc.label : "workspace",
    ...collections,
  } as ExportDocument;
}

/** The row arrays, defaulted and checked for identity. */
type Collections = { [K in Collection]: { id: string }[] };

/**
 * Every collection as an array of rows that at least have an id.
 *
 * A missing collection reads as empty — a file written by an older shape is
 * still a file worth restoring, and this is the same courtesy the browser store
 * extends to an older snapshot. A collection that is present and not an array,
 * or a row without an id, is refused instead: the first means the file is not
 * what it claims to be, and the second is a row nothing can ever address again.
 */
function readCollections(doc: Record<string, unknown>): Collections {
  const out = {} as Collections;

  for (const { key } of COLLECTIONS) {
    const value = doc[key];
    if (value === undefined || value === null) {
      out[key] = [];
      continue;
    }
    if (!Array.isArray(value)) {
      throw new ImportError(
        `Este arquivo está corrompido: "${key}" não é uma lista de registros.`,
      );
    }

    const rows: { id: string }[] = [];
    for (const row of value) {
      if (!row || typeof row !== "object" || typeof row.id !== "string" || !row.id) {
        throw new ImportError(
          `Este arquivo está corrompido: um dos registros de ${NOUN[key][1]} não tem id.`,
        );
      }
      rows.push(row as { id: string });
    }
    out[key] = rows;
  }

  return out;
}

/**
 * Invent the workspace rows a file did not carry.
 *
 * The one parent that may be reconstructed rather than refused, because it is
 * the one that holds no content of its own: a workspace is an id and a name, so
 * rebuilding it guesses a label and loses nothing. Every other missing parent
 * means rows are actually absent from the file, and inventing an empty project
 * to hang orphaned chats off would be inventing the thing the user came to
 * restore.
 *
 * `store.ts` does the same for a snapshot read back from before workspaces were
 * persisted, under the same name — see `withWorkspaceDefaults`.
 */
function reconstructWorkspaces(collections: Collections): void {
  const known = new Set(collections.workspaces.map((row) => row.id));
  const missing = new Map<string, Workspace>();

  for (const project of collections.projects as { id: string; workspaceId?: unknown }[]) {
    const id = project.workspaceId;
    if (typeof id !== "string" || !id || known.has(id) || missing.has(id)) continue;
    missing.set(id, { id, name: "Workspace importado" });
  }

  if (missing.size) collections.workspaces.push(...missing.values());
}

/**
 * Refuse a file whose rows point at parents it does not contain.
 *
 * Named in the message, and counted, because "this file is incomplete" is only
 * actionable if it says what is missing from it — an export truncated mid-write
 * and an export of a project whose workspace row was hand-deleted are the same
 * error to SQLite and very different problems to the person holding the file.
 */
function checkParents(collections: Collections): void {
  for (const { key, parent } of COLLECTIONS) {
    if (!parent) continue;

    const present = new Set(collections[parent.of].map((row) => row.id));
    const orphans = (collections[key] as Record<string, unknown>[]).filter(
      (row) => {
        const owner = row[parent.field];
        return typeof owner !== "string" || !present.has(owner);
      },
    );

    if (orphans.length) {
      throw new ImportError(
        `Este arquivo está incompleto: ${count(orphans.length, key)} ` +
          `${orphans.length === 1 ? "pertence" : "pertencem"} a ` +
          `${parent.of === "messages" ? "uma" : "um"} ${NOUN[parent.of][0]} que o arquivo não contém.`,
      );
    }
  }
}

function readScope(value: unknown): ExportDocument["scope"] {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const scope = value as { kind?: unknown; projectId?: unknown };
    if (scope.kind === "project" && typeof scope.projectId === "string") {
      return { kind: "project", projectId: scope.projectId };
    }
  }
  return { kind: "workspace" };
}

/* ---------------------------------------------------------------------- */
/* Saying what will happen                                                 */
/* ---------------------------------------------------------------------- */

/**
 * What importing this file would do, before it does it.
 *
 * The confirm step needs real numbers rather than "Import?" — a restore is the
 * one gesture where the user is holding a file they may not have opened in
 * months, and "4 projects, 2 of which replace ones already here" is the
 * difference between confirming and going to find the right file.
 */
export interface ImportPlan {
  doc: ExportDocument;
  /** What the file calls itself. */
  label: string;
  /** ISO 8601, as written. Empty when the file did not say. */
  exportedAt: string;
  /** The build that wrote it. */
  app: string;
  scope: ExportDocument["scope"];
  /** Rows arriving, per collection. */
  totals: Record<Collection, number>;
  /**
   * Projects in the file that this workspace already has, by id.
   *
   * The unit a user thinks in, and the only place the import overwrites rather
   * than adds — so it is the one number the confirm step has to lead with.
   */
  replacing: number;
  /** True when the file carries nothing to write. */
  empty: boolean;
}

export function planImport(
  doc: ExportDocument,
  current: Pick<Snapshot, "projects">,
): ImportPlan {
  const totals = {} as Record<Collection, number>;
  for (const { key } of COLLECTIONS) totals[key] = doc[key]?.length ?? 0;

  const here = new Set(current.projects.map((project) => project.id));

  return {
    doc,
    label: doc.label,
    exportedAt: doc.exportedAt,
    app: doc.app,
    scope: doc.scope,
    totals,
    replacing: doc.projects.filter((project) => here.has(project.id)).length,
    // Workspaces alone are not content: a file holding one empty workspace and
    // nothing else would import "successfully" and change nothing visible.
    empty: doc.projects.length === 0,
  };
}

/**
 * What an import could not finish, once everything else has landed.
 *
 * Not an error, and not silence. Document text is written after the rows it
 * hangs off, so a failure there leaves a restore that is complete except for
 * some files' contents — and that is precisely the state a backup must not keep
 * to itself, because a document with no text resolves to nothing in a prompt
 * rather than to a complaint.
 */
export interface ImportOutcome {
  /** Documents whose rows arrived but whose text could not be written. */
  documentsWithoutText: number;
  /**
   * Attachments whose messages arrived but whose bytes could not be written.
   *
   * Reported for the same reason and with the same shape: a transcript that
   * names a screenshot it cannot show is a restore that looks complete and is
   * not, and the user is the only one who can decide whether that matters
   * enough to try the file again.
   */
  attachmentsWithoutBytes: number;
}

/** The snapshot slices an import writes. Chunks and bytes travel separately. */
export function importedSnapshot(doc: ExportDocument): Snapshot {
  return {
    workspaces: doc.workspaces,
    projects: doc.projects,
    chats: doc.chats,
    messages: doc.messages,
    memory: doc.memory,
    decisions: doc.decisions,
    timeline: doc.timeline,
    documents: doc.documents,
  };
}
