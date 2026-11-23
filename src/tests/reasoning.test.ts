import { describe, expect, test } from "bun:test";
import {
  nextReasoningVisibility,
  summarizeReasoning,
} from "../lib/reasoning";

describe("nextReasoningVisibility", () => {
  test("cycles full → summary → hidden → full", () => {
    expect(nextReasoningVisibility("full")).toBe("summary");
    expect(nextReasoningVisibility("summary")).toBe("hidden");
    expect(nextReasoningVisibility("hidden")).toBe("full");
  });
});

describe("summarizeReasoning", () => {
  test("keeps existing bullets", () => {
    const bullets = summarizeReasoning(
      [
        "Let me think about this carefully.",
        "- Check the budget rule",
        "- Prefer project memory over guesswork",
        "- Reply in the user's language",
      ].join("\n"),
    );
    expect(bullets).toEqual([
      "Check the budget rule",
      "Prefer project memory over guesswork",
      "Reply in the user's language",
    ]);
  });

  test("falls back to first sentences of paragraphs", () => {
    const bullets = summarizeReasoning(
      [
        "The user asked about Postgres. We already decided on it last week.",
        "I should cite the decision rather than reopen the debate. That keeps the project coherent.",
      ].join("\n\n"),
    );
    expect(bullets[0]).toContain("Postgres");
    expect(bullets.length).toBeGreaterThanOrEqual(1);
    expect(bullets.length).toBeLessThanOrEqual(5);
  });

  test("caps length and count", () => {
    const bullets = summarizeReasoning(
      Array.from({ length: 12 }, (_, i) => {
        const body = `Point ${i} about ${"detail ".repeat(40)}end.`;
        return `${i + 1}. ${body}`;
      }).join("\n"),
    );
    expect(bullets).toHaveLength(5);
    for (const b of bullets) expect(b.length).toBeLessThanOrEqual(140);
  });

  test("returns empty for blank input", () => {
    expect(summarizeReasoning("   ")).toEqual([]);
  });
});
