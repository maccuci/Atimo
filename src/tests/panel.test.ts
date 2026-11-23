import { describe, expect, test } from "bun:test";
import {
  MAX_PANEL_MODELS,
  answersForTurn,
  canReviewPanelTurn,
  canonicalAfter,
  groupTranscript,
  lastAnswerGroup,
  normalisePanel,
  panelModels,
  panelPatch,
  panelTotals,
  promotePanelPrimary,
  selectablePanelAnswers,
} from "../lib/panel";
import { selectHistory } from "../lib/prompt-builder";
import type { Message } from "../lib/types";

/*
 * The panel, as rules rather than as pixels.
 *
 * Two of these carry most of the weight. `selectHistory` is what keeps several
 * models in one chat affordable — one answer per turn travels forward, and the
 * failure mode of getting it wrong is a bill that grows quadratically while
 * every screen still looks correct. `groupTranscript` is what keeps the rows
 * the store wrote readable as the turns they came from.
 */

let seq = 0;
const answer = (over: Partial<Message> = {}): Message => ({
  id: `m-${++seq}`,
  chatId: "c-1",
  role: "assistant",
  content: "an answer",
  createdAt: "2026-07-01T00:00:00.000Z",
  modelId: "claude-opus-5",
  ...over,
});

const asked = (over: Partial<Message> = {}): Message => ({
  id: `m-${++seq}`,
  chatId: "c-1",
  role: "user",
  content: "a prompt",
  createdAt: "2026-07-01T00:00:00.000Z",
  ...over,
});

describe("normalisePanel", () => {
  test("drops the primary, so no model is asked the same question twice", () => {
    expect(normalisePanel("a", ["b", "a", "c"])).toEqual(["b", "c"]);
  });

  test("drops repeats within the panel itself", () => {
    expect(normalisePanel("a", ["b", "b", "c"])).toEqual(["b", "c"]);
  });

  test("caps the panel, counting the primary against the limit", () => {
    const extras = ["b", "c", "d", "e", "f"];
    expect(normalisePanel("a", extras)).toHaveLength(MAX_PANEL_MODELS - 1);
  });

  test("an empty panel is absent from the row, not an empty array", () => {
    // Stored as a field that is simply not there, so an ordinary chat's JSON is
    // byte-for-byte what it was before panels existed.
    expect(panelPatch("a", [])).toEqual({ panel: undefined });
    expect(panelPatch("a", ["b"])).toEqual({ panel: ["b"] });
  });
});

describe("promotePanelPrimary", () => {
  test("keeps every selected model when a panel answer becomes primary", () => {
    expect(
      promotePanelPrimary({ modelId: "a", panel: ["b", "c"] }, "b"),
    ).toEqual({
      modelId: "b",
      panel: ["a", "c"],
    });
  });

  test("deduplicates and respects the panel cap while reordering", () => {
    const promoted = promotePanelPrimary(
      { modelId: "a", panel: ["b", "b", "c", "d", "e"] },
      "b",
    );

    expect(promoted.modelId).toBe("b");
    expect(promoted.panel).toEqual(["a", "c", "d"]);
    expect(promoted.panel).toHaveLength(MAX_PANEL_MODELS - 1);
  });
});

describe("panelModels", () => {
  test("primary first, then the panel", () => {
    expect(
      panelModels({ modelId: "a", panel: ["b", "c"] }, "openrouter"),
    ).toEqual(["a", "b", "c"]);
  });

  test("collapses to the primary on a CLI provider", () => {
    // A local CLI answers as whatever it is configured to be, so a panel over
    // one would spawn three child processes to produce three copies of one
    // answer — three times the wait and three times the subscription usage.
    expect(
      panelModels({ modelId: "a", panel: ["b", "c"] }, "claude-cli"),
    ).toEqual(["a"]);
  });
});

describe("answersForTurn", () => {
  test("keeps one chat and one panel turn in transcript order", () => {
    const first = answer({ chatId: "c-1", turnId: "t-1" });
    const second = answer({ chatId: "c-1", turnId: "t-1" });
    const otherTurn = answer({ chatId: "c-1", turnId: "t-2" });
    const otherChat = answer({ chatId: "c-2", turnId: "t-1" });

    expect(
      answersForTurn([asked(), first, otherTurn, second, otherChat], "c-1", "t-1"),
    ).toEqual([first, second]);
  });
});

describe("selectablePanelAnswers", () => {
  test("keeps completed text, including a stopped partial answer", () => {
    const complete = answer({ content: "complete" });
    const partial = answer({ content: "partial", stopped: true });
    const pending = answer({ content: "still arriving", pending: true });
    const failed = answer({ content: "", error: "provider failed" });
    const empty = answer({ content: "  " });

    expect(
      selectablePanelAnswers([complete, partial, pending, failed, empty]),
    ).toEqual([complete, partial]);
  });
});

describe("canReviewPanelTurn", () => {
  test("opens only for a settled panel with two usable responses", () => {
    expect(
      canReviewPanelTurn([answer({ content: "one" }), answer({ content: "two" })]),
    ).toBe(true);
    expect(
      canReviewPanelTurn([
        answer({ content: "one" }),
        answer({ content: "two", pending: true }),
      ]),
    ).toBe(false);
    expect(
      canReviewPanelTurn([
        answer({ content: "one" }),
        answer({ content: "", error: "provider failed" }),
      ]),
    ).toBe(false);
  });
});

describe("selectHistory", () => {
  test("carries exactly one answer per panel turn", () => {
    const history = [
      asked(),
      answer({ turnId: "t-1", canonical: true, content: "kept" }),
      answer({ turnId: "t-1", content: "alternative one" }),
      answer({ turnId: "t-1", content: "alternative two" }),
    ];

    const sent = selectHistory(history).map((m) => m.content);
    expect(sent).toEqual(["a prompt", "kept"]);
  });

  test("follows a promotion rather than the order the answers were sent in", () => {
    const history = [
      asked(),
      answer({ turnId: "t-1", canonical: false, content: "first" }),
      answer({ turnId: "t-1", canonical: true, content: "promoted" }),
    ];

    expect(selectHistory(history).map((m) => m.content)).toEqual([
      "a prompt",
      "promoted",
    ]);
  });

  test("a panel turn with no canonical answer contributes none", () => {
    // Failing closed. Guessing one would silently pick the conversation's
    // future on the user's behalf, and the store never writes this state.
    const history = [asked(), answer({ turnId: "t-1" }), answer({ turnId: "t-1" })];
    expect(selectHistory(history)).toHaveLength(1);
  });

  test("an ordinary answer still travels without any flag on it", () => {
    const history = [asked(), answer({ content: "plain" })];
    expect(selectHistory(history)).toHaveLength(2);
  });

  test("the tail counts turns, not rows", () => {
    // Twenty-one panel turns of three answers each is 63 assistant rows. If the
    // tail were taken before the alternatives were dropped, the request would
    // carry seven turns instead of twenty.
    const history: Message[] = [];
    for (let i = 0; i < 21; i++) {
      const turnId = `t-${i}`;
      history.push(asked({ content: `prompt ${i}` }));
      history.push(answer({ turnId, canonical: true, content: `kept ${i}` }));
      history.push(answer({ turnId, content: `alt a ${i}` }));
      history.push(answer({ turnId, content: `alt b ${i}` }));
    }

    const sent = selectHistory(history);
    expect(sent).toHaveLength(20);
    expect(sent.every((m) => !m.content.startsWith("alt"))).toBe(true);
    // The tail is the *end* of the conversation, so the oldest turns are what
    // fell off.
    expect(sent.at(-1)!.content).toBe("kept 20");
  });
});

describe("lastAnswerGroup", () => {
  test("is the whole group, so regenerate re-runs every model in it", () => {
    const group = [
      answer({ turnId: "t-1", canonical: true }),
      answer({ turnId: "t-1" }),
    ];
    const transcript = [asked(), ...group];

    expect(lastAnswerGroup(transcript).map((m) => m.id)).toEqual(
      group.map((m) => m.id),
    );
  });

  test("is the single answer when the turn was not a panel", () => {
    const last = answer();
    expect(lastAnswerGroup([asked(), last])).toEqual([last]);
  });

  test("is empty when the transcript ends on a prompt", () => {
    expect(lastAnswerGroup([asked()])).toEqual([]);
    expect(lastAnswerGroup([])).toEqual([]);
  });

  test("stops at the previous turn rather than swallowing it", () => {
    const transcript = [
      asked(),
      answer({ turnId: "t-1", canonical: true }),
      answer({ turnId: "t-1" }),
      asked(),
      answer({ turnId: "t-2", canonical: true }),
      answer({ turnId: "t-2" }),
    ];
    expect(
      lastAnswerGroup(transcript).every((m) => m.turnId === "t-2"),
    ).toBe(true);
  });
});

describe("groupTranscript", () => {
  test("gathers a turn's answers into one entry and leaves the prompt alone", () => {
    const entries = groupTranscript([
      asked(),
      answer({ turnId: "t-1", canonical: true }),
      answer({ turnId: "t-1" }),
    ]);

    expect(entries.map((e) => e.kind)).toEqual(["message", "panel"]);
    expect(entries[1]!.kind === "panel" && entries[1]!.answers).toHaveLength(2);
  });

  test("a group reduced to one answer reads as an ordinary message", () => {
    // What a fork leaves behind: the alternatives were not carried, so the row
    // that survived is the answer, not a panel of one.
    const entries = groupTranscript([
      asked(),
      answer({ turnId: "t-1", canonical: true }),
    ]);
    expect(entries.map((e) => e.kind)).toEqual(["message", "message"]);
  });

  test("keys stay unique when a group is not contiguous", () => {
    // Grouping reads adjacency. A transcript that interleaved rows of one group
    // must still produce distinct React keys rather than silently colliding.
    const entries = groupTranscript([
      answer({ turnId: "t-1", canonical: true }),
      asked(),
      answer({ turnId: "t-1" }),
    ]);

    const keys = entries.map((e) => e.key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  test("a transcript with no panels is unchanged in shape", () => {
    const transcript = [asked(), answer(), asked(), answer()];
    const entries = groupTranscript(transcript);
    expect(entries.every((e) => e.kind === "message")).toBe(true);
    expect(entries).toHaveLength(4);
  });
});

describe("panelTotals", () => {
  test("sums cost but takes the slowest latency, because the runs were parallel", () => {
    const totals = panelTotals([
      answer({
        turnId: "t-1",
        canonical: true,
        costUsd: 0.01,
        usage: { in: 100, out: 50, latencyMs: 2_000 },
      }),
      answer({
        turnId: "t-1",
        costUsd: 0.02,
        usage: { in: 100, out: 70, latencyMs: 5_000 },
      }),
    ]);

    expect(totals.costUsd).toBeCloseTo(0.03);
    expect(totals.outTokens).toBe(120);
    expect(totals.latencyMs).toBe(5_000);
    expect(totals.settled).toBe(true);
  });

  test("is unsettled while any model is still answering", () => {
    const totals = panelTotals([
      answer({ turnId: "t-1", canonical: true, usage: { in: 1, out: 1, latencyMs: 1 } }),
      answer({ turnId: "t-1", pending: true }),
    ]);
    expect(totals.settled).toBe(false);
  });

  test("reports no cost at all rather than zero when no provider priced the turn", () => {
    // Zero would read as "this was free", which is a different claim.
    const totals = panelTotals([answer({ turnId: "t-1", canonical: true })]);
    expect(totals.costUsd).toBeUndefined();
  });
});

/*
 * Which answer is the conversation, after a turn settles.
 *
 * Exactly one, always. Two makes the next request carry both answers and pay
 * for them; none makes it carry neither, so the chat sends a prompt whose reply
 * is on screen but not in history. Both surface several turns later as a model
 * that has lost the thread, which is the least actionable bug report there is.
 *
 * The partial cases are the ones a retry produces: a failed member of a panel
 * repaired on its own, decided against siblings that were never re-run.
 */
describe("canonicalAfter", () => {
  const row = (over: Partial<Parameters<typeof canonicalAfter>[0][number]>) => ({
    id: "r",
    canonical: false,
    failed: false,
    usable: true,
    ...over,
  });

  test("leaves a working canonical answer alone", () => {
    expect(
      canonicalAfter([
        row({ id: "a", canonical: true }),
        row({ id: "b" }),
      ]),
    ).toBe("a");
  });

  test("rescues the turn when the canonical answer failed", () => {
    // Otherwise `selectHistory` drops the failed row for being failed and the
    // working one for not being canonical, and the turn contributes nothing.
    expect(
      canonicalAfter([
        row({ id: "a", canonical: true, failed: true, usable: false }),
        row({ id: "b" }),
      ]),
    ).toBe("b");
  });

  test("does not overrule a promotion the user made", () => {
    // The user chose `b` over a perfectly good `a`. Nothing failed, so there is
    // no absence of a choice to fill in.
    expect(
      canonicalAfter([row({ id: "a" }), row({ id: "b", canonical: true })]),
    ).toBe("b");
  });

  test("promotes a repaired answer when the turn had none that worked", () => {
    // Every model failed, so `a` stayed canonical while holding an error. The
    // user retried `c` alone and it came back. Nothing else was re-run, so `c`
    // is the only answer the turn has — and `a` has to stop being canonical in
    // the same transition, or the turn now has two.
    expect(
      canonicalAfter([
        row({ id: "a", canonical: true, failed: true, usable: false }),
        row({ id: "b", failed: true, usable: false }),
        row({ id: "c" }),
      ]),
    ).toBe("c");
  });

  test("keeps the canonical row when a repaired sibling was not promoted", () => {
    // `a` answered and is the conversation; `b` rate-limited and was retried on
    // its own. A working alternative is not a reason to re-cast the turn.
    expect(
      canonicalAfter([row({ id: "a", canonical: true }), row({ id: "b" })]),
    ).toBe("a");
  });

  test("stays on the failed row when nothing in the turn is usable", () => {
    // A turn where every model failed still has to name one row, or the next
    // settle has no anchor to demote from.
    expect(
      canonicalAfter([
        row({ id: "a", canonical: true, failed: true, usable: false }),
        row({ id: "b", failed: true, usable: false }),
      ]),
    ).toBe("a");
  });

  test("treats an empty answer as nothing to rescue with", () => {
    // No error, no text — a stream that produced nothing is not an answer the
    // turn can be carried by.
    expect(
      canonicalAfter([
        row({ id: "a", canonical: true, failed: true, usable: false }),
        row({ id: "b", usable: false }),
        row({ id: "c" }),
      ]),
    ).toBe("c");
  });
});
