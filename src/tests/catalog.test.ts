import { describe, expect, test } from "bun:test";
import { isOpenWeights } from "../lib/models";
import { derivedModel, matchLiveModel, shortId, toModel, vendorToProvider } from "../lib/catalog";
import type { CatalogEntry } from "../lib/adapter";
import type { Model } from "../lib/types";

const entry = (over: Partial<CatalogEntry> & { id: string }): CatalogEntry => ({
  name: over.id,
  vendor: over.id.split("/")[0] ?? "other",
  contextLength: 128_000,
  costIn: 1,
  costOut: 5,
  costCacheRead: null,
  costCacheWrite: null,
  maxOutput: null,
  supportsVision: false,
  supportsFiles: false,
  supportsAudio: false,
  supportsTools: false,
  supportsReasoning: false,
  created: 0,
  description: "",
  ...over,
});

const live = (id: string, created = 0): Model => toModel(entry({ id, created }));

describe("vendorToProvider", () => {
  test("maps the slugs that differ from our provider ids", () => {
    expect(vendorToProvider("x-ai")).toBe("xai");
    expect(vendorToProvider("meta-llama")).toBe("meta");
    expect(vendorToProvider("mistralai")).toBe("mistral");
    expect(vendorToProvider("qwen")).toBe("alibaba");
  });

  test("treats OpenRouter's `~vendor` preview namespace as the same vendor", () => {
    // The live catalog really does ship `~anthropic`, `~openai`, `~x-ai`.
    expect(vendorToProvider("~anthropic")).toBe("anthropic");
    expect(vendorToProvider("~x-ai")).toBe("xai");
    expect(vendorToProvider("~moonshotai")).toBe("moonshotai");
  });

  test("keeps an unknown vendor's own slug rather than guessing", () => {
    // Guessing would put someone else's brand mark on their model.
    expect(vendorToProvider("moonshotai")).toBe("moonshotai");
    expect(vendorToProvider("NousResearch")).toBe("nousresearch");
  });

  test("gives a local CLI's models the vendor's mark, not a generic one", () => {
    // The ids are namespaced by tool so they cannot collide with a gateway's,
    // but the model is still Anthropic's and OpenAI's — a generic icon in the
    // picker would read as some unrelated third-party model.
    expect(vendorToProvider("claude-cli")).toBe("anthropic");
    expect(vendorToProvider("codex-cli")).toBe("openai");
    expect(vendorToProvider("cursor-cli")).toBe("cursor");
    expect(vendorToProvider("gemini-cli")).toBe("google");
    expect(vendorToProvider("grok-cli")).toBe("xai");
    expect(vendorToProvider("kimi-cli")).toBe("kimi");
    expect(vendorToProvider("devin-cli")).toBe("devin");
  });
});

describe("shortId", () => {
  test("drops the vendor prefix and any variant suffix", () => {
    expect(shortId("anthropic/claude-sonnet-4.5")).toBe("claude-sonnet-4.5");
    expect(shortId("meta-llama/llama-4-scout:free")).toBe("llama-4-scout");
    expect(shortId("bare-model")).toBe("bare-model");
    // The CLI aliases are what the status bar should show — `claude-cli/opus`
    // in a status bar names the transport, not the model.
    expect(shortId("claude-cli/opus")).toBe("opus");
  });
});

describe("derivedModel", () => {
  test("renders an id from no catalog at all without inventing prices", () => {
    const model = derivedModel("anthropic/claude-2-retired");
    expect(model.provider).toBe("anthropic");
    expect(model.label).toBe("Claude 2 Retired");
    expect(derivedModel("openai/gpt-5.5").label).toBe("GPT 5.5");
    // A made-up price would show up as a confident, wrong cost readout.
    expect(model.costIn).toBe(0);
    expect(model.costOut).toBe(0);
  });
});

describe("matchLiveModel", () => {
  const catalog = [
    live("anthropic/claude-opus-4", 100),
    live("anthropic/claude-opus-4.5", 300),
    live("anthropic/claude-haiku-4.5", 200),
    live("openai/gpt-5-mini", 250),
    live("google/gemini-3-pro", 150),
  ];

  test("lands on the same family, newest generation", () => {
    const seed: Model = {
      id: "claude-opus-5",
      label: "Claude Opus 5",
      short: "opus-5",
      provider: "anthropic",
      contextWindow: 1_000_000,
      costIn: 5,
      costOut: 25,
    };

    expect(matchLiveModel(seed, catalog)?.id).toBe("anthropic/claude-opus-4.5");
  });

  test("stays inside the vendor even when no family word matches", () => {
    const seed: Model = {
      id: "gpt-5.6-sol",
      label: "GPT-5.6 Sol",
      short: "gpt-5.6-sol",
      provider: "openai",
      contextWindow: 1_000_000,
      costIn: 5,
      costOut: 30,
    };

    // "sol" matches nothing, so the vendor is the only signal left — and
    // answering with an Anthropic model would be worse than answering coarsely.
    expect(matchLiveModel(seed, catalog)?.provider).toBe("openai");
  });

  test("returns nothing when there is no catalog to match against", () => {
    const seed: Model = {
      id: "grok-4.5",
      label: "Grok 4.5",
      short: "grok-4.5",
      provider: "xai",
      contextWindow: 500_000,
      costIn: 2,
      costOut: 6,
    };

    expect(matchLiveModel(seed, [])).toBeUndefined();
  });
});

describe("toModel", () => {
  test("carries capabilities through so the picker can show them", () => {
    const model = toModel(
      entry({
        id: "x-ai/grok-4",
        name: "Grok 4",
        supportsVision: true,
        supportsTools: true,
        maxOutput: 8_192,
      }),
    );

    expect(model.provider).toBe("xai");
    expect(model.short).toBe("grok-4");
    expect(model.live).toBe(true);
    expect(model.supportsVision).toBe(true);
    expect(model.maxOutput).toBe(8_192);
  });

  test("keeps a missing cache price absent rather than calling it free", () => {
    const cached = toModel(entry({ id: "anthropic/claude-x", costCacheRead: 0.3 }));
    expect(cached.costCacheRead).toBe(0.3);

    // `null` from the wire has to become `undefined`, not `0` — a zero here
    // would render as a model whose cached reads cost nothing.
    const uncached = toModel(entry({ id: "someone/no-cache" }));
    expect(uncached.costCacheRead).toBeUndefined();
  });
});

describe("isOpenWeights", () => {
  test("tells published-weight families from closed ones", () => {
    expect(isOpenWeights({ id: "deepseek/deepseek-v4-pro" })).toBe(true);
    expect(isOpenWeights({ id: "z-ai/glm-5.3" })).toBe(true);
    expect(isOpenWeights({ id: "anthropic/claude-opus-5.5" })).toBe(false);
    expect(isOpenWeights({ id: "openai/gpt-5.6-sol" })).toBe(false);
  });
});
