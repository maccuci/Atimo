import { afterEach, describe, expect, test } from "bun:test";
import { publishWorkspace, resetWorkspace } from "../lib/workspace";
import { compose } from "../lib/context-composer";
import {
  buildMessages,
  contentText,
  systemPreamble,
} from "../lib/prompt-builder";
import { contextUsage } from "../lib/context-usage";
import { resolveReference } from "../lib/reference-resolver";
import { contextBudget } from "../lib/tokens";
import type { Project } from "../lib/types";

/*
 * The project's base context, from the field to the wire.
 *
 * "A project can have multiple chats and its base context is shared" is the whole
 * claim, and it is only true if three things hold: every chat in the project
 * composes it, the optimizer never drops it, and the Prompt Builder does not file
 * it under project knowledge. Each is tested here, because each fails silently —
 * a brief that quietly stopped being sent looks identical from the UI.
 */

const MODEL = "claude-opus-5";

const project = (over: Partial<Project> = {}): Project => ({
  id: "p-1",
  workspaceId: "ws-1",
  name: "Atimo",
  description: "The shared knowledge layer.",
  instructions: "Never suggest MongoDB. Prefer Postgres with pgvector.",
  memoryTokens: 0,
  ...over,
});

const graph = (projects: Project[], over: Record<string, unknown> = {}) => ({
  workspaces: [{ id: "ws-1", name: "Test" }],
  projects,
  chats: [
    {
      id: "c-1",
      projectId: "p-1",
      title: "Architecture",
      modelId: MODEL,
      createdAt: "2026-07-01T00:00:00.000Z",
      updatedAt: "2026-07-01T00:00:00.000Z",
    },
    {
      id: "c-2",
      projectId: "p-1",
      title: "Frontend",
      modelId: "gpt-5.6-sol",
      createdAt: "2026-07-02T00:00:00.000Z",
      updatedAt: "2026-07-02T00:00:00.000Z",
    },
  ],
  messages: [],
  memory: [],
  documents: [],
  decisions: [],
  ...over,
});

afterEach(resetWorkspace);

describe("the base context in the composed prompt", () => {
  test("is composed for a prompt that has nothing to do with it", () => {
    publishWorkspace(graph([project()]));

    // Retrieval is scored; this is not. The brief applies because it is the
    // project's, not because the prompt happened to mention it.
    const context = compose("what time is it", "p-1", MODEL);
    const chunk = context.chunks.find((c) => c.stage === "project");

    expect(chunk).toBeDefined();
    expect(chunk!.included).toBe(true);
    expect(chunk!.excerpt).toContain("MongoDB");
  });

  test("is the same for every chat in the project, whichever model", () => {
    publishWorkspace(graph([project()]));

    // The claim in one assertion: two chats, two different models, one brief.
    const first = compose("design the schema", "p-1", MODEL);
    const second = compose("build the form", "p-1", "gpt-5.6-sol");

    const briefOf = (c: typeof first) =>
      c.chunks.find((x) => x.stage === "project")!.excerpt;

    expect(briefOf(first)).toBe(briefOf(second));
  });

  test("survives a budget too small to hold it", () => {
    // Priced against the narrowest seed window, so the brief genuinely exceeds
    // the retrieval budget rather than merely being large. A chunk competing for
    // that budget would certainly be dropped; instructions do not compete.
    const narrow = "claude-haiku-4.5";
    publishWorkspace(
      graph([project({ instructions: "Prefer Postgres. ".repeat(20_000) })]),
    );

    const context = compose("anything", "p-1", narrow);
    const chunk = context.chunks.find((c) => c.stage === "project")!;

    expect(chunk.tokens).toBeGreaterThan(contextBudget(narrow));
    expect(chunk.required).toBe(true);
    expect(chunk.included).toBe(true);
  });

  test("a project with no brief contributes no chunk at all", () => {
    publishWorkspace(graph([project({ instructions: "" })]));

    // Not an empty chunk: an empty heading in the system message would cost
    // tokens and tell the model there was a brief it could not see.
    const context = compose("anything", "p-1", MODEL);
    expect(context.chunks.some((c) => c.stage === "project")).toBe(false);
  });

  test("a whitespace-only brief is treated as none", () => {
    publishWorkspace(graph([project({ instructions: "  \n\n  " })]));
    const context = compose("anything", "p-1", MODEL);
    expect(context.chunks.some((c) => c.stage === "project")).toBe(false);
  });

  test("another project's brief does not leak in", () => {
    publishWorkspace(
      graph([
        project(),
        project({ id: "p-2", name: "Other", instructions: "Always use MongoDB." }),
      ]),
    );

    const context = compose("anything", "p-1", MODEL);
    const briefs = context.chunks.filter((c) => c.stage === "project");

    expect(briefs).toHaveLength(1);
    expect(briefs[0]!.excerpt).not.toContain("Always use MongoDB");
  });
});

describe("the base context in the system message", () => {
  test("is sent under its own heading, not as project knowledge", () => {
    publishWorkspace(graph([project()]));
    const context = compose("design the schema", "p-1", MODEL);

    const built = buildMessages({
      context,
      history: [],
      prompt: "design the schema",
      projectName: "Atimo",
    });
    const system = contentText(built[0]!.content);

    expect(system).toContain("## Project instructions");
    expect(system).toContain("Never suggest MongoDB");

    /*
     * The load-bearing assertion. The brief must not land under "Project
     * memory — established facts": a model that reads standing instructions as
     * things the project discovered will cite them back as findings, which is
     * the same mistake the skills block exists to avoid.
     */
    const instructionsAt = system.indexOf("## Project instructions");
    const memoryAt = system.indexOf("## Project memory");
    if (memoryAt !== -1) expect(instructionsAt).toBeLessThan(memoryAt);
    expect(system).not.toMatch(
      /## Project memory[\s\S]*Never suggest MongoDB/,
    );
  });

  test("is absent from the system message when the project has none", () => {
    publishWorkspace(graph([project({ instructions: "" })]));
    const context = compose("hello", "p-1", MODEL);

    const system = contentText(
      buildMessages({
        context,
        history: [],
        prompt: "hello",
        projectName: "Atimo",
      })[0]!.content,
    );

    expect(system).not.toContain("## Project instructions");
  });

  test("the one-line description stays in the preamble, not in the brief block", () => {
    // Two different jobs for two different fields: the description orients the
    // model in one sentence, the brief tells it how to work.
    expect(systemPreamble("Atimo", "The shared knowledge layer.")).toContain(
      "The shared knowledge layer.",
    );
  });
});

describe("what the base context costs", () => {
  test("is reported as its own segment, not folded into the system brief", () => {
    publishWorkspace(graph([project()]));
    const context = compose("anything", "p-1", MODEL);

    const usage = contextUsage({
      context,
      history: [],
      draft: "anything",
      modelId: MODEL,
      projectName: "Atimo",
      projectDescription: "The shared knowledge layer.",
    });

    const segment = usage.segments.find((s) => s.id === "instructions")!;
    expect(segment.tokens).toBeGreaterThan(0);

    // A user who cannot see what the brief costs cannot decide whether it earns
    // its place on every turn.
    const brief = usage.segments.find((s) => s.id === "brief")!;
    expect(segment.tokens).not.toBe(brief.tokens);
  });

  test("costs nothing when there is no brief", () => {
    publishWorkspace(graph([project({ instructions: "" })]));
    const context = compose("anything", "p-1", MODEL);

    const usage = contextUsage({
      context,
      history: [],
      draft: "anything",
      modelId: MODEL,
      projectName: "Atimo",
    });

    expect(usage.segments.find((s) => s.id === "instructions")!.tokens).toBe(0);
  });
});

describe('@project("…")', () => {
  test("resolves to another project's description and brief", () => {
    publishWorkspace(
      graph([
        project(),
        project({
          id: "p-2",
          name: "Inserium",
          description: "Agency work.",
          instructions: "Copy in Brazilian Portuguese.",
        }),
      ]),
    );

    // Reaching a *different* project is the point: it is the cross-project half
    // of the shared-knowledge thesis.
    const resolved = resolveReference("project", "Inserium", "p-1");

    expect(resolved).not.toBeNull();
    expect(resolved!.excerpt).toContain("Agency work.");
    expect(resolved!.excerpt).toContain("Copy in Brazilian Portuguese.");
  });

  test("naming the open project does not send its brief twice", () => {
    publishWorkspace(graph([project()]));

    const context = compose('summarise @project("Atimo")', "p-1", MODEL);
    const copies = context.chunks.filter((c) =>
      c.excerpt.includes("Never suggest MongoDB"),
    );

    // The base-context chunk and the reference resolve to the same project id, so
    // dedupe collapses them — otherwise the brief would be paid for twice.
    expect(copies).toHaveLength(1);
  });

  test("a project with neither description nor brief resolves to nothing", () => {
    publishWorkspace(
      graph([
        project(),
        project({ id: "p-2", name: "Bare", description: "", instructions: "" }),
      ]),
    );

    // An empty reference would inject a heading with no content under it.
    expect(resolveReference("project", "Bare", "p-1")).toBeNull();
  });
});
