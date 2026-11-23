import { beforeEach, describe, expect, test } from "bun:test";
import { buildExport, toJson, toMarkdown, type ExportSource } from "../lib/export";
import {
  ImportError,
  importedSnapshot,
  parseImport,
  planImport,
} from "../lib/import";
import { useStore } from "../lib/store";
import type { Chat, Message, Project } from "../lib/types";

/*
 * The import is the half of the backup that decides whether the other half was
 * worth writing, and its failures are quiet ones: a file that restores into a
 * workspace missing a transcript, or one that overwrites work it should have
 * left alone. Most of what follows is about those two.
 */

function project(id: string, name: string, workspaceId = "w1"): Project {
  return {
    id,
    workspaceId,
    name,
    description: `${name} description`,
    instructions: `${name} brief`,
    memoryTokens: 100,
  };
}

function chat(id: string, projectId: string, title: string): Chat {
  return {
    id,
    projectId,
    title,
    modelId: "claude-opus-5",
    createdAt: "2026-07-01T00:00:00.000Z",
    updatedAt: "2026-07-01T00:00:00.000Z",
  };
}

function message(id: string, chatId: string, content: string): Message {
  return {
    id,
    chatId,
    role: "user",
    content,
    createdAt: "2026-07-01T00:00:00.000Z",
  };
}

function source(): ExportSource {
  return {
    workspaces: [{ id: "w1", name: "Workspace one" }],
    projects: [project("p1", "Atimo"), project("p2", "Research")],
    chats: [chat("c1", "p1", "Backend"), chat("c2", "p2", "Papers")],
    messages: [
      message("m1", "c1", "hello from p1"),
      message("m2", "c1", "second in c1"),
      message("m3", "c2", "hello from p2"),
    ],
    memory: [
      {
        id: "mem1",
        projectId: "p1",
        kind: "architecture",
        title: "Postgres",
        body: "We use Postgres",
        createdAt: "2026-07-01T00:00:00.000Z",
        hits: 3,
      },
    ],
    decisions: [
      {
        id: "d1",
        projectId: "p1",
        title: "Use SQLite",
        reason: "local first",
        alternatives: ["Postgres"],
        date: "2026-07-01",
        participants: ["claude-opus-5"],
        affectedFiles: ["db.rs"],
      },
    ],
    timeline: [
      {
        id: "t1",
        projectId: "p1",
        date: "2026-07-01",
        modelId: "claude-opus-5",
        summary: "Decided on SQLite",
        kind: "decision",
      },
    ],
    documents: [
      {
        id: "doc1",
        projectId: "p1",
        name: "Runbook.md",
        kind: "markdown",
        tokens: 12,
        updatedAt: "2026-07-01T00:00:00.000Z",
        excerpt: "How to run it",
      },
    ],
    chunks: [
      {
        id: "ch1",
        documentId: "doc1",
        projectId: "p1",
        index: 0,
        text: "How to run it: bun run tauri dev",
        tokens: 12,
      },
    ],
    attachments: [
      {
        id: "att1",
        messageId: "m1",
        chatId: "c1",
        data: "data:image/png;base64,AAAA",
      },
    ],
  };
}

const OPTIONS = { label: "Workspace one", app: "0.1.0", now: new Date("2026-07-30T10:00:00.000Z") };

function file(over: Record<string, unknown> = {}): string {
  return JSON.stringify({ ...buildExport(source(), OPTIONS), ...over });
}

describe("parseImport", () => {
  test("a file this app wrote reads back with every row intact", () => {
    const written = buildExport(source(), OPTIONS);
    const read = parseImport(toJson(written));

    // Deep equality across the whole document, not a spot check: the failure
    // this guards is a collection silently dropped in transit, and a test that
    // asserted on three of them would not see the fourth go missing.
    expect(read).toEqual(written);
  });

  test("the Markdown export is refused by name rather than by stack trace", () => {
    // The likeliest wrong file, because it sits next to the right one in the
    // same folder with the same stem.
    const markdown = toMarkdown(buildExport(source(), OPTIONS));
    expect(() => parseImport(markdown)).toThrow(ImportError);
    expect(() => parseImport(markdown)).toThrow(/Markdown/);
  });

  test("some other application's JSON is refused", () => {
    expect(() => parseImport(`{"format":"notion.export","pages":[]}`)).toThrow(
      /não uma exportação do Atimo/,
    );
    expect(() => parseImport(`{"projects":[]}`)).toThrow(/exportação do Atimo/);
    expect(() => parseImport(`[]`)).toThrow(ImportError);
  });

  test("a file from a newer build is refused rather than half-understood", () => {
    expect(() => parseImport(file({ version: 99 }))).toThrow(/formato de exportação 99/);
  });

  test("a backup made before the rename to Atimo still reads", () => {
    expect(parseImport(file({ format: "grapheno.workspace" })).chats).toHaveLength(2);
  });

  test("a file from an older build, or one missing a collection, still reads", () => {
    const { timeline: _dropped, ...rest } = JSON.parse(file());
    const read = parseImport(JSON.stringify(rest));
    expect(read.timeline).toEqual([]);
    expect(read.chats).toHaveLength(2);
  });

  test("a row with no id is refused — nothing could ever address it again", () => {
    const doc = JSON.parse(file());
    delete doc.chats[0].id;
    expect(() => parseImport(JSON.stringify(doc))).toThrow(/registros de chats não tem id/);
  });

  test("a collection that is not a list is refused", () => {
    expect(() => parseImport(file({ messages: "all of them" }))).toThrow(
      /"messages" não é uma lista/,
    );
  });

  /*
   * The whole point of validating here rather than letting the database do it.
   * `db_apply` would reject the transaction on the foreign key and the user
   * would read "FOREIGN KEY constraint failed", which names neither the file's
   * problem nor anything they can do about it.
   */
  test("a chat whose project is not in the file is refused, and says so", () => {
    const doc = JSON.parse(file());
    doc.projects = doc.projects.filter((p: Project) => p.id !== "p2");

    expect(() => parseImport(JSON.stringify(doc))).toThrow(
      /1 chat pertence a um projeto que o arquivo não contém/,
    );
  });

  test("orphaned messages are counted, not listed one at a time", () => {
    const doc = JSON.parse(file());
    doc.chats = [];
    doc.projects = [];
    doc.memory = [];
    doc.decisions = [];
    doc.timeline = [];
    doc.documents = [];
    doc.chunks = [];

    expect(() => parseImport(JSON.stringify(doc))).toThrow(
      /3 mensagens pertencem a um chat/,
    );
  });

  test("a missing workspace row is rebuilt rather than refused", () => {
    // The one parent that holds no content of its own, so reconstructing it
    // guesses a label and loses nothing. Every other one means rows are gone.
    const read = parseImport(file({ workspaces: [] }));

    expect(read.workspaces).toEqual([{ id: "w1", name: "Workspace importado" }]);
    expect(read.projects).toHaveLength(2);
  });

  test("a fork pointing outside the file is left alone", () => {
    // A single-project export legitimately references chats it does not carry.
    // Refusing that would make project exports unusable for sharing a project.
    const doc = JSON.parse(file());
    doc.chats[0].forkedFrom = { chatId: "c-elsewhere", messageId: "m-elsewhere" };

    expect(parseImport(JSON.stringify(doc)).chats[0].forkedFrom).toEqual({
      chatId: "c-elsewhere",
      messageId: "m-elsewhere",
    });
  });
});

describe("planImport", () => {
  test("counts what will arrive and what it will replace", () => {
    const doc = parseImport(file());
    const plan = planImport(doc, { projects: [project("p2", "Research")] });

    expect(plan.totals.projects).toBe(2);
    expect(plan.totals.messages).toBe(3);
    expect(plan.totals.documents).toBe(1);
    expect(plan.replacing).toBe(1);
    expect(plan.empty).toBe(false);
    expect(plan.app).toBe("0.1.0");
  });

  test("a file with no projects in it is nothing to import", () => {
    const doc = parseImport(
      file({
        projects: [],
        chats: [],
        messages: [],
        memory: [],
        decisions: [],
        timeline: [],
        documents: [],
        chunks: [],
        attachments: [],
      }),
    );
    expect(planImport(doc, { projects: [] }).empty).toBe(true);
  });
});

/*
 * The merge, through the store, because that is where getting it wrong is
 * expensive: the rule is upsert-by-id and never delete, and the two ways to
 * break it are losing rows the file did not mention and duplicating rows it did.
 */
describe("restore", () => {
  beforeEach(() => {
    useStore.setState({
      workspaces: [],
      projects: [],
      chats: [],
      messages: [],
      memory: [],
      decisions: [],
      timeline: [],
      documents: [],
      workspaceId: "",
      projectId: "",
      chatId: "",
    });
  });

  test("restoring into an empty workspace brings the file back whole", () => {
    const doc = parseImport(file());
    useStore.getState().restore(importedSnapshot(doc));

    const state = useStore.getState();
    expect(state.projects.map((p) => p.id)).toEqual(["p1", "p2"]);
    expect(state.messages.map((m) => m.id)).toEqual(["m1", "m2", "m3"]);
    expect(state.decisions).toHaveLength(1);
    // And it opens on what arrived, rather than leaving the user on nothing.
    expect(state.projectId).toBe("p1");
    expect(state.workspaceId).toBe("w1");
    expect(state.chatId).toBe("c1");
  });

  test("a project the file does not mention survives the restore", () => {
    useStore.getState().hydrate({
      workspaces: [{ id: "w9", name: "Mine" }],
      projects: [project("p9", "Untouched", "w9")],
      chats: [chat("c9", "p9", "Mine")],
      messages: [message("m9", "c9", "still here")],
      memory: [],
      decisions: [],
      timeline: [],
      documents: [],
    });

    useStore.getState().restore(importedSnapshot(parseImport(file())));

    const state = useStore.getState();
    expect(state.projects.map((p) => p.id)).toEqual(["p9", "p1", "p2"]);
    expect(state.messages.find((m) => m.id === "m9")?.content).toBe("still here");
  });

  test("a row the file also has is replaced in place, not duplicated", () => {
    useStore.getState().hydrate({
      workspaces: [{ id: "w1", name: "Workspace one" }],
      projects: [project("p1", "Stale name")],
      chats: [chat("c1", "p1", "Stale title")],
      messages: [
        message("m1", "c1", "stale first"),
        message("m-local", "c1", "written after the backup"),
      ],
      memory: [],
      decisions: [],
      timeline: [],
      documents: [],
    });

    useStore.getState().restore(importedSnapshot(parseImport(file())));

    const state = useStore.getState();
    expect(state.projects.filter((p) => p.id === "p1")).toHaveLength(1);
    expect(state.projects.find((p) => p.id === "p1")?.name).toBe("Atimo");
    expect(state.chats.find((c) => c.id === "c1")?.title).toBe("Backend");

    /*
     * Transcript order is array order — there is no sort anywhere between here
     * and the screen — so a replaced message has to keep its position. Appending
     * on update would walk the restored turn to the end of the conversation and
     * leave the transcript reading as an answer before its question.
     */
    expect(state.messages.map((m) => m.id)).toEqual(["m1", "m-local", "m2", "m3"]);
    expect(state.messages[0]?.content).toBe("hello from p1");
    expect(state.messages[1]?.content).toBe("written after the backup");
  });

  test("importing the same file twice changes nothing the second time", () => {
    const snapshot = importedSnapshot(parseImport(file()));
    useStore.getState().restore(snapshot);
    const after = useStore.getState();
    const once = {
      projects: after.projects,
      chats: after.chats,
      messages: after.messages,
    };

    useStore.getState().restore(importedSnapshot(parseImport(file())));

    const twice = useStore.getState();
    expect(twice.projects).toEqual(once.projects);
    expect(twice.chats).toEqual(once.chats);
    expect(twice.messages).toEqual(once.messages);
  });
});
