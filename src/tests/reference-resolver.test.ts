import { afterEach, describe, expect, test } from "bun:test";
import { compose } from "../lib/context-composer";
import { chatBody, referenceCost, resolveReference } from "../lib/reference-resolver";
import { buildMessages, contentText } from "../lib/prompt-builder";
import { getModel } from "../lib/models";
import { contextBudget, estimateTokens } from "../lib/tokens";
import { formatShare } from "../lib/utils";
import { publishWorkspace, resetWorkspace } from "../lib/workspace";
import type { Message } from "../lib/types";

afterEach(resetWorkspace);

describe("resolveReference", () => {
  /*
   * This used to assert the excerpt was a prefix of the transcript, which is
   * what the bug looked like from the inside: `summarize()` took the first two
   * paragraphs and cut them at 320 characters, so `@chat("X")` reliably
   * injected whatever the user had asked first and never the answer. Anyone
   * referencing an old chat to ask about a figure established in it got a
   * heading that promised a conversation and eighty tokens that held none of
   * it — and a model that filled the gap rather than reporting it.
   *
   * A chat still goes in distilled rather than whole (mem-2). "Distilled" now
   * means the passages that answer the prompt, in reading order, attributed.
   */
  test("a chat resolves to the passages that answer the prompt", () => {
    const resolved = resolveReference(
      "chat",
      "Architecture",
      "p-atimo",
      ["pgvector", "index"],
    )!;

    expect(resolved.id).toBe("c-arch");
    expect(resolved.tokens).toBeGreaterThan(0);
    // The substance of the chat, not its opening.
    expect(resolved.excerpt).toContain("HNSW index");
    // Attributed, so the model can tell a question from an answer, and its own
    // earlier speculation from a peer's.
    expect(resolved.excerpt).toContain("Assistant (claude-opus-5):");
  });

  test("prices a chat against the same rendering it sends", () => {
    const resolved = resolveReference("chat", "Architecture", "p-atimo")!;

    // The seed chat is short enough to go in whole, so nothing was dropped and
    // the two numbers meet. They may never cross: `tokens` is a selection out
    // of `fullTokens`, and a preview reading "218 of 209" is a bug report.
    expect(resolved.tokens).toBe(estimateTokens(resolved.excerpt));
    expect(resolved.fullTokens).toBeGreaterThanOrEqual(resolved.tokens);
    expect(chatBody("c-arch")).toContain("HNSW index");
  });


  /*
   * This used to assert a document went in whole, and it was pinning a bug: the
   * resolver reported `doc.tokens` — the size of the entire file — while putting
   * `doc.excerpt` into the prompt. The budget was charged six thousand tokens
   * for two lines of text, so a document was both the most expensive thing to
   * mention and one of the least useful.
   *
   * A document now resolves the way a chat does: `tokens` is what actually goes
   * in, `fullTokens` is what the file holds, and the gap between them is what
   * the composer shows while you type.
   */
  test("a document resolves to a passage, priced at what is sent", () => {
    const resolved = resolveReference("document", "PRD", "p-atimo")!;

    expect(resolved.tokens).toBeGreaterThan(0);
    expect(resolved.tokens).toBe(estimateTokens(resolved.excerpt));
    // The seed fixtures carry an excerpt and no body, so this is the whole of
    // what there is to send — and still a fraction of what the file holds.
    expect(resolved.fullTokens).toBe(6_800);
    expect(resolved.fullTokens).toBeGreaterThan(resolved.tokens);
  });

  test("matches the label case-insensitively but not across projects", () => {
    expect(resolveReference("chat", "architecture", "p-atimo")).not.toBeNull();
    expect(resolveReference("chat", "Architecture", "p-research")).toBeNull();
    expect(resolveReference("chat", "", "p-atimo")).toBeNull();
    expect(resolveReference("task", "Architecture", "p-atimo")).toBeNull();
  });
});

describe("referenceCost", () => {
  test("prices the mention against the model that will carry it", () => {
    const opus = referenceCost("document", "PRD", "p-atimo", "claude-opus-5")!;
    const haiku = referenceCost(
      "document",
      "PRD",
      "p-atimo",
      "claude-haiku-4.5",
    )!;

    expect(opus.tokens).toBe(haiku.tokens);
    // Same text, narrower window — a bigger bite out of it.
    expect(haiku.share).toBeGreaterThan(opus.share);
    // Against what the mention actually costs, not against the file's size:
    // those are different numbers now, and the share the user is shown has to
    // be the one they are about to pay.
    expect(opus.share).toBeCloseTo(
      opus.tokens / getModel("claude-opus-5").contextWindow,
      10,
    );
    expect(opus.budgetShare).toBeCloseTo(
      opus.tokens / contextBudget("claude-opus-5"),
      10,
    );
    expect(opus.fullTokens).toBe(6_800);
    expect(opus.model.label).toBe("Claude Opus 5");
  });

  test("quotes the same number the composer injects", () => {
    const cost = referenceCost(
      "chat",
      "Architecture",
      "p-atimo",
      "claude-opus-5",
    )!;
    const chunk = compose(
      '@chat("Architecture") what did we settle on?',
      "p-atimo",
      "claude-opus-5",
    ).chunks.find((c) => c.stage === "resolve")!;

    expect(chunk.tokens).toBe(cost.tokens);
    expect(chunk.required).toBe(true);
  });

  test("is null for a target that binds to nothing", () => {
    expect(
      referenceCost("chat", "Nope", "p-atimo", "claude-opus-5"),
    ).toBeNull();
  });
});

describe("references made earlier in the conversation", () => {
  const turn = (role: "user" | "assistant", content: string): Message => ({
    id: `m-${role}-${content.length}`,
    chatId: "c-arch",
    role,
    content,
    createdAt: new Date().toISOString(),
  });

  const mentioned = turn(
    "user",
    'Given @chat("Architecture"), what breaks?',
  );
  const answered = turn("assistant", "The connection pooler is the risk.");

  test("stay resolved on later turns, so a fork inherits the content too", () => {
    const history = [mentioned, answered];
    const prompt = "what failed?";

    const context = compose(prompt, "p-atimo", "claude-opus-5", [], history);
    const carried = context.chunks.filter((c) => c.stage === "resolve");

    expect(carried.map((c) => c.label)).toEqual(["Architecture"]);

    // The point of the whole thing: the mention the model can read in its own
    // transcript has its content attached to the request.
    const system = buildMessages({
      context,
      history,
      prompt,
      projectName: "Atimo",
    }).map((m) => contentText(m.content)).join("\n\n");
    expect(system).toContain("### Architecture");
  });

  test("carry without being required, so the live prompt's mention wins", () => {
    const context = compose("what failed?", "p-atimo", "claude-opus-5", [], [
      mentioned,
    ]);
    for (const chunk of context.chunks.filter((c) => c.stage === "resolve")) {
      expect(chunk.required).toBeUndefined();
      expect(chunk.score).toBeLessThan(1);
      expect(chunk.included).toBe(true);
    }

    // Naming it again on this turn upgrades it back rather than duplicating it.
    const renamed = compose(
      '@chat("Architecture") again',
      "p-atimo",
      "claude-opus-5",
      [],
      [mentioned],
    );
    const arch = renamed.chunks.filter((c) => c.label === "Architecture");
    expect(arch).toHaveLength(1);
    expect(arch[0]!.required).toBe(true);
  });

  test("are read from the user's turns only, not the model's prose", () => {
    const quoted = turn("assistant", 'You asked about @chat("Architecture").');
    const context = compose("go on", "p-atimo", "claude-opus-5", [], [quoted]);

    expect(context.chunks.some((c) => c.stage === "resolve")).toBe(false);
  });

  test("stop being injected once the turn that made them falls out of history", () => {
    // `selectHistory` keeps the last 20 turns; the mention sits behind them, so
    // no message the model receives refers to it any more.
    const filler = Array.from({ length: 24 }, (_, i) =>
      turn(i % 2 === 0 ? "user" : "assistant", `filler turn number ${i}`),
    );
    const context = compose("what failed?", "p-atimo", "claude-opus-5", [], [
      mentioned,
      ...filler,
    ]);

    expect(context.chunks.some((c) => c.stage === "resolve")).toBe(false);
  });
});

/*
 * The reported failure, start to finish.
 *
 * A chat reads a file and establishes a figure. The user accepts the key points
 * the turn proposed, so they become project knowledge. The file is deleted. A
 * new chat names the old one and asks about the figure — and the model answers
 * with a number nobody said.
 *
 * Every part of that is reachable from this graph, and each assertion below is
 * one of the three ways the old pipeline lost the answer: the extract stopped
 * before it, the distilled record was reachable only by lexical accident, and
 * the dead reference was dropped without a word.
 */
describe("a chat referenced after its source file was deleted", () => {
  const MODEL = "claude-opus-5";

  /** Enough paragraphs that the extract has to choose, and choose late. */
  const answer = [
    "I read the sheet. Here is what it covers.",
    "The first section restates last year's list, which has not moved.",
    "Section two is the regional breakdown, split by billing entity.",
    "Section three covers the partner rebates, which are unchanged.",
    "Section four is the support attach rate, tracked separately.",
    "Section five is a footnote about currency conversion.",
    "Section six restates the renewal calendar.",
    "Section seven lists the accounts under review.",
    "Section eight is the churn commentary.",
    "Section nine is the methodology note.",
    "The number you actually want: the enterprise seat price is $184 per month, list, before any volume discount.",
  ].join("\n\n");

  const graph = () => ({
    workspaces: [{ id: "ws-1", name: "Test" }],
    projects: [
      {
        id: "p-1",
        workspaceId: "ws-1",
        name: "Pricing",
        description: "",
        instructions: "",
        memoryTokens: 0,
      },
    ],
    chats: [
      {
        id: "c-old",
        projectId: "p-1",
        title: "Q3 pricing",
        modelId: MODEL,
        createdAt: "2026-07-01T00:00:00.000Z",
        updatedAt: "2026-07-01T00:00:00.000Z",
      },
    ],
    messages: [
      {
        id: "m-1",
        chatId: "c-old",
        role: "user" as const,
        content: 'Read @document("Q3 pricing sheet") and pull out the headline numbers.',
        createdAt: "2026-07-01T00:00:00.000Z",
      },
      {
        id: "m-2",
        chatId: "c-old",
        role: "assistant" as const,
        modelId: MODEL,
        content: answer,
        createdAt: "2026-07-01T00:00:00.000Z",
      },
    ],
    // Distilled from that chat and accepted by the user, which is why it
    // outlives the file the chat was reading.
    memory: [
      {
        id: "mem-1",
        projectId: "p-1",
        kind: "business-rule" as const,
        title: "Enterprise list price is $184/seat/month",
        body: "List price before volume discount. Tiers start at 250 seats.",
        sourceChatId: "c-old",
        createdAt: "2026-07-01T00:00:00.000Z",
        hits: 3,
      },
    ],
    // The file itself is gone.
    documents: [],
    decisions: [],
  });

  const systemFor = (prompt: string) => {
    publishWorkspace(graph());
    const context = compose(prompt, "p-1", MODEL);
    return buildMessages({
      context,
      history: [],
      prompt,
      projectName: "Pricing",
    }).map((m) => contentText(m.content)).join("\n\n");
  };

  test("carries the passage that holds the figure, not the chat's opening", () => {
    const system = systemFor(
      'Based on @chat("Q3 pricing"), what is the enterprise seat price?',
    );

    // The answer sits in the last paragraph of a long turn. `summarize()` took
    // the first two and cut at 320 characters, so this is precisely the text it
    // could never reach — and precisely what the user was asking for.
    expect(system).toContain("$184 per month");
    expect(system).toContain(`Assistant (${MODEL}):`);
    // Selected, not continuous: the skipped sections are marked as skipped.
    expect(system).toContain("…");
  });

  test("says a deleted document is gone instead of dropping the mention", () => {
    const system = systemFor('What did @document("Q3 pricing sheet") report?');

    expect(system).toContain("no longer in the project");
    expect(system).toContain("Q3 pricing sheet");
    expect(system).toContain("not available to you");
  });

  test("does not report an unimplemented kind as deleted", () => {
    // `@task()` is grammar the product does not resolve yet. Calling it deleted
    // would be a different false statement about the same project.
    const system = systemFor('Log this against @task("Ship pricing v2").');

    expect(system).not.toContain("no longer in the project");
  });
});

describe("formatShare", () => {
  test("never rounds a real cost down to nothing", () => {
    expect(formatShare(0)).toBe("0%");
    expect(formatShare(0.0000008)).toBe("<0.1%");
    expect(formatShare(0.042)).toBe("4.2%");
    expect(formatShare(0.3)).toBe("30%");
  });
});
