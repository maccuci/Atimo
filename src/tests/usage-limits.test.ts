import { describe, expect, test } from "bun:test";
import { currentLeft, fromClaude, parseUsage, resetLabel, supportsUsage, tightestLeft } from "../lib/usage-limits";

describe("usage limits", () => {
  test("codex: the app-server read becomes the ChatGPT popover", () => {
    // Captured from `codex app-server` 0.171.0, `account/rateLimits/read`, 2026-11-22.
    const snap = parseUsage("codex-cli", {
      ordinaryUsageAllowed: true,
      rateLimits: {
        limitId: "codex",
        primary: { usedPercent: 0, windowDurationMins: 300, resetsAt: 1795408106 },
        secondary: { usedPercent: 11, windowDurationMins: 10080, resetsAt: 1795729651 },
        credits: { hasCredits: false, unlimited: false, balance: "0" },
        planType: "plus",
      },
    });
    expect(snap.source).toBe("seu plano Plus");
    expect(snap.rows.map((r) => [r.label, r.value])).toEqual([
      ["Limite de 5 horas", "100% restante"],
      ["Limite semanal", "89% restante"],
      ["Créditos", "0 créditos"],
    ]);
    expect(snap.rows[0]!.resetsAt).toBe(1795408106 * 1000);
  });

  test("claude: utilization is a fraction, and both windows are read", () => {
    // Captured from Claude Code 2.1.330 `rate_limit_event`, 2026-11-22.
    const snap = fromClaude(
      {
        status: "allowed",
        resetsAt: 1795401000,
        rateLimitType: "five_hour",
        unifiedWindows: {
          five_hour: { utilization: 0.31, resetsAt: 1795401000, status: "allowed" },
          seven_day: { utilization: 0.3, resetsAt: 1795456800, status: "allowed" },
        },
      },
      "max",
    );
    expect(snap?.source).toBe("seu plano Max");
    expect(snap?.rows.map((r) => r.value)).toEqual(["69% restante", "70% restante"]);
    // An older build sends one window at the top level; an empty event is no reading.
    expect(fromClaude({ rateLimitType: "seven_day", utilization: 0.5, resetsAt: 1 }, null)?.rows[0]?.label).toBe("Limite semanal");
    expect(fromClaude({ status: "allowed" }, null)).toBeNull();
  });

  test("openrouter: key limit, spend, and no free-model row for a paying key", () => {
    // Example response from the OpenRouter API reference for GET /api/v1/key.
    const snap = parseUsage("openrouter", {
      label: "sk-or-v1-au7...890",
      limit: 100,
      limit_remaining: 74.5,
      limit_reset: "monthly",
      usage: 25.5,
      usage_daily: 25.5,
      usage_monthly: 25.5,
      is_free_tier: false,
      free_model_daily_requests: { used: 0, limit: 1000, remaining: 1000 },
    });
    expect(snap.rows.map((r) => r.label)).toEqual(["Limite mensal da chave", "Gasto hoje", "Gasto no mês"]);
    expect(snap.rows[0]!.left).toBe(74.5);
    expect(snap.rows[0]!.value).toBe("$74.50 de $100.00");
  });

  test("zai: windows sorted shortest first, reset already in ms", () => {
    const snap = parseUsage("zai", {
      limits: [
        { type: "TIME_LIMIT", unit: 5, number: 1, percentage: 3, nextResetTime: 1800000000000 },
        { type: "TOKENS_LIMIT", unit: 6, number: 1, percentage: 40, nextResetTime: 1800000000000 },
        { type: "TOKENS_LIMIT", unit: 3, number: 5, percentage: 12, nextResetTime: 1795400000000 },
      ],
    });
    expect(snap.rows.map((r) => [r.label, r.value])).toEqual([
      ["Limite de 5 horas", "88% restante"],
      ["Limite semanal", "60% restante"],
      ["Ferramentas MCP no mês", "97% restante"],
    ]);
    expect(snap.rows[0]!.resetsAt).toBe(1795400000000);
    expect(supportsUsage("zai", "general")).toBe(false);
  });

  test("deepseek: balance is an amount, not a window", () => {
    const snap = parseUsage("deepseek", { is_available: true, balance_infos: [{ currency: "USD", total_balance: "12.30" }] });
    expect(snap.rows).toHaveLength(1);
    expect(snap.rows[0]!.left).toBeNull();
    expect(tightestLeft(snap)).toBeNull();
  });

  test("a window whose reset passed reads as fresh, and the ring takes the tightest", () => {
    const now = 1_000_000;
    const rows = [
      { label: "a", left: 20, value: "", resetsAt: now - 1 },
      { label: "b", left: 55, value: "", resetsAt: now + 1 },
    ];
    expect(currentLeft(rows[0]!, now)).toBe(100);
    expect(tightestLeft({ source: "", rows, at: now }, now)).toBe(55);
    expect(resetLabel(now - 1, now)).toStartWith("Renovou");
  });
});
