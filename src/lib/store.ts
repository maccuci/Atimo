import { ResearchOrchestrator, stopResearch } from "./research-orchestrator";
import { reserveCall, settleCall, useResearchSettings } from "./research-settings";
import { create } from "zustand";
import { WORKSPACES } from "./mock-data";
import type { Snapshot } from "./persistence";
import {
  adapter,
  AGENT_LOGIN,
  credentialKey,
  findConnectable,
  migrateCredentials,
  isAgentKey,
  PROVIDERS,
  readPreferredProvider,
  readZaiPlan,
  writePreferredProvider,
  writeZaiPlan,
} from "./adapter";
import type {
  Account,
  AgentKey,
  AgentProbe,
  ChatRequest,
  GatewayKey,
  ProviderKey,
  StreamEvent,
  ZaiPlan,
} from "./adapter";
import { matchLiveModel, toModel } from "./catalog";
import {
  MAX_PER_TURN,
  UnattachableFile,
  attachmentGuard,
  attachmentPart,
  attachmentSupport,
  isAttachable,
  pdfEngineFor,
  readAttachment,
  toAttachment,
  type PendingAttachment,
} from "./attachments";
import { compose } from "./context-composer";
import {
  UnreadableFile,
  ensureIndex,
  forgetDocument,
  forgetProject,
  indexDocument,
  readFile,
  toDocument,
} from "./documents";
import { embedQuery } from "./embeddings";
import { ensureVectors, forgetVectors, reindexProject } from "./vectors";
import { EMPTY_PATCH, applyPatch, store } from "./persistence";
import type { StoredAttachment } from "./persistence";
import {
  buildExport,
  exportStem,
  toJson,
  toMarkdown,
  type ExportDocument,
} from "./export";
import { saveExport, type ExportFormat, type Saved } from "./export-file";
import { importedSnapshot, type ImportOutcome } from "./import";
import { flushWorkspace, seedWorkspace } from "./sync";
import { estimateTokens } from "./tokens";
import { getModel, isLive, registerCatalog } from "./models";
import {
  answersForTurn,
  canReviewPanelTurn,
  canonicalAfter,
  lastAnswerGroup,
  panelModels,
  panelPatch,
  promotePanelPrimary,
  selectablePanelAnswers,
} from "./panel";
import { buildMessages } from "./prompt-builder";
import { readEffort, writeEffort, type Effort } from "./effort";
import { readFast, writeFast } from "./fast";
import {
  readReasoningVisibility,
  writeReasoningVisibility,
  type ReasoningVisibility,
} from "./reasoning";
import { activeSkills, readSkillModes, writeSkillModes } from "./skills";
import { uid } from "./utils";
import { completionError } from "./completion";
import { captureRequest } from "./eval-capture";
import { recordRateLimits } from "./usage-limits";
import {
  applyAppearance,
  readAppearance,
  readTheme,
  writeAppearance,
  writeTheme,
  type Appearance,
  type ThemeId,
} from "./theme";
import type {
  Attachment,
  AttachmentKind,
  Chat,
  ComposedContext,
  Decision,
  Document,
  DocumentChunk,
  DocumentNotice,
  MemoryEntry,
  Message,
  Model,
  Project,
  SkillMode,
  TimelineEvent,
  Workspace,
} from "./types";

export type { ReasoningVisibility };

export type View =
  | "home"
  | "projects"
  | "chat"
  | "apps"
  | "skills"
  | "settings";

/** A temporary choice between the answers of one persisted panel turn. */
export interface PanelReview {
  chatId: string;
  turnId: string;
}

export type ConnectionStatus =
  | "unknown"
  | "disconnected"
  | "connecting"
  | "connected"
  | "error";

export interface Connection {
  status: ConnectionStatus;
  /** Which gateway or local CLI is answering. */
  provider: ProviderKey;
  /** Z.AI general API vs Coding Plan endpoint. Ignored for OpenRouter. */
  zaiPlan: ZaiPlan;
  /** Last four characters of the stored key, never the key. Null for a CLI. */
  hint: string | null;
  /**
   * What the local CLI reported about itself, when the provider is one.
   *
   * Null for gateways, and null for a CLI that has not been probed yet — the
   * connect sheet distinguishes the two by the provider, not by this field.
   */
  agent: AgentProbe | null;
  account: Account | null;
  error: string | null;
  /** Where the key is kept — the connect sheet states this plainly. */
  storage: "desktop" | "web";
}

interface State {
  /* data */
  workspaces: Workspace[];
  projects: Project[];
  chats: Chat[];
  messages: Message[];
  memory: MemoryEntry[];
  decisions: Decision[];
  timeline: TimelineEvent[];
  documents: Document[];

  /**
   * False until the stored workspace has been read back.
   *
   * The persisted collections start empty rather than seeded, so that a returning
   * user never sees a frame of fixture data swapped out from under them. Anything
   * that renders the workspace waits on this instead.
   */
  hydrated: boolean;

  /**
   * True when this launch found no stored workspace at all, so the app is
   * someone's first run and has to ask what to put in it.
   *
   * A separate flag rather than "hydrated and empty", because those are not the
   * same state: a user who deleted their last project has an empty workspace and
   * must not be sent back through setup, and someone whose database failed to
   * open has neither and must not be told it is empty.
   */
  onboarding: boolean;

  /* selection */
  workspaceId: string;
  projectId: string;
  chatId: string;
  view: View;

  /* provider */
  connection: Connection;
  /** Live model catalog. Empty until the provider answers. */
  catalog: Model[];
  catalogStatus: "idle" | "loading" | "ready" | "error";
  catalogError: string | null;

  /**
   * Installed skills, by registry id. A missing id is a skill that is not
   * installed at all — one that is installed and paused is `"off"`.
   */
  skills: Record<string, SkillMode>;

  /** How much of a model's reasoning stream the chat should show. */
  reasoningVisibility: ReasoningVisibility;
  /** How hard the model should think. Applies to whichever provider answers. */
  effort: Effort;
  /** Prefer the highest-throughput provider (OpenRouter `:nitro` routing). */
  fast: boolean;

  /* ui */
  theme: ThemeId;
  /** Accent, font and text size, layered over the theme. */
  appearance: Appearance;
  /** Full rail when true; hidden (peek on hover of the title-bar toggle) when false. */
  sidebarExpanded: boolean;
  /** Collapsed sidebar floating over the content while the toggle is hovered. */
  sidebarPeek: boolean;
  /** Narrow-viewport nav drawer. Independent of desktop rail expand/collapse. */
  mobileNavOpen: boolean;
  paletteOpen: boolean;
  connectOpen: boolean;
  /** Message whose composed context is pinned open in the context panel. */
  inspectedMessageId: string | null;
  /** Whether the new-workspace sheet is open. */
  /** `true` creates a workspace; a workspace id renames that one. */
  workspaceSheet: boolean | string;
  /**
   * Which project the editor sheet is open on: an id, `"new"`, or null.
   *
   * In the store rather than in `ProjectsView`, because three surfaces open the
   * same sheet — the projects grid, the rail's project menu, and the context
   * panel's base-context block — and a sheet owned by one of them could not be
   * opened from the other two.
   */
  projectSheet: string | null;
  /**
   * Live composer text. Kept here so the status-bar context meter can price
   * the next turn without owning the textarea.
   */
  composerDraft: string;
  sending: boolean;
  /** Focused answer choice for one multi-model turn; never persisted. */
  panelReview: PanelReview | null;
  /**
   * The upload receipt — what landed, what was refused. Null when there is
   * nothing to say, which is almost always, so it costs nothing to keep here.
   *
   * Success and failure share one shape so a mixed drop (three good, two bad)
   * can be told as a single story rather than racing two banners.
   */
  documentNotice: DocumentNotice | null;
  /**
   * Labels waiting to become `@document()` chips in the composer. The notice
   * chips enqueue here; the composer owns the caret and drains the queue.
   */
  documentMentionQueue: string[];
  /**
   * Files staged for the next prompt, with their bytes.
   *
   * In the store rather than in the composer's own state because three surfaces
   * put things here — the clip, a drop anywhere on the chat, and a paste — and
   * only one of them is inside the composer. They are cleared when the turn
   * leaves and when the open chat changes: an attachment belongs to a prompt,
   * and a prompt that was never sent has no claim on the next conversation.
   */
  composerAttachments: PendingAttachment[];
  /**
   * Attachment bytes for the open chat, by attachment id.
   *
   * Held here rather than in a module cache so a transcript re-renders when they
   * land — a chat reopened with three screenshots in it paints their frames
   * immediately and fills them as the read comes back. Replaced wholesale on
   * every chat switch, which is what bounds it: the resident set is one
   * conversation's pictures, not the workspace's.
   */
  attachmentBlobs: Record<string, string>;

  /* actions */
  hydrate: (snapshot: Snapshot) => void;
  /** Nothing was stored: ask what this workspace should start as. */
  beginOnboarding: () => void;
  /** Setup answered. The workspace has been hydrated by whoever wrote it. */
  completeOnboarding: () => void;
  bootstrapProvider: () => Promise<void>;
  /** Connect a gateway by key. */
  connect: (key: string, provider?: GatewayKey) => Promise<void>;
  /**
   * Connect a local CLI: ask it whether it is installed and signed in.
   *
   * Deliberately not `connect()` with an empty key — there is no secret to
   * hand over, and the failure modes are different enough ("not installed",
   * "installed but signed out") that sharing one code path would mean
   * inventing a fake credential to carry them.
   */
  connectAgent: (provider?: AgentKey) => Promise<void>;
  disconnect: () => Promise<void>;
  setProvider: (provider: ProviderKey) => void;
  setZaiPlan: (plan: ZaiPlan) => void;
  refreshCatalog: () => Promise<void>;
  setConnectOpen: (open: boolean) => void;
  stopStreaming: () => void;

  selectWorkspace: (id: string) => void;
  /** Create, select and persist an empty workspace. */
  createWorkspace: (name: string) => string;
  renameWorkspace: (id: string, name: string) => void;
  deleteWorkspace: (id: string) => void;
  selectProject: (id: string) => void;
  selectChat: (id: string) => void;
  setView: (view: View) => void;
  setTheme: (theme: ThemeId) => void;
  setAppearance: (patch: Partial<Appearance>) => void;
  toggleSidebar: () => void;
  setSidebarPeek: (peek: boolean) => void;
  setMobileNavOpen: (open: boolean) => void;
  setPaletteOpen: (open: boolean) => void;
  setWorkspaceSheet: (open: boolean | string) => void;
  inspectMessage: (id: string | null) => void;
  setProjectSheet: (target: string | null) => void;
  openPanelReview: (chatId: string, turnId: string) => void;
  closePanelReview: () => void;
  choosePanelReviewAnswer: (messageId: string) => void;
  setComposerDraft: (draft: string) => void;
  setReasoningVisibility: (value: ReasoningVisibility) => void;
  setEffort: (value: Effort) => void;
  setFast: (value: boolean) => void;

  /**
   * Write the workspace, or one project of it, to a file the user keeps.
   *
   * Rejects rather than storing an error, because there is exactly one caller
   * and it is a menu that stays open to show the outcome. Putting a
   * `exportError` on the store would mean every surface that renders the store
   * could see a failure that belongs to a menu two clicks away.
   */
  exportWorkspace: (options: {
    projectId?: string;
    format: ExportFormat;
  }) => Promise<Saved>;

  /**
   * Read a file the user kept back into this workspace.
   *
   * Rejects on a failure that stopped it, and resolves with what it could not
   * finish — the two are different outcomes and a restore that reports the
   * second as the first sends the user to redo an import that mostly worked.
   */
  importWorkspace: (doc: ExportDocument) => Promise<ImportOutcome>;

  /**
   * Fold an imported workspace into this one, and open on what arrived.
   *
   * Upsert by id, through the same `applyPatch` the browser store uses, so what
   * a restore means in memory and what it means on disk cannot drift: a row the
   * file also has is replaced in place, one it does not is left alone, and a new
   * one is appended. Nothing is deleted — see `import.ts`.
   */
  restore: (snapshot: Snapshot) => void;

  installSkill: (id: string) => void;
  removeSkill: (id: string) => void;
  setSkillMode: (id: string, mode: SkillMode) => void;
  toggleSkill: (id: string) => void;

  /** Returns the new project's id, so the caller can open it. */
  /**
   * Read files into the open project. Returns what landed and what could not
   * be taken, so the caller can say so — a silently ignored drop reads as a
   * broken app, and a silent success is almost as bad.
   */
  addDocuments: (
    files: File[],
  ) => Promise<{ added: Document[]; rejected: string[] }>;
  /**
   * Take a mixed handful of files and put each where it belongs.
   *
   * One entry point for all three gestures, because the user makes no
   * distinction when they drop a screenshot and a spec together — and the
   * routing rule is not something a drop handler should be reimplementing. Text
   * becomes project knowledge; images, PDFs and audio ride with the next prompt.
   */
  addFiles: (files: File[]) => Promise<{
    /** Files that became project knowledge. */
    added: Document[];
    /** Files staged for the next turn. */
    attached: PendingAttachment[];
    rejected: string[];
  }>;
  removeAttachment: (id: string) => void;
  clearAttachments: () => void;
  deleteDocument: (documentId: string) => void;
  setDocumentNotice: (notice: DocumentNotice | null) => void;
  queueDocumentMention: (name: string) => void;
  clearDocumentMentionQueue: () => void;

  createProject: (input: NewProject) => string;
  renameProject: (projectId: string, name: string) => void;
  /** Edit the description or the base context. Both stamp `updatedAt`. */
  updateProject: (
    projectId: string,
    patch: Partial<Pick<Project, "name" | "description" | "instructions">>,
  ) => void;
  deleteProject: (projectId: string) => void;

  newChat: (modelId?: string) => void;
  forkChat: (chatId: string, messageId: string, modelId: string) => void;
  setChatModel: (chatId: string, modelId: string) => void;
  /** Replace the extra models answering alongside this chat's primary. */
  setChatPanel: (chatId: string, modelIds: readonly string[]) => void;
  /**
   * Make one answer of a panel turn the conversation.
   *
   * The only way a user changes what the next turn conditions on, so it is a
   * store action rather than view state — the choice outlives the render, the
   * session and the export.
   */
  promoteAnswer: (messageId: string) => void;
  renameChat: (chatId: string, title: string) => void;
  deleteChat: (chatId: string) => void;

  send: (prompt: string) => Promise<void>;
  /** Run the last answer in its chat again, into the same message. */
  retry: (messageId: string) => Promise<void>;
}

/**
 * Write a prompt's attachment bytes, once the message that owns them exists.
 *
 * The flush is the ordering rule, not a nicety: the blob rows carry a foreign
 * key to a message row that the sync subscriber writes on a 400ms debounce, and
 * SQLite rejects a child whose parent has not been committed. Uploading a
 * document obeys the same rule for the same reason.
 *
 * Awaited before the request goes out, so a crash mid-stream cannot leave a
 * transcript naming a screenshot whose bytes were never saved. Failure is logged
 * rather than thrown: the turn is already on screen and the bytes are in memory,
 * so the answer it produces is real — what is lost is the picture on the next
 * launch, which the transcript says out loud rather than hiding.
 */
async function persistAttachments(
  pending: readonly PendingAttachment[],
  messageId: string,
  chatId: string,
): Promise<void> {
  try {
    await flushWorkspace();
    await store.putAttachments(
      pending.map((attachment) => ({
        id: attachment.id,
        messageId,
        chatId,
        data: attachment.dataUrl,
      })),
    );
  } catch (error) {
    console.error("could not save this turn's attachments", error);
  }
}

/**
 * Bring the open chat's attachment bytes into memory.
 *
 * Fire-and-forget, like `ensureIndex`: a transcript renders its attachment
 * frames from the metadata on the message and fills them when this lands, so
 * the read costs a frame of placeholder rather than a blocked chat switch.
 *
 * Replaced wholesale rather than merged, which is what keeps the resident set to
 * one conversation. The `chatId` check afterwards is not paranoia — switching
 * chats twice quickly starts two reads, and without it the slower one lands last
 * and leaves the open chat showing another chat's pictures.
 */
function loadAttachmentBlobs(
  set: (partial: Partial<State>) => void,
  get: () => State,
  chatId: string,
): void {
  if (!chatId) {
    set({ attachmentBlobs: {} });
    return;
  }

  void store
    .loadAttachments(chatId)
    .then((rows) => {
      if (get().chatId !== chatId) return;
      const blobs: Record<string, string> = {};
      for (const row of rows) blobs[row.id] = row.data;
      // Anything staged in the composer keeps its bytes: those belong to a
      // prompt that has not been sent, so no read from the database will
      // contain them.
      for (const pending of get().composerAttachments) {
        blobs[pending.id] = pending.dataUrl;
      }
      set({ attachmentBlobs: blobs });
    })
    .catch((error) => {
      // Degrades to "the pictures in this chat cannot be shown or re-sent",
      // which the transcript states per attachment, rather than to a failed
      // chat switch.
      console.error("could not load this chat's attachments", error);
    });
}

/**
 * A stored project, with fields added since it was written filled in.
 *
 * The browser store already does this one level up — "a snapshot missing a
 * collection is a snapshot from an older shape" — and a row is no different. A
 * project persisted before base contexts existed has no `instructions` at all,
 * and the SQLite migration deliberately copies each row's JSON verbatim rather
 * than rewriting it, so the gap arrives here rather than being papered over in
 * SQL. Without this the composer would read `undefined.trim()` on the first
 * launch after an update, which is the whole workspace failing to open.
 *
 * Returns the row unchanged when nothing is missing, so reference identity
 * survives and hydration does not queue a write of every project.
 */
function withDefaults(project: Project): Project {
  return typeof project.instructions === "string"
    ? project
    : { ...project, instructions: "" };
}

/**
 * Keep old snapshots usable after workspaces became persisted state.
 *
 * Before this collection existed, projects still carried a workspace id but
 * there was no parent row to load. Known fixture ids recover their original
 * labels; unknown ids get a visible placeholder rather than leaving projects
 * orphaned in an invisible section.
 */
function withWorkspaceDefaults(
  workspaces: Workspace[],
  projects: Project[],
): Workspace[] {
  const known = new Map<string, Workspace>();

  for (const workspace of workspaces) {
    if (!workspace.id.trim()) continue;
    const fixture = WORKSPACES.find((candidate) => candidate.id === workspace.id);
    known.set(
      workspace.id,
      fixture && workspace.name === "Workspace importado" ? fixture : workspace,
    );
  }

  for (const project of projects) {
    if (known.has(project.workspaceId)) continue;
    known.set(
      project.workspaceId,
      WORKSPACES.find((workspace) => workspace.id === project.workspaceId) ?? {
        id: project.workspaceId,
        name: "Workspace importado",
      },
    );
  }

  return [...known.values()];
}

/** What the sheet collects for a new project. */
export interface NewProject {
  name: string;
  description?: string;
  instructions?: string;
  /** Defaults to the open workspace. */
  workspaceId?: string;
}

/**
 * The chat a project should open on: the one worked on most recently.
 *
 * Array order is insertion order once chats are read back from the store, so
 * taking the first match would reopen the project on its oldest conversation.
 */
const firstChatOf = (chats: Chat[], projectId: string) => {
  let best: Chat | undefined;
  for (const chat of chats) {
    if (chat.projectId !== projectId) continue;
    if (!best || chat.updatedAt > best.updatedAt) best = chat;
  }
  return best?.id ?? "";
};

export const useStore = create<State>((set, get) => ({
  // Persisted workspace metadata starts empty until the first launch is read.
  // This avoids showing fixture workspaces for a frame over a returning user's
  // real workspace list.
  workspaces: [],
  documents: [],
  projects: [],
  chats: [],
  messages: [],
  memory: [],
  decisions: [],
  timeline: [],
  hydrated: false,
  onboarding: false,

  workspaceId: "",
  projectId: "",
  chatId: "",
  view: "home",

  connection: {
    status: "unknown",
    provider: readPreferredProvider(),
    zaiPlan: readZaiPlan(),
    hint: null,
    agent: null,
    account: null,
    error: null,
    storage: adapter.kind,
  },
  catalog: [],
  catalogStatus: "idle",
  catalogError: null,
  skills: readSkillModes(),
  reasoningVisibility: readReasoningVisibility(),
  effort: readEffort(),
  fast: readFast(),

  theme: readTheme(),
  appearance: readAppearance(),
  sidebarExpanded: true,
  sidebarPeek: false,
  mobileNavOpen: false,
  paletteOpen: false,
  connectOpen: false,
  inspectedMessageId: null,
  workspaceSheet: false,
  projectSheet: null,
  composerDraft: "",
  sending: false,
  panelReview: null,
  documentNotice: null,
  documentMentionQueue: [],
  composerAttachments: [],
  attachmentBlobs: {},

  /* -- hydration --------------------------------------------------------- */

  /**
   * Adopt the stored workspace.
   *
   * Selection is resolved here rather than left to the initial state, because
   * which project and chat exist is only knowable once they have been read back
   * — the ids that used to be hardcoded (`p-atimo`, `c-arch`) are fixtures,
   * and pointing at one that had since been deleted would open the app on an
   * empty transcript.
   */
  hydrate: (snapshot) => {
    set((s) => {
      const projects = snapshot.projects.map(withDefaults);
      const workspaces = withWorkspaceDefaults(snapshot.workspaces ?? [], projects);
      const selectedWorkspace = workspaces.find((w) => w.id === s.workspaceId);
      const project = selectedWorkspace
        ? projects.find((p) => p.workspaceId === selectedWorkspace.id)
        : projects[0];
      const workspaceId =
        project?.workspaceId ??
        selectedWorkspace?.id ??
        workspaces[0]?.id ??
        "";

      // The project the app is about to open on. Its documents and its vectors
      // should both be retrievable by the time the user has finished reading
      // the screen. `reindexProject` waits on the model, so this is a no-op
      // until it has loaded and a catch-up scan once it has.
      if (project) {
        void ensureIndex(project.id);
        void reindexProject(project.id);
      }

      return {
        ...snapshot,
        // Proposals are off (see the distill call site); drop any still saved.
        // Untouched rows keep their identity so nothing else is rewritten.
        messages: snapshot.messages.map((m) =>
          m.candidates ? { ...m, candidates: undefined } : m,
        ),
        workspaces,
        projects,
        hydrated: true,
        workspaceId,
        projectId: project?.id ?? "",
        chatId: project ? firstChatOf(snapshot.chats, project.id) : "",
        panelReview: null,
      };
    });

    // After the selection is resolved, because which chat is open is what
    // decides whose bytes to read.
    loadAttachmentBlobs(set, get, get().chatId);
  },

  beginOnboarding: () => set({ onboarding: true }),

  completeOnboarding: () => set({ onboarding: false }),

  /* -- provider ---------------------------------------------------------- */

  bootstrapProvider: async () => {
    await migrateCredentials().catch((error) => set((s) => ({ connection: { ...s.connection, error: messageOf(error) } })));
    const preferred = readPreferredProvider();
    // Prefer the saved provider when it is still usable; otherwise take the
    // first one that is, so reconnecting after a restart still works. Both
    // questions are free — a keychain lookup, or asking a CLI who is signed in.
    const provider =
      (await findConnectable([
        preferred,
        ...PROVIDERS.filter((p) => p !== preferred),
      ])) ?? preferred;

    if (provider !== preferred) writePreferredProvider(provider);
    set((s) => ({ connection: { ...s.connection, provider } }));

    // Adopting a live connection is the same work whether it was found here or
    // chosen in the sheet, so it goes through the same function.
    const adopted = await adoptProvider(set, provider);

    // The catalog is public (or static), so the picker can show the real
    // lineup before anyone connects anything.
    await get().refreshCatalog();
    if (adopted) void loadAccount(set, get);
  },

  connect: async (key, provider) => {
    const gateway = (provider ?? get().connection.provider) as GatewayKey;
    set((s) => ({
      connection: {
        ...s.connection,
        provider: gateway,
        status: "connecting",
        error: null,
      },
    }));
    try {
      const status = await adapter.credentialSet(credentialKey(gateway, get().connection.zaiPlan), key);
      // Saving a key only proves it was written. Asking the provider who it
      // belongs to is what proves it works, and it fills in the credit
      // balance the connect sheet shows.
      const account = await adapter.account(gateway, {
        zaiPlan: get().connection.zaiPlan,
      });
      writePreferredProvider(gateway);
      set((s) => ({
        connection: {
          ...s.connection,
          provider: gateway,
          status: "connected",
          hint: status.hint,
          agent: null,
          account,
          error: null,
        },
      }));
      await get().refreshCatalog();
    } catch (error) {
      // A key that does not authenticate is worse than none: it would fail on
      // every turn instead of once, here. Roll it back.
      await adapter.credentialClear(credentialKey(gateway, get().connection.zaiPlan)).catch(() => {});
      set((s) => ({
        connection: {
          ...s.connection,
          provider: gateway,
          status: "error",
          hint: null,
          agent: null,
          account: null,
          error: messageOf(error),
        },
      }));
    }
  },

  connectAgent: async (provider) => {
    const agent = (provider ?? get().connection.provider) as AgentKey;
    set((s) => ({
      connection: {
        ...s.connection,
        provider: agent,
        status: "connecting",
        error: null,
      },
    }));

    // A rejected probe is itself an answer — "we could not ask" — so it is
    // shaped like one rather than thrown, and the panel below renders it the
    // same way it renders a CLI that answered "not signed in".
    const probe: AgentProbe = await adapter.agentProbe(agent).catch((error) => ({
      installed: false,
      path: null,
      version: null,
      loggedIn: false,
      method: null,
      account: null,
      plan: null,
      model: null,
      loginCommand: AGENT_LOGIN[agent],
      problem: messageOf(error),
    }));

    // `problem` is the CLI's own diagnosis, already written as a sentence a
    // user can act on ("not signed in — run `claude auth login`"). Nothing here
    // improves on it, so it is passed through rather than rewritten.
    if (!probe.loggedIn) {
      set((s) => ({
        connection: {
          ...s.connection,
          provider: agent,
          status: "error",
          hint: null,
          agent: probe,
          account: null,
          error: probe.problem ?? "Essa CLI ainda não está pronta para responder.",
        },
      }));
      return;
    }

    writePreferredProvider(agent);
    set((s) => ({
      connection: {
        ...s.connection,
        provider: agent,
        status: "connected",
        hint: null,
        agent: probe,
        error: null,
      },
    }));
    void loadAccount(set, get);
    await get().refreshCatalog();
  },

  disconnect: async () => {
    const provider = get().connection.provider;
    // Nothing to revoke for a CLI: the app never held a credential for it, and
    // the user's own `claude`/`codex` login is not ours to sign out.
    if (!isAgentKey(provider)) {
      await adapter.credentialClear(credentialKey(provider as GatewayKey, get().connection.zaiPlan)).catch(() => {});
    }
    set((s) => ({
      connection: {
        ...s.connection,
        status: "disconnected",
        hint: null,
        agent: null,
        account: null,
        error: null,
      },
    }));
  },

  setProvider: (provider) => {
    writePreferredProvider(provider);
    set((s) => ({
      connection: {
        ...s.connection,
        provider,
        // Switching providers clears connection state until the user connects
        // (or the probe below finds this one already usable).
        status: "disconnected",
        hint: null,
        agent: null,
        account: null,
        error: null,
      },
      catalog: [],
      catalogStatus: "idle",
      catalogError: null,
    }));
    void (async () => {
      if (await adoptProvider(set, provider)) void loadAccount(set, get);
      await get().refreshCatalog();
    })();
  },

  setZaiPlan: (plan) => {
    writeZaiPlan(plan);
    set((s) => ({
      connection: { ...s.connection, zaiPlan: plan, error: null },
    }));
    // Re-check the key against the new endpoint when already connected —
    // Coding Plan and general keys are not interchangeable.
    if (get().connection.provider === "zai") {
      set((s) => ({ connection: { ...s.connection, status: "disconnected", hint: null, account: null } }));
      void adoptProvider(set, "zai").then((ready) => { if (ready) void loadAccount(set, get); });
    }
  },

  refreshCatalog: async () => {
    const provider = get().connection.provider;
    set({ catalogStatus: "loading", catalogError: null });
    try {
      const catalog = (await adapter.catalog(provider))
        .map(toModel)
        // Newest first inside a vendor; the picker groups by vendor anyway.
        .sort((a, b) => (b.created ?? 0) - (a.created ?? 0));

      registerCatalog(catalog);
      set({ catalog, catalogStatus: "ready", catalogError: null });
      realign(set, get, catalog);
    } catch (error) {
      set({ catalogStatus: "error", catalogError: messageOf(error) });
    }
  },

  setConnectOpen: (connectOpen) => set({ connectOpen }),

  stopStreaming: () => {
    stopResearch();
    const provider = get().connection.provider;
    // Snapshot first: cancelling removes entries from the set as they settle.
    for (const id of [...activeStreams]) adapter.cancel(provider, id);
  },

  selectWorkspace: (id) => {
    const { projects, chats, workspaces } = get();
    if (!workspaces.some((workspace) => workspace.id === id)) return;
    const first = projects.find((p) => p.workspaceId === id);
    set({
      workspaceId: id,
      projectId: first?.id ?? "",
      chatId: first ? firstChatOf(chats, first.id) : "",
      inspectedMessageId: null,
      view: "home",
    });
  },

  createWorkspace: (name) => {
    const workspace: Workspace = {
      id: uid("ws"),
      name: name.trim() || "Workspace sem nome",
    };

    set((s) => ({
      workspaces: [...s.workspaces, workspace],
      workspaceId: workspace.id,
      projectId: "",
      chatId: "",
      inspectedMessageId: null,
      view: "home",
    }));

    return workspace.id;
  },

  renameWorkspace: (id, name) => {
    const next = name.trim();
    // A blank name has nothing to show in the switcher; keep the old one.
    if (!next) return;
    set((s) => ({
      workspaces: s.workspaces.map((w) => (w.id === id ? { ...w, name: next } : w)),
    }));
  },

  deleteWorkspace: (id) => {
    const { workspaces, projects } = get();
    // The last one stays: with no workspace there is nowhere to create a
    // project, and the app would be stuck on an empty shell.
    if (workspaces.length < 2 || !workspaces.some((w) => w.id === id)) return;

    // Project by project, so each one's index, stream and selection are
    // handled by the one reducer that already knows how.
    for (const project of projects.filter((p) => p.workspaceId === id)) {
      get().deleteProject(project.id);
    }

    const leaving = get().workspaceId === id;
    set((s) => ({ workspaces: s.workspaces.filter((w) => w.id !== id) }));
    if (leaving) get().selectWorkspace(get().workspaces[0]!.id);
  },

  selectProject: (id) => {
    // Fire and forget: retrieval reads the index synchronously and simply finds
    // nothing until this lands, which is a turn at most and self-correcting.
    // Blocking the selection on a database read would make switching projects
    // feel slow to buy a case that resolves itself. The vectors are read the
    // same way, and are the smaller of the two by an order of magnitude.
    void ensureIndex(id);
    void ensureVectors(id);
    void reindexProject(id);

    const wasOpen = get().chatId;

    set((s) => {
      const project = s.projects.find((p) => p.id === id);
      if (!project) return {};
      // Stay on the open chat when it already belongs here. Jumping to
      // `firstChatOf` (most recently updated) is what made Projects → back look
      // like the transcript had been wiped — the user landed on a different,
      // often empty, Untitled.
      const stays =
        s.chats.some((c) => c.id === s.chatId && c.projectId === id)
          ? s.chatId
          : firstChatOf(s.chats, id);
      return {
        projectId: id,
        workspaceId: project?.workspaceId ?? s.workspaceId,
        chatId: stays,
        inspectedMessageId: null,
        panelReview: s.panelReview?.chatId === stays ? s.panelReview : null,
        ...(stays === wasOpen ? null : { composerAttachments: [] }),
      };
    });

    if (get().chatId !== wasOpen) loadAttachmentBlobs(set, get, get().chatId);
  },

  selectChat: (id) => {
    const moved = get().chatId !== id;

    set((s) => ({
      chatId: id,
      view: "chat",
      inspectedMessageId: null,
      panelReview: s.panelReview?.chatId === id ? s.panelReview : null,
      // Staged files belong to the prompt being written, not to the next
      // conversation the user opens — carrying them across would attach a
      // screenshot to a question about something else.
      ...(moved ? { composerAttachments: [] } : null),
    }));

    if (moved) loadAttachmentBlobs(set, get, id);
    // Leaving a chat mid-stream (or just after settle's in-memory write) must
    // not leave the answer sitting in the 400ms debounce — that is the window
    // where a remount used to resurrect the empty placeholder.
    void flushWorkspace();
  },

  setView: (view) => {
    set({ view, panelReview: null });
    void flushWorkspace();
  },

  setTheme: (theme) => {
    writeTheme(theme);
    set({ theme });
  },

  setAppearance: (patch) => {
    const appearance = { ...get().appearance, ...patch };
    writeAppearance(appearance);
    applyAppearance(appearance);
    set({ appearance });
  },

  toggleSidebar: () =>
    set((s) => ({ sidebarExpanded: !s.sidebarExpanded, sidebarPeek: false })),

  setSidebarPeek: (sidebarPeek) => set({ sidebarPeek }),

  setMobileNavOpen: (mobileNavOpen) => set({ mobileNavOpen }),

  setPaletteOpen: (paletteOpen) => set({ paletteOpen }),

  inspectMessage: (inspectedMessageId) =>
    set({ inspectedMessageId }),

  setWorkspaceSheet: (workspaceSheet) => set({ workspaceSheet }),

  setProjectSheet: (projectSheet) => set({ projectSheet }),

  openPanelReview: (chatId, turnId) =>
    set((s) => {
      const chat = s.chats.find((candidate) => candidate.id === chatId);
      if (
        !chat ||
        !canReviewPanelTurn(answersForTurn(s.messages, chatId, turnId))
      ) {
        return {};
      }
      const project = s.projects.find((candidate) => candidate.id === chat.projectId);

      return {
        panelReview: { chatId, turnId },
        workspaceId: project?.workspaceId ?? s.workspaceId,
        projectId: chat.projectId,
        chatId,
        view: "chat",
        inspectedMessageId: null,
      };
    }),

  closePanelReview: () => set({ panelReview: null, view: "chat" }),

  choosePanelReviewAnswer: (messageId) => {
    const review = get().panelReview;
    const target = get().messages.find((message) => message.id === messageId);
    if (
      !review ||
      !target ||
      target.chatId !== review.chatId ||
      target.turnId !== review.turnId ||
      selectablePanelAnswers([target]).length === 0
    ) {
      return;
    }

    get().promoteAnswer(messageId);
    get().closePanelReview();
  },

  setComposerDraft: (composerDraft) => set({ composerDraft }),

  setReasoningVisibility: (reasoningVisibility) => {
    writeReasoningVisibility(reasoningVisibility);
    set({ reasoningVisibility });
  },

  setEffort: (effort) => {
    writeEffort(effort);
    set({ effort });
  },

  setFast: (fast) => {
    writeFast(fast);
    set({ fast });
  },

  /* -- skills ------------------------------------------------------------ */

  // A skill arrives running: installing one and then discovering it does
  // nothing until a second switch is found is the worse default.
  exportWorkspace: async ({ projectId, format }) => {
    const s = get();
    const projects = projectId
      ? s.projects.filter((p) => p.id === projectId)
      : s.projects;

    /*
     * Document text is the one part of the workspace that is not already in
     * memory — it is kept out of the snapshot on purpose (see
     * `persistence/types.ts`), so it has to be read back per project here.
     *
     * Deliberately not caught. An export that quietly omitted every uploaded
     * file would still be a valid-looking file with the user's documents
     * missing from it, and they would find out when they needed it. A failure
     * they can see and retry is the better half of that trade.
     */
    const chunks = (
      await Promise.all(projects.map((p) => store.loadChunks(p.id)))
    ).flat();

    /*
     * Attachment bytes, read the same way and for the same reason — and per
     * chat rather than per project, because that is the only key the blob table
     * is indexed on.
     *
     * Scoped to the chats actually being exported, not to every chat in the
     * workspace: a single-project export of a workspace full of screenshots
     * should not carry the other projects' megabytes.
     */
    const scopedProjects = new Set(projects.map((p) => p.id));
    const chatIds = s.chats
      .filter((c) => scopedProjects.has(c.projectId))
      .map((c) => c.id);
    const attachments = (
      await Promise.all(chatIds.map((id) => store.loadAttachments(id)))
    ).flat();

    const doc = buildExport(
      { ...s, projects: s.projects, chunks, attachments },
      {
        projectId,
        label: projectId
          ? (projects[0]?.name ?? "project")
          : (s.workspaces.find((w) => w.id === s.workspaceId)?.name ??
            "workspace"),
        app: typeof __APP_VERSION__ === "undefined" ? "dev" : __APP_VERSION__,
      },
    );

    return saveExport(
      exportStem(doc),
      format,
      format === "json" ? toJson(doc) : toMarkdown(doc),
    );
  },

  /*
   * Restore, which is an export read backwards and one ordering rule.
   *
   * The rule is the same one uploads obey: document text carries a foreign key
   * to a document row, so the rows have to be committed before the text that
   * points at them. On a fresh install that commit is the seed; on a workspace
   * that already exists it is the sync subscriber, and `flushWorkspace` is what
   * makes waiting for it explicit rather than hopeful.
   *
   * The indexes are dropped after the text lands and not before. Both paths
   * above ask for an index while writing — `hydrate` warms the project it opens
   * on, and so does `restore` — and an index built between the rows and their
   * text is one that answers "this project's files contain nothing" for the rest
   * of the session, on the launch the user is checking their backup worked.
   */
  importWorkspace: async (doc) => {
    const snapshot = importedSnapshot(doc);

    if (get().onboarding) {
      // Nothing was ever written here, so there is no workspace to merge into
      // and no marker saying one exists. Seeding is what writes that marker;
      // a patch applied without it lands rows that the next launch cannot see.
      await seedWorkspace(snapshot);
    } else {
      get().restore(snapshot);
      await flushWorkspace();
    }

    const chunksOf = new Map<string, DocumentChunk[]>();
    for (const chunk of doc.chunks) {
      const owned = chunksOf.get(chunk.documentId);
      if (owned) owned.push(chunk);
      else chunksOf.set(chunk.documentId, [chunk]);
    }

    /*
     * Counted rather than thrown. Everything else has already landed by now, so
     * failing the whole call would report a restore that did not happen — and
     * the honest thing to say is which part of it did not, since a document
     * whose row is present and whose text is not resolves to silence in a
     * prompt rather than to an error.
     */
    let documentsWithoutText = 0;
    for (const [documentId, chunks] of chunksOf) {
      try {
        await store.putChunks(documentId, chunks);
      } catch (error) {
        console.error("could not save an imported document's text", error);
        documentsWithoutText += 1;
      }
    }

    /*
     * Attachment bytes, after the same commit and counted the same way.
     *
     * In one call rather than per row: unlike the chunks, which are grouped by
     * document because the write replaces a document's set, these are a plain
     * upsert keyed by id, so a batch is a batch. The cost of that is coarser
     * reporting — a single failure counts the whole file's attachments as
     * missing — which is the honest answer anyway, since the write is one
     * transaction.
     */
    let attachmentsWithoutBytes = 0;
    if (doc.attachments?.length) {
      try {
        await store.putAttachments(doc.attachments);
      } catch (error) {
        console.error("could not save the imported attachments", error);
        attachmentsWithoutBytes = doc.attachments.length;
      }
    }

    for (const project of doc.projects) {
      forgetProject(project.id);
      // The restored text is different text, so the vectors describing the old
      // text are not stale in a way the fingerprints can see — their unit ids
      // are gone with the rows they came from. Dropping the resident index
      // makes the next scan rebuild from what was actually written.
      forgetVectors(project.id);
    }
    void ensureIndex(get().projectId);
    void reindexProject(get().projectId);
    // The open chat may be one the file just restored, so its bytes have to be
    // read back rather than assumed absent from before the import.
    loadAttachmentBlobs(set, get, get().chatId);

    return { documentsWithoutText, attachmentsWithoutBytes };
  },

  restore: (snapshot) =>
    set((s) => {
      const merged = applyPatch(
        {
          workspaces: s.workspaces,
          projects: s.projects,
          chats: s.chats,
          messages: s.messages,
          memory: s.memory,
          decisions: s.decisions,
          timeline: s.timeline,
          documents: s.documents,
        },
        { ...EMPTY_PATCH, ...snapshot },
      );

      const projects = merged.projects.map(withDefaults);
      const workspaces = withWorkspaceDefaults(merged.workspaces, projects);

      /*
       * Open on the file's first project rather than staying put. A restore
       * whose only visible effect is a project appearing somewhere in a rail the
       * user is not looking at reads as having done nothing, which is the one
       * impression a backup must not leave. Falling back to the current
       * selection covers the file that carried no projects at all.
       */
      const arrived = snapshot.projects[0];
      const project =
        (arrived && projects.find((p) => p.id === arrived.id)) ??
        projects.find((p) => p.id === s.projectId) ??
        projects[0];

      return {
        ...merged,
        workspaces,
        projects,
        workspaceId: project?.workspaceId ?? s.workspaceId,
        projectId: project?.id ?? "",
        chatId: project ? firstChatOf(merged.chats, project.id) : "",
        panelReview: null,
      };
    }),

  installSkill: (id) => set((s) => persistSkills({ ...s.skills, [id]: "auto" })),

  removeSkill: (id) =>
    set((s) => {
      const { [id]: _removed, ...rest } = s.skills;
      return persistSkills(rest);
    }),

  setSkillMode: (id, mode) =>
    set((s) => (s.skills[id] ? persistSkills({ ...s.skills, [id]: mode }) : {})),

  // The switch restores `auto` rather than the mode it was paused from: the
  // mode control is right there, and remembering a hidden `always` would turn
  // a skill back on for every turn without saying so.
  toggleSkill: (id) =>
    set((s) => {
      const current = s.skills[id];
      if (!current) return {};
      return persistSkills({
        ...s.skills,
        [id]: current === "off" ? "auto" : "off",
      });
    }),

  /* -- projects ---------------------------------------------------------- */

  /**
   * A project starts empty rather than with a chat in it.
   *
   * Creating one is an act of setting up context, not of starting a
   * conversation: the sheet the user just filled in was about the brief, and
   * spending a model choice on their behalf in the same gesture would put an
   * "Untitled" row in the rail they did not ask for. `newChat` is one click away
   * and carries the model they actually want.
   */
  /*
   * Upload.
   *
   * The ordering is the whole subtlety. Chunks carry a foreign key to their
   * document, and the document row is written by the sync subscriber rather than
   * from here — so the flush between the two is not a nicety, it is what stops
   * SQLite rejecting a chunk whose parent has not been committed yet.
   *
   * Files are taken one at a time rather than in parallel. A drop of twenty is
   * twenty file reads plus twenty chunk passes, and doing them at once on the
   * main thread janks the window for exactly as long as it takes; sequentially
   * the app stays responsive and the user watches the count climb.
   */
  addDocuments: async (files) => {
    const projectId = get().projectId;
    if (!projectId) {
      return {
        added: [],
        rejected: ["Abra um projeto antes de adicionar arquivos."],
      };
    }

    const added: Document[] = [];
    const rejected: string[] = [];

    for (const file of files) {
      let prepared;
      try {
        const parsed = await readFile(file);
        if (parsed.sources) {
          const originalName = parsed.name;
          let suffix = 2;
          // References bind by name; a re-upload must not silently review the older file.
          while (get().documents.some((doc) => doc.projectId === projectId && doc.name.toLowerCase() === parsed.name.toLowerCase())) {
            parsed.name = `${originalName} (${suffix++})`;
          }
        }
        prepared = toDocument(parsed, projectId);
      } catch (error) {
        rejected.push(
          error instanceof UnreadableFile
            ? error.message
            : `Não foi possível ler ${file.name}.`,
        );
        continue;
      }

      const { document, chunks } = prepared;

      // The row first, and committed, before anything points at it.
      set((s) => ({ documents: [...s.documents, document] }));
      try {
        await flushWorkspace();
        await store.putChunks(document.id, chunks);
      } catch (error) {
        console.error("could not save the document", error);
        // Rolled back rather than left as a row with no text: a document that
        // resolves to nothing is worse than one that was never added, because
        // it looks available and injects silence.
        set((s) => ({
          documents: s.documents.filter((d) => d.id !== document.id),
        }));
        rejected.push(`Não foi possível salvar ${file.name}.`);
        continue;
      }

      indexDocument(projectId, chunks);
      added.push(document);
    }

    return { added, rejected };
  },

  /*
   * Routing a mixed drop.
   *
   * The split is by what the file *is*, not by what the user aimed at, because
   * the two gestures are indistinguishable: a screenshot and a spec land on the
   * same target in the same motion. A `.md` becomes searchable project
   * knowledge; a `.png` rides with the next prompt, because there is nothing in
   * it to index and the model is the thing that reads it.
   *
   * Attachments are staged, not sent. Nothing has been paid for and nothing is
   * persisted until a prompt goes with them — which is also what makes removing
   * a chip free, unlike deleting a document.
   */
  addFiles: async (files) => {
    const media: File[] = [];
    const text: File[] = [];
    for (const file of files) {
      (isAttachable(file) ? media : text).push(file);
    }

    const rejected: string[] = [];
    const attached: PendingAttachment[] = [];

    const room = MAX_PER_TURN - get().composerAttachments.length;
    if (media.length > room) {
      rejected.push(
        room <= 0
          ? `Uma mensagem leva até ${MAX_PER_TURN} arquivos — envie esta antes de anexar mais.`
          : `Only ${room} more ${room === 1 ? "file" : "files"} fit on this prompt; the rest were left out.`,
      );
    }

    // One at a time. Decoding and downscaling a photo is main-thread work, and
    // doing ten at once janks the window for exactly as long as it takes; in
    // sequence the app stays responsive and the chips appear as they land.
    for (const file of media.slice(0, Math.max(0, room))) {
      try {
        attached.push(await readAttachment(file));
      } catch (error) {
        rejected.push(
          error instanceof UnattachableFile
            ? error.message
            : `Não foi possível ler ${file.name}.`,
        );
      }
    }

    if (attached.length) {
      set((s) => ({
        composerAttachments: [...s.composerAttachments, ...attached],
        // Available to the transcript the moment they are staged, so the chips
        // and the sent message draw from one place rather than two.
        attachmentBlobs: {
          ...s.attachmentBlobs,
          ...Object.fromEntries(attached.map((a) => [a.id, a.dataUrl])),
        },
      }));
    }

    const documents = text.length
      ? await get().addDocuments(text)
      : { added: [], rejected: [] };

    for (const document of documents.added) {
      if (document.review) get().queueDocumentMention(document.name);
    }

    return {
      added: documents.added,
      attached,
      rejected: [...rejected, ...documents.rejected],
    };
  },

  removeAttachment: (id) =>
    set((s) => ({
      composerAttachments: s.composerAttachments.filter((a) => a.id !== id),
    })),

  clearAttachments: () => set({ composerAttachments: [] }),

  setDocumentNotice: (documentNotice) => set({ documentNotice }),

  queueDocumentMention: (name) =>
    set((s) => ({
      documentMentionQueue: [...s.documentMentionQueue, name],
    })),

  clearDocumentMentionQueue: () => set({ documentMentionQueue: [] }),

  deleteDocument: (documentId) => {
    const doc = get().documents.find((d) => d.id === documentId);
    if (!doc) return;

    // The store drops the row; the diff turns that into `deletedDocuments`, and
    // SQLite's cascade takes the chunks. Only the in-memory index has to be told
    // by hand, because it is the one copy no foreign key reaches.
    set((s) => ({
      documents: s.documents.filter((d) => d.id !== documentId),
    }));
    forgetDocument(doc.projectId, documentId);
  },

  createProject: ({ name, description, instructions, workspaceId }) => {
    const state = get();
    const targetWorkspaceId =
      workspaceId && state.workspaces.some((w) => w.id === workspaceId)
        ? workspaceId
        : state.workspaces.some((w) => w.id === state.workspaceId)
          ? state.workspaceId
          : state.workspaces[0]?.id;
    if (!targetWorkspaceId) return "";

    const project: Project = {
      id: uid("p"),
      workspaceId: targetWorkspaceId,
      // The sheet trims before submitting, but so does this: every path in must
      // store the same thing, and a project named "   " has nothing to click on.
      name: name.trim() || "Projeto sem nome",
      description: description?.trim() ?? "",
      instructions: instructions?.trim() ?? "",
      memoryTokens: 0,
    };

    set((s) => ({
      projects: [...s.projects, project],
      workspaceId: project.workspaceId,
      projectId: project.id,
      // Nothing in it yet, so there is no chat to select and nothing pinned in
      // the context panel that still belongs to what the user was looking at.
      chatId: "",
      inspectedMessageId: null,
    }));

    return project.id;
  },

  renameProject: (projectId, name) => get().updateProject(projectId, { name }),

  /**
   * One reducer for every field the sheet can change.
   *
   * A field per action would mean three reducers applying three slightly
   * different readings of "blank" — and the interesting rule here is exactly
   * that reading, so it belongs in one place.
   */
  updateProject: (projectId, patch) =>
    set((s) => {
      const project = s.projects.find((p) => p.id === projectId);
      if (!project) return {};

      const next: Project = { ...project };
      // A blank name reverts rather than erases, the same forgiving reading a
      // cleared chat title gets. A blank description or brief is a legitimate
      // value — "this project has no standing instructions" is a real answer.
      if (patch.name !== undefined) {
        const name = patch.name.trim();
        if (name) next.name = name;
      }
      if (patch.description !== undefined) next.description = patch.description.trim();
      if (patch.instructions !== undefined) {
        // Only the ends: the brief is prose the user formatted on purpose, and
        // collapsing its blank lines would rewrite what they wrote.
        next.instructions = patch.instructions.trim();
      }

      if (
        next.name === project.name &&
        next.description === project.description &&
        next.instructions === project.instructions
      ) {
        // Nothing moved. Returning the same row keeps it out of the next patch —
        // the sheet commits on close, so re-opening it and closing it again must
        // not write.
        return {};
      }

      return {
        projects: s.projects.map((p) => (p.id === projectId ? next : p)),
      };
    }),

  /**
   * Delete a project and everything it owns.
   *
   * The cascade is written out here as well as in SQL because the store is what
   * the views read: leaving a project's decisions in memory until the next
   * launch would show the Decisions view rows belonging to a project that no
   * longer exists, and the composer would keep retrieving them.
   *
   * Memory and the decision log are append-only *within* a project — a later
   * turn cannot retract them. Deleting the project they belong to is the one
   * thing that can, because at that point they have nothing left to be about.
   */
  deleteProject: (projectId) => {
    const { sending, chats, chatId } = get();
    // The index is the one copy of this project's text that no foreign key
    // reaches, so it is the one that has to be told.
    forgetProject(projectId);
    // A turn streaming into a chat in this project has nowhere left to land.
    if (sending && chats.find((c) => c.id === chatId)?.projectId === projectId) {
      get().stopStreaming();
    }

    set((s) => {
      const doomedChats = new Set(
        s.chats.filter((c) => c.projectId === projectId).map((c) => c.id),
      );
      const projects = s.projects.filter((p) => p.id !== projectId);
      const chats = s.chats.filter((c) => !doomedChats.has(c.id));

      /*
       * Only the project the user was in forces a move.
       *
       * Deleting one from the projects grid while a chat is open in another must
       * leave that chat exactly where it was — recomputing the selection either
       * way would silently swap the open conversation for the project's most
       * recent one, which is a change the user did not ask for and would notice
       * only after they had started typing into it.
       */
      const moving = s.projectId === projectId;

      // Prefer a sibling in the same workspace: the user was working in that
      // workspace, and jumping them to another one is a bigger move than the one
      // they made. Falling back to any project keeps the app on something real
      // when the workspace is now empty.
      const successor = moving
        ? (projects.find((p) => p.workspaceId === s.workspaceId) ?? projects[0])
        : projects.find((p) => p.id === s.projectId);

      const inspected = s.messages.find((m) => m.id === s.inspectedMessageId);

      return {
        projects,
        chats,
        messages: s.messages.filter((m) => !doomedChats.has(m.chatId)),
        memory: s.memory.filter((m) => m.projectId !== projectId),
        decisions: s.decisions.filter((d) => d.projectId !== projectId),
        timeline: s.timeline.filter((t) => t.projectId !== projectId),
        documents: s.documents.filter((d) => d.projectId !== projectId),
        projectId: successor?.id ?? "",
        workspaceId: successor?.workspaceId ?? s.workspaceId,
        chatId: moving
          ? successor
            ? firstChatOf(chats, successor.id)
            : ""
          : s.chatId,
        inspectedMessageId:
          inspected && doomedChats.has(inspected.chatId)
            ? null
            : s.inspectedMessageId,
        // The sheet was almost certainly the thing that asked for this.
        projectSheet: s.projectSheet === projectId ? null : s.projectSheet,
        panelReview:
          s.panelReview && doomedChats.has(s.panelReview.chatId)
            ? null
            : s.panelReview,
      };
    });

    if (get().chatId !== chatId) loadAttachmentBlobs(set, get, get().chatId);
  },

  newChat: (modelId) => {
    const { projectId, chats, chatId, catalog } = get();
    // A chat belongs to a project — that is the whole point of the hierarchy, and
    // since the last project can now be deleted there is a real state with none
    // selected. An orphan chat would violate the foreign key and take its whole
    // patch down with it, so the guard is here rather than at each call site.
    // An empty workspace has no project to hold the chat: ask for one first.
    if (!projectId) {
      set({ projectSheet: "new" });
      return;
    }

    // An untouched chat in this project is reused rather than joined by another
    // "Untitled": clicking New chat twice should not leave a trail of empties.
    if (!modelId) {
      const { messages } = get();
      const empty = chats.find(
        (c) => c.projectId === projectId && !messages.some((m) => m.chatId === c.id),
      );
      if (empty) {
        get().selectChat(empty.id);
        return;
      }
    }

    const current = chats.find((c) => c.id === chatId);
    const carried = current?.modelId;
    // Carry the current model forward; fall back to the newest live model
    // before the seed default, so a connected app never opens on a fixture.
    const model =
      modelId ?? (carried && isLive(carried) ? carried : catalog[0]?.id) ??
      carried ??
      "claude-opus-5";
    const now = new Date().toISOString();
    const chat: Chat = {
      id: uid("c"),
      projectId,
      title: "Sem título",
      modelId: model,
      createdAt: now,
      updatedAt: now,
      // The panel carries forward with the model, and for the same reason:
      // someone who works two models against each other is doing that to the
      // project, not to one conversation. Not carried when the caller named a
      // model — that is "new chat *on this model*", an explicit narrowing.
      ...panelPatch(model, modelId ? undefined : current?.panel),
    };
    set((s) => ({
      chats: [chat, ...s.chats],
      chatId: chat.id,
      view: "chat",
      panelReview: null,
      // A brand-new chat has nothing attached and nothing to load — and the
      // files staged for the prompt being abandoned do not follow.
      composerAttachments: [],
      attachmentBlobs: {},
    }));
  },

  forkChat: (chatId, messageId, modelId) => {
    const { chats, messages } = get();
    const source = chats.find((c) => c.id === chatId);
    if (!source) return;

    const transcript = messages.filter((m) => m.chatId === chatId);
    const cut = transcript.findIndex((m) => m.id === messageId);
    if (cut === -1) return;

    /*
     * A fork is one line through the conversation, so it carries one answer per
     * turn — the one that was taken, except at the turn being forked from, where
     * it carries the one being forked from. That is what makes "fork from this
     * alternative" mean anything: a fork that also carried the sibling the user
     * passed over would open on two answers to the same prompt, neither of them
     * the history the new chat is supposed to continue.
     *
     * The copies then drop `turnId` and `canonical` entirely. Their group no
     * longer exists here, and a lone member of a group that is not present is a
     * row every reader downstream would have to special-case.
     */
    const forked = transcript[cut]!;
    const carried = transcript
      .slice(0, cut + 1)
      .filter((m) => {
        if (!m.turnId) return true;
        if (m.turnId === forked.turnId) return m.id === messageId;
        return m.canonical === true;
      })
      .map((m) =>
        m.turnId ? { ...m, turnId: undefined, canonical: undefined } : m,
      );

    const now = new Date().toISOString();
    const fork: Chat = {
      id: uid("c"),
      projectId: source.projectId,
      title: `${source.title} (fork)`,
      modelId,
      createdAt: now,
      updatedAt: now,
      forkedFrom: { chatId, messageId },
    };

    /*
     * Original context preserved: the carried messages are copied, not moved.
     *
     * Attachments are copied too, and re-identified rather than shared. Their
     * rows hang off a message id and carry a chat id, so a copy pointing at the
     * original's bytes would read back as nothing the next time the fork is
     * opened — the picture would be in the transcript on screen and gone after a
     * reload. New ids for new rows; the bytes themselves are looked up from what
     * is already in memory.
     */
    const blobs = get().attachmentBlobs;
    const copiedBlobs: Record<string, string> = {};
    const copiedRows: StoredAttachment[] = [];

    const copies = carried.map((m) => {
      const id = uid("m");
      const copy: Message = { ...m, id, chatId: fork.id };
      if (!m.attachments?.length) return copy;

      copy.attachments = m.attachments.map((attachment) => {
        const next = {
          ...attachment,
          id: uid("att"),
          messageId: id,
          chatId: fork.id,
        };
        const data = blobs[attachment.id];
        if (data) {
          copiedBlobs[next.id] = data;
          copiedRows.push({
            id: next.id,
            messageId: id,
            chatId: fork.id,
            data,
          });
        }
        return next;
      });
      return copy;
    });

    const event: TimelineEvent = {
      id: uid("t"),
      projectId: source.projectId,
      date: now,
      modelId,
      summary: `Forked ${source.title} at message ${messageId.slice(0, 8)}`,
      kind: "fork",
      refId: fork.id,
    };

    set((s) => ({
      chats: [fork, ...s.chats],
      messages: [...s.messages, ...copies],
      timeline: [...s.timeline, event],
      chatId: fork.id,
      view: "chat",
      panelReview: null,
      composerAttachments: [],
      // The fork opens on exactly the bytes that were carried into it, so the
      // transcript paints without waiting for a read.
      attachmentBlobs: copiedBlobs,
    }));

    // The same ordering rule an upload obeys: the message rows have to be
    // committed before anything carries a foreign key to them. Not awaited —
    // the fork is already on screen and usable, and a failure costs the copies'
    // pictures on the next launch rather than the fork.
    if (copiedRows.length) {
      void flushWorkspace()
        .then(() => store.putAttachments(copiedRows))
        .catch((error) =>
          console.error("could not copy this fork's attachments", error),
        );
    }
  },

  setChatModel: (chatId, modelId) =>
    set((s) => ({
      chats: s.chats.map((c) =>
        c.id === chatId
          ? // Re-normalised, not just assigned: promoting a panel member to
            // primary must not leave it in the panel as well, or it would
            // answer the next turn twice and be billed twice for it.
            { ...c, modelId, ...panelPatch(modelId, c.panel) }
          : c,
      ),
    })),

  setChatPanel: (chatId, modelIds) =>
    set((s) => ({
      chats: s.chats.map((c) =>
        c.id === chatId ? { ...c, ...panelPatch(c.modelId, modelIds) } : c,
      ),
    })),

  promoteAnswer: (messageId) =>
    set((s) => {
      const target = s.messages.find((m) => m.id === messageId);
      if (!target?.turnId) return {};

      // The answer that continues the transcript and the model that receives
      // its next turn must move together. A legacy row can lack modelId, in
      // which case preserving the history choice is still safer than guessing
      // a primary model.
      const modelId = target.modelId;
      const chat = modelId
        ? s.chats.find((candidate) => candidate.id === target.chatId)
        : undefined;
      const needsModelPromotion = Boolean(
        chat && modelId && chat.modelId !== modelId,
      );

      // A promotion that already matches both the transcript and the primary
      // model must not rewrite a row — the sync layer diffs on identity, and a
      // no-op write would put the whole turn back through SQLite for nothing.
      if (target.canonical && !needsModelPromotion) return {};

      return {
        ...(target.canonical
          ? {}
          : {
              messages: s.messages.map((m) =>
                m.turnId === target.turnId
                  ? { ...m, canonical: m.id === messageId }
                  : m,
              ),
            }),
        ...(chat && modelId
          ? {
              chats: s.chats.map((candidate) =>
                candidate.id === chat.id
                  ? {
                      ...candidate,
                      ...promotePanelPrimary(candidate, modelId),
                    }
                  : candidate,
              ),
            }
          : {}),
      };
    }),

  renameChat: (chatId, title) => {
    // Trimmed here rather than at the call site, so every path into a rename —
    // the rail, the chat header, anything added later — stores the same thing,
    // and a title of pure whitespace cannot reach the store at all.
    const next = title.trim();
    if (!next) return;
    set((s) => ({
      chats: s.chats.map((c) =>
        c.id === chatId && c.title !== next ? { ...c, title: next } : c,
      ),
    }));
  },

  deleteChat: (chatId) => {
    // A turn streaming into this chat has nowhere left to land. Only one chat
    // sends at a time, so the open stream is necessarily this one's — leaving it
    // running would keep the connection (and the provider's meter) alive for an
    // answer no one can read.
    if (get().sending && get().chatId === chatId) get().stopStreaming();

    const wasOpen = get().chatId;

    set((s) => {
      const chats = s.chats.filter((c) => c.id !== chatId);
      return {
        chats,
        messages: s.messages.filter((m) => m.chatId !== chatId),
        // The context panel may be pinned to a message that is about to stop
        // existing.
        inspectedMessageId: s.messages.some(
          (m) => m.id === s.inspectedMessageId && m.chatId === chatId,
        )
          ? null
          : s.inspectedMessageId,
        chatId: s.chatId === chatId ? firstChatOf(chats, s.projectId) : s.chatId,
        panelReview: s.panelReview?.chatId === chatId ? null : s.panelReview,
      };
    });

    if (get().chatId !== wasOpen) loadAttachmentBlobs(set, get, get().chatId);
  },

  send: async (prompt) => {
    const { chatId, chats, messages } = get();
    const chat = chats.find((c) => c.id === chatId);
    if (!chat || !prompt.trim() || get().sending) return;

    const history = messages.filter((m) => m.chatId === chatId);

    /*
     * The one caller that waits for the query vector.
     *
     * Everything else that composes runs on a debounce and reads whatever is
     * cached, because a round-trip per keystroke is not worth it. This
     * composition *is* the prompt: a turn that quietly went out with
     * lexical-only context is indistinguishable afterwards from one that had
     * nothing to find, and the user would be looking at a confident answer built
     * from the wrong half of their workspace. One embedding of one sentence, on
     * a gesture the user already expects to take a moment.
     */
    await embedQuery(prompt);

    // Read after the await, not before: embedding a sentence takes long enough
    // for a paste to land, and a file staged inside that window would otherwise
    // be cleared below without ever having been sent.
    const composerAttachments = get().composerAttachments;

    const plan = planTurn(
      set,
      get,
      chat,
      prompt,
      history,
      undefined,
      composerAttachments,
    );

    const now = new Date().toISOString();
    const messageId = uid("m");
    const attachments = composerAttachments.map((pending) =>
      toAttachment(pending, messageId, chatId),
    );
    const userMessage: Message = {
      id: messageId,
      chatId,
      role: "user",
      content: prompt,
      createdAt: now,
      ...(attachments.length ? { attachments } : null),
    };

    /*
     * One row per answering model, appended contiguously and in plan order —
     * `groupTranscript` and `lastAnswerGroup` both read that adjacency, and
     * `runTurns` pairs these with `plan.runs` by index.
     *
     * A turn that cannot leave writes one row regardless of the panel. Four
     * copies of "no provider connected" is four ways of saying the same thing,
     * and the group would be a comparison of nothing.
     */
    const runs = plan.guard ? plan.runs.slice(0, 1) : plan.runs;
    const turnId = runs.length > 1 ? uid("turn") : null;
    const placeholders: Message[] = runs.map((run, index) => ({
      id: uid("m"),
      chatId,
      role: "assistant",
      modelId: run.modelId,
      content: "",
      createdAt: now,
      context: run.context,
      pending: !plan.guard,
      error: plan.guard ?? undefined,
      // The primary model's answer is the conversation until the user says
      // otherwise. It has to be decided here rather than once the answers are
      // in: `retry`, an export or a reload between the two would otherwise meet
      // a group with no canonical member and no way to pick one.
      ...(turnId ? { turnId, canonical: index === 0 } : null),
    }));

    set((s) => ({
      messages: [...s.messages, userMessage, ...placeholders],
      sending: !plan.guard,
      chats: s.chats.map((c) =>
        c.id === chatId
          ? {
              ...c,
              updatedAt: now,
              title: c.title === "Sem título" || c.title === "Untitled" ? deriveTitle(prompt) : c.title,
            }
          : c,
      ),
      // Cleared whether or not the turn can leave. A guarded turn still put the
      // prompt in the transcript with its files listed on it, so leaving them
      // staged would attach them to the next prompt as well.
      composerAttachments: [],
    }));

    if (attachments.length) {
      await persistAttachments(composerAttachments, messageId, chatId);
    }

    if (plan.guard) return;

    await runTurns(set, get, {
      targetIds: placeholders.map((m) => m.id),
      chatId,
      prompt,
      attachments,
      history,
      plan,
    });
  },

  /**
   * Run the last answer again — after a failure, or because it was a poor one.
   *
   * Restricted to the last message in the chat, and deliberately so. Re-running
   * an answer in the middle would have to discard every turn that followed it,
   * because those were replies to text that no longer exists; silently deleting
   * a user's afternoon is not a reasonable reading of a button labelled
   * "Regenerate". Fork is the gesture for reconsidering an older turn, and it
   * keeps the original.
   *
   * The answer streams back into the *same message row* rather than into a
   * replacement. That is not a micro-optimisation: the persistence diff has no
   * concept of a deleted message — one only leaves when its chat does — so a
   * retry that dropped the old row and appended a new one would leave the
   * failed turn in SQLite, invisible until the next launch brought it back.
   *
   * Two gestures reach this, and a panel tells them apart.
   *
   * **Regenerate**, on an answer that worked, re-runs the whole turn. Re-rolling
   * one member would leave a comparison between a fresh answer and three older
   * ones — composed against a project that may have learned something in
   * between — which is not a comparison of models any more.
   *
   * **Retry**, in a failed answer's error box, repairs that row alone. The
   * failure is the only thing wrong with the turn: its siblings answered the
   * same prompt and are still on screen, and re-running them would delete three
   * good answers, and re-bill them, to recover one. The panel exists so that one
   * model rate-limiting does not cost the turn; a repair that discarded the
   * survivors would spend the panel's whole value on its worst member.
   *
   * Either way the answers stream back into the rows already there, which is
   * also what keeps a partial repair expressible at all — a panel that grew or
   * shrank on retry would need rows the diff cannot remove.
   */
  retry: async (messageId) => {
    const { chats, messages, sending } = get();
    if (sending) return;

    const target = messages.find((m) => m.id === messageId);
    if (!target || target.role !== "assistant") return;

    const chat = chats.find((c) => c.id === target.chatId);
    if (!chat) return;

    const transcript = messages.filter((m) => m.chatId === target.chatId);
    const group = lastAnswerGroup(transcript);
    if (!group.some((m) => m.id === messageId)) return;

    // The prompt this answered. A turn always arrives as prompt-then-answers,
    // so anything else here means a transcript we did not write and should not
    // act on.
    const asked = transcript[transcript.length - group.length - 1];
    if (!asked || asked.role !== "user") return;

    const history = transcript.slice(0, transcript.length - group.length - 1);

    // Repairing a failure touches only the row that failed; regenerating a
    // working answer re-runs the turn it belongs to.
    const rerun = target.error ? [target] : group;

    /*
     * Re-composed rather than reused: the composer's budget is a fraction of the
     * target model's window, and project memory and the decision log may have
     * grown in between — which is often exactly why someone is asking again.
     *
     * The models, though, are the ones that wrote these rows and not whatever
     * the chat's panel says today. That keeps the runs aligned one-to-one with
     * the rows being rewritten, and it keeps regenerate meaning "these models,
     * again" rather than silently re-casting the comparison. Changing the panel
     * and sending afresh is the gesture for that.
     */
    // Same reason as `send`: this recomposition is the prompt that goes out.
    await embedQuery(asked.content);

    const plan = planTurn(
      set,
      get,
      chat,
      asked.content,
      history,
      rerun.map((m) => m.modelId ?? chat.modelId),
      // The files that prompt was sent with, not whatever is staged now — a
      // retry re-runs a turn that already happened.
      asked.attachments ?? [],
    );

    const cleared = new Map(
      rerun.map((m, i) => [m.id, clearedForRetry(m, plan.runs[i]!, plan.guard)]),
    );

    set((s) => ({
      messages: s.messages.map((m) => cleared.get(m.id) ?? m),
      sending: !plan.guard,
    }));

    if (plan.guard) return;

    await runTurns(set, get, {
      targetIds: rerun.map((m) => m.id),
      chatId: target.chatId,
      prompt: asked.content,
      attachments: asked.attachments,
      history,
      plan,
      // The whole turn, even when only one row of it is being rewritten: which
      // answer *is* the conversation is a question about the turn, and a repair
      // can change the answer.
      turnIds: group.map((m) => m.id),
    });
  },

}));

/* ---------------------------------------------------------------------- */

/** Write installed skills through to storage as the state slice is returned. */
function persistSkills(skills: Record<string, SkillMode>): { skills: Record<string, SkillMode> } {
  writeSkillModes(skills);
  return { skills };
}

function deriveTitle(prompt: string): string {
  const words = prompt.replace(/@\w+\([^)]*\)/g, "").trim().split(/\s+/);
  return words.slice(0, 8).join(" ").replace(/[.,:;]$/, "") || "Sem título";
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/* ---------------------------------------------------------------------- */
/* Model adapter — the box the PRD draws between Prompt Builder and the     */
/* providers. Everything above this line is provider-agnostic.             */
/* ---------------------------------------------------------------------- */

/** Ids of turns currently streaming, so stop can reach all of them. */
const activeStreams = new Set<string>();

interface TurnResult {
  text: string;
  reasoning: string;
  promptTokens: number | null;
  estimatedPromptTokens?: number;
  completionTokens: number | null;
  cachedPromptTokens?: number | null;
  costUsd: number | null;
  latencyMs: number;
  error: string | null;
  cancelled: boolean;
  finishReason?: string | null;
}

/**
 * Run one streamed turn to completion.
 *
 * Deltas arrive per token, and writing each one straight into the store would
 * re-render the transcript a hundred times a second for text the display can
 * only show sixty times a second. They are coalesced onto animation frames
 * instead: the same visible result, a fraction of the work, and the paint
 * stays in step with the browser rather than racing it.
 */
async function runTurn({
  provider,
  zaiPlan,
  request,
  onText,
  onReasoning,
  onLimits,
  purpose = "answer",
  signal,
}: {
  purpose?: "answer" | "planning";
  signal?: AbortSignal;
  provider: ProviderKey;
  zaiPlan: ZaiPlan;
  request: ChatRequest;
  onText: (text: string) => void;
  onReasoning?: (text: string) => void;
  /** The provider corrected the model's catalogued limits mid-turn. */
  onLimits?: (limits: {
    model: string;
    contextLength: number;
    maxOutput: number | null;
  }) => void;
}): Promise<TurnResult> {
  const streamId = uid("s");
  activeStreams.add(streamId);

  const started = performance.now();
  const result: TurnResult = {
    text: "",
    reasoning: "",
    promptTokens: null,
    completionTokens: null,
    costUsd: null,
    latencyMs: 0,
    error: null,
    cancelled: false,
  };

  const paintText = frameBatched(onText);
  const paintReasoning = onReasoning ? frameBatched(onReasoning) : null;

  let receiving = true;
  /** Re-arms the silence timer; replaced once the request is in flight. */
  let touch = () => {};
  const handle = (event: StreamEvent) => {
    if (!receiving) return;
    touch();
    switch (event.type) {
      case "delta":
        result.text += event.text;
        paintText.push(result.text);
        break;
      case "reasoning":
        result.reasoning += event.text;
        paintReasoning?.push(result.reasoning);
        break;
      case "usage":
        result.promptTokens = event.promptTokens;
        result.completionTokens = event.completionTokens;
        result.cachedPromptTokens = event.cachedPromptTokens ?? null;
        result.costUsd = event.cost;
        break;
      case "limits":
        // Not batched onto a frame like the text: this arrives once, at the
        // end, and it changes a number the context meter reads rather than
        // anything being painted per token.
        onLimits?.({
          model: event.model,
          contextLength: event.contextLength,
          maxOutput: event.maxOutput,
        });
        break;
      case "rateLimits":
        recordRateLimits(provider, event.info, useStore.getState().connection.agent?.plan ?? null);
        break;
      case "done":
        result.cancelled = event.cancelled;
        result.finishReason = event.finishReason;
        if (!event.cancelled) result.error ??= completionError(result.text, event.finishReason);
        break;
      case "error":
        result.error = event.message;
        break;
      case "open":
      case "alive":
        break;
      default: {
        const _exhaustive: never = event;
        return _exhaustive;
      }
    }
  };

  let callId: string | undefined;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  let idle: ReturnType<typeof setTimeout> | undefined;
  const model = getModel(request.model);
  const subscription = isAgentKey(provider) || (provider === "zai" && zaiPlan === "coding");
  const priced = Boolean(model.live || model.costIn || model.costOut);
  const textInput = request.messages.map((m) => typeof m.content === "string" ? m.content : m.content.filter((p) => p.type === "text").map((p) => p.text).join("\n")).join("\n");
  result.estimatedPromptTokens = estimateTokens(textInput);
  const inputCeiling = new TextEncoder().encode(textInput).length + request.messages.length * 32;
  const multimodal = request.messages.some((m) => Array.isArray(m.content) && m.content.some((p) => p.type !== "text"));
  const budgeted = useResearchSettings.getState().monthlyBudget !== null;
  const boundedRequest = budgeted && !subscription && !request.maxTokens ? { ...request, maxTokens: Math.min(model.maxOutput ?? 8192, 8192) } : request;
  const ceiling = subscription ? 0 : priced && !multimodal && boundedRequest.maxTokens
    ? (inputCeiling * model.costIn + boundedRequest.maxTokens * model.costOut) / 1e6 : null;
  const abort = () => adapter.cancel(provider, streamId);
  signal?.addEventListener("abort", abort, { once: true });
  try {
    signal?.throwIfAborted();
    callId = reserveCall({ provider: provider === "zai" && zaiPlan === "coding" ? "zai-coding" : provider, model: request.model, purpose }, ceiling);
    // Silence, not duration: a 180k-token review can stream for many minutes,
    // but three minutes with no event at all means the stream is dead.
    const interrupted = new Promise<never>((_resolve, reject) => {
      const fail = (message: string) => { abort(); reject(new Error(message)); };
      touch = () => {
        clearTimeout(idle);
        idle = setTimeout(() => fail("Sem resposta do modelo por 180s. Tente novamente."), 180_000);
      };
      touch();
      timeout = setTimeout(() => fail("Tempo limite da resposta excedido (15 min). Tente novamente."), 15 * 60_000);
    });
    if (purpose === "answer") captureRequest(callId, provider, boundedRequest, zaiPlan);
    await Promise.race([adapter.chat(provider, streamId, boundedRequest, handle, { zaiPlan }), interrupted]);
  } catch (error) {
    if (signal?.aborted) result.cancelled = true;
    else result.error ??= messageOf(error);
  } finally {
    receiving = false;
    if (subscription) result.costUsd = 0;
    if (timeout) clearTimeout(timeout);
    clearTimeout(idle);
    signal?.removeEventListener("abort", abort);
    if (callId) {
      const input = result.promptTokens ?? estimateTokens(textInput);
      const output = result.completionTokens ?? estimateTokens(result.text + result.reasoning);
      const hasUsage = result.promptTokens !== null && result.completionTokens !== null;
      const cost = subscription ? 0 : result.costUsd ?? (hasUsage && priced ? (input * model.costIn + output * model.costOut) / 1e6 : null);
      settleCall(callId, {
        status: result.error ? "error" : result.cancelled ? "cancelled" : "done",
        inputTokens: result.promptTokens, outputTokens: result.completionTokens,
        finishReason: result.finishReason ?? null,
        cachedInputTokens: result.cachedPromptTokens ?? null,
        ...(cost !== null ? { costUsd: cost } : !result.error && !result.cancelled && priced ? { costUsd: (input * model.costIn + output * model.costOut) / 1e6 } : {}),
        estimated: !subscription && result.costUsd === null,
      });
    }
    activeStreams.delete(streamId);
    // Flush whatever the last frame did not get, so the final text on screen
    // is the complete text and not one batch short of it.
    paintText.flush();
    paintReasoning?.flush();
    result.latencyMs = Math.round(performance.now() - started);
  }

  return result;
}

/** Coalesce a rapid series of values into at most one call per frame. */
function frameBatched<T>(sink: (value: T) => void) {
  let pending: T | null = null;
  let frame = 0;

  return {
    push(value: T) {
      pending = value;
      if (frame) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        if (pending !== null) sink(pending);
        pending = null;
      });
    },
    flush() {
      if (frame) cancelAnimationFrame(frame);
      frame = 0;
      if (pending !== null) sink(pending);
      pending = null;
    },
  };
}

/**
 * Token and cost accounting.
 *
 * Provider-reported numbers win: they are what the user is billed for. The
 * estimates only stand in when a provider omits usage, and the input estimate
 * is the composer's own budget figure so the Context panel and the transcript
 * cannot disagree.
 */
/** Input price in USD×1e6: cache hits at the cache-read rate when the model has one. */
export function inputCost(
  inTokens: number,
  cached: number | null | undefined,
  model: { costIn: number; costCacheRead?: number },
): number {
  const hit = model.costCacheRead === undefined ? 0 : Math.min(cached ?? 0, inTokens);
  return hit * (model.costCacheRead ?? 0) + (inTokens - hit) * model.costIn;
}

function accountFor(
  result: TurnResult,
  composedTokens: number,
  modelId: string,
): {
  usage: { in: number; out: number; latencyMs: number; cached?: number };
  costUsd: number | undefined;
} {
  const model = getModel(modelId);
  const inTokens = result.promptTokens ?? result.estimatedPromptTokens ?? composedTokens;
  const outTokens = result.completionTokens ?? estimateTokens(result.text);

  return {
    usage: {
      in: inTokens, out: outTokens, latencyMs: result.latencyMs,
      ...(result.cachedPromptTokens != null ? { cached: result.cachedPromptTokens } : {}),
    },
    costUsd:
      result.costUsd ??
      (model.costIn || model.costOut
        ? (inputCost(inTokens, result.cachedPromptTokens, model) + outTokens * model.costOut) / 1e6
        : undefined),
  };
}

/* ---------------------------------------------------------------------- */
/* One turn, shared by `send` and `retry`                                   */
/* ---------------------------------------------------------------------- */

type SetState = (
  partial: Partial<State> | ((state: State) => Partial<State>),
) => void;

/** One model's share of a turn: what it will be sent, and by whom. */
interface TurnRun {
  modelId: string;
  /**
   * Composed against *this* model's window, not the chat's primary one. The
   * retrieval budget is a fraction of the target's context length, so a panel
   * that composed once and reused it would either starve the large model or
   * overrun the small one — and the comparison would be between two prompts
   * rather than between two models.
   */
  context: ComposedContext;
}

/** Everything a turn needs decided before any of it reaches the transcript. */
interface TurnPlan {
  /** One per answering model, primary first. Never empty. */
  runs: TurnRun[];
  /**
   * Captured here rather than re-read when the turn settles. A stream can run
   * for a minute, and a user who switches project during one would otherwise
   * have its distilled knowledge filed under wherever they happened to land.
   */
  projectId: string;
  project: Project | undefined;
  /** Why the turn cannot leave, or null. Becomes the message's error. */
  guard: string | null;
}

/**
 * Work out which models answer, what each is sent, and whether the turn can
 * leave at all.
 *
 * Split out because `send` and `retry` differ only in which assistant rows the
 * answers land in — everything upstream of that is the same pipeline, and two
 * copies of it would drift the day one of them learns something the other does
 * not.
 *
 * `only` names the models verbatim, skipping the seed-id realignment below.
 * Regenerate passes it: those rows were written by models that had already been
 * realigned, and re-resolving them could map two of them onto the same live
 * model, leaving fewer runs than rows to write into.
 */
function planTurn(
  set: SetState,
  get: () => State,
  chat: Chat,
  prompt: string,
  history: Message[],
  only?: readonly string[],
  attachments: readonly { kind: AttachmentKind; name: string }[] = [],
): TurnPlan {
  // Resolve before composing: the token budget is a fraction of each target
  // model's window, so composing against a model we are not going to use would
  // size the context wrong.
  const modelIds = only ?? sendableModels(set, get, chat);
  const { projectId, projects, skills } = get();

  // Armed once and shared. Skills are instructions about how to work, so a
  // panel whose members were told to work differently would not be comparing
  // models — and arming per run would let the same prompt produce different
  // skill sets from identical inputs.
  const armed = activeSkills(skills);

  // The pipeline runs before the request, invisibly (PRD: Context Composer).
  const runs: TurnRun[] = modelIds.map((modelId) => ({
    modelId,
    context: compose(prompt, projectId, modelId, armed, history),
  }));

  // Memory that actually reached the model gets credited for it. This is the
  // only honest measure of whether an entry earns its place in the index — one
  // that is never injected is dead weight the user should be able to see. A turn
  // that never leaves therefore credits nothing, which is why the connection is
  // checked before the counters move rather than after.
  //
  // The attachment check runs second because it names a model, and "no provider
  // connected" is the more useful sentence when neither is satisfied. The
  // composer refuses the send long before this — this is the backstop for a
  // model swapped between staging a file and pressing return.
  const guard =
    notConnected(get) ??
    attachmentGuard(
      attachments,
      get().connection.provider,
      modelIds.map(getModel),
    );

  return {
    runs,
    projectId,
    project: projects.find((p) => p.id === projectId),
    guard,
  };
}

/**
 * The same assistant row, emptied out and ready to be streamed into again.
 *
 * Every field the last attempt produced has to go, not just the visible ones: a
 * retry that kept `usage` would price the new answer at the old one's token
 * count, and one that kept `candidates` would leave the user accepting project
 * knowledge distilled from text that is no longer on screen.
 *
 * `turnId` and `canonical` are the two that stay. They describe the row's place
 * in the transcript rather than the attempt it holds, and clearing them would
 * dissolve the group mid-regenerate — leaving four answers that no longer know
 * they answer one prompt, and a history that carries all four.
 */
function clearedForRetry(
  message: Message,
  run: TurnRun,
  guard: string | null,
): Message {
  return {
    ...message,
    modelId: run.modelId,
    context: run.context,
    content: "",
    reasoning: undefined,
    error: guard ?? undefined,
    stopped: undefined,
    usage: undefined,
    costUsd: undefined,
    candidates: undefined,
    research: undefined,
    researchStage: undefined,
    pending: !guard,
  };
}

/**
 * Stream one model's answer into a row that is already in the transcript.
 *
 * Paints as it goes and returns what it got; it deliberately does not settle
 * the row. Settling is a decision about the whole turn — see `runTurns`.
 */
async function streamAnswer(
  set: SetState,
  get: () => State,
  args: {
    targetId: string;
    prompt: string;
    history: Message[];
    plan: TurnPlan;
    run: TurnRun;
    /** Files sent with this prompt, if any. */
    attachments?: readonly Attachment[];
  },
): Promise<TurnResult> {
  const { targetId, prompt, history, plan, run, attachments } = args;

  /** Rewrite the row being streamed into, leaving every other message alone. */
  const paint = (change: Partial<Message>) =>
    set((s) => ({
      messages: s.messages.map((m) =>
        m.id === targetId ? { ...m, ...change } : m,
      ),
    }));

  const provider = get().connection.provider;
  const zaiPlan = get().connection.zaiPlan;
  const model = getModel(run.modelId);
  /*
   * Resolved per run, not per turn, and that is the point of doing it here.
   * A panel composes each member's context against its own window; the same
   * holds for what each member can be shown. The guard has already refused a
   * turn whose *new* attachments a model cannot take, so what this decides in
   * practice is the history: a chat that swapped to a text-only model still
   * replays, with the pictures named rather than sent.
   */
  const support = attachmentSupport(provider, model);
  const blobs = get().attachmentBlobs;

  const request: ChatRequest = {
    model: run.modelId,
    messages: buildMessages({
      context: run.context,
      history,
      prompt,
      attachments,
      resolveAttachment: (attachment) => attachmentPart(attachment, blobs[attachment.id], support),
      projectName: plan.project?.name ?? "this project",
      projectDescription: plan.project?.description,
    }),
    effort: get().effort,
    fast: get().fast,
    pdfEngine: pdfEngineFor(provider, model),
  };
  try {
    return await new ResearchOrchestrator().run({
      question: prompt,
      recentQuestions: history.filter((m) => m.role === "user").map((m) => m.content),
      request,
      prior: history.filter((m) => m.role === "assistant" && m.canonical !== false && m.research).map((m) => m.research!),
      onStage: (researchStage) => paint({ researchStage }),
      onResearch: (research) => paint({ research: { ...research } }),
      execute: (prepared, purpose, signal) => runTurn({
        provider, zaiPlan, request: prepared, purpose, signal,
        onLimits: (limits) => applyLimits(set, get, limits),
        onText: purpose === "answer" ? (content) => paint({ content }) : () => {},
        onReasoning: purpose === "answer" ? (reasoning) => paint({ reasoning }) : undefined,
      }),
    });
  } catch (error) {
    const cancelled = /cancel|abort/i.test(messageOf(error));
    return { text: "", reasoning: "", promptTokens: null, completionTokens: null, costUsd: null,
      latencyMs: 0, error: cancelled ? null : messageOf(error), cancelled };
  } finally { paint({ researchStage: undefined }); }

}

/**
 * Run every model of one turn, then settle the turn.
 *
 * The runs are genuinely concurrent. A panel that answered in sequence would
 * take as long as the sum of its models rather than as long as its slowest, and
 * the latency figures the panel exists to expose would measure queue position
 * instead of the model.
 *
 * Everything after them lands in a single `set`, whether one model answered or
 * four. That is the same "one transition, not two" the single-model path always
 * had, and it matters more here: the composer re-enables with `sending`, and a
 * settle split across runs would let it accept a prompt while rows of the turn
 * it is replacing still read as pending.
 */
async function runTurns(
  set: SetState,
  get: () => State,
  args: {
    /** The assistant rows the answers are written into, parallel to `plan.runs`. */
    targetIds: string[];
    chatId: string;
    prompt: string;
    /** Files the prompt was sent with, so every model of the turn gets them. */
    attachments?: readonly Attachment[];
    history: Message[];
    plan: TurnPlan;
    /**
     * Every row of the turn these answers belong to, when that is more than the
     * rows being written — a repair re-running one failed member of a panel.
     *
     * Defaults to `targetIds`, which is the truth for a send and for a whole-turn
     * regenerate. It exists because canonicality is a property of the turn: with
     * only the rewritten rows in view, a repair cannot tell whether the answer
     * that *is* the conversation is one of them, and would either distil from a
     * sibling nobody promoted or leave the turn with two canonical rows.
     */
    turnIds?: string[];
  },
): Promise<void> {
  const { targetIds, chatId, prompt, attachments, history, plan } = args;
  const turnIds = args.turnIds ?? targetIds;

  const results = await Promise.all(
    plan.runs.map((run, index) =>
      streamAnswer(set, get, {
        targetId: targetIds[index]!,
        prompt,
        attachments,
        history,
        plan,
        run,
      }),
    ),
  );

  /*
   * The write half of the loop: read the finished turn back and propose what
   * deserves to outlive this chat. Runs on the complete text, never mid-stream,
   * and never on a turn the user cut short — half an answer is not a fact the
   * project should inherit.
   *
   * Once per turn, on the canonical answer alone. Distilling every member of a
   * panel would flood the proposal queue with four near-identical readings of
   * one exchange — and worse, with contradictory ones, which the user would be
   * asked to adjudicate as if they were separate discoveries. The canonical
   * answer is the one the project actually took; it is the one the project
   * should learn from. It is re-read from the store rather than assumed to be
   * the first run, because a stream can last a minute and the user may have
   * promoted a different answer inside it.
   */
  const isPanel = turnIds.length > 1;

  /*
   * How each row of the turn stands now that these runs are done.
   *
   * Read from the results for the rows this call rewrote and from the store for
   * the rest, because a repair leaves siblings it never touched — and those
   * siblings are most of the reason the turn still has a good answer at all.
   */
  const answered = new Map(targetIds.map((id, index) => [id, results[index]!]));
  const rows = turnIds.map((id) => {
    const result = answered.get(id);
    const message = get().messages.find((m) => m.id === id);
    return {
      id,
      canonical: message?.canonical !== false,
      failed: result ? Boolean(result.error) : Boolean(message?.error),
      usable: result
        ? !result.error && result.text.trim() !== ""
        : Boolean(message && !message.error && message.content.trim() !== ""),
    };
  });

  /*
   * A rescue, not an override — see `canonicalAfter`. Off a panel there is
   * nothing to choose between, and the single row stays the conversation
   * whether it worked or not.
   */
  const canonicalId = isPanel ? canonicalAfter(rows) : targetIds[0]!;

  const settled = new Map<string, Partial<Message>>();

  // Restated across the whole turn so it always holds exactly one canonical row,
  // even when the rescue above promoted a row this call did not run — the
  // sibling that has to be demoted for it is one of the ones left alone.
  // Omitted entirely off a panel, so an ordinary answer never grows a flag that
  // means nothing on it.
  if (isPanel) {
    for (const row of rows) settled.set(row.id, { canonical: row.id === canonicalId });
  }

  for (const [index, result] of results.entries()) {
    const id = targetIds[index]!;
    const run = plan.runs[index]!;
    const usage = accountFor(result, run.context.finalTokens, run.modelId);

    settled.set(id, {
      ...settled.get(id),
      // Authoritative copy — not "whatever the last paint frame held". The
      // first frame of `send` already flushed an empty placeholder (it also
      // touched the chat row, so it was deliberate); if we settle without
      // writing the text, that empty row is what a remount or a reload puts
      // back on screen.
      content: result.text,
      reasoning: result.reasoning || undefined,
      pending: false,
      error: result.error ?? undefined,
      stopped: result.cancelled || undefined,
      // A failed run has no usage worth quoting; the row shows its error.
      usage: result.error ? undefined : usage.usage,
      costUsd: result.error ? undefined : usage.costUsd,
    });
  }

  set((s) => ({
    sending: false,
    messages: s.messages.map((m) => {
      const change = settled.get(m.id);
      return change ? { ...m, ...change } : m;
    }),
  }));

  const settledTurnId = isPanel
    ? get().messages.find((message) => message.id === turnIds[0])?.turnId
    : undefined;
  const settledAnswers = settledTurnId
    ? answersForTurn(get().messages, chatId, settledTurnId)
    : [];
  const state = get();
  if (
    settledTurnId &&
    state.chatId === chatId &&
    state.view === "chat" &&
    !state.panelReview &&
    canReviewPanelTurn(settledAnswers)
  ) {
    state.openPanelReview(chatId, settledTurnId);
  }

  // Message-only patches wait on the 400ms debounce. Settling is the moment the
  // transcript becomes durable — leaving the chat, remounting sync, or quitting
  // before that timer fires used to resurrect the empty placeholder.
  await flushWorkspace();
}

/** The sentence to fail a turn with when there is no key. */
function notConnected(get: () => State): string | null {
  if (get().connection.status === "connected") return null;
  return "Nenhum provedor conectado. Adicione uma chave de API nas configurações para enviar esta mensagem.";
}

/**
 * The models this chat can actually send to, primary first.
 *
 * Seed ids are fixtures, not real provider slugs, so once a live catalog
 * exists a chat still pointing at one needs a real destination. The swap is
 * recorded on the chat rather than done per-request, so the picker shows what
 * will actually run.
 *
 * Deduplicated *after* the swap, not before: two different seed ids can match
 * the same live model, and a panel that sent to it twice would pay twice to
 * compare it with itself.
 */
function sendableModels(
  set: (partial: Partial<State>) => void,
  get: () => State,
  chat: Chat,
): string[] {
  const wanted = panelModels(chat, get().connection.provider);
  const { catalog, catalogStatus, chats } = get();
  if (catalogStatus !== "ready") return wanted;

  const swaps = new Map<string, string>();
  for (const id of wanted) {
    if (isLive(id)) continue;
    const replacement = matchLiveModel(getModel(id), catalog);
    if (replacement) swaps.set(id, replacement.id);
  }
  if (!swaps.size) return wanted;

  const resolved = [...new Set(wanted.map((id) => swaps.get(id) ?? id))];

  set({
    chats: chats.map((c) =>
      c.id === chat.id
        ? {
            ...c,
            modelId: resolved[0]!,
            // Re-derived from the resolved set rather than mapped in place, so
            // a swap that collapsed two entries into one leaves the stored
            // panel matching what was actually sent.
            ...panelPatch(resolved[0]!, resolved.slice(1)),
          }
        : c,
    ),
  });

  return resolved;
}

/**
 * Point every chat at a real model once the catalog lands.
 *
 * Only `chat.modelId` moves — the model recorded on each past message stays
 * put, because it is a fact about who wrote that text, not a setting.
 */
function realign(
  set: (partial: Partial<State>) => void,
  get: () => State,
  catalog: Model[],
) {
  if (!catalog.length) return;
  const { chats } = get();

  let changed = false;
  const next = chats.map((chat) => {
    if (isLive(chat.modelId)) return chat;
    const replacement = matchLiveModel(getModel(chat.modelId), catalog);
    if (!replacement) return chat;
    changed = true;
    return { ...chat, modelId: replacement.id };
  });

  if (changed) set({ chats: next });
}

/**
 * Move the connection to `provider` if it is already usable, and say whether it
 * was. Used at launch and when switching tabs — both need the same answer, and
 * neither should make the user re-enter something they already gave once.
 *
 * "Usable" is a question with two different cheap answers: a gateway has a key
 * in the keychain, and a CLI is installed and reports itself signed in. Neither
 * costs a token, so this is safe to run on every launch.
 *
 * A CLI that is present but signed out is reported rather than swallowed — that
 * is the state the user most needs to be told about, and it is fixed by one
 * command in a terminal.
 */
async function adoptProvider(
  set: (fn: (s: State) => Partial<State>) => void,
  provider: ProviderKey,
): Promise<boolean> {
  if (isAgentKey(provider)) {
    const probe = await adapter.agentProbe(provider).catch(() => null);
    set((s) => ({
      connection: {
        ...s.connection,
        status: probe?.loggedIn ? "connected" : "disconnected",
        hint: null,
        agent: probe,
        error: probe?.installed ? (probe.problem ?? null) : null,
      },
    }));
    return Boolean(probe?.loggedIn);
  }

  const status = await adapter
    .credentialStatus(credentialKey(provider as GatewayKey, useStore.getState().connection.zaiPlan))
    .catch(() => null);
  set((s) => ({
    connection: {
      ...s.connection,
      status: status?.present ? "connected" : "disconnected",
      hint: status?.hint ?? null,
      agent: null,
    },
  }));
  return Boolean(status?.present);
}

/**
 * Adopt the limits a provider stated mid-turn.
 *
 * The catalogued window for a CLI-routed model is a floor, not a fact —
 * `claude-cli/default` resolves to whatever the user configured, and the answer
 * only arrives with the turn. Until this lands, a 1M-window model reads as 200k
 * and the context meter says the project barely fits when it comfortably does.
 *
 * A no-op when the number has not moved, so a long conversation does not
 * rebuild the catalog on every turn.
 */
function applyLimits(
  set: (fn: (s: State) => Partial<State>) => void,
  get: () => State,
  limits: { model: string; contextLength: number; maxOutput: number | null },
) {
  const current = get().catalog.find((m) => m.id === limits.model);
  if (!current) return;
  if (
    current.contextWindow === limits.contextLength &&
    (current.maxOutput ?? null) === limits.maxOutput
  ) {
    return;
  }

  const catalog = get().catalog.map((model) =>
    model.id === limits.model
      ? {
          ...model,
          contextWindow: limits.contextLength,
          maxOutput: limits.maxOutput ?? undefined,
        }
      : model,
  );
  // The module registry is what render paths read from when all they have is
  // an id, so it has to move with the store copy or the two disagree.
  registerCatalog(catalog);
  set(() => ({ catalog }));
}

async function loadAccount(
  set: (fn: (s: State) => Partial<State>) => void,
  get: () => State,
) {
  try {
    const { provider, zaiPlan } = get().connection;
    const account = await adapter.account(provider, { zaiPlan });
    set((s) => ({ connection: { ...s.connection, account, error: null } }));
  } catch (error) {
    // OpenRouter balance blips should not surface as a connection failure.
    // Z.AI plan mismatches should — the wrong endpoint rejects the key. So
    // should a CLI that has stopped answering, since that is the whole
    // connection rather than one optional number on it.
    const { provider } = get().connection;
    if (provider !== "openrouter") {
      set((s) => ({
        connection: { ...s.connection, error: messageOf(error) },
      }));
    }
  }
}
