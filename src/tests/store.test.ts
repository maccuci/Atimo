import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { useStore } from "../lib/store";
import { diff } from "../lib/sync";
import { browserStore } from "../lib/persistence/browser";
import type { Snapshot } from "../lib/persistence";
import type {
  Chat,
  Decision,
  Document,
  MemoryEntry,
  Message,
  TimelineEvent,
} from "../lib/types";

/*
 * Renaming and deleting a chat, through the store and out the other side.
 *
 * The unit tests either side of this cover the pieces — `db.rs` proves the SQL,
 * `sync.test.ts` proves the diff — but neither proves the reducers produce the
 * shape the diff depends on. That link is easy to break by accident: a reducer
 * that rebuilt every row instead of copying the one it touched would still pass
 * every existing test and would write the whole workspace on every keystroke.
 */

const chat = (id: string, over: Partial<Chat> = {}): Chat => ({
  id,
  projectId: "p-1",
  title: id,
  modelId: "claude-opus-5",
  createdAt: "2026-07-01T00:00:00.000Z",
  updatedAt: "2026-07-01T00:00:00.000Z",
  ...over,
});

const message = (id: string, chatId: string): Message => ({
  id,
  chatId,
  role: "user",
  content: `body of ${id}`,
  createdAt: "2026-07-01T00:00:00.000Z",
});

const SNAPSHOT: Snapshot = {
  workspaces: [{ id: "ws-inserium", name: "Inserium" }],
  projects: [
    {
      id: "p-1",
      workspaceId: "ws-inserium",
      name: "Test",
      description: "",
      instructions: "",
      memoryTokens: 0,
    },
  ],
  chats: [
    chat("c-1", { updatedAt: "2026-07-02T00:00:00.000Z" }),
    chat("c-2", { updatedAt: "2026-07-05T00:00:00.000Z" }),
  ],
  messages: [message("m-1", "c-1"), message("m-2", "c-1"), message("m-3", "c-2")],
  memory: [],
  decisions: [],
  timeline: [],
  documents: [],
};

/** The slices the sync layer watches, as they stand right now. */
const watched = (): Snapshot => {
  const s = useStore.getState();
  return {
    workspaces: s.workspaces,
    projects: s.projects,
    chats: s.chats,
    messages: s.messages,
    memory: s.memory,
    decisions: s.decisions,
    timeline: s.timeline,
    documents: s.documents,
  };
};

beforeEach(() => {
  useStore.getState().hydrate(SNAPSHOT);
});

describe("hydrate", () => {
  test("opens on the most recently worked-on chat, not the first stored one", () => {
    // Rows come back in insertion order, so "first in the array" is the oldest
    // conversation in the project — never what the user wants to see.
    expect(useStore.getState().chatId).toBe("c-2");
    expect(useStore.getState().projectId).toBe("p-1");
    expect(useStore.getState().hydrated).toBe(true);
  });
});

describe("renameChat", () => {
  test("writes exactly one row", () => {
    const before = watched();
    useStore.getState().renameChat("c-1", "Renamed");

    const patch = diff(before, watched())!;
    expect(patch.chats).toHaveLength(1);
    expect(patch.chats[0]!.id).toBe("c-1");
    expect(patch.chats[0]!.title).toBe("Renamed");
    // Nothing else moved — in particular the transcript was not rewritten.
    expect(patch.messages).toHaveLength(0);
    expect(patch.deletedChats).toHaveLength(0);
  });

  test("trims, and refuses a title that is only whitespace", () => {
    useStore.getState().renameChat("c-1", "  Padded  ");
    expect(useStore.getState().chats.find((c) => c.id === "c-1")!.title).toBe(
      "Padded",
    );

    const before = watched();
    useStore.getState().renameChat("c-1", "   ");

    // A blank title would leave a row in the rail with nothing to click on.
    expect(useStore.getState().chats.find((c) => c.id === "c-1")!.title).toBe(
      "Padded",
    );
    expect(diff(before, watched())).toBeNull();
  });

  test("renaming to the same title writes nothing", () => {
    const before = watched();
    useStore.getState().renameChat("c-1", "c-1");
    expect(diff(before, watched())).toBeNull();
  });
});

describe("deleteChat", () => {
  test("removes the chat and its transcript", () => {
    useStore.getState().deleteChat("c-1");

    const { chats, messages } = useStore.getState();
    expect(chats.map((c) => c.id)).toEqual(["c-2"]);
    expect(messages.map((m) => m.id)).toEqual(["m-3"]);
  });

  test("reports the chat as deleted and does not re-write its messages", () => {
    const before = watched();
    useStore.getState().deleteChat("c-1");

    const patch = diff(before, watched())!;
    expect(patch.deletedChats).toEqual(["c-1"]);
    // The messages left with the chat, so the cascade is what removes them —
    // sending them as upserts would re-create rows the batch is deleting.
    expect(patch.messages).toHaveLength(0);
    expect(patch.chats).toHaveLength(0);
  });

  test("selection moves to the next chat when the open one is deleted", () => {
    useStore.getState().selectChat("c-2");
    useStore.getState().deleteChat("c-2");

    expect(useStore.getState().chatId).toBe("c-1");
  });

  test("deleting the last chat leaves no selection rather than a stale one", () => {
    useStore.getState().deleteChat("c-1");
    useStore.getState().deleteChat("c-2");

    expect(useStore.getState().chatId).toBe("");
    expect(useStore.getState().chats).toHaveLength(0);
  });

  test("deleting a chat the user is not looking at leaves selection alone", () => {
    useStore.getState().selectChat("c-2");
    useStore.getState().deleteChat("c-1");

    expect(useStore.getState().chatId).toBe("c-2");
  });

  test("a pinned message in the deleted chat is unpinned", () => {
    useStore.getState().inspectMessage("m-1");
    useStore.getState().deleteChat("c-1");

    // The context panel would otherwise stay pinned to a message that no longer
    // exists.
    expect(useStore.getState().inspectedMessageId).toBeNull();
  });

  test("a pinned message in another chat stays pinned", () => {
    useStore.getState().inspectMessage("m-3");
    useStore.getState().deleteChat("c-1");

    expect(useStore.getState().inspectedMessageId).toBe("m-3");
  });
});

/* ---------------------------------------------------------------------- */
/* Projects                                                                */
/* ---------------------------------------------------------------------- */

const memoryEntry = (id: string, projectId: string): MemoryEntry => ({
  id,
  projectId,
  kind: "architecture",
  title: id,
  body: `body of ${id}`,
  createdAt: "2026-07-01T00:00:00.000Z",
  hits: 0,
});

const decision = (id: string, projectId: string): Decision => ({
  id,
  projectId,
  title: id,
  reason: "because",
  alternatives: [],
  date: "2026-07-01T00:00:00.000Z",
  participants: [],
  affectedFiles: [],
});

const event = (id: string, projectId: string): TimelineEvent => ({
  id,
  projectId,
  date: "2026-07-01T00:00:00.000Z",
  modelId: "claude-opus-5",
  summary: id,
  kind: "chat",
});

/** Two projects, each with its own chats and knowledge. */
const twoProjects = () => {
  useStore.getState().hydrate({
    workspaces: [{ id: "ws-inserium", name: "Inserium" }],
    projects: [
      {
        id: "p-1",
        workspaceId: "ws-inserium",
        name: "First",
        description: "",
        instructions: "Always use tabs.",
        memoryTokens: 100,
      },
      {
        id: "p-2",
        workspaceId: "ws-inserium",
        name: "Second",
        description: "",
        instructions: "",
        memoryTokens: 50,
      },
    ],
    chats: [
      chat("c-1", { projectId: "p-1" }),
      chat("c-2", { projectId: "p-1" }),
      // Two chats in the surviving project, with the older one first: a single
      // chat there would hide any bug that recomputed the selection, because the
      // only candidate would also be the right answer.
      chat("c-3", { projectId: "p-2", updatedAt: "2026-07-01T00:00:00.000Z" }),
      chat("c-4", { projectId: "p-2", updatedAt: "2026-07-09T00:00:00.000Z" }),
    ],
    messages: [message("m-1", "c-1"), message("m-2", "c-2"), message("m-3", "c-3")],
    memory: [memoryEntry("mem-1", "p-1"), memoryEntry("mem-2", "p-2")],
    decisions: [decision("dec-1", "p-1")],
    timeline: [event("t-1", "p-1"), event("t-2", "p-2")],
    documents: [uploaded("doc-1", "p-1"), uploaded("doc-2", "p-2")],
  });
};

const uploaded = (id: string, projectId: string): Document => ({
  id,
  projectId,
  name: `${id}.md`,
  kind: "markdown",
  tokens: 120,
  updatedAt: "2026-07-01T00:00:00.000Z",
  excerpt: "the opening of the file",
  bytes: 480,
  chunkCount: 2,
});

describe("createProject", () => {
  test("lands in the open workspace and becomes the selection", () => {
    const id = useStore
      .getState()
      .createProject({ name: "Fresh", instructions: "Be terse." });

    const state = useStore.getState();
    const created = state.projects.find((p) => p.id === id)!;
    expect(created.name).toBe("Fresh");
    expect(created.instructions).toBe("Be terse.");
    expect(created.workspaceId).toBe("ws-inserium");
    expect(state.projectId).toBe(id);
  });

  test("opens with no chat rather than an untitled one", () => {
    // Creating a project is setting up context, not starting a conversation —
    // and an implicit chat would also pick a model on the user's behalf.
    const id = useStore.getState().createProject({ name: "Fresh" });

    expect(useStore.getState().chatId).toBe("");
    expect(useStore.getState().chats.some((c) => c.projectId === id)).toBe(false);
  });

  test("trims, and a name of pure whitespace still leaves something clickable", () => {
    const id = useStore.getState().createProject({ name: "   " });
    expect(useStore.getState().projects.find((p) => p.id === id)!.name).toBe(
      "Projeto sem nome",
    );
  });

  test("writes exactly one row", () => {
    const before = watched();
    useStore.getState().createProject({ name: "Fresh" });

    const patch = diff(before, watched())!;
    expect(patch.projects).toHaveLength(1);
    expect(patch.chats).toHaveLength(0);
    expect(patch.messages).toHaveLength(0);
  });
});

describe("createWorkspace", () => {
  test("creates and selects an empty workspace", () => {
    const id = useStore.getState().createWorkspace("  New space  ");
    const state = useStore.getState();

    expect(id).toMatch(/^ws-/);
    expect(state.workspaces.at(-1)).toEqual({ id, name: "New space" });
    expect(state.workspaceId).toBe(id);
    expect(state.projectId).toBe("");
    expect(state.chatId).toBe("");
    expect(state.view).toBe("home");
  });

  test("falls back to a visible name", () => {
    const id = useStore.getState().createWorkspace("   ");
    expect(useStore.getState().workspaces.find((workspace) => workspace.id === id)?.name).toBe(
      "Workspace sem nome",
    );
  });
});

describe("deleteWorkspace", () => {
  test("takes its projects and chats with it and moves to another workspace", () => {
    const id = useStore.getState().createWorkspace("Temporário");
    const projectId = useStore.getState().createProject({ name: "Dentro", workspaceId: id });
    useStore.getState().newChat();
    const before = watched();

    useStore.getState().deleteWorkspace(id);
    const state = useStore.getState();

    expect(state.workspaces.some((w) => w.id === id)).toBe(false);
    expect(state.projects.some((p) => p.id === projectId)).toBe(false);
    expect(state.chats.some((c) => c.projectId === projectId)).toBe(false);
    expect(state.workspaceId).not.toBe(id);
    expect(diff(before, watched())?.deletedWorkspaces).toEqual([id]);
  });

  test("refuses to delete the last workspace", () => {
    for (const w of useStore.getState().workspaces.slice(1)) {
      useStore.getState().deleteWorkspace(w.id);
    }
    const [last] = useStore.getState().workspaces;
    useStore.getState().deleteWorkspace(last!.id);
    expect(useStore.getState().workspaces).toHaveLength(1);
  });
});

describe("renameWorkspace", () => {
  test("renames in place and the change reaches storage", () => {
    const id = useStore.getState().createWorkspace("Antigo");
    const before = watched();

    useStore.getState().renameWorkspace(id, "  Novo nome  ");

    expect(useStore.getState().workspaces.find((w) => w.id === id)?.name).toBe("Novo nome");
    expect(diff(before, watched())?.workspaces).toEqual([{ id, name: "Novo nome" }]);
  });

  test("a blank name keeps the old one", () => {
    const id = useStore.getState().createWorkspace("Antigo");
    useStore.getState().renameWorkspace(id, "   ");
    expect(useStore.getState().workspaces.find((w) => w.id === id)?.name).toBe("Antigo");
  });
});

describe("updateProject", () => {
  test("changing the base context writes only that project", () => {
    const before = watched();
    useStore.getState().updateProject("p-1", { instructions: "Use pgvector." });

    const patch = diff(before, watched())!;
    expect(patch.projects).toHaveLength(1);
    expect(patch.projects[0]!.instructions).toBe("Use pgvector.");
    expect(patch.chats).toHaveLength(0);
  });

  test("a no-op edit writes nothing", () => {
    // The sheet commits on close, so re-opening and closing it must not write.
    useStore.getState().updateProject("p-1", { instructions: "Same" });
    const before = watched();
    useStore.getState().updateProject("p-1", { instructions: "Same" });

    expect(diff(before, watched())).toBeNull();
  });

  test("a blank base context is a real value, but a blank name reverts", () => {
    useStore.getState().updateProject("p-1", { instructions: "Something" });
    useStore.getState().updateProject("p-1", { instructions: "   " });
    // "This project has no standing instructions" is a legitimate answer.
    expect(useStore.getState().projects[0]!.instructions).toBe("");

    useStore.getState().updateProject("p-1", { name: "  " });
    // A nameless project would have nothing to click on in the rail.
    expect(useStore.getState().projects[0]!.name).toBe("Test");
  });

  test("only the ends of the base context are trimmed", () => {
    // The brief is prose the user formatted deliberately; collapsing its blank
    // lines would rewrite what they wrote.
    useStore.getState().updateProject("p-1", { instructions: "  a\n\n  b  " });
    expect(useStore.getState().projects[0]!.instructions).toBe("a\n\n  b");
  });
});

describe("deleteProject", () => {
  beforeEach(twoProjects);

  test("takes its chats, transcripts, memory, decisions, timeline and documents", () => {
    useStore.getState().deleteProject("p-1");

    const state = useStore.getState();
    expect(state.projects.map((p) => p.id)).toEqual(["p-2"]);
    expect(state.chats.map((c) => c.id)).toEqual(["c-3", "c-4"]);
    expect(state.messages.map((m) => m.id)).toEqual(["m-3"]);
    expect(state.memory.map((m) => m.id)).toEqual(["mem-2"]);
    expect(state.decisions).toHaveLength(0);
    expect(state.timeline.map((t) => t.id)).toEqual(["t-2"]);
    expect(state.documents.map((d) => d.id)).toEqual(["doc-2"]);
  });

  test("reports the project as deleted and re-writes nothing it owned", () => {
    const before = watched();
    useStore.getState().deleteProject("p-1");

    const patch = diff(before, watched())!;
    expect(patch.deletedProjects).toEqual(["p-1"]);
    // The cascade removes the children, so naming them as well would have one
    // batch describe the same delete twice.
    expect(patch.deletedChats).toHaveLength(0);
    expect(patch.chats).toHaveLength(0);
    expect(patch.messages).toHaveLength(0);
    expect(patch.memory).toHaveLength(0);
    // Documents included: SQLite reaches them through the project's foreign key,
    // and naming one here would delete it twice — harmless in SQL, but it would
    // also mean the browser store took a different path to the same result.
    expect(patch.deletedDocuments).toHaveLength(0);
    expect(patch.documents).toHaveLength(0);
  });

  test("selection moves to a sibling, on its most recent chat", () => {
    useStore.getState().selectProject("p-1");
    useStore.getState().deleteProject("p-1");

    expect(useStore.getState().projectId).toBe("p-2");
    expect(useStore.getState().chatId).toBe("c-4");
  });

  test("deleting a project the user is not in leaves the open chat alone", () => {
    useStore.getState().selectProject("p-2");
    // Deliberately not the project's most recent chat: recomputing the selection
    // would land on c-4 and swap the conversation out from under the user.
    useStore.getState().selectChat("c-3");

    useStore.getState().deleteProject("p-1");

    expect(useStore.getState().projectId).toBe("p-2");
    expect(useStore.getState().chatId).toBe("c-3");
  });

  test("deleting the last project leaves no selection rather than a stale one", () => {
    useStore.getState().deleteProject("p-1");
    useStore.getState().deleteProject("p-2");

    const state = useStore.getState();
    expect(state.projects).toHaveLength(0);
    expect(state.projectId).toBe("");
    expect(state.chatId).toBe("");
  });

  test("a pinned message in the deleted project is unpinned", () => {
    useStore.getState().inspectMessage("m-1");
    useStore.getState().deleteProject("p-1");

    expect(useStore.getState().inspectedMessageId).toBeNull();
  });
});

describe("selectProject", () => {
  test("keeps the open chat when it already belongs to the project", () => {
    twoProjects();
    // Not the most recent in p-2 — firstChatOf would otherwise jump to c-4.
    useStore.getState().selectChat("c-3");

    useStore.getState().selectProject("p-2");

    expect(useStore.getState().projectId).toBe("p-2");
    expect(useStore.getState().chatId).toBe("c-3");
  });

  test("opens the most recent chat when switching into a different project", () => {
    twoProjects();
    useStore.getState().selectChat("c-1");

    useStore.getState().selectProject("p-2");

    expect(useStore.getState().projectId).toBe("p-2");
    expect(useStore.getState().chatId).toBe("c-4");
  });
});

describe("newChat", () => {
  test("refuses to create an orphan when no project is selected", () => {
    useStore.getState().deleteProject("p-1");
    expect(useStore.getState().projectId).toBe("");

    useStore.getState().newChat();

    // A chat with no project violates the foreign key and takes its whole patch
    // down with it, so the guard lives in the reducer rather than at call sites.
    expect(useStore.getState().chats).toHaveLength(0);
  });

  test("reuses an untouched chat instead of stacking another Untitled", () => {
    useStore.getState().newChat();
    const first = useStore.getState().chatId;
    const count = useStore.getState().chats.length;

    useStore.getState().newChat();

    expect(useStore.getState().chatId).toBe(first);
    expect(useStore.getState().chats).toHaveLength(count);
  });
});

describe("hydrate", () => {
  test("fills in a base context missing from a stored row", () => {
    // What a project persisted before base contexts existed looks like coming
    // back: the migration copies each row's JSON verbatim, so the gap arrives
    // here. Left undefined, the composer reads `undefined.trim()` on the first
    // launch after an update.
    const legacy = {
      id: "p-old",
      workspaceId: "ws-inserium",
      name: "Legacy",
      description: "",
      memoryTokens: 0,
    };

    useStore.getState().hydrate({
      ...SNAPSHOT,
      projects: [legacy as unknown as Snapshot["projects"][number]],
    });

    expect(useStore.getState().projects[0]!.instructions).toBe("");
  });

  test("a row that needs no filling keeps its identity, so nothing is written", () => {
    const before = watched();
    useStore.getState().hydrate(watched());

    // Hydration must not queue a write of every project on every launch.
    expect(diff(before, watched())).toBeNull();
  });
});

/* ---------------------------------------------------------------------- */
/* Panel turns — several models answering one prompt in one chat            */
/* ---------------------------------------------------------------------- */

/**
 * A chat holding one finished panel turn: a prompt, then two answers grouped
 * under `t-1`, the first of them the conversation.
 */
function panelChat() {
  useStore.getState().hydrate({
    ...SNAPSHOT,
    chats: [chat("c-1", { panel: ["gpt-5.2"] })],
    messages: [
      { ...message("u-1", "c-1"), role: "user", content: "how?" },
      {
        ...message("a-1", "c-1"),
        role: "assistant",
        modelId: "claude-opus-5",
        content: "primary answer",
        turnId: "t-1",
        canonical: true,
      },
      {
        ...message("a-2", "c-1"),
        role: "assistant",
        modelId: "gpt-5.2",
        content: "second answer",
        turnId: "t-1",
        canonical: false,
      },
    ],
  });
}

describe("setChatPanel", () => {
  test("stores the extras and never the primary", () => {
    useStore.getState().setChatPanel("c-1", ["gpt-5.2", "claude-opus-5"]);

    // The primary answering twice would be billed twice to compare it with
    // itself.
    expect(useStore.getState().chats.find((c) => c.id === "c-1")!.panel).toEqual(
      ["gpt-5.2"],
    );
  });

  test("clearing the panel removes the field rather than storing an empty list", () => {
    useStore.getState().setChatPanel("c-1", ["gpt-5.2"]);
    useStore.getState().setChatPanel("c-1", []);

    expect(
      useStore.getState().chats.find((c) => c.id === "c-1")!.panel,
    ).toBeUndefined();
  });
});

describe("setChatModel", () => {
  test("promoting a panel member to primary takes it out of the panel", () => {
    useStore.getState().setChatPanel("c-1", ["gpt-5.2", "gemini-3-pro"]);
    useStore.getState().setChatModel("c-1", "gpt-5.2");

    const updated = useStore.getState().chats.find((c) => c.id === "c-1")!;
    expect(updated.modelId).toBe("gpt-5.2");
    // Left in the panel it would answer the next turn twice.
    expect(updated.panel).toEqual(["gemini-3-pro"]);
  });
});

describe("promoteAnswer", () => {
  test("moves the conversation and its primary model to the chosen answer", () => {
    panelChat();
    useStore.getState().promoteAnswer("a-2");

    const messages = useStore.getState().messages;
    expect(messages.find((m) => m.id === "a-1")!.canonical).toBe(false);
    expect(messages.find((m) => m.id === "a-2")!.canonical).toBe(true);

    const updated = useStore.getState().chats.find((c) => c.id === "c-1")!;
    expect(updated.modelId).toBe("gpt-5.2");
    // Choosing a response reorders the comparison; it must not silently drop
    // the model that was primary when the panel was sent.
    expect(updated.panel).toEqual(["claude-opus-5"]);
  });

  test("writes only the turn's own rows", () => {
    panelChat();
    const before = watched();
    useStore.getState().promoteAnswer("a-2");

    const patch = diff(before, watched())!;
    // The prompt is untouched: a promotion changes which answer travels
    // forward, not the exchange it belongs to.
    expect(patch.messages.map((m) => m.id).sort()).toEqual(["a-1", "a-2"]);
    expect(patch.chats.map((c) => c.id)).toEqual(["c-1"]);
  });

  test("still promotes history when a legacy answer has no model id", () => {
    panelChat();
    const snapshot = watched();
    useStore.getState().hydrate({
      ...snapshot,
      messages: snapshot.messages.map((message) =>
        message.id === "a-2" ? { ...message, modelId: undefined } : message,
      ),
    });

    useStore.getState().promoteAnswer("a-2");

    expect(useStore.getState().messages.find((m) => m.id === "a-2")!.canonical).toBe(
      true,
    );
    const updated = useStore.getState().chats.find((c) => c.id === "c-1")!;
    expect(updated.modelId).toBe("claude-opus-5");
    expect(updated.panel).toEqual(["gpt-5.2"]);
  });

  test("promoting the answer that is already canonical writes nothing", () => {
    panelChat();
    const before = watched();
    useStore.getState().promoteAnswer("a-1");

    expect(diff(before, watched())).toBeNull();
  });

  test("aligns the primary model when the confirmed answer is already canonical", () => {
    panelChat();
    const snapshot = watched();
    useStore.getState().hydrate({
      ...snapshot,
      chats: snapshot.chats.map((current) =>
        current.id === "c-1"
          ? {
              ...current,
              modelId: "gpt-5.2",
              panel: ["claude-opus-5"],
            }
          : current,
      ),
    });

    useStore.getState().promoteAnswer("a-1");

    const updated = useStore.getState().chats.find((c) => c.id === "c-1")!;
    expect(updated.modelId).toBe("claude-opus-5");
    expect(updated.panel).toEqual(["gpt-5.2"]);
  });

  test("an answer outside a panel cannot be promoted", () => {
    const before = watched();
    useStore.getState().promoteAnswer("m-1");

    expect(diff(before, watched())).toBeNull();
  });
});

describe("panel review", () => {
  test("opens only when a turn has two completed responses to choose from", () => {
    panelChat();
    useStore.getState().openPanelReview("c-1", "t-1");

    expect(useStore.getState().panelReview).toEqual({
      chatId: "c-1",
      turnId: "t-1",
    });
    expect(useStore.getState().view).toBe("chat");
  });

  test("does not open while a panel response is pending or failed", () => {
    panelChat();
    const snapshot = watched();
    useStore.getState().hydrate({
      ...snapshot,
      messages: snapshot.messages.map((current) =>
        current.id === "a-2"
          ? { ...current, pending: true, error: "provider failed" }
          : current,
      ),
    });

    useStore.getState().openPanelReview("c-1", "t-1");

    expect(useStore.getState().panelReview).toBeNull();
  });

  test("chooses an answer, promotes its model and returns to chat", () => {
    panelChat();
    useStore.getState().openPanelReview("c-1", "t-1");
    useStore.getState().choosePanelReviewAnswer("a-2");

    expect(useStore.getState().panelReview).toBeNull();
    expect(useStore.getState().view).toBe("chat");
    expect(useStore.getState().messages.find((m) => m.id === "a-2")!.canonical).toBe(
      true,
    );
    expect(useStore.getState().chats.find((c) => c.id === "c-1")!.modelId).toBe(
      "gpt-5.2",
    );
  });

  test("dismisses without changing the response that continues history", () => {
    panelChat();
    useStore.getState().openPanelReview("c-1", "t-1");
    useStore.getState().closePanelReview();

    expect(useStore.getState().panelReview).toBeNull();
    expect(useStore.getState().messages.find((m) => m.id === "a-1")!.canonical).toBe(
      true,
    );
  });

  test("clears the review when its chat is deleted", () => {
    panelChat();
    useStore.getState().openPanelReview("c-1", "t-1");
    useStore.getState().deleteChat("c-1");

    expect(useStore.getState().panelReview).toBeNull();
  });

  test("clears the review when its project is deleted", () => {
    panelChat();
    useStore.getState().openPanelReview("c-1", "t-1");
    useStore.getState().deleteProject("p-1");

    expect(useStore.getState().panelReview).toBeNull();
  });
});

describe("forkChat from a panel turn", () => {
  test("carries the answer forked from and drops its siblings", () => {
    panelChat();
    useStore.getState().forkChat("c-1", "a-2", "gpt-5.2");

    const forkId = useStore.getState().chatId;
    const carried = useStore
      .getState()
      .messages.filter((m) => m.chatId === forkId);

    // The prompt and the one answer being continued from. Carrying the sibling
    // too would open the fork on two answers to the same question, neither of
    // them the history it is supposed to continue.
    expect(carried.map((m) => m.content)).toEqual(["how?", "second answer"]);
  });

  test("the carried answer stops being a group member", () => {
    panelChat();
    useStore.getState().forkChat("c-1", "a-2", "gpt-5.2");

    const forkId = useStore.getState().chatId;
    const answer = useStore
      .getState()
      .messages.filter((m) => m.chatId === forkId)
      .at(-1)!;

    // A lone member of a group that no longer exists is a row every reader
    // downstream would have to special-case — and `selectHistory` would drop
    // it, leaving the fork with a prompt and no answer.
    expect(answer.turnId).toBeUndefined();
    expect(answer.canonical).toBeUndefined();
  });

  test("forking from the prompt keeps the line the chat actually took", () => {
    panelChat();
    useStore.getState().forkChat("c-1", "u-1", "gpt-5.2");

    const forkId = useStore.getState().chatId;
    const carried = useStore
      .getState()
      .messages.filter((m) => m.chatId === forkId);

    expect(carried.map((m) => m.content)).toEqual(["how?"]);
  });

  test("the original keeps its panel intact", () => {
    panelChat();
    useStore.getState().forkChat("c-1", "a-2", "gpt-5.2");

    // Forking copies, it does not move.
    const source = useStore
      .getState()
      .messages.filter((m) => m.chatId === "c-1");
    expect(source).toHaveLength(3);

    // A fork is one model continuing one line, so it starts without a panel of
    // its own — inheriting one would silently double the cost of a chat the
    // user opened to follow a single answer.
    const fork = useStore.getState().chats.find((c) => c.id === useStore.getState().chatId)!;
    expect(fork.panel).toBeUndefined();
  });
});

/*
 * Attachments across a fork.
 *
 * A fork copies messages under new ids, and an attachment's rows hang off a
 * message id and carry a chat id. Left shared, the copies would point at the
 * original's bytes — which read back as nothing the next time the fork is
 * opened, so the picture would be in the transcript on screen and gone after a
 * reload. This is the reducer half of that; `db.rs` proves the cascade.
 */
describe("forking a chat that has files in it", () => {
  /*
   * A stand-in for the one Web API the browser store needs and the test runner
   * does not have. Without it the copy path still runs — the fork is on screen
   * either way — but its write fails, and a test that cannot tell a successful
   * persist from a swallowed failure is not testing the interesting half.
   */
  beforeEach(() => {
    const cells = new Map<string, string>();
    (globalThis as { localStorage?: unknown }).localStorage = {
      getItem: (key: string) => cells.get(key) ?? null,
      setItem: (key: string, value: string) => void cells.set(key, value),
      removeItem: (key: string) => void cells.delete(key),
      clear: () => cells.clear(),
      key: () => null,
      length: 0,
    };
  });

  afterEach(() => {
    delete (globalThis as { localStorage?: unknown }).localStorage;
  });

  const attachment = (id: string, messageId: string) => ({
    id,
    messageId,
    chatId: "c-1",
    name: "screenshot.png",
    mime: "image/png",
    kind: "image" as const,
    bytes: 1_024,
    width: 800,
    height: 600,
    tokens: 640,
  });

  const withAttachment = () => {
    useStore.setState((s) => ({
      messages: s.messages.map((m) =>
        m.id === "m-1" ? { ...m, attachments: [attachment("att-1", "m-1")] } : m,
      ),
      attachmentBlobs: { "att-1": "data:image/png;base64,AAA" },
    }));
  };

  test("the copy gets its own attachment rows, pointing at the copy", () => {
    withAttachment();
    useStore.getState().forkChat("c-1", "m-1", "gpt-5.2");

    const forkId = useStore.getState().chatId;
    const copy = useStore
      .getState()
      .messages.find((m) => m.chatId === forkId && m.content === "body of m-1")!;

    const carried = copy.attachments![0]!;
    expect(carried.id).not.toBe("att-1");
    expect(carried.messageId).toBe(copy.id);
    expect(carried.chatId).toBe(forkId);
    // Everything that describes the file itself is the same file.
    expect(carried.name).toBe("screenshot.png");
    expect(carried.tokens).toBe(640);
  });

  test("the fork opens on the bytes it carried, without waiting for a read", () => {
    withAttachment();
    useStore.getState().forkChat("c-1", "m-1", "gpt-5.2");

    const forkId = useStore.getState().chatId;
    const copy = useStore
      .getState()
      .messages.find((m) => m.chatId === forkId && m.content === "body of m-1")!;

    expect(useStore.getState().attachmentBlobs[copy.attachments![0]!.id]).toBe(
      "data:image/png;base64,AAA",
    );
  });

  test("the original's message and bytes are untouched", () => {
    withAttachment();
    useStore.getState().forkChat("c-1", "m-1", "gpt-5.2");

    const original = useStore.getState().messages.find((m) => m.id === "m-1")!;
    expect(original.attachments![0]!.id).toBe("att-1");
    expect(original.attachments![0]!.chatId).toBe("c-1");
  });

  test("the copied bytes are written where the fork will look for them", async () => {
    withAttachment();
    useStore.getState().forkChat("c-1", "m-1", "gpt-5.2");
    const forkId = useStore.getState().chatId;

    // The write is deliberately not awaited by `forkChat` — the fork is usable
    // before it lands — so the test waits for the microtasks it queued.
    await new Promise((resolve) => setTimeout(resolve, 0));

    const stored = await browserStore.loadAttachments(forkId);
    expect(stored).toHaveLength(1);
    expect(stored[0]!.data).toBe("data:image/png;base64,AAA");
    // Never the original's row: that one belongs to the chat it was sent in.
    expect(stored[0]!.id).not.toBe("att-1");
  });
});
