import { describe, expect, test } from "bun:test";
import {
  EXPORT_FORMAT,
  EXPORT_FORMAT_VERSION,
  buildExport,
  exportStem,
  toJson,
  toMarkdown,
  type ExportSource,
} from "../lib/export";
import type { Chat, Message, Project } from "../lib/types";

/*
 * The export is a backup, so the failure that matters is not "it crashed" but
 * "it wrote a file that looks complete and is not". Most of what follows is
 * about that: scoping that drops rows it should have kept, and rows kept that
 * belong to someone else.
 */

const NOW = new Date("2026-07-30T10:00:00.000Z");

function project(id: string, name: string): Project {
  return {
    id,
    workspaceId: "w1",
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
    modelId: "anthropic/claude-opus-5",
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
      message("m2", "c2", "hello from p2"),
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
      {
        id: "mem2",
        projectId: "p2",
        kind: "standard",
        title: "Citations",
        body: "APA",
        createdAt: "2026-07-01T00:00:00.000Z",
        hits: 0,
      },
    ],
    decisions: [
      {
        id: "d1",
        projectId: "p1",
        title: "Use SQLite",
        reason: "No server",
        alternatives: ["Postgres"],
        date: "2026-07-02",
        participants: ["anthropic/claude-opus-5"],
        affectedFiles: ["src-tauri/src/db.rs"],
      },
    ],
    timeline: [
      {
        id: "t1",
        projectId: "p1",
        date: "2026-07-02",
        modelId: "anthropic/claude-opus-5",
        summary: "Chose SQLite",
        kind: "decision",
      },
    ],
    documents: [
      {
        id: "doc1",
        projectId: "p1",
        name: "Runbook.md",
        kind: "markdown",
        tokens: 20,
        updatedAt: "2026-07-01T00:00:00.000Z",
        excerpt: "How to deploy",
      },
      {
        id: "doc2",
        projectId: "p2",
        name: "Paper.txt",
        kind: "text",
        tokens: 10,
        updatedAt: "2026-07-01T00:00:00.000Z",
        excerpt: "Abstract",
      },
    ],
    chunks: [
      { id: "k1", documentId: "doc1", projectId: "p1", index: 0, text: "Deploy with CI", tokens: 10 },
      { id: "k2", documentId: "doc2", projectId: "p2", index: 0, text: "Abstract text", tokens: 10 },
    ],
    attachments: [
      { id: "a1", messageId: "m1", chatId: "c1", data: "data:image/png;base64,AAA" },
      { id: "a2", messageId: "m3", chatId: "c2", data: "data:image/png;base64,BBB" },
    ],
  };
}

const options = { label: "My Company", app: "0.1.0", now: NOW };

describe("scope", () => {
  test("a workspace export keeps everything", () => {
    const doc = buildExport(source(), options);

    expect(doc.projects).toHaveLength(2);
    expect(doc.chats).toHaveLength(2);
    expect(doc.messages).toHaveLength(2);
    expect(doc.memory).toHaveLength(2);
    expect(doc.documents).toHaveLength(2);
    expect(doc.chunks).toHaveLength(2);
    expect(doc.scope).toEqual({ kind: "workspace" });
  });

  /*
   * The bug this exists to prevent: messages carry a `chatId` and no
   * `projectId`, so a scoping pass that filtered each slice on `projectId`
   * independently would find the field missing on messages and keep either all
   * of them or none. Both are wrong and neither throws.
   */
  test("a project export keeps that project's messages, reached through its chats", () => {
    const doc = buildExport(source(), { ...options, projectId: "p1" });

    expect(doc.projects.map((p) => p.id)).toEqual(["p1"]);
    expect(doc.chats.map((c) => c.id)).toEqual(["c1"]);
    expect(doc.messages.map((m) => m.id)).toEqual(["m1"]);
  });

  test("a project export does not leak another project's knowledge", () => {
    const doc = buildExport(source(), { ...options, projectId: "p1" });

    expect(doc.memory.map((m) => m.id)).toEqual(["mem1"]);
    expect(doc.decisions.map((d) => d.id)).toEqual(["d1"]);
    expect(doc.timeline.map((t) => t.id)).toEqual(["t1"]);
    expect(doc.documents.map((d) => d.id)).toEqual(["doc1"]);
    expect(doc.scope).toEqual({ kind: "project", projectId: "p1" });
  });

  /* Document text is reached through documents, which are reached through
     projects — two hops, and the one most likely to be dropped. */
  test("document text follows its document into a project export", () => {
    const doc = buildExport(source(), { ...options, projectId: "p1" });

    expect(doc.chunks.map((c) => c.id)).toEqual(["k1"]);
    expect(doc.chunks[0]?.text).toBe("Deploy with CI");
  });

  test("exporting a project that does not exist yields an empty document, not everything", () => {
    const doc = buildExport(source(), { ...options, projectId: "nope" });

    expect(doc.projects).toHaveLength(0);
    expect(doc.chats).toHaveLength(0);
    expect(doc.messages).toHaveLength(0);
    expect(doc.chunks).toHaveLength(0);
  });
});

describe("json", () => {
  test("carries the format stamp an importer would read first", () => {
    const parsed = JSON.parse(toJson(buildExport(source(), options)));

    expect(parsed.format).toBe(EXPORT_FORMAT);
    expect(parsed.version).toBe(EXPORT_FORMAT_VERSION);
    expect(parsed.app).toBe("0.1.0");
    expect(parsed.exportedAt).toBe("2026-07-30T10:00:00.000Z");
  });

  test("round-trips every slice unchanged", () => {
    const doc = buildExport(source(), options);
    const parsed = JSON.parse(toJson(doc));

    // The point of the JSON format: what comes out is what the store held, so
    // a future import is a seed rather than a translation.
    expect(parsed.projects).toEqual(doc.projects);
    expect(parsed.messages).toEqual(doc.messages);
    expect(parsed.chunks).toEqual(doc.chunks);
  });
});

describe("markdown", () => {
  test("names the model that answered rather than 'assistant'", () => {
    const src = source();
    src.messages.push({
      id: "m3",
      chatId: "c1",
      role: "assistant",
      content: "an answer",
      createdAt: "2026-07-01T00:01:00.000Z",
      modelId: "openai/gpt-5",
    });

    const md = toMarkdown(buildExport(src, options));

    expect(md).toContain("**openai/gpt-5**");
    expect(md).not.toContain("**Assistant**");
  });

  test("includes the base context, memory, decisions and transcripts", () => {
    const md = toMarkdown(buildExport(source(), options));

    expect(md).toContain("# My Company");
    expect(md).toContain("## Atimo");
    expect(md).toContain("Atimo brief");
    expect(md).toContain("We use Postgres");
    expect(md).toContain("Use SQLite");
    expect(md).toContain("hello from p1");
  });

  test("fences document text so an uploaded file cannot restructure the export", () => {
    const src = source();
    src.chunks[0]!.text = "# Not a section of this export";

    const md = toMarkdown(buildExport(src, options));

    expect(md).toContain("```\n# Not a section of this export\n```");
  });

  test("says when a turn failed or was stopped rather than showing a blank reply", () => {
    const src = source();
    src.messages.push({
      id: "m4",
      chatId: "c1",
      role: "assistant",
      content: "",
      createdAt: "2026-07-01T00:02:00.000Z",
      modelId: "openai/gpt-5",
      error: "rate limited",
    });

    const md = toMarkdown(buildExport(src, options));

    expect(md).toContain("> Failed: rate limited");
  });
});

describe("filename", () => {
  test("is the label and the date", () => {
    const doc = buildExport(source(), options);

    expect(exportStem(doc)).toBe("atimo-My-Company-2026-07-30");
  });

  test("survives a label that is punctuation, an accent or nothing at all", () => {
    const stem = (label: string) =>
      exportStem(buildExport(source(), { ...options, label }));

    expect(stem("Pesquisa Acadêmica")).toBe("atimo-Pesquisa-Academica-2026-07-30");
    expect(stem("a/b\\c")).toBe("atimo-abc-2026-07-30");
    expect(stem("   ")).toBe("atimo-workspace-2026-07-30");
    expect(stem("研究")).toBe("atimo-workspace-2026-07-30");
  });
});
