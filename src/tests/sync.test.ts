import { describe, expect, test } from "bun:test";
import { deliberate, diff, merge } from "../lib/sync";
import { applyPatch } from "../lib/persistence/patch";
import { EMPTY_PATCH, type Patch, type Snapshot } from "../lib/persistence";
import type { Chat, Decision, MemoryEntry, Message, Project } from "../lib/types";

/*
 * The write-through path is a diff of two immutable snapshots, which makes it
 * cheap but also makes it depend on the store's reducers copying only the rows
 * they touch. These cases pin the three ways that assumption pays off or fails:
 * an untouched row must not be written, a changed row must be, and a row whose
 * chat has been deleted must not come back.
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

const message = (id: string, chatId: string, content = ""): Message => ({
  id,
  chatId,
  role: "user",
  content,
  createdAt: "2026-07-01T00:00:00.000Z",
});

const project = (id: string, over: Partial<Project> = {}): Project => ({
  id,
  workspaceId: "ws-1",
  name: id,
  description: "",
  instructions: "",
  memoryTokens: 0,
  ...over,
});

const memoryEntry = (id: string, projectId: string): MemoryEntry => ({
  id,
  projectId,
  kind: "architecture",
  title: id,
  body: id,
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

const state = (over: Partial<Snapshot> = {}): Snapshot => ({
  workspaces: [],
  projects: [],
  chats: [],
  messages: [],
  memory: [],
  decisions: [],
  timeline: [],
  documents: [],
  ...over,
});

const patch = (over: Partial<Patch> = {}): Patch => ({ ...EMPTY_PATCH, ...over });

describe("diff", () => {
  test("an unchanged store writes nothing", () => {
    const before = state({ chats: [chat("c-1")] });
    expect(diff(before, before)).toBeNull();
  });

  test("a rebuilt array whose rows all survived still writes nothing", () => {
    // What `messages.map()` produces on a transition that changed a different
    // collection: a new array of the same rows. Comparing arrays would report a
    // change; comparing rows correctly reports none.
    const rows = [chat("c-1"), chat("c-2")];
    const before = state({ chats: rows });
    const after = state({ chats: [...rows] });

    expect(diff(before, after)).toBeNull();
  });

  test("only the row that changed is written", () => {
    const keep = chat("c-1");
    const before = state({ chats: [keep, chat("c-2")] });
    const after = state({
      chats: [keep, { ...before.chats[1]!, title: "Renamed" }],
    });

    const result = diff(before, after)!;
    expect(result.chats).toHaveLength(1);
    expect(result.chats[0]!.title).toBe("Renamed");
  });

  test("a deleted chat is reported by id", () => {
    const before = state({ chats: [chat("c-1"), chat("c-2")] });
    const after = state({ chats: [before.chats[0]!] });

    const result = diff(before, after)!;
    expect(result.deletedChats).toEqual(["c-2"]);
    expect(result.chats).toHaveLength(0);
  });

  test("a chat that was renamed and then deleted is only deleted", () => {
    const before = state({ chats: [chat("c-1")] });
    const after = state({ chats: [] });

    const result = diff(before, after)!;
    expect(result.deletedChats).toEqual(["c-1"]);
    expect(result.chats).toHaveLength(0);
  });

  test("messages of a chat deleted in the same transition are dropped", () => {
    // The shape a streaming turn interrupted by a delete produces: the message
    // row is new *and* its chat is gone, in one store transition.
    const before = state({ chats: [chat("c-1")], messages: [] });
    const after = state({ chats: [], messages: [message("m-1", "c-1")] });

    const result = diff(before, after)!;
    expect(result.deletedChats).toEqual(["c-1"]);
    expect(result.messages).toHaveLength(0);
  });

  test("messages of surviving chats are kept when another is deleted", () => {
    const before = state({ chats: [chat("c-1"), chat("c-2")] });
    const after = state({
      chats: [before.chats[1]!],
      messages: [message("m-1", "c-2")],
    });

    const result = diff(before, after)!;
    expect(result.deletedChats).toEqual(["c-1"]);
    expect(result.messages.map((m) => m.id)).toEqual(["m-1"]);
  });

  test("a deleted project is reported by id", () => {
    const before = state({ projects: [project("p-1"), project("p-2")] });
    const after = state({ projects: [before.projects[0]!] });

    const result = diff(before, after)!;
    expect(result.deletedProjects).toEqual(["p-2"]);
    expect(result.projects).toHaveLength(0);
  });

  test("chats of a deleted project are left to the cascade, not listed", () => {
    // Naming them as `deletedChats` too would have one batch describe the same
    // delete twice — the SQL cascade already reaches them through the project.
    const before = state({
      projects: [project("p-1")],
      chats: [chat("c-1", { projectId: "p-1" })],
    });
    const after = state({ projects: [], chats: [] });

    const result = diff(before, after)!;
    expect(result.deletedProjects).toEqual(["p-1"]);
    expect(result.deletedChats).toHaveLength(0);
  });

  test("a chat deleted on its own is still reported while a project goes too", () => {
    // Two projects, one deleted; the other loses a chat by itself. Only the
    // second chat is a deletion in its own right.
    const keep = project("p-2");
    const survivor = chat("c-3", { projectId: "p-2" });
    const before = state({
      projects: [project("p-1"), keep],
      chats: [chat("c-1", { projectId: "p-1" }), chat("c-2", { projectId: "p-2" }), survivor],
    });
    const after = state({ projects: [keep], chats: [survivor] });

    const result = diff(before, after)!;
    expect(result.deletedProjects).toEqual(["p-1"]);
    expect(result.deletedChats).toEqual(["c-2"]);
  });

  test("nothing a deleted project owned rides along as an upsert", () => {
    // The shape a turn streaming into a project deleted mid-flight produces:
    // brand-new rows for a parent that is going away in the same transition.
    const before = state({ projects: [project("p-1")], chats: [chat("c-1", { projectId: "p-1" })] });
    const after = state({
      projects: [],
      chats: [],
      messages: [message("m-1", "c-1", "half an answer")],
      memory: [memoryEntry("mem-1", "p-1")],
      decisions: [decision("dec-1", "p-1")],
    });

    const result = diff(before, after)!;
    expect(result.deletedProjects).toEqual(["p-1"]);
    // Each of these would either violate the foreign key or resurrect a row the
    // same transaction is removing.
    expect(result.messages).toHaveLength(0);
    expect(result.memory).toHaveLength(0);
    expect(result.decisions).toHaveLength(0);
  });

  test("a deleted workspace owns the project cascade", () => {
    const first = project("p-1", { workspaceId: "ws-1" });
    const second = project("p-2", { workspaceId: "ws-2" });
    const before = state({
      workspaces: [
        { id: "ws-1", name: "One" },
        { id: "ws-2", name: "Two" },
      ],
      projects: [first, second],
      chats: [
        chat("c-1", { projectId: first.id }),
        chat("c-2", { projectId: second.id }),
      ],
      messages: [message("m-1", "c-1"), message("m-2", "c-2")],
    });
    const after = state({
      workspaces: [before.workspaces[1]!],
      projects: [second],
      chats: [before.chats[1]!],
      messages: [before.messages[1]!],
    });

    const result = diff(before, after)!;
    expect(result.deletedWorkspaces).toEqual(["ws-1"]);
    expect(result.deletedProjects).toHaveLength(0);
    expect(result.deletedChats).toHaveLength(0);
    expect(result.messages).toHaveLength(0);
  });
});

describe("merge", () => {
  test("a row queued twice is stored once, at its latest value", () => {
    // Sixty frames of one streaming message must not become sixty rows.
    const pending = patch();
    for (const text of ["a", "ab", "abc"]) {
      merge(pending, patch({ messages: [message("m-1", "c-1", text)] }));
    }

    expect(pending.messages).toHaveLength(1);
    expect(pending.messages[0]!.content).toBe("abc");
  });

  test("queued rows survive alongside a later row", () => {
    const pending = patch({ messages: [message("m-1", "c-1", "first")] });
    merge(pending, patch({ messages: [message("m-2", "c-1", "second")] }));

    expect(pending.messages.map((m) => m.id)).toEqual(["m-1", "m-2"]);
  });

  test("deleting a chat clears the rows already queued for it", () => {
    const pending = patch({
      chats: [chat("c-1")],
      messages: [message("m-1", "c-1"), message("m-2", "c-2")],
    });

    merge(pending, patch({ deletedChats: ["c-1"] }));

    // Writing the chat back and then deleting it in the same transaction would
    // work, but re-creating a row the batch is about to remove is not something
    // a batch should ever be asked to do.
    expect(pending.chats).toHaveLength(0);
    expect(pending.messages.map((m) => m.id)).toEqual(["m-2"]);
    expect(pending.deletedChats).toEqual(["c-1"]);
  });

  test("the same chat deleted twice is listed once", () => {
    const pending = patch({ deletedChats: ["c-1"] });
    merge(pending, patch({ deletedChats: ["c-1", "c-2"] }));

    expect(pending.deletedChats.sort()).toEqual(["c-1", "c-2"]);
  });

  test("deleting a project clears every row already queued for it", () => {
    // A project edited, chatted in, and then deleted, all inside one debounce.
    const pending = patch({
      projects: [project("p-1", { instructions: "edited" }), project("p-2")],
      chats: [chat("c-1", { projectId: "p-1" }), chat("c-2", { projectId: "p-2" })],
      messages: [message("m-1", "c-1"), message("m-2", "c-2")],
      memory: [memoryEntry("mem-1", "p-1"), memoryEntry("mem-2", "p-2")],
      decisions: [decision("dec-1", "p-1")],
    });

    merge(pending, patch({ deletedProjects: ["p-1"] }));

    expect(pending.deletedProjects).toEqual(["p-1"]);
    expect(pending.projects.map((p) => p.id)).toEqual(["p-2"]);
    expect(pending.chats.map((c) => c.id)).toEqual(["c-2"]);
    // Reached through the queued chat rather than through the message itself:
    // once the store has moved on, the queued chats are the only place the
    // chat→project mapping still exists.
    expect(pending.messages.map((m) => m.id)).toEqual(["m-2"]);
    expect(pending.memory.map((m) => m.id)).toEqual(["mem-2"]);
    expect(pending.decisions).toHaveLength(0);
  });

  test("a queued chat delete is dropped once its project is going too", () => {
    const pending = patch({
      chats: [chat("c-1", { projectId: "p-1" })],
      deletedChats: ["c-1"],
    });

    merge(pending, patch({ deletedProjects: ["p-1"] }));

    expect(pending.deletedProjects).toEqual(["p-1"]);
    expect(pending.deletedChats).toHaveLength(0);
  });

  test("a queued workspace delete clears its descendants", () => {
    const pending = patch({
      workspaces: [{ id: "ws-1", name: "One" }],
      projects: [project("p-1")],
      chats: [chat("c-1")],
      messages: [message("m-1", "c-1")],
    });

    merge(pending, patch({ deletedWorkspaces: ["ws-1"] }));

    expect(pending.workspaces).toHaveLength(0);
    expect(pending.projects).toHaveLength(0);
    expect(pending.chats).toHaveLength(0);
    expect(pending.messages).toHaveLength(0);
  });
});

describe("deliberate", () => {
  /*
   * What decides whether a patch waits for the debounce. Getting this backwards
   * either loses a rename on quit, or writes a row per frame of a stream.
   */

  test("mid-stream message output can wait", () => {
    expect(deliberate(patch({ messages: [message("m-1", "c-1", "partial")] }))).toBe(
      false,
    );
  });

  test("a rename is written at once", () => {
    expect(deliberate(patch({ chats: [chat("c-1", { title: "New" })] }))).toBe(true);
  });

  test("a delete is written at once", () => {
    expect(deliberate(patch({ deletedChats: ["c-1"] }))).toBe(true);
  });

  test("a project delete is written at once", () => {
    expect(deliberate(patch({ deletedProjects: ["p-1"] }))).toBe(true);
  });

  test("the first frame of a turn is deliberate, because it touches the chat", () => {
    // `send()` stamps `updatedAt` and may derive the title, so the user's own
    // prompt reaches the database immediately rather than 400ms later.
    expect(
      deliberate(
        patch({
          chats: [chat("c-1", { title: "Derived from the prompt" })],
          messages: [message("m-1", "c-1", "the prompt")],
        }),
      ),
    ).toBe(true);
  });

  test("an empty patch is not worth a write", () => {
    expect(deliberate(patch())).toBe(false);
  });
});

describe("applyPatch", () => {
  /*
   * The browser store's stand-in for SQL. Its behaviour has to match the
   * SQLite store's, or a workspace would come back in a different shape
   * depending on whether it was saved from `bun run dev` or the desktop app.
   */

  test("an upsert replaces in place, so transcript order holds", () => {
    const snapshot = state({
      chats: [chat("c-1")],
      messages: [message("m-1", "c-1", "prompt"), message("m-2", "c-1", "")],
    });

    const next = applyPatch(
      snapshot,
      patch({ messages: [message("m-2", "c-1", "answer")] }),
    );

    expect(next.messages.map((m) => m.id)).toEqual(["m-1", "m-2"]);
    expect(next.messages[1]!.content).toBe("answer");
  });

  test("a new row is appended", () => {
    const snapshot = state({ chats: [chat("c-1")] });
    const next = applyPatch(snapshot, patch({ chats: [chat("c-2")] }));

    expect(next.chats.map((c) => c.id)).toEqual(["c-1", "c-2"]);
  });

  test("deleting a chat takes its messages, matching the SQL cascade", () => {
    const snapshot = state({
      chats: [chat("c-1"), chat("c-2")],
      messages: [message("m-1", "c-1"), message("m-2", "c-2")],
    });

    const next = applyPatch(snapshot, patch({ deletedChats: ["c-1"] }));

    expect(next.chats.map((c) => c.id)).toEqual(["c-2"]);
    expect(next.messages.map((m) => m.id)).toEqual(["m-2"]);
  });

  test("the input snapshot is not mutated", () => {
    // The store holds these arrays; applying a patch must not reach into them.
    const snapshot = state({ chats: [chat("c-1")] });
    applyPatch(snapshot, patch({ chats: [chat("c-2")], deletedChats: ["c-1"] }));

    expect(snapshot.chats.map((c) => c.id)).toEqual(["c-1"]);
  });

  test("deleting a project cascades two levels, matching the SQL", () => {
    // The assertion that matters is `messages`: they hang off chats, not off the
    // project, so a one-level cascade would leave them orphaned in localStorage
    // while SQLite removed them. That divergence is exactly what this file exists
    // to prevent.
    const snapshot = state({
      projects: [project("p-1"), project("p-2")],
      chats: [chat("c-1", { projectId: "p-1" }), chat("c-2", { projectId: "p-2" })],
      messages: [message("m-1", "c-1"), message("m-2", "c-2")],
      memory: [memoryEntry("mem-1", "p-1"), memoryEntry("mem-2", "p-2")],
      decisions: [decision("dec-1", "p-1")],
    });

    const next = applyPatch(snapshot, patch({ deletedProjects: ["p-1"] }));

    expect(next.projects.map((p) => p.id)).toEqual(["p-2"]);
    expect(next.chats.map((c) => c.id)).toEqual(["c-2"]);
    expect(next.messages.map((m) => m.id)).toEqual(["m-2"]);
    expect(next.memory.map((m) => m.id)).toEqual(["mem-2"]);
    expect(next.decisions).toHaveLength(0);
  });

  test("a project and a chat deleted in one patch both go", () => {
    const snapshot = state({
      projects: [project("p-1"), project("p-2")],
      chats: [chat("c-1", { projectId: "p-1" }), chat("c-2", { projectId: "p-2" })],
      messages: [message("m-1", "c-1"), message("m-2", "c-2")],
    });

    const next = applyPatch(
      snapshot,
      patch({ deletedProjects: ["p-1"], deletedChats: ["c-2"] }),
    );

    expect(next.chats).toHaveLength(0);
    expect(next.messages).toHaveLength(0);
  });

  test("deleting a workspace cascades through projects and chats", () => {
    const snapshot = state({
      workspaces: [
        { id: "ws-1", name: "One" },
        { id: "ws-2", name: "Two" },
      ],
      projects: [
        project("p-1", { workspaceId: "ws-1" }),
        project("p-2", { workspaceId: "ws-2" }),
      ],
      chats: [
        chat("c-1", { projectId: "p-1" }),
        chat("c-2", { projectId: "p-2" }),
      ],
      messages: [message("m-1", "c-1"), message("m-2", "c-2")],
    });

    const next = applyPatch(snapshot, patch({ deletedWorkspaces: ["ws-1"] }));

    expect(next.workspaces.map((workspace) => workspace.id)).toEqual(["ws-2"]);
    expect(next.projects.map((project) => project.id)).toEqual(["p-2"]);
    expect(next.chats.map((chat) => chat.id)).toEqual(["c-2"]);
    expect(next.messages.map((message) => message.id)).toEqual(["m-2"]);
  });
});
