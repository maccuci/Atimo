import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  encodeVector,
  embedQuery,
  resetEmbeddings,
  setEmbedderForTests,
} from "../lib/embeddings";
import {
  ensureVectors,
  forgetMissingProjects,
  hasVectors,
  passageId,
  passagesOf,
  reindexProject,
  scoreProject,
  resetVectors,
} from "../lib/vectors";
import { ensureIndex, indexDocument, resetIndexes, toDocument } from "../lib/documents";
import { compose } from "../lib/context-composer";
import { semanticSearch } from "../lib/search";
import { publishWorkspace, resetWorkspace } from "../lib/workspace";
import { store } from "../lib/persistence";
import type { WorkspaceGraph } from "../lib/workspace";

/*
 * Meaning matching, end to end.
 *
 * The claim under test is the one the PRD makes and the lexical stand-in could
 * not keep: a conversation about *session cookies* is what someone asking about
 * *login flow* is looking for, and the two share no word at all. Every
 * assertion below is that sentence from a different reader — the command
 * palette, the Context Composer, a named `@chat()`.
 *
 * The embedder is a stand-in, and deliberately a crude one: it maps text onto
 * one of four topics by keyword. That is not a model, and it is not pretending
 * to be — what is being tested is the index, the fusion and the fallbacks, all
 * of which are wrong or right regardless of how good the vectors are. Testing
 * them against the real model would make the suite depend on a gigabyte of
 * download and turn every ranking assertion into a judgement about ONNX.
 */

class MemoryStorage {
  private map = new Map<string, string>();
  get length() {
    return this.map.size;
  }
  key(i: number) {
    return [...this.map.keys()][i] ?? null;
  }
  getItem(k: string) {
    return this.map.get(k) ?? null;
  }
  setItem(k: string, v: string) {
    this.map.set(k, String(v));
  }
  removeItem(k: string) {
    this.map.delete(k);
  }
  clear() {
    this.map.clear();
  }
}

/** The four things anything in these fixtures can be about. */
const TOPICS: Array<[axis: number, words: string[]]> = [
  [0, ["session", "cookie", "cookies", "login", "signin", "auth", "credential", "password"]],
  [1, ["postgres", "migration", "migrations", "sql", "schema", "database"]],
  [2, ["latency", "slow", "throughput", "cache", "performance"]],
];

function topicOf(text: string): number {
  const hay = text.toLowerCase();
  for (const [axis, words] of TOPICS) {
    if (words.some((word) => hay.includes(word))) return axis;
  }
  return 3;
}

/** A model that knows exactly one thing: which of four topics a text is about. */
const topicEmbedder = async (texts: string[]) =>
  texts.map((text) => {
    const values = [0.1, 0.1, 0.1, 0.1];
    values[topicOf(text)] = 1;
    return encodeVector(values);
  });

const MODEL = "claude-opus-5";

function graph(overrides: Partial<WorkspaceGraph> = {}): WorkspaceGraph {
  return {
    workspaces: [{ id: "ws-1", name: "Test" }],
    projects: [
      {
        id: "p-1",
        workspaceId: "ws-1",
        name: "Product",
        description: "",
        instructions: "",
        memoryTokens: 0,
      },
    ],
    chats: [],
    messages: [],
    memory: [],
    decisions: [],
    documents: [],
    ...overrides,
  };
}

function chat(id: string, title: string) {
  return {
    id,
    projectId: "p-1",
    title,
    modelId: MODEL,
    createdAt: "2026-07-01T00:00:00.000Z",
    updatedAt: "2026-07-01T00:00:00.000Z",
  };
}

function message(id: string, chatId: string, content: string) {
  return {
    id,
    chatId,
    role: "assistant" as const,
    modelId: MODEL,
    content,
    createdAt: "2026-07-01T00:00:00.000Z",
  };
}

beforeEach(() => {
  globalThis.localStorage = new MemoryStorage() as unknown as Storage;
  resetIndexes();
  resetVectors();
  resetEmbeddings();
  setEmbedderForTests(topicEmbedder);
});

afterEach(() => {
  setEmbedderForTests(null);
  resetWorkspace();
});

/* ---------------------------------------------------------------------- */

describe("passagesOf", () => {
  test("a paragraph that is already a thought is left as one", () => {
    const text = [
      "The session cookie is set on the auth callback and read on every request after it, which is what keeps the user signed in across page loads.",
      "The refresh token lives in the database rather than in a cookie, because a cookie the browser can send is a cookie an attacker can replay.",
    ].join("\n\n");

    expect(passagesOf(text)).toHaveLength(2);
  });

  test("short paragraphs are packed with their neighbours", () => {
    // "Yes." is a point in space that means nothing and sits close to every
    // other short affirmation in the workspace. It needs its context.
    const text = ["Yes.", "ok", "Sounds right."].join("\n\n");
    expect(passagesOf(text)).toHaveLength(1);
  });

  test("a wall of text is cut rather than truncated by the model", () => {
    // The model reads 512 tokens and stops. Embedded whole, the second half of
    // this would not be in the index at all, and nothing would say so.
    const passages = passagesOf("x".repeat(5_000));
    expect(passages.length).toBeGreaterThan(2);
    expect(passages.every((p) => p.length <= 1_600)).toBe(true);
  });

  test("the extract and the index name a passage the same way", () => {
    // Two splitters would mean the extract asking the index about passages that
    // do not exist in it, and silently scoring every one of them at zero.
    expect(passageId("m-1", 2)).toBe("passage:m-1#2");
  });
});

/* ---------------------------------------------------------------------- */

describe("the index", () => {
  test("a project with nothing indexed says so, rather than scoring zero", async () => {
    publishWorkspace(graph());
    expect(hasVectors("p-1")).toBe(false);
  });

  test("a scan embeds the project's chats", async () => {
    publishWorkspace(
      graph({
        chats: [chat("c-1", "Auth")],
        messages: [message("m-1", "c-1", "The session cookie is set on the callback and read on every request after that.")],
      }),
    );

    await reindexProject("p-1");
    expect(hasVectors("p-1")).toBe(true);

    const auth = (await embedQuery("how does login work"))!;
    expect([...scoreProject("p-1", auth).passage.values()].some((s) => s > 0.5)).toBe(true);
  });

  test("a second scan re-embeds only what changed", async () => {
    let embedded = 0;
    setEmbedderForTests(async (texts) => {
      embedded += texts.length;
      return topicEmbedder(texts);
    });

    const before = graph({
      chats: [chat("c-1", "Auth")],
      messages: [message("m-1", "c-1", "The session cookie is set on the auth callback.")],
    });
    publishWorkspace(before);
    await reindexProject("p-1");
    const first = embedded;
    expect(first).toBeGreaterThan(0);

    // One new message in a project that already has an index. Without the
    // fingerprints this is where every turn re-embeds the whole conversation.
    publishWorkspace({
      ...before,
      messages: [
        ...before.messages,
        message("m-2", "c-1", "Migrations run before the new build takes traffic."),
      ],
    });
    await reindexProject("p-1");

    expect(embedded - first).toBe(1);
  });

  test("a scan with nothing to do does not reach the model", async () => {
    publishWorkspace(
      graph({
        chats: [chat("c-1", "Auth")],
        messages: [message("m-1", "c-1", "The session cookie is set on the auth callback.")],
      }),
    );
    await reindexProject("p-1");

    let calls = 0;
    setEmbedderForTests(async (texts) => {
      calls += 1;
      return topicEmbedder(texts);
    });
    await reindexProject("p-1");

    // The common case, on every idle tick of the sync loop.
    expect(calls).toBe(0);
  });

  test("a passage the workspace no longer contains stops being retrievable", async () => {
    const before = graph({
      chats: [chat("c-1", "Auth")],
      messages: [
        message("m-1", "c-1", "The session cookie is set on the auth callback and read on every later request."),
        message("m-2", "c-1", "Migrations run before the new build takes traffic, and are not rolled back."),
      ],
    });
    publishWorkspace(before);
    await reindexProject("p-1");

    const db = (await embedQuery("when do migrations run"))!;
    expect(scoreProject("p-1", db).passage.get("m-2")).toBeGreaterThan(0.5);

    // The second message is deleted. No cascade reaches its vector — the chat is
    // still there — so left behind it is quotable text the chat does not have.
    publishWorkspace({ ...before, messages: [before.messages[0]!] });
    await reindexProject("p-1");

    expect(scoreProject("p-1", db).passage.has("m-2")).toBe(false);
  });

  test("a pending message is not indexed until it has said something", async () => {
    publishWorkspace(
      graph({
        chats: [chat("c-1", "Auth")],
        messages: [{ ...message("m-1", "c-1", "The session cook"), pending: true }],
      }),
    );
    await reindexProject("p-1");

    // Streaming rewrites this row sixty times a second. Indexing it would be the
    // most expensive thing the app does, in service of text still being written.
    expect(hasVectors("p-1")).toBe(false);
  });

  test("vectors survive a reload, and are not re-embedded", async () => {
    publishWorkspace(
      graph({
        chats: [chat("c-1", "Auth")],
        messages: [message("m-1", "c-1", "The session cookie is set on the auth callback.")],
      }),
    );
    await reindexProject("p-1");

    // What a relaunch looks like: the in-memory index is gone, the rows are not.
    resetVectors();
    let calls = 0;
    setEmbedderForTests(async (texts) => {
      calls += 1;
      return topicEmbedder(texts);
    });

    await ensureVectors("p-1");
    expect(hasVectors("p-1")).toBe(true);
    await reindexProject("p-1");
    expect(calls).toBe(0);
  });

  test("a deleted project's index is dropped even when it left with its workspace", async () => {
    publishWorkspace(
      graph({
        chats: [chat("c-1", "Auth")],
        messages: [message("m-1", "c-1", "The session cookie is set on the auth callback.")],
      }),
    );
    await reindexProject("p-1");
    expect(hasVectors("p-1")).toBe(true);

    // A workspace delete never names its projects — the database cascade covers
    // them — so the in-memory index has to be worked out by difference.
    forgetMissingProjects([]);
    expect(hasVectors("p-1")).toBe(false);
  });
});

/* ---------------------------------------------------------------------- */

describe("documents", () => {
  const RUNBOOK = `# Sign-in

A session cookie is issued on the auth callback and read on every request
after it, which is what keeps someone signed in across page loads.

# Migrations

Migrations run before the new build receives traffic. One that cannot be
rolled back must ship in its own release.
`;

  async function uploadRunbook() {
    const { document, chunks } = toDocument(
      { name: "Runbook.md", kind: "markdown", text: RUNBOOK, bytes: RUNBOOK.length },
      "p-1",
    );
    await store.putChunks(document.id, chunks);
    await ensureIndex("p-1");
    indexDocument("p-1", chunks);
    return { document, chunks };
  }

  test("a chunk is reachable by meaning, and lifts its document with it", async () => {
    const { document } = await uploadRunbook();
    publishWorkspace(graph({ documents: [document] }));
    await reindexProject("p-1");

    const query = (await embedQuery("how does login work"))!;

    // Per chunk, for choosing which paragraphs to inject...
    const chunks = scoreProject("p-1", query).chunk;
    expect([...chunks.values()].some((s) => s > 0.5)).toBe(true);

    // ...and per document, for ranking files in the palette. A file is forty
    // pages about forty things; only its best passage has a useful answer.
    expect(scoreProject("p-1", query).document.get(document.id)).toBeGreaterThan(0.5);
  });
});

/* ---------------------------------------------------------------------- */

/*
 * The reported failure, in one sentence: a conversation that talked about
 * session cookies is invisible to a search for login flow.
 */
describe("what the synonym table could not do", () => {
  const AUTH = [
    "The session cookie is issued on the auth callback and read on every request after it.",
    "It is scoped to the apex domain so the marketing site and the app share one signed-in state.",
  ].join("\n\n");

  const SPEED = [
    "The p95 sits at 640ms, and almost all of it is the fan-out to the pricing service.",
    "Caching the pricing response for sixty seconds takes it to 180ms with no correctness cost.",
  ].join("\n\n");

  const workspace = () =>
    graph({
      chats: [chat("c-auth", "Cookies and domains"), chat("c-speed", "The 640ms problem")],
      messages: [message("m-1", "c-auth", AUTH), message("m-2", "c-speed", SPEED)],
    });

  test("the palette finds the conversation with no word in common", async () => {
    publishWorkspace(workspace());
    await reindexProject("p-1");
    await embedQuery("login flow");

    const [best] = semanticSearch("login flow", { projectId: "p-1" });

    // "login" and "flow" appear nowhere in that chat, and neither does any word
    // the old seven-entry synonym table would have expanded them to.
    expect(best?.id).toBe("c-auth");
    expect(AUTH.toLowerCase()).not.toContain("login");
  });

  test("the composer injects it, not just the palette", async () => {
    publishWorkspace(workspace());
    await reindexProject("p-1");
    await embedQuery("how does login work");

    const context = compose("how does login work", "p-1", MODEL);
    const injected = context.chunks.filter((c) => c.included && c.kind === "chat");

    // The palette finding it and the pipeline not injecting it would be the
    // worse half of the same bug: the user can see the conversation exists and
    // the model still answers as though it does not.
    expect(injected.map((c) => c.label)).toContain("Cookies and domains");
  });

  test("a named chat contributes the passage that answers, not its opening", async () => {
    publishWorkspace(workspace());
    await reindexProject("p-1");

    const prompt = 'Based on @chat("The 640ms problem"), what did we do about it?';
    await embedQuery(prompt);

    const context = compose(prompt, "p-1", MODEL);
    const resolved = context.chunks.find(
      (c) => c.stage === "resolve" && c.kind === "chat",
    );

    expect(resolved?.excerpt).toContain("Caching the pricing response");
  });

  test("an exact identifier still wins on words alone", async () => {
    // The half embeddings are structurally bad at: a model trained on prose has
    // never seen this string and puts it wherever it puts the others.
    publishWorkspace(
      graph({
        chats: [chat("c-auth", "Cookies and domains"), chat("c-err", "Build failure")],
        messages: [
          message("m-1", "c-auth", AUTH),
          message("m-2", "c-err", "The build died with ERR_MODULE_NOT_FOUND on the pricing package."),
        ],
      }),
    );
    await reindexProject("p-1");
    await embedQuery("ERR_MODULE_NOT_FOUND");

    const [best] = semanticSearch("ERR_MODULE_NOT_FOUND", { projectId: "p-1" });
    expect(best?.id).toBe("c-err");
  });

  test("search still works before anything has been embedded", async () => {
    // Every reader has to survive this: the model is still downloading, or this
    // is the browser build, or the project's index has not landed yet.
    publishWorkspace(workspace());
    resetVectors();

    const results = semanticSearch("cookie", { projectId: "p-1" });
    expect(results.map((r) => r.id)).toContain("c-auth");
  });
});
