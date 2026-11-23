import { desktopTransport } from "./desktop";
import { webTransport } from "./web";
import { credentialKey, isAgentKey } from "./types";
import type { AgentKey, GatewayKey, ProviderKey, Transport, ZaiPlan } from "./types";

export type {
  Account,
  AgentKey,
  AgentProbe,
  CatalogEntry,
  ChatMessage,
  ChatRequest,
  ContentPart,
  CredentialStatus,
  CredentialKey,
  GatewayKey,
  ProviderCallOpts,
  ProviderKey,
  StreamEvent,
  Transport,
  ZaiPlan,
} from "./types";

export { AGENT_LOGIN, credentialKey, isAgentKey, zaiBaseUrl } from "./types";

/*
 * The single seam between the app and a model.
 *
 * `draftReply()` used to live here in spirit — a local function pretending to
 * be a provider. It is gone: `send()` now goes through this façade, and the
 * only thing that varies is which transport answers.
 */

/** Tauri injects this before any app code runs. */
function isDesktop(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

export const adapter: Transport = isDesktop() ? desktopTransport : webTransport;

/**
 * Where the key is kept, for the connect sheet to state honestly. The browser
 * fallback is a development convenience and says so.
 */
export const KEY_STORAGE: Record<Transport["kind"], string> = {
  desktop: "macOS Keychain",
  web: "localStorage deste navegador",
};

/** Everything the connect sheet can offer, in tab order. */
export const PROVIDERS: readonly ProviderKey[] = [
  "openrouter",
  "zai",
  "deepseek",
  "claude-cli",
  "codex-cli",
  "cursor-cli",
  "gemini-cli",
  "grok-cli",
  "kimi-cli",
  "devin-cli",
];

interface ProviderMeta {
  title: string;
  subtitle: string;
  /** Where the user goes to get what this provider needs. */
  keysUrl: string;
  /** Key field hint; unused by CLI providers, which have no key field. */
  placeholder: string;
}

export const PROVIDER_META: Record<ProviderKey, ProviderMeta> = {
  openrouter: {
    title: "OpenRouter",
    subtitle: "Uma chave, todos os modelos do seletor",
    keysUrl: "https://openrouter.ai/keys",
    placeholder: "sk-or-v1-…",
  },
  zai: {
    title: "Z.AI",
    subtitle: "Modelos GLM, direto da Zhipu",
    keysUrl: "https://z.ai/manage-apikey/apikey-list",
    placeholder: "Chave de API…",
  },
  deepseek: {
    title: "DeepSeek",
    subtitle: "Modelos DeepSeek V4, direto da API oficial",
    keysUrl: "https://platform.deepseek.com/api_keys",
    placeholder: "sk-…",
  },
  "claude-cli": {
    title: "Claude",
    subtitle: "Sua assinatura do Claude, pela CLI que você já tem",
    keysUrl: "https://docs.claude.com/en/docs/claude-code/overview",
    placeholder: "",
  },
  "codex-cli": {
    title: "ChatGPT",
    subtitle: "Seu plano do ChatGPT, pela CLI que você já tem",
    keysUrl: "https://developers.openai.com/codex/cli",
    placeholder: "",
  },
  "cursor-cli": {
    title: "Cursor",
    subtitle: "Sua conta do Cursor, pela CLI que você já tem",
    keysUrl: "https://cursor.com/docs/cli/installation",
    placeholder: "",
  },
  "gemini-cli": {
    title: "Gemini",
    subtitle: "Sua conta Google, pela Gemini CLI",
    keysUrl: "https://geminicli.com/docs/get-started/installation/",
    placeholder: "",
  },
  "grok-cli": {
    title: "Grok",
    subtitle: "Sua conta do Grok, pela CLI Grok Build",
    keysUrl: "https://docs.x.ai/build/overview",
    placeholder: "",
  },
  "kimi-cli": {
    title: "Kimi",
    subtitle: "Sua conta do Kimi, pela Kimi Code CLI",
    keysUrl: "https://www.kimi.ai/code",
    placeholder: "",
  },
  "devin-cli": {
    title: "Devin",
    subtitle: "Sua conta do Devin, pela CLI local",
    keysUrl: "https://docs.devin.ai/cli",
    placeholder: "",
  },
};

const PREFERRED_KEY = "atimo.gateway.v1";

/** Prefer a previously chosen provider; fall back to OpenRouter. */
export function readPreferredProvider(): ProviderKey {
  try {
    const raw = localStorage.getItem(PREFERRED_KEY);
    if (raw && (PROVIDERS as readonly string[]).includes(raw)) {
      return raw as ProviderKey;
    }
  } catch {
    /* ignore */
  }
  return "openrouter";
}

export function writePreferredProvider(provider: ProviderKey) {
  try {
    localStorage.setItem(PREFERRED_KEY, provider);
  } catch {
    /* ignore */
  }
}

/**
 * Which providers already have something to connect with, cheapest question
 * first. Used at launch to reconnect whatever the last session was using.
 *
 * Both questions are free: a keychain lookup, or asking a CLI its version and
 * who is signed in. Neither calls a model.
 */
export async function findConnectable(
  order: readonly ProviderKey[],
): Promise<ProviderKey | null> {
  for (const provider of order) {
    if (await isConnectable(provider)) return provider;
  }
  return null;
}

/** A saved key, or a CLI that is installed and signed in. Calls no model. */
export async function isConnectable(provider: ProviderKey): Promise<boolean> {
  if (isAgentKey(provider)) {
    const probe = await adapter.agentProbe(provider as AgentKey).catch(() => null);
    return Boolean(probe?.loggedIn);
  }
  const status = await adapter
    .credentialStatus(credentialKey(provider as GatewayKey, readZaiPlan()))
    .catch(() => null);
  return Boolean(status?.present);
}

const ZAI_PLAN_KEY = "atimo.zaiPlan.v1";

export function readZaiPlan(): ZaiPlan {
  try {
    const raw = localStorage.getItem(ZAI_PLAN_KEY);
    if (raw === "general" || raw === "coding") return raw;
  } catch {
    /* ignore */
  }
  return "general";
}

export function writeZaiPlan(plan: ZaiPlan) {
  try {
    localStorage.setItem(ZAI_PLAN_KEY, plan);
  } catch {
    /* ignore */
  }
}

export async function migrateCredentials(): Promise<void> {
  const marker = "atimo.credentials-separated.v1";
  if (localStorage.getItem(marker)) return;
  if (readZaiPlan() === "coding") await adapter.migrateZaiCodingCredential();
  localStorage.setItem(marker, "1");
}
