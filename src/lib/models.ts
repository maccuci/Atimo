import { derivedModel } from "./catalog";
import type { KnownProviderId, Model, ProviderId } from "./types";

/**
 * Seed catalog — the lineup the app ships with, used before a provider key is
 * connected and to keep historical chats renderable afterwards.
 *
 * Once OpenRouter answers, `registerCatalog()` layers the real catalog on top
 * and the picker selects from that. The PRD treats models as interchangeable
 * adapters behind the Context Engine, so nothing outside this file and
 * `catalog.ts` may hardcode a provider name.
 */
export const SEED_MODELS: Model[] = [
  /* —— Anthropic ———————————————————————————————————————————————— */
  {
    id: "claude-fable-5",
    label: "Claude Fable 5",
    short: "fable-5",
    provider: "anthropic",
    contextWindow: 1_000_000,
    costIn: 10,
    costOut: 50,
  },
  {
    id: "claude-opus-5",
    label: "Claude Opus 5",
    short: "opus-5",
    provider: "anthropic",
    contextWindow: 1_000_000,
    costIn: 5,
    costOut: 25,
  },
  {
    id: "claude-sonnet-5",
    label: "Claude Sonnet 5",
    short: "sonnet-5",
    provider: "anthropic",
    contextWindow: 1_000_000,
    costIn: 3,
    costOut: 15,
  },
  {
    id: "claude-haiku-4.5",
    label: "Claude Haiku 4.5",
    short: "haiku-4.5",
    provider: "anthropic",
    contextWindow: 200_000,
    costIn: 1,
    costOut: 5,
  },

  /* —— OpenAI ——————————————————————————————————————————————————— */
  {
    id: "gpt-5.6-sol",
    label: "GPT-5.6 Sol",
    short: "gpt-5.6-sol",
    provider: "openai",
    contextWindow: 1_000_000,
    costIn: 5,
    costOut: 30,
  },
  {
    id: "gpt-5.6-terra",
    label: "GPT-5.6 Terra",
    short: "gpt-5.6-terra",
    provider: "openai",
    contextWindow: 400_000,
    costIn: 2.5,
    costOut: 15,
  },
  {
    id: "gpt-5.6-luna",
    label: "GPT-5.6 Luna",
    short: "gpt-5.6-luna",
    provider: "openai",
    contextWindow: 400_000,
    costIn: 0.5,
    costOut: 3,
  },
  {
    id: "gpt-5.5",
    label: "GPT-5.5",
    short: "gpt-5.5",
    provider: "openai",
    contextWindow: 400_000,
    costIn: 5,
    costOut: 30,
  },

  /* —— Google ——————————————————————————————————————————————————— */
  {
    id: "gemini-3.1-pro",
    label: "Gemini 3.1 Pro",
    short: "gemini-3.1",
    provider: "google",
    contextWindow: 1_000_000,
    costIn: 2,
    costOut: 12,
  },
  {
    id: "gemini-3.6-flash",
    label: "Gemini 3.6 Flash",
    short: "gemini-3.6",
    provider: "google",
    contextWindow: 1_000_000,
    costIn: 1.5,
    costOut: 7.5,
  },
  {
    id: "gemini-3.5-flash-lite",
    label: "Gemini 3.5 Flash-Lite",
    short: "gemini-lite",
    provider: "google",
    contextWindow: 1_000_000,
    costIn: 0.3,
    costOut: 2.5,
  },

  /* —— xAI —————————————————————————————————————————————————————— */
  {
    id: "grok-4.5",
    label: "Grok 4.5",
    short: "grok-4.5",
    provider: "xai",
    contextWindow: 500_000,
    costIn: 2,
    costOut: 6,
  },
  {
    id: "grok-4.3",
    label: "Grok 4.3",
    short: "grok-4.3",
    provider: "xai",
    contextWindow: 1_000_000,
    costIn: 1.25,
    costOut: 2.5,
  },
  {
    id: "grok-4.1-fast",
    label: "Grok 4.1 Fast",
    short: "grok-4.1f",
    provider: "xai",
    contextWindow: 2_000_000,
    costIn: 0.2,
    costOut: 0.5,
  },

  /* —— DeepSeek ————————————————————————————————————————————————— */
  {
    id: "deepseek-v4-pro",
    label: "DeepSeek V4 Pro",
    short: "ds-v4-pro",
    provider: "deepseek",
    contextWindow: 1_000_000,
    costIn: 0.44,
    costOut: 0.87,
  },
  {
    id: "deepseek-v4-flash",
    label: "DeepSeek V4 Flash",
    short: "ds-v4-flash",
    provider: "deepseek",
    contextWindow: 1_000_000,
    costIn: 0.14,
    costOut: 0.28,
  },

  /* —— Mistral —————————————————————————————————————————————————— */
  {
    id: "mistral-medium-3.5",
    label: "Mistral Medium 3.5",
    short: "mistral-m3.5",
    provider: "mistral",
    contextWindow: 256_000,
    costIn: 0.4,
    costOut: 2,
  },

  /* —— Meta ————————————————————————————————————————————————————— */
  {
    id: "muse-spark-1.1",
    label: "Muse Spark 1.1",
    short: "muse-1.1",
    provider: "meta",
    contextWindow: 1_000_000,
    costIn: 1.5,
    costOut: 8,
  },

  /* —— Alibaba / Qwen ——————————————————————————————————————————— */
  {
    id: "qwen3.7-max",
    label: "Qwen3.7 Max",
    short: "qwen-max",
    provider: "alibaba",
    contextWindow: 1_000_000,
    costIn: 0.8,
    costOut: 3.2,
  },
  {
    id: "qwen3.7-plus",
    label: "Qwen3.7 Plus",
    short: "qwen-plus",
    provider: "alibaba",
    contextWindow: 1_000_000,
    costIn: 0.4,
    costOut: 1.6,
  },
];

/** Legacy ids from earlier mock data → current seed ids. */
const ALIASES: Record<string, string> = {
  "gpt-5.6": "gpt-5.6-sol",
  "gemini-3-pro": "gemini-3.1-pro",
  "grok-4": "grok-4.5",
  "deepseek-v4": "deepseek-v4-pro",
  // Claude CLI entries were aliases before they were full ids; old chats keep theirs.
  "claude-cli/opus": "claude-cli/claude-opus-5-5",
  "claude-cli/sonnet": "claude-cli/claude-sonnet-5-5",
  "claude-cli/haiku": "claude-cli/claude-haiku-5-5",
};

const SEED_BY_ID = new Map(SEED_MODELS.map((m) => [m.id, m]));

/**
 * Live catalog, replaced wholesale on each refresh. Kept as a module-level map
 * rather than store state because it is read from render paths that only have
 * an id to work with — a message from six months ago naming a retired model.
 * The store holds the same list so components re-render when it changes.
 */
let liveById = new Map<string, Model>();

export function registerCatalog(models: Model[]) {
  liveById = new Map(models.map((m) => [m.id, m]));
}

/**
 * Resolve an id to something renderable — always. An unknown id is a chat
 * pointing at a model the provider retired, not a bug worth crashing the view
 * over, so it degrades to a placeholder derived from the slug.
 */
export function getModel(id: string): Model {
  const resolved = ALIASES[id] ?? id;
  return liveById.get(resolved) ?? SEED_BY_ID.get(resolved) ?? derivedModel(resolved);
}

/** Whether an id names a model we can actually send to. */
export function isLive(id: string): boolean {
  return liveById.has(ALIASES[id] ?? id);
}

const KNOWN_PROVIDER_LABEL: Record<KnownProviderId, string> = {
  anthropic: "Anthropic",
  openai: "OpenAI",
  google: "Google",
  xai: "xAI",
  deepseek: "DeepSeek",
  mistral: "Mistral",
  meta: "Meta",
  alibaba: "Alibaba",
  perplexity: "Perplexity",
  microsoft: "Microsoft",
  amazon: "Amazon",
  copilot: "GitHub",
  cursor: "Cursor",
  kimi: "Moonshot AI",
  devin: "Devin",
  openrouter: "OpenRouter",
  zai: "Z.AI",
};

export const PROVIDER_LABEL = KNOWN_PROVIDER_LABEL;

/** Title-cases an unknown vendor slug (`moonshotai` → `Moonshotai`). */
export function providerLabel(provider: ProviderId): string {
  return (
    KNOWN_PROVIDER_LABEL[provider as KnownProviderId] ??
    provider.replace(/[-_]/g, " ").replace(/\b\w/g, (c) => c.toUpperCase())
  );
}

/**
 * Whether a model's weights are published — the families Atimo's
 * open-model principle prefers.
 *
 * ponytail: matched on the id because no catalog carries a licence field;
 * a family released closed under one of these names would be mislabelled.
 * Read a licence from the catalog when one starts sending it.
 */
const OPEN_WEIGHTS = /deepseek|qwen|llama|mistral|mixtral|gemma|glm|kimi|lfm|olmo|phi-|gpt-oss|nemotron|ernie|minimax|hermes/i;
export function isOpenWeights(model: Pick<Model, "id">): boolean {
  return OPEN_WEIGHTS.test(model.id);
}
