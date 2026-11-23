import { describe, expect, test } from "bun:test";
import { compose } from "../lib/context-composer";
import { contextUsage, estimateInputTokens } from "../lib/context-usage";
import { getSkill } from "../lib/skills";
import type { ActiveSkill, Message } from "../lib/types";

const always = (id: string): ActiveSkill => ({
  skill: getSkill(id)!,
  mode: "always",
});

const msg = (
  role: Message["role"],
  content: string,
  overrides: Partial<Message> = {},
): Message => ({
  id: overrides.id ?? `m-${role}-${content.slice(0, 8)}`,
  chatId: "c-test",
  role,
  content,
  createdAt: new Date().toISOString(),
  ...overrides,
});

describe("contextUsage", () => {
  test("prices the standing brief even with an empty draft", () => {
    const usage = contextUsage({
      context: compose("", "p-atimo", "claude-opus-5"),
      history: [],
      draft: "",
      modelId: "claude-opus-5",
      projectName: "Atimo",
    });

    const brief = usage.segments.find((s) => s.id === "brief")!;
    expect(brief.tokens).toBeGreaterThan(0);
    expect(usage.total).toBeGreaterThanOrEqual(brief.tokens);
    expect(usage.window).toBeGreaterThan(usage.budget);
  });

  test("counts conversation from the same history tail the builder sends", () => {
    const history = Array.from({ length: 25 }, (_, i) =>
      msg(i % 2 === 0 ? "user" : "assistant", `turn ${i} `.repeat(20)),
    );

    const usage = contextUsage({
      context: compose("hello", "p-atimo", "claude-opus-5"),
      history,
      draft: "hello",
      modelId: "claude-opus-5",
      projectName: "Atimo",
    });

    const conversation = usage.segments.find((s) => s.id === "conversation")!;
    // 20-turn cap — older turns must not inflate the estimate.
    expect(conversation.tokens).toBeGreaterThan(0);
    expect(conversation.tokens).toBeLessThan(
      history.reduce((sum, m) => sum + Math.ceil(m.content.length / 4), 0),
    );
  });

  test("ignores pending and failed turns", () => {
    const usage = contextUsage({
      context: compose("hi", "p-atimo", "claude-opus-5"),
      history: [
        msg("user", "solid"),
        msg("assistant", "ok"),
        msg("user", "pending one", { pending: true }),
        msg("assistant", "failed one", { error: "boom" }),
      ],
      draft: "hi",
      modelId: "claude-opus-5",
      projectName: "Atimo",
    });

    const conversation = usage.segments.find((s) => s.id === "conversation")!;
    // Only the two completed turns.
    expect(conversation.tokens).toBe(
      Math.ceil("solid".length / 4) + Math.ceil("ok".length / 4),
    );
  });

  test("attributes always-on skills to the skills bucket", () => {
    const usage = contextUsage({
      context: compose("anything", "p-atimo", "claude-opus-5", [
        always("caveman"),
      ]),
      history: [],
      draft: "anything",
      modelId: "claude-opus-5",
      projectName: "Atimo",
    });

    expect(usage.segments.find((s) => s.id === "skills")!.tokens).toBeGreaterThan(
      0,
    );
  });

  test("prices the files staged for a turn that has not been sent yet", () => {
    // An attachment is staged exactly like the draft text beside it, so a meter
    // that only counted sent ones would report the turn as free right up until
    // it left.
    const usage = contextUsage({
      context: compose("look at this", "p-atimo", "claude-opus-5"),
      history: [],
      draft: "look at this",
      modelId: "claude-opus-5",
      projectName: "Atimo",
      attachments: [{ tokens: 640 }],
    });

    expect(usage.segments.find((s) => s.id === "attachments")!.tokens).toBe(640);
  });

  test("keeps pricing a picture for as long as its turn is still in history", () => {
    /*
     * The recurring half. A stateless chat API has no memory of an image, so it
     * is re-sent on every turn its message stays in the tail — under-reporting
     * that would go wrong precisely when the window starts to matter.
     */
    const usage = contextUsage({
      context: compose("and the top left?", "p-atimo", "claude-opus-5"),
      history: [
        msg("user", "what is this?", {
          attachments: [
            {
              id: "att-1",
              messageId: "m-1",
              chatId: "c-test",
              name: "shot.png",
              mime: "image/png",
              kind: "image",
              bytes: 1_000,
              tokens: 900,
            },
          ],
        }),
        msg("assistant", "A login form."),
      ],
      draft: "and the top left?",
      modelId: "claude-opus-5",
      projectName: "Atimo",
    });

    expect(usage.segments.find((s) => s.id === "attachments")!.tokens).toBe(900);
  });

  test("estimateInputTokens matches the segment total", () => {
    const input = {
      context: compose("budget check", "p-atimo", "claude-opus-5"),
      history: [msg("user", "earlier")],
      draft: "budget check",
      modelId: "claude-opus-5",
      projectName: "Atimo",
    };
    expect(estimateInputTokens(input)).toBe(contextUsage(input).total);
  });
});
