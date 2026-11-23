import { afterEach, describe, expect, test } from "bun:test";
import { publishWorkspace, resetWorkspace, workspace } from "../lib/workspace";
import { resolveReference } from "../lib/reference-resolver";
import { buildIndex } from "../lib/references";
import { semanticSearch } from "../lib/search";
import type { MemoryEntry } from "../lib/types";

/*
 * Retrieval used to read the fixtures directly, which meant a chat created or
 * renamed at runtime was invisible to `@references`, to the Context Composer and
 * to search. These cases pin the seam that fixed it: what the store publishes is
 * what retrieval sees, on the next call, with no explicit invalidation step.
 */

afterEach(resetWorkspace);

const graph = (over: Partial<ReturnType<typeof workspace>> = {}) => ({
  workspaces: [{ id: "ws-1", name: "Test" }],
  projects: [
    {
      id: "p-1",
      workspaceId: "ws-1",
      name: "Test",
      description: "",
      instructions: "",
      memoryTokens: 0,
    },
  ],
  chats: [
    {
      id: "c-1",
      projectId: "p-1",
      title: "Original",
      modelId: "claude-opus-5",
      createdAt: "2026-07-01T00:00:00.000Z",
      updatedAt: "2026-07-01T00:00:00.000Z",
    },
  ],
  messages: [
    {
      id: "m-1",
      chatId: "c-1",
      role: "user" as const,
      content: "We picked pgvector for the embedding index.",
      createdAt: "2026-07-01T00:00:00.000Z",
    },
  ],
  memory: [] as MemoryEntry[],
  documents: [],
  decisions: [],
  ...over,
});

describe("the published graph", () => {
  test("defaults to the fixtures, so nothing has to boot a store", () => {
    expect(resolveReference("chat", "Architecture", "p-atimo")).not.toBeNull();
  });

  test("a renamed chat resolves under its new title, not its old one", () => {
    publishWorkspace(graph());
    expect(resolveReference("chat", "Original", "p-1")).not.toBeNull();

    // The rename the store would publish: same id, new title.
    publishWorkspace(
      graph({ chats: [{ ...graph().chats[0]!, title: "Renamed" }] }),
    );

    // Both halves matter. The new title has to resolve, and the memoised answer
    // for the old one must not survive — a stale hit here is what would silently
    // inject the wrong chat into a prompt.
    expect(resolveReference("chat", "Renamed", "p-1")).not.toBeNull();
    expect(resolveReference("chat", "Original", "p-1")).toBeNull();
  });

  test("a deleted chat stops answering searches", () => {
    publishWorkspace(graph());
    expect(semanticSearch("pgvector", { projectId: "p-1" })).not.toHaveLength(0);

    publishWorkspace(graph({ chats: [], messages: [] }));
    expect(semanticSearch("pgvector", { projectId: "p-1" })).toHaveLength(0);
  });

  test("a file is found by its name, accents or not, above chats that only mention it", () => {
    const doc = {
      id: "d-1",
      projectId: "p-1",
      name: "Integração Pedidos.iar",
      kind: "integration",
      tokens: 0,
      updatedAt: "2026-07-01T00:00:00.000Z",
      excerpt: "",
    } as unknown as ReturnType<typeof workspace>["documents"][number];
    publishWorkspace(
      graph({
        documents: [doc],
        messages: [{ ...graph().messages[0]!, content: "a integracao de pedidos falhou" }],
      }),
    );
    for (const q of ["integração pedidos", "integracao pedidos"]) {
      expect(semanticSearch(q, { projectId: "p-1" })[0]?.id).toBe("d-1");
    }
  });

  test("a new chat becomes referenceable without a restart", () => {
    publishWorkspace(graph());
    expect(buildIndex("p-1").map((i) => i.label)).toContain("Original");

    publishWorkspace(
      graph({
        chats: [
          graph().chats[0]!,
          { ...graph().chats[0]!, id: "c-2", title: "Second" },
        ],
      }),
    );

    expect(buildIndex("p-1").map((i) => i.label)).toContain("Second");
  });
});
