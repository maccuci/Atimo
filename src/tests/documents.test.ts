import { beforeEach, describe, expect, test } from "bun:test";
import {
  chunkText,
  documentChunks,
  ensureIndex,
  forgetDocument,
  forgetProject,
  indexDocument,
  indexTerms,
  resetIndexes,
  searchChunks,
  toDocument,
} from "../lib/documents";
import { store } from "../lib/persistence";

/*
 * Chunking and retrieval.
 *
 * The property under test is not "does it find something" — a substring scan
 * would too. It is that a *passage* comes back rather than a file, because that
 * is the whole difference between this and pasting the document in.
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

const RUNBOOK = `# Deployment

The service is deployed from CI on every tagged release.

# Database migrations

Migrations run before the new build receives traffic. A migration that cannot
be rolled back must ship in its own release.

# Incident response

Page the on-call engineer through the rota. Do not roll back a migration.
`;

beforeEach(() => {
  globalThis.localStorage = new MemoryStorage() as unknown as Storage;
  resetIndexes();
});

describe("chunkText", () => {
  test("cuts on headings rather than at a fixed offset", () => {
    const chunks = chunkText(RUNBOOK, "doc-1", "p-1");

    expect(chunks).toHaveLength(3);
    // A chunk that straddled two sections would be about neither.
    expect(chunks[0]!.text).toContain("deployed from CI");
    expect(chunks[0]!.text).not.toContain("Migrations run");
  });

  test("each passage carries the heading it fell under", () => {
    const chunks = chunkText(RUNBOOK, "doc-1", "p-1");

    // Both the model and the scorer need this: a paragraph saying "must ship in
    // its own release" is unusable without knowing what "it" is.
    const migrations = chunks.find((c) => c.text.includes("rolled back"))!;
    expect(migrations.text).toContain("Database migrations");
  });

  test("positions are contiguous and start at zero", () => {
    const chunks = chunkText(RUNBOOK, "doc-1", "p-1");
    expect(chunks.map((c) => c.index)).toEqual([0, 1, 2]);
  });

  test("a paragraph too long to keep whole is split rather than dropped", () => {
    const chunks = chunkText("x".repeat(5_000), "doc-1", "p-1");

    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.reduce((n, c) => n + c.text.length, 0)).toBe(5_000);
  });

  test("an empty document produces no chunks rather than one blank one", () => {
    expect(chunkText("   \n\n  \n", "doc-1", "p-1")).toEqual([]);
  });
});

describe("toDocument", () => {
  test("prices the row from the chunks it actually produced", () => {
    const { document, chunks } = toDocument(
      { name: "runbook.md", kind: "markdown", text: RUNBOOK, bytes: 400 },
      "p-1",
    );

    expect(document.chunkCount).toBe(chunks.length);
    // Derived here rather than anywhere else, or the document ends up priced at
    // a length it does not have — the bug the old `@document()` shipped with.
    expect(document.tokens).toBe(chunks.reduce((n, c) => n + c.tokens, 0));
    expect(chunks.every((c) => c.documentId === document.id)).toBe(true);
  });
});

describe("searchChunks", () => {
  const index = async () => {
    const { document, chunks } = toDocument(
      { name: "runbook.md", kind: "markdown", text: RUNBOOK, bytes: 400 },
      "p-1",
    );
    await store.putChunks(document.id, chunks);
    await ensureIndex("p-1");
    return document;
  };

  test("returns the passage that answers, not the file that contains it", async () => {
    await index();

    const hits = searchChunks("p-1", indexTerms("how do migrations roll back"));
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0]!.chunk.text).toContain("rolled back");
    // The point of the whole exercise: the deployment section stays out.
    expect(hits[0]!.chunk.text).not.toContain("deployed from CI");
  });

  test("a term in a heading reaches the body under it", async () => {
    await index();

    const hits = searchChunks("p-1", indexTerms("incident"));
    expect(hits[0]!.chunk.text).toContain("on-call engineer");
  });

  test("nothing matching scores nothing", async () => {
    await index();
    expect(searchChunks("p-1", indexTerms("kubernetes helm"))).toEqual([]);
  });

  test("an unindexed project is empty rather than an error", () => {
    // The window between selecting a project and its chunks arriving. One turn
    // without documents beats making every keystroke await a database.
    expect(searchChunks("p-nope", indexTerms("migrations"))).toEqual([]);
  });

  test("the cap is honoured", async () => {
    await index();
    expect(
      searchChunks("p-1", indexTerms("migrations deployed incident"), 1),
    ).toHaveLength(1);
  });

  test("one project's files do not answer another's prompts", async () => {
    await index();
    expect(searchChunks("p-2", indexTerms("migrations"))).toEqual([]);
  });
});

describe("documentChunks", () => {
  test("with no query, a named file opens at the beginning", async () => {
    const { document, chunks } = toDocument(
      { name: "runbook.md", kind: "markdown", text: RUNBOOK, bytes: 400 },
      "p-1",
    );
    await store.putChunks(document.id, chunks);
    await ensureIndex("p-1");

    // Where a document says what it is.
    const opening = documentChunks("p-1", document.id);
    expect(opening[0]!.index).toBe(0);
  });

  test("with a query, the relevant section comes first", async () => {
    const { document, chunks } = toDocument(
      { name: "runbook.md", kind: "markdown", text: RUNBOOK, bytes: 400 },
      "p-1",
    );
    await store.putChunks(document.id, chunks);
    await ensureIndex("p-1");

    const found = documentChunks("p-1", document.id, indexTerms("incident rota"));
    expect(found[0]!.text).toContain("on-call engineer");
  });

  test("a file named but not matched still goes in", async () => {
    const { document, chunks } = toDocument(
      { name: "runbook.md", kind: "markdown", text: RUNBOOK, bytes: 400 },
      "p-1",
    );
    await store.putChunks(document.id, chunks);
    await ensureIndex("p-1");

    // The user asked for it by name; answering with nothing would be worse than
    // answering with the opening.
    const found = documentChunks("p-1", document.id, indexTerms("kubernetes"));
    expect(found.length).toBeGreaterThan(0);
  });
});

describe("index maintenance", () => {
  test("a new upload joins an index that is already built", async () => {
    await ensureIndex("p-1");
    expect(searchChunks("p-1", indexTerms("migrations"))).toEqual([]);

    const { document, chunks } = toDocument(
      { name: "runbook.md", kind: "markdown", text: RUNBOOK, bytes: 400 },
      "p-1",
    );
    indexDocument("p-1", chunks);

    // Without this the file would be invisible until the next project switch.
    expect(searchChunks("p-1", indexTerms("migrations")).length).toBeGreaterThan(0);
    expect(documentChunks("p-1", document.id).length).toBe(chunks.length);
  });

  test("forgetting a document leaves the rest of the index pointing at the right text", async () => {
    await ensureIndex("p-1");

    const first = toDocument(
      { name: "runbook.md", kind: "markdown", text: RUNBOOK, bytes: 400 },
      "p-1",
    );
    const second = toDocument(
      {
        name: "glossary.md",
        kind: "markdown",
        text: "# Glossary\n\nA canary is a partial rollout.",
        bytes: 60,
      },
      "p-1",
    );
    indexDocument("p-1", first.chunks);
    indexDocument("p-1", second.chunks);

    forgetDocument("p-1", first.document.id);

    // The postings lists hold positions into a shared array, so a delete that
    // spliced instead of rebuilding would leave every later term pointing one
    // chunk off — retrieval that returns confidently wrong paragraphs.
    expect(searchChunks("p-1", indexTerms("migrations"))).toEqual([]);
    const canary = searchChunks("p-1", indexTerms("canary rollout"));
    expect(canary[0]!.chunk.text).toContain("partial rollout");
  });

  /*
   * The window a restore opens.
   *
   * Opening a project starts an index read; a restore writes that project's
   * text and drops the index while the read is still in flight. Whoever lands
   * last wins, and if that is the read, the project spends the rest of the
   * session retrieving nothing out of files sitting in its list — the exact
   * launch on which someone is checking their backup came back.
   */
  test("text written while an index read is in flight is what gets indexed", async () => {
    // Both halves of the invalidation are load-bearing here. The read has to
    // decline to publish what it found, *and* the slot it is holding has to be
    // cleared — leaving either one intact hands the next caller the pre-restore
    // index and never rebuilds it.
    void ensureIndex("p-1");
    forgetProject("p-1");

    const { document, chunks } = toDocument(
      { name: "runbook.md", kind: "markdown", text: RUNBOOK, bytes: 400 },
      "p-1",
    );
    await store.putChunks(document.id, chunks);
    await ensureIndex("p-1");

    expect(documentChunks("p-1", document.id).length).toBe(chunks.length);
    expect(searchChunks("p-1", indexTerms("migrations")).length).toBeGreaterThan(0);
  });
});
