import type { CatalogEntry } from "./adapter";
import type { Model, ProviderId } from "./types";

/*
 * Live catalog → domain model.
 *
 * OpenRouter names models `vendor/model-slug`. That prefix is the only vendor
 * signal there is, and it does not match our internal provider ids one for one
 * (`x-ai` vs `xai`, `meta-llama` vs `meta`), so the translation lives here and
 * nowhere else.
 */

/** OpenRouter vendor slug → the provider id our brand marks are keyed by. */
const VENDOR_TO_PROVIDER: Record<string, ProviderId> = {
  anthropic: "anthropic",
  openai: "openai",
  google: "google",
  "google-ai-studio": "google",
  "x-ai": "xai",
  xai: "xai",
  deepseek: "deepseek",
  mistralai: "mistral",
  mistral: "mistral",
  "meta-llama": "meta",
  meta: "meta",
  qwen: "alibaba",
  alibaba: "alibaba",
  perplexity: "perplexity",
  microsoft: "microsoft",
  amazon: "amazon",
  github: "copilot",
  openrouter: "openrouter",
  zai: "zai",
  "z-ai": "zai",
  // The local-CLI catalogs namespace their ids by the tool (`claude-cli/opus`)
  // so they cannot collide with a gateway slug — but the model is still the
  // vendor's, and it should wear the vendor's mark in the picker.
  "claude-cli": "anthropic",
  "codex-cli": "openai",
  "cursor-cli": "cursor",
  "gemini-cli": "google",
  "grok-cli": "xai",
  "kimi-cli": "kimi",
  "devin-cli": "devin",
};

export function vendorToProvider(vendor: string): ProviderId {
  // OpenRouter namespaces preview and variant routes under `~vendor`. Those are
  // the same vendor and must carry the same brand mark — otherwise a Claude
  // preview shows up in the picker wearing the generic icon.
  const slug = vendor.toLowerCase().replace(/^~/, "");
  // Unknown vendors keep their slug: `providerUi()` renders them with the
  // generic mark rather than mislabelling them as someone else's model.
  return VENDOR_TO_PROVIDER[slug] ?? slug;
}

/** `anthropic/claude-sonnet-4.5` → `claude-sonnet-4.5`, for the status bar. */
export function shortId(id: string): string {
  const slug = id.includes("/") ? id.slice(id.indexOf("/") + 1) : id;
  return slug.replace(/:.*$/, "");
}

export function toModel(entry: CatalogEntry): Model {
  return {
    id: entry.id,
    label: entry.name,
    provider: vendorToProvider(entry.vendor),
    short: shortId(entry.id),
    contextWindow: entry.contextLength,
    costIn: entry.costIn,
    costOut: entry.costOut,
    costCacheRead: entry.costCacheRead ?? undefined,
    costCacheWrite: entry.costCacheWrite ?? undefined,
    live: true,
    maxOutput: entry.maxOutput ?? undefined,
    supportsVision: entry.supportsVision,
    supportsFiles: entry.supportsFiles,
    supportsAudio: entry.supportsAudio,
    supportsTools: entry.supportsTools,
    supportsReasoning: entry.supportsReasoning,
    created: entry.created,
    description: entry.description,
  };
}

/**
 * Best-effort model for an id that is in no catalog — a chat saved against a
 * model the provider has since retired, or a seed id with no live twin.
 *
 * Returning a placeholder rather than throwing is deliberate: an old chat must
 * still render its history, and the only thing genuinely unknown is the
 * pricing, which we leave at zero rather than invent.
 */
/** "claude-opus-5.5" → "Claude Opus 5.5": the header and the picker must not show a raw slug. */
export function readableName(slug: string): string {
  return slug
    .split(/[-_]/)
    .filter(Boolean)
    .map((w) => (/^(gpt|glm|ai)$/i.test(w) ? w.toUpperCase() : w[0]!.toUpperCase() + w.slice(1)))
    .join(" ");
}

export function derivedModel(id: string): Model {
  const vendor = id.includes("/") ? id.slice(0, id.indexOf("/")) : "other";
  return {
    id,
    label: readableName(shortId(id)),
    provider: vendorToProvider(vendor),
    short: shortId(id),
    contextWindow: 128_000,
    costIn: 0,
    costOut: 0,
  };
}

/* ---------------------------------------------------------------------- */
/* Seed → live matching                                                     */
/* ---------------------------------------------------------------------- */

/** Version noise carries no family signal; letters do. */
function familyTokens(id: string): string[] {
  return id
    .toLowerCase()
    .split(/[^a-z]+/)
    .filter((token) => token.length >= 3);
}

/**
 * Find the live model that best stands in for a seed one.
 *
 * The seed catalog is a fixture — its ids are not real OpenRouter slugs — so
 * the moment a key is connected, every chat pointing at a seed model needs a
 * real destination. Matching on vendor plus family words ("opus", "gemini")
 * survives the catalog being renamed under us, which a hardcoded alias table
 * would not.
 */
export function matchLiveModel(seed: Model, live: Model[]): Model | undefined {
  const wanted = new Set(familyTokens(seed.id));
  const sameVendor = live.filter((m) => m.provider === seed.provider);
  const pool = sameVendor.length ? sameVendor : live;

  let best: Model | undefined;
  let bestScore = -1;

  for (const candidate of pool) {
    const tokens = familyTokens(candidate.id);
    let overlap = 0;
    for (const token of tokens) if (wanted.has(token)) overlap += 1;

    // Newer wins ties, so a family match lands on the current generation.
    const score = overlap * 1_000_000 + (candidate.created ?? 0) / 1e6;
    if (score > bestScore) {
      bestScore = score;
      best = candidate;
    }
  }

  return best;
}

/**
 * The model a fresh chat should open with. Prefers whatever the user was
 * already using, then a live model with a real family match, then the newest
 * live model, and only then the seed default.
 */
export function resolveDefaultModel(
  preferred: string | undefined,
  live: Model[],
  seedFallback: string,
): string {
  if (!live.length) return preferred ?? seedFallback;
  if (preferred && live.some((m) => m.id === preferred)) return preferred;
  return live[0]?.id ?? seedFallback;
}
