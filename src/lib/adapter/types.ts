import type { Effort } from "../effort";

/*
 * The contract between the app and whatever is answering prompts.
 *
 * These types mirror the Rust adapters (`openrouter.rs`, `zai.rs`) exactly —
 * the Rust side serialises straight into them. Both transports (desktop,
 * browser) speak this shape, so the store never learns which one it got.
 */

/**
 * Something that can answer a turn.
 *
 * Two kinds, and the difference is not cosmetic. A *gateway* holds an API key
 * and is billed per token. An *agent* is a first-party CLI already installed
 * and signed in on this machine — Atimo spawns it and reads its stdout, so
 * the turn is covered by whatever subscription the CLI already has and no
 * credential passes through this app at all.
 *
 * The agent route exists because the alternative does not survive contact with
 * the vendors' terms: reusing a subscription OAuth token outside the vendor's
 * own client is a terms violation at Anthropic (blocked since January 2026) and
 * unwritten-but-unblocked at OpenAI. Running the vendor's own tool is neither.
 */
export type ProviderKey = GatewayKey | AgentKey;

/** Gateways: an API key, stored by us, billed per token. */
export type GatewayKey = "openrouter" | "zai" | "deepseek";
export type CredentialKey = GatewayKey | "zai-coding" | "gemini";

export function credentialKey(provider: GatewayKey, plan?: ZaiPlan): CredentialKey {
  return provider === "zai" && plan === "coding" ? "zai-coding" : provider;
}

/** Local CLIs: no key, no token, billed to the user's existing subscription. */
export type AgentKey = "claude-cli" | "codex-cli" | "cursor-cli" | "gemini-cli" | "grok-cli" | "kimi-cli" | "devin-cli";

const AGENT_KEYS: readonly AgentKey[] = ["claude-cli", "codex-cli", "cursor-cli", "gemini-cli", "grok-cli", "kimi-cli", "devin-cli"];

export const AGENT_LOGIN: Record<AgentKey, string> = {
  "claude-cli": "claude auth login",
  "codex-cli": "codex login",
  "cursor-cli": "cursor-agent login",
  "gemini-cli": "gemini",
  "grok-cli": "grok login",
  "kimi-cli": "kimi login",
  "devin-cli": "devin auth login",
};

export function isAgentKey(provider: ProviderKey): provider is AgentKey {
  return (AGENT_KEYS as readonly string[]).includes(provider);
}

/**
 * Z.AI endpoint flavour. Coding Plan keys must hit the coding base URL or
 * the subscription quota is not used — see docs.z.ai/devpack.
 */
export type ZaiPlan = "general" | "coding";

/** OpenAI-compatible bases — Anthropic `/api/anthropic` is Claude Code only. */
export function zaiBaseUrl(plan: ZaiPlan): string {
  return plan === "coding"
    ? "https://api.z.ai/api/coding/paas/v4"
    : "https://api.z.ai/api/paas/v4";
}

/** Options for gateway calls that differ by provider flavour. */
export interface ProviderCallOpts {
  zaiPlan?: ZaiPlan;
}

export interface CredentialStatus {
  present: boolean;
  /** Last four characters. The key itself is never handed back. */
  hint: string | null;
}

/**
 * What a local CLI reports about itself. Mirrors `AgentProbe` in `cli_agent.rs`.
 *
 * Note what this cannot contain: a token, an expiry, anything derived from a
 * credential. `account` is whatever the CLI itself prints about who is signed
 * in — the app asks the question and repeats the answer.
 */
export interface AgentProbe {
  installed: boolean;
  /** Where it was found, so two installs can be told apart. */
  path: string | null;
  version: string | null;
  loggedIn: boolean;
  /** How the CLI says it is authenticated — `claude.ai`, `ChatGPT`, an API key. */
  method: string | null;
  account: string | null;
  plan: string | null;
  /** The model the CLI is configured to use, when it will say. */
  model: string | null;
  /** The shell command that fixes `loggedIn: false`. */
  loginCommand: string;
  /** One sentence naming what is wrong, or null when nothing is. */
  problem: string | null;
}

/** A model as the catalog describes it. Prices are USD per 1M tokens. */
export interface CatalogEntry {
  id: string;
  name: string;
  /** Slug prefix — `anthropic`, `openai`, `x-ai`… */
  vendor: string;
  contextLength: number;
  costIn: number;
  costOut: number;
  /**
   * Input price for a cached prefix, when the model has one — null when it
   * does not, which is a different thing from free.
   */
  costCacheRead: number | null;
  costCacheWrite: number | null;
  maxOutput: number | null;
  supportsVision: boolean;
  /** Accepts a document (PDF) as a message part, rather than as pasted text. */
  supportsFiles: boolean;
  supportsAudio: boolean;
  supportsTools: boolean;
  supportsReasoning: boolean;
  /** Unix seconds. */
  created: number;
  description: string;
}

export interface Account {
  label: string;
  /** USD spent on this key. */
  usage: number;
  limit: number | null;
  isFreeTier: boolean;
}

/**
 * One piece of a multimodal message, in the shape every OpenAI-compatible
 * gateway takes. Mirrors `MessageContent::Parts` in `openrouter.rs`, which
 * forwards these opaquely.
 *
 * The `url` and `file_data` fields are `data:` URLs rather than links. Nothing
 * in this app is reachable from the internet — the bytes are on the user's
 * machine — so a hosted URL would mean uploading them somewhere first, which is
 * a second place the user's screenshots would live.
 */
export type ContentPart =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string } }
  | { type: "file"; file: { filename: string; file_data: string } }
  | { type: "input_audio"; input_audio: { data: string; format: string } };

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  /**
   * Prose, or parts when the turn carries attachments.
   *
   * A bare string on every turn that attaches nothing, which is nearly all of
   * them — so the ordinary request is byte-identical to the one this app sent
   * before attachments existed, and no model has to accept a shape it might
   * only half support to answer a plain question.
   */
  content: string | ContentPart[];
}

export interface ChatRequest {
  model: string;
  messages: ChatMessage[];
  temperature?: number;
  maxTokens?: number;
  /**
   * How an attached PDF should be turned into tokens. OpenRouter only, and only
   * meaningful when a message carries a `file` part — see `pdfEngineFor()` in
   * `attachments.ts` for why it is always stated rather than defaulted.
   */
  pdfEngine?: "native" | "pdf-text" | "mistral-ocr";
  /**
   * How hard to think. Omitted or `"auto"` sends nothing — see `effort.ts`
   * for the scale and `src-tauri/src/effort.rs` for the per-provider mapping.
   */
  effort?: Effort;
  /**
   * Prefer the highest-throughput provider. OpenRouter only — maps to
   * `provider.sort: "throughput"` (the `:nitro` shortcut). Ignored elsewhere.
   */
  fast?: boolean;
}

/**
 * Ordering guarantee: `open`, then any number of `delta`/`reasoning`, then
 * `usage`, then exactly one terminal `done` or `error`. Consumers can rely on
 * receiving a terminal event even when the turn fails.
 */
export type StreamEvent =
  | { type: "open" }
  /** Data without text (keepalive, hidden thinking): the stream is alive. */
  | { type: "alive" }
  | { type: "delta"; text: string }
  | { type: "reasoning"; text: string }
  | {
      /**
       * The model's real limits, once the provider names them. Only the CLI
       * transport sends this — `claude-cli/default` resolves to whatever the
       * user configured, so its window cannot be catalogued in advance.
       */
      type: "limits";
      /** The catalog id, not the provider's internal model name. */
      model: string;
      contextLength: number;
      maxOutput: number | null;
    }
  /** Plan windows the CLI reported mid-turn, raw — see `usage-limits.ts`. */
  | { type: "rateLimits"; info: unknown }
  | {
      type: "usage";
      promptTokens: number;
      completionTokens: number;
      /** Unknown when absent; zero means a measured cache miss. */
      cachedPromptTokens?: number | null;
      /** USD as billed by the provider, when it reports one. */
      cost: number | null;
    }
  | { type: "done"; finishReason: string | null; cancelled: boolean }
  | { type: "error"; message: string };

export interface Transport {
  /** `desktop` keeps the key in the OS keychain; `web` cannot. */
  readonly kind: "desktop" | "web";
  credentialStatus(provider: CredentialKey): Promise<CredentialStatus>;
  credentialSet(provider: CredentialKey, key: string): Promise<CredentialStatus>;
  credentialClear(provider: CredentialKey): Promise<CredentialStatus>;
  migrateZaiCodingCredential(): Promise<void>;
  research(streamId: string, request: import("../research-provider").ResearchRequest): Promise<unknown>;
  /** Raw HTML of a Tables and Views for HCM page (`toc.htm` or `name-123.html`). Desktop only. */
  oracleDoc(page: string): Promise<string>;
  /**
   * Ask a local CLI whether it is installed and signed in. Cheap and safe to
   * call on every launch: no model is invoked and no credential is read.
   */
  agentProbe(provider: AgentKey): Promise<AgentProbe>;
  catalog(provider: ProviderKey): Promise<CatalogEntry[]>;
  account(provider: ProviderKey, opts?: ProviderCallOpts): Promise<Account>;
  /** Plan limits or balance, in the provider's own shape. Calls no model. */
  usage(provider: ProviderKey, opts?: ProviderCallOpts): Promise<unknown>;
  chat(
    provider: ProviderKey,
    streamId: string,
    request: ChatRequest,
    onEvent: (event: StreamEvent) => void,
    opts?: ProviderCallOpts,
  ): Promise<void>;
  cancel(provider: ProviderKey, streamId: string): void;
}
