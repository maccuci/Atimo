import type { StoredAttachment } from "./persistence/types";
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
} from "./types";

/*
 * Taking the workspace back out.
 *
 * The product asks a user to put months of project knowledge into a SQLite file
 * on one machine, with no server and no sync. "What if I lose it?" is the first
 * question anyone serious asks, and until this module existed the answer was
 * that there wasn't one — which is a fine reason to decline to use it.
 *
 * Two formats, because they answer two different questions.
 *
 *   JSON      is the workspace, faithfully. Same shape as `persistence/types.ts`
 *             `Snapshot`, deliberately: what comes out is what the database
 *             holds, so restoring it later is `store.seed(doc)` rather than a
 *             parser someone has to write first. It keeps the fields a human
 *             would never read — per-message context, token counts, cost — and
 *             is the one to keep.
 *
 *   Markdown  is the workspace, readably. Transcripts, decisions and memory as
 *             prose, for reading somewhere else or handing to someone. It drops
 *             the diagnostic fields, so it is lossy on purpose.
 *
 * Everything here is pure. The bytes are written by `export-file.ts`, which is
 * the only part that knows whether it is running on the desktop.
 */

export const EXPORT_FORMAT = "atimo.workspace";

/**
 * Bump when the shape changes in a way an importer would have to notice.
 *
 * It is written into every file rather than inferred from the app version,
 * because the file outlives the app that wrote it — that is the entire point of
 * it — and "which Atimo wrote this" is a different question from "what shape
 * is it in".
 */
/**
 * 1. Workspaces, projects, chats, transcripts, knowledge, documents and their
 *    text.
 * 2. Attachment bytes, which travel in the file like document text does.
 *
 * The bump costs something real — a build reading up to 1 refuses a version-2
 * file outright — and that is the trade being made deliberately. The alternative
 * is an older build restoring a workspace whose screenshots it silently drops,
 * and finding that out is what a backup is for.
 */
export const EXPORT_FORMAT_VERSION = 2;

/** Everything the export reads. Mirrors the store's slices. */
export interface ExportSource {
  workspaces: Workspace[];
  projects: Project[];
  chats: Chat[];
  messages: Message[];
  memory: MemoryEntry[];
  decisions: Decision[];
  timeline: TimelineEvent[];
  documents: Document[];
  /**
   * Document text, which the workspace snapshot deliberately does not carry —
   * see `persistence/types.ts`. An export that skipped it would silently drop
   * every file the user uploaded, which is the one omission a backup cannot
   * afford, so the caller loads them per project and passes them in.
   */
  chunks: DocumentChunk[];
  /**
   * Attachment bytes, off the snapshot for the same reason the chunks are, and
   * loaded per chat by the caller.
   *
   * They make the file large — a workspace with fifty screenshots in it exports
   * as tens of megabytes of base64 — and they go in anyway. A backup that
   * restored a conversation with the picture it was about missing is a backup
   * of half a conversation, and there is no second copy of those bytes
   * anywhere.
   */
  attachments: StoredAttachment[];
}

export interface ExportDocument {
  format: typeof EXPORT_FORMAT;
  version: number;
  /** ISO 8601, UTC. */
  exportedAt: string;
  /** The app build that wrote the file. */
  app: string;
  /** What was asked for: one project, or everything. */
  scope: { kind: "workspace" } | { kind: "project"; projectId: string };
  /** For the filename and the Markdown title. */
  label: string;
  workspaces: Workspace[];
  projects: Project[];
  chats: Chat[];
  messages: Message[];
  memory: MemoryEntry[];
  decisions: Decision[];
  timeline: TimelineEvent[];
  documents: Document[];
  chunks: DocumentChunk[];
  attachments: StoredAttachment[];
}

export interface ExportOptions {
  /** Omit for the whole workspace. */
  projectId?: string;
  /** Names the file and titles the document. */
  label: string;
  app: string;
  /** Injectable so the tests are not a clock. */
  now?: Date;
}

/**
 * Gather the slices, narrowed to the scope.
 *
 * The narrowing walks outward from projects rather than filtering each slice on
 * its own: messages carry a `chatId` and no `projectId`, so the only honest way
 * to know a message belongs to a project is to have resolved its chat first.
 * Filtering each slice independently would quietly drop every message in a
 * single-project export.
 */
export function buildExport(
  source: ExportSource,
  options: ExportOptions,
): ExportDocument {
  const { projectId } = options;

  const projects = projectId
    ? source.projects.filter((p) => p.id === projectId)
    : source.projects;

  const projectIds = new Set(projects.map((p) => p.id));
  const workspaceIds = new Set(projects.map((p) => p.workspaceId));
  const chats = source.chats.filter((c) => projectIds.has(c.projectId));
  const chatIds = new Set(chats.map((c) => c.id));
  const documents = source.documents.filter((d) => projectIds.has(d.projectId));
  const documentIds = new Set(documents.map((d) => d.id));

  return {
    format: EXPORT_FORMAT,
    version: EXPORT_FORMAT_VERSION,
    exportedAt: (options.now ?? new Date()).toISOString(),
    app: options.app,
    scope: projectId ? { kind: "project", projectId } : { kind: "workspace" },
    label: options.label,
    workspaces: projectId
      ? source.workspaces.filter((workspace) => workspaceIds.has(workspace.id))
      : source.workspaces,
    projects,
    chats,
    messages: source.messages.filter((m) => chatIds.has(m.chatId)),
    memory: source.memory.filter((m) => projectIds.has(m.projectId)),
    decisions: source.decisions.filter((d) => projectIds.has(d.projectId)),
    timeline: source.timeline.filter((t) => projectIds.has(t.projectId)),
    documents,
    chunks: source.chunks.filter((c) => documentIds.has(c.documentId)),
    // Narrowed by chat rather than by message, which is the same set by a
    // cheaper route: an attachment's `chatId` is denormalised from its message
    // precisely so nobody has to resolve one to know where it belongs.
    attachments: source.attachments.filter((a) => chatIds.has(a.chatId)),
  };
}

export function toJson(doc: ExportDocument): string {
  // Indented. The file is an archive a person may well open in an editor years
  // from now, and the bytes saved by minifying it are worth nothing against
  // that.
  return `${JSON.stringify(doc, null, 2)}\n`;
}

/* ---------------------------------------------------------------------- */
/* Markdown                                                                */
/* ---------------------------------------------------------------------- */

/** `Atimo-Research-2026-07-30`, safe to hand to a filesystem. */
export function exportStem(doc: ExportDocument): string {
  const slug =
    doc.label
      .normalize("NFKD")
      .replace(/[^\w\s-]/g, "")
      .trim()
      .replace(/\s+/g, "-")
      .slice(0, 48) || "workspace";
  return `atimo-${slug}-${doc.exportedAt.slice(0, 10)}`;
}

const ROLE_LABEL: Record<string, string> = {
  user: "You",
  system: "System",
};

function speaker(message: Message): string {
  const who =
    ROLE_LABEL[message.role] ??
    // Which model answered is the fact worth keeping. A transcript where every
    // reply is attributed to "Assistant" loses the one thing this app is for.
    message.modelId ??
    "Assistant";

  // A panel turn exports as several answers in a row, and flat Markdown has no
  // way to show that they answer one prompt. Unlabelled, they read as a model
  // repeating itself — and nothing in the file would say which one the chat
  // actually continued from, which is the fact the next turn was built on.
  if (!message.turnId) return who;
  return `${who} — ${message.canonical ? "in history" : "alternative"}`;
}

function section(title: string, count: number): string {
  return count ? `### ${title} (${count})\n` : "";
}

export function toMarkdown(doc: ExportDocument): string {
  const out: string[] = [];

  out.push(`# ${doc.label}`);
  out.push(
    `Exported ${doc.exportedAt} by Atimo ${doc.app} · ` +
      `${doc.projects.length} ${doc.projects.length === 1 ? "project" : "projects"}, ` +
      `${doc.chats.length} ${doc.chats.length === 1 ? "chat" : "chats"}, ` +
      `${doc.messages.length} ${doc.messages.length === 1 ? "message" : "messages"}`,
  );

  for (const project of doc.projects) {
    out.push(`\n---\n`);
    out.push(`## ${project.name}`);
    if (project.description) out.push(project.description);

    if (project.instructions) {
      out.push(`### Base context\n`);
      out.push(project.instructions);
    }

    const memory = doc.memory.filter((m) => m.projectId === project.id);
    if (memory.length) {
      out.push(section("Project memory", memory.length));
      for (const entry of memory) {
        out.push(`- **${entry.title}** \`${entry.kind}\` — ${entry.body}`);
      }
    }

    const decisions = doc.decisions.filter((d) => d.projectId === project.id);
    if (decisions.length) {
      out.push(section("Decisions", decisions.length));
      for (const decision of decisions) {
        out.push(`#### ${decision.title}`);
        out.push(`_${decision.date}_${
          decision.participants.length ? ` · ${decision.participants.join(", ")}` : ""
        }`);
        if (decision.reason) out.push(decision.reason);
        if (decision.alternatives.length) {
          out.push(`Alternatives considered: ${decision.alternatives.join(", ")}`);
        }
        if (decision.affectedFiles.length) {
          out.push(`Affects: ${decision.affectedFiles.map((f) => `\`${f}\``).join(", ")}`);
        }
      }
    }

    const timeline = doc.timeline.filter((t) => t.projectId === project.id);
    if (timeline.length) {
      out.push(section("Timeline", timeline.length));
      for (const event of timeline) {
        out.push(`- \`${event.date}\` **${event.kind}** ${event.summary} — ${event.modelId}`);
      }
    }

    const documents = doc.documents.filter((d) => d.projectId === project.id);
    if (documents.length) {
      out.push(section("Documents", documents.length));
      for (const document of documents) {
        out.push(`#### ${document.name}`);
        const text = doc.chunks
          .filter((c) => c.documentId === document.id)
          .map((c) => c.text)
          .join("\n\n");
        // Fenced, because a document is verbatim text that happens to be inside
        // a Markdown file — an uploaded README would otherwise reformat the
        // export around its own headings.
        out.push(text ? "```\n" + text + "\n```" : "_(text not available)_");
      }
    }

    const chats = doc.chats.filter((c) => c.projectId === project.id);
    if (chats.length) {
      out.push(section("Chats", chats.length));
      for (const chat of chats) {
        out.push(`#### ${chat.title}`);
        out.push(
          `_${[chat.modelId, ...(chat.panel ?? [])].join(", ")}_${
            chat.forkedFrom ? " · forked from another chat" : ""
          }`,
        );
        const transcript = doc.messages.filter((m) => m.chatId === chat.id);
        for (const message of transcript) {
          out.push(`**${speaker(message)}** · ${message.createdAt}`);
          if (message.error) out.push(`> Failed: ${message.error}`);
          // Named, not embedded. Markdown is the readable export — inlining a
          // megabyte of base64 in the middle of a transcript would make it
          // neither readable nor a smaller file than the JSON beside it.
          if (message.attachments?.length) {
            out.push(
              `_Attached: ${message.attachments.map((a) => a.name).join(", ")}_`,
            );
          }
          if (message.content) out.push(message.content);
          if (message.research) {
            const sources = [...new Map(message.research.results.flatMap((result) => result.sources).map((source) => [source.url, source])).values()];
            if (sources.length) out.push("Sources consulted:\n" + sources.map((source) => `- ${source.title}: ${source.url}`).join("\n"));
            if (message.research.warning) out.push(`> ${message.research.warning}`);
            const dictionary = message.research.dictionary;
            if (dictionary?.tables.length) out.push("Oracle documentation read:\n" + dictionary.tables.map((table) => `- ${table.name}: ${table.url}`).join("\n"));
            if (dictionary?.issues?.length) out.push(`> SQL columns not listed on their table's page: ${dictionary.issues.join(", ")}`);
            for (const rule of dictionary?.rules ?? []) out.push(`> ${rule}`);
          }
          if (message.stopped) out.push(`_(stopped early)_`);
        }
      }
    }
  }

  return `${out.join("\n\n")}\n`;
}
