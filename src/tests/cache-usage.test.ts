import { expect, test } from "bun:test";
import { cachedPromptTokens } from "../lib/adapter/usage";
import { webTransport } from "../lib/adapter/web";
import { monthlyUsage, reserveCall, settleCall, useResearchSettings } from "../lib/research-settings";
import type { StreamEvent } from "../lib/adapter";

test("cache usage reads the standard field and DeepSeek's fallback without inventing misses", () => {
  expect(cachedPromptTokens({ prompt_tokens_details: { cached_tokens: 12 }, prompt_cache_hit_tokens: 20 })).toBe(12);
  expect(cachedPromptTokens({ prompt_tokens_details: { cached_tokens: null }, prompt_cache_hit_tokens: 20 })).toBe(20);
  expect(cachedPromptTokens({ prompt_tokens_details: { cached_tokens: 0 } })).toBe(0);
  expect(cachedPromptTokens({})).toBeNull();
  expect(cachedPromptTokens({ prompt_cache_hit_tokens: -1 })).toBeNull();
});

test("browser streaming forwards actual cache usage to the shared store contract", async () => {
  const fetch = globalThis.fetch;
  const storage = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  const values = new Map<string, string>();
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => values.set(key, value) } });
  try {
    await webTransport.credentialSet("deepseek", "test-only");
    globalThis.fetch = (async () => new Response(
      `data: ${JSON.stringify({ choices: [{ delta: { content: "Answer" }, finish_reason: "stop" }], usage: { prompt_tokens: 100, completion_tokens: 20, prompt_tokens_details: { cached_tokens: 64 } } })}\n\ndata: [DONE]\n\n`,
      { headers: { "Content-Type": "text/event-stream" } },
    )) as unknown as typeof globalThis.fetch;
    const events: StreamEvent[] = [];
    await webTransport.chat("deepseek", "cache-test", { model: "deepseek-flash", messages: [{ role: "user", content: "Hello" }] }, (event) => events.push(event));
    expect(events.find((event) => event.type === "usage")).toMatchObject({ promptTokens: 100, cachedPromptTokens: 64 });
  } finally {
    globalThis.fetch = fetch;
    if (storage) Object.defineProperty(globalThis, "localStorage", storage); else Reflect.deleteProperty(globalThis, "localStorage");
  }
});

test("persisted cache telemetry separates unreported usage from measured misses", () => {
  const saved = useResearchSettings.getState();
  try {
    useResearchSettings.setState({ calls: [], monthlyBudget: null });
    const hit = reserveCall({ provider: "deepseek", model: "deepseek-flash", purpose: "answer" }, null);
    settleCall(hit, { inputTokens: 100, cachedInputTokens: 80, status: "done" });
    const miss = reserveCall({ provider: "deepseek", model: "deepseek-flash", purpose: "answer" }, null);
    settleCall(miss, { inputTokens: 300, cachedInputTokens: 0, status: "done" });
    const unknown = reserveCall({ provider: "zai", model: "glm-5.3", purpose: "answer" }, null);
    settleCall(unknown, { inputTokens: 500, status: "done" });
    expect(monthlyUsage().cache).toEqual({ measuredCalls: 2, inputTokens: 400, cachedTokens: 80, hitRate: 0.2 });
  } finally { useResearchSettings.setState(saved); }
});
