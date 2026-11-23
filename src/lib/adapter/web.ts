import { AGENT_LOGIN, credentialKey, isAgentKey, zaiBaseUrl } from "./types";
import { researchWire } from "../research-provider";
import type { Effort } from "../effort";
import { cachedPromptTokens } from "./usage";
import type {
  Account,
  AgentKey,
  AgentProbe,
  CatalogEntry,
  ChatRequest,
  CredentialStatus,
  CredentialKey,
  GatewayKey,
  ProviderCallOpts,
  ProviderKey,
  Transport,
} from "./types";

/*
 * Browser transport — development only.
 *
 * `bun run dev` opens the frontend at localhost:1420 with no Rust process
 * behind it, so there is no keychain to talk to. Rather than leave the whole
 * adapter dead in that mode, this speaks to the active gateway directly and
 * keeps the key in localStorage.
 *
 * That is genuinely less safe than the desktop path — any script on the page
 * can read localStorage — which is why `kind` is exposed: the connect sheet
 * says so plainly instead of letting the user assume keychain-grade storage.
 */

/*
 * A page cannot spawn a process, so the local-CLI providers do not exist here.
 * Every entry point that could reach one says that in a sentence rather than
 * failing with whatever `fetch` makes of a provider it has no base URL for.
 */
const NO_AGENTS =
  "Provedores via CLI precisam do app desktop. O navegador não pode executar " +
  "programas locais. Use o app desktop ou conecte uma chave de API.";

function refuseAgents(provider: ProviderKey): asserts provider is GatewayKey {
  if (isAgentKey(provider)) throw new Error(NO_AGENTS);
}

function gatewayLabel(provider: GatewayKey): string {
  switch (provider) {
    case "openrouter":
      return "OpenRouter";
    case "zai":
      return "Z.AI";
    case "deepseek":
      return "DeepSeek";
    default: {
      const _exhaustive: never = provider;
      return _exhaustive;
    }
  }
}

function gatewayBase(provider: GatewayKey, opts?: ProviderCallOpts): string {
  switch (provider) {
    case "openrouter":
      return "https://openrouter.ai/api/v1";
    case "zai":
      return zaiBaseUrl(opts?.zaiPlan ?? "general");
    case "deepseek":
      return "https://api.deepseek.com";
    default: {
      const _exhaustive: never = provider;
      return _exhaustive;
    }
  }
}

/** Versioned so a future shape change can be detected rather than mis-parsed. */
const STORAGE_KEY = "atimo.credentials.v1";

type Vault = Partial<Record<CredentialKey, string>>;

function readVault(): Vault {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? (JSON.parse(raw) as Vault) : {};
  } catch {
    return {};
  }
}

function writeVault(vault: Vault) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(vault));
  } catch {
    /* private browsing, quota — the caller sees `present: false` either way */
  }
}

function statusOf(key: string | undefined): CredentialStatus {
  return key
    ? { present: true, hint: key.slice(-4) }
    : { present: false, hint: null };
}

function requireKey(provider: CredentialKey): string {
  const key = readVault()[provider];
  if (!key) {
    throw new Error(
      `Nenhuma chave do ${provider} salva. Conecte uma chave primeiro.`,
    );
  }
  return key;
}

/** Mirrors `describe_failure` in the Rust adapters so both paths read alike. */
async function describeFailure(
  provider: GatewayKey,
  response: Response,
): Promise<string> {
  const label = gatewayLabel(provider);
  const body = await response.text().catch(() => "");
  let detail = body.slice(0, 200);
  try {
    const parsed = JSON.parse(body);
    detail = parsed?.error?.message ?? parsed?.msg ?? detail;
  } catch {
    /* keep the raw body */
  }

  switch (response.status) {
    case 401:
    case 403:
      return `${label} recusou a chave. Confira se ela ainda é válida.`;
    case 402:
      return `Sem créditos no ${label}. ${detail}`;
    case 429:
      return `Limite de requisições do ${label}. Aguarde um pouco e tente de novo.`;
    default:
      return detail
        ? `${label} respondeu ${response.status}: ${detail}`
        : `${label} respondeu ${response.status}`;
  }
}

function toOpenRouterEntry(model: Record<string, any>): CatalogEntry {
  const id = String(model.id ?? "");
  const perMillion = (value: unknown) =>
    (Number.parseFloat(String(value ?? "0")) || 0) * 1e6;
  const inputs: string[] = model.architecture?.input_modalities ?? [];
  const supported: string[] = model.supported_parameters ?? [];
  const rawName = String(model.name ?? id);

  return {
    id,
    name: rawName.includes(": ")
      ? rawName.slice(rawName.indexOf(": ") + 2)
      : rawName,
    vendor: id.split("/")[0] ?? "other",
    contextLength: Number(
      model.context_length ?? model.top_provider?.context_length ?? 0,
    ),
    costIn: perMillion(model.pricing?.prompt),
    costOut: perMillion(model.pricing?.completion),
    // Zero here means "no cached rate quoted", not "cached reads are free".
    costCacheRead: perMillion(model.pricing?.input_cache_read) || null,
    costCacheWrite: perMillion(model.pricing?.input_cache_write) || null,
    maxOutput: model.top_provider?.max_completion_tokens ?? null,
    supportsVision: inputs.includes("image"),
    supportsFiles: inputs.includes("file"),
    supportsAudio: inputs.includes("audio"),
    supportsTools: supported.includes("tools"),
    supportsReasoning:
      supported.includes("reasoning") ||
      supported.includes("include_reasoning"),
    created: Number(model.created ?? 0),
    description: String(model.description ?? ""),
  };
}

/** Mirrors `zai::static_catalog` so the browser path has the same lineup. */
function zaiCatalog(): CatalogEntry[] {
  const v = "zai";
  const e = (
    id: string,
    name: string,
    contextLength: number,
    costIn: number,
    costOut: number,
    costCacheRead: number | null,
    maxOutput: number | null,
    supportsVision: boolean,
    supportsTools: boolean,
    supportsReasoning: boolean,
    created: number,
  ): CatalogEntry => ({
    id,
    name,
    vendor: v,
    contextLength,
    costIn,
    costOut,
    costCacheRead,
    costCacheWrite: null,
    maxOutput,
    supportsVision,
    // Mirrors `zai::entry` — the OpenAI-compatible endpoint takes images inline
    // and has no document or audio part at all.
    supportsFiles: false,
    supportsAudio: false,
    supportsTools,
    supportsReasoning,
    created,
    description: "",
  });

  return [
    // Mirrors zai.rs: GLM-5.4 specs copied from 5.3 until docs.z.ai publishes them.
    e("glm-5.4", "GLM-5.4", 1_000_000, 1.4, 4.4, 0.26, 128_000, false, true, true, 54),
    e("glm-5.3", "GLM-5.3", 1_000_000, 1.4, 4.4, 0.26, 128_000, false, true, true, 53),
    e("glm-5.3-flashx", "GLM-5.3-FlashX", 1_000_000, 0.37, 1.25, 0.075, 128_000, true, true, true, 52),
    e("glm-5.3-flash", "GLM-5.3-Flash", 1_000_000, 0.15, 0.5, 0.03, 128_000, true, true, true, 51),
    e("glm-5.2", "GLM-5.2", 1_000_000, 1.4, 4.4, 0.26, 128_000, false, true, true, 50),
    e("glm-5.1", "GLM-5.1", 200_000, 1.4, 4.4, 0.26, 128_000, false, true, true, 49),
    e("glm-5", "GLM-5", 200_000, 1.0, 3.2, 0.2, 128_000, false, true, true, 48),
    e("glm-5-turbo", "GLM-5-Turbo", 200_000, 1.2, 4.0, 0.24, 128_000, false, true, true, 47),
    e("glm-4.7", "GLM-4.7", 200_000, 0.6, 2.2, 0.11, 128_000, false, true, true, 46),
    e("glm-4.7-flashx", "GLM-4.7-FlashX", 200_000, 0.07, 0.4, 0.01, 128_000, false, true, true, 45),
    e("glm-4.7-flash", "GLM-4.7-Flash", 200_000, 0, 0, null, 128_000, false, true, true, 44),
    e("glm-4.6", "GLM-4.6", 200_000, 0.6, 2.2, 0.11, 128_000, false, true, true, 43),
    e("glm-4.5", "GLM-4.5", 128_000, 0.6, 2.2, 0.11, 96_000, false, true, true, 42),
    e("glm-4.5-air", "GLM-4.5-Air", 128_000, 0.2, 1.1, 0.03, 96_000, false, true, true, 41),
    e("glm-4.5-flash", "GLM-4.5-Flash", 200_000, 0, 0, null, 96_000, false, true, true, 40),
    e("glm-5v-turbo", "GLM-5V-Turbo", 200_000, 1.2, 4.0, 0.24, 16_000, true, true, true, 39),
    e("glm-4.6v", "GLM-4.6V", 128_000, 0.3, 0.9, 0.05, 16_000, true, true, true, 38),
    e("glm-4.5v", "GLM-4.5V", 64_000, 0.6, 1.8, 0.11, 16_000, true, true, true, 37),
    e("glm-4.6v-flash", "GLM-4.6V-Flash", 128_000, 0, 0, null, 16_000, true, true, false, 36),
  ];
}

/** Mirrors `deepseek::static_catalog` (peak-hour prices). */
function deepseekCatalog(): CatalogEntry[] {
  const e = (id: string, name: string, costIn: number, costOut: number, costCacheRead: number, supportsVision: boolean, created: number): CatalogEntry => ({
    id, name, vendor: "deepseek", contextLength: 1_000_000, costIn, costOut, costCacheRead,
    costCacheWrite: null, maxOutput: 384_000, supportsVision, supportsFiles: false,
    supportsAudio: false, supportsTools: true, supportsReasoning: true, created, description: "",
  });
  return [
    e("deepseek-v4-pro", "DeepSeek V4 Pro", 1.32, 3.96, 0.044, false, 2),
    e("deepseek-flash", "DeepSeek V4.1 Flash", 0.3, 1.2, 0.006, true, 1),
  ];
}

/**
 * The reasoning field for one gateway, or null when nothing should be sent.
 *
 * The same table as `Effort` in `src-tauri/src/effort.rs`, and exported so a
 * test can hold the two side by side: OpenRouter's ceiling is `xhigh` rather
 * than `max`, and Z.AI has a switch where the others have a dial.
 */
export function reasoningField(
  provider: GatewayKey,
  effort: Effort | undefined,
  model?: string,
): Record<string, unknown> | null {
  if (provider === "zai" && model && /^glm-5\.[34](-|$)/.test(model)) {
    return { thinking: { type: "enabled" }, reasoning_effort: effort === "max" || effort === "high" ? effort : !effort || effort === "auto" || effort === "medium" ? "medium" : "low" };
  }
  if (!effort || effort === "auto") return null;

  if (provider === "zai") {
    return { thinking: { type: effort === "off" ? "disabled" : "enabled" } };
  }
  if (provider === "deepseek") {
    if (effort === "off") return { thinking: { type: "disabled" } };
    return { reasoning_effort: effort === "medium" ? "high" : effort };
  }
  if (effort === "off") return { reasoning: { enabled: false } };
  return { reasoning: { effort: effort === "max" ? "xhigh" : effort } };
}

/**
 * OpenRouter's throughput routing, or null when nothing should be sent.
 *
 * Same contract as `request.fast` in `src-tauri/src/openrouter.rs` — the
 * `:nitro` shortcut expressed as `provider.sort` so the catalog id stays
 * intact for context metering.
 */
export function fastProviderField(
  provider: GatewayKey,
  fast: boolean | undefined,
): Record<string, unknown> | null {
  if (!fast || provider !== "openrouter") return null;
  return { provider: { sort: "throughput" } };
}

/**
 * OpenRouter's file-parser plugin, or null when nothing should be sent.
 *
 * Same contract as `request.pdf_engine` in `src-tauri/src/openrouter.rs`, down
 * to only declaring the plugin when a message actually attaches a document —
 * see `pdfEngineFor()` in `attachments.ts` for why the engine is never left to
 * OpenRouter's default.
 */
export function filePluginField(
  provider: GatewayKey,
  request: ChatRequest,
): Record<string, unknown> | null {
  if (provider !== "openrouter" || !request.pdfEngine) return null;

  const attachesFile = request.messages.some(
    (message) =>
      Array.isArray(message.content) &&
      message.content.some((part) => part.type === "file"),
  );
  if (!attachesFile) return null;

  return {
    plugins: [{ id: "file-parser", pdf: { engine: request.pdfEngine } }],
  };
}

/** Stop flags for in-flight turns, keyed the same way the Rust registry is. */
const inFlight = new Map<string, AbortController>();

export const webTransport: Transport = {
  kind: "web",

  async credentialStatus(provider) {
    return statusOf(readVault()[provider]);
  },

  async credentialSet(provider, key) {
    const trimmed = key.trim();
    if (!trimmed) throw new Error("key is empty");
    const vault = readVault();
    vault[provider] = trimmed;
    writeVault(vault);
    return statusOf(trimmed);
  },

  async credentialClear(provider) {
    const vault = readVault();
    delete vault[provider];
    writeVault(vault);
    return statusOf(undefined);
  },

  async migrateZaiCodingCredential() {
    const vault = readVault();
    if (!vault["zai-coding"] && vault.zai) {
      vault["zai-coding"] = vault.zai;
      delete vault.zai;
      writeVault(vault);
    }
  },

  async oracleDoc() {
    // docs.oracle.com sends no CORS headers; the web build answers without the dictionary.
    throw new Error("Tables and Views disponível só no desktop.");
  },

  async research(streamId, request) {
    const controller = new AbortController();
    inFlight.set(streamId, controller);
    const timer = setTimeout(() => controller.abort(new Error("Timeout de pesquisa (90s).")), 90000);
    try {
      const { url, body } = researchWire(request);
      const key = requireKey(request.provider);
      const headers: Record<string, string> = request.provider === "gemini" ? { "x-goog-api-key": key } : { Authorization: `Bearer ${key}` };
      const response = await fetch(url, {
        method: "POST", headers: { ...headers, "Content-Type": "application/json" },
        body: JSON.stringify(body), signal: controller.signal,
      });
      if (!response.ok) {
        const retryable = response.status === 429 || [502, 503, 504].includes(response.status);
        throw new Error(`${retryable ? "RETRYABLE: " : ""}Pesquisa retornou HTTP ${response.status}. Verifique chave, modelo e créditos.`);
      }
      return await response.json();
    } finally {
      clearTimeout(timer);
      inFlight.delete(streamId);
    }
  },

  async agentProbe(provider: AgentKey): Promise<AgentProbe> {
    return {
      installed: false,
      path: null,
      version: null,
      loggedIn: false,
      method: null,
      account: null,
      plan: null,
      model: null,
      loginCommand: AGENT_LOGIN[provider],
      problem: NO_AGENTS,
    };
  },

  async catalog(provider): Promise<CatalogEntry[]> {
    refuseAgents(provider);
    if (provider === "zai") return zaiCatalog();
    if (provider === "deepseek") return deepseekCatalog();

    const key = readVault().openrouter;
    const response = await fetch(`${gatewayBase("openrouter")}/models`, {
      headers: key ? { Authorization: `Bearer ${key}` } : {},
    });
    if (!response.ok) throw new Error(await describeFailure(provider, response));
    const body = await response.json();
    if (!Array.isArray(body?.data)) {
      throw new Error("catalog response had no `data` array");
    }
    return body.data
      .map(toOpenRouterEntry)
      .filter((m: CatalogEntry) => m.id);
  },

  async account(provider, opts): Promise<Account> {
    refuseAgents(provider);
    if (provider === "zai") {
      const coding = opts?.zaiPlan === "coding";
      const response = await fetch(`${gatewayBase(provider, opts)}/models`, {
        headers: {
          Authorization: `Bearer ${requireKey(credentialKey(provider, opts?.zaiPlan))}`,
          "Accept-Language": "en-US,en",
        },
      });
      if (response.status === 401 || response.status === 403) {
        throw new Error(await describeFailure(provider, response));
      }
      if (response.status >= 500) {
        throw new Error(await describeFailure(provider, response));
      }
      return {
        label: coding ? "Z.AI Coding Plan" : "Z.AI key",
        usage: 0,
        limit: null,
        isFreeTier: false,
      };
    }

    if (provider === "deepseek") {
      const response = await fetch(`${gatewayBase(provider)}/user/balance`, {
        headers: { Authorization: `Bearer ${requireKey(provider)}` },
      });
      if (!response.ok) throw new Error(await describeFailure(provider, response));
      const info = (await response.json())?.balance_infos?.[0];
      return {
        label: info ? `DeepSeek key · ${info.total_balance} ${info.currency}` : "DeepSeek key",
        usage: 0,
        limit: null,
        isFreeTier: false,
      };
    }

    const response = await fetch(`${gatewayBase("openrouter")}/key`, {
      headers: { Authorization: `Bearer ${requireKey(credentialKey(provider, opts?.zaiPlan))}` },
    });
    if (!response.ok) throw new Error(await describeFailure(provider, response));
    const data = (await response.json())?.data ?? {};
    return {
      label: data.label ?? "OpenRouter key",
      usage: Number(data.usage ?? 0),
      limit: data.limit ?? null,
      isFreeTier: Boolean(data.is_free_tier),
    };
  },

  // OpenRouter only: the rest need the desktop app (CLIs) or a key the
  // browser build has no business sending to a monitoring endpoint.
  async usage(provider) {
    if (provider !== "openrouter") throw new Error("Limites deste provedor só no app desktop.");
    const response = await fetch(`${gatewayBase("openrouter")}/key`, {
      headers: { Authorization: `Bearer ${requireKey("openrouter")}` },
    });
    if (!response.ok) throw new Error(await describeFailure(provider, response));
    return (await response.json())?.data ?? {};
  },

  async chat(provider, streamId, request: ChatRequest, onEvent, opts) {
    if (isAgentKey(provider)) {
      onEvent({ type: "error", message: NO_AGENTS });
      return;
    }

    const controller = new AbortController();
    inFlight.set(streamId, controller);
    const base = gatewayBase(provider, opts);
    const label = gatewayLabel(provider);

    try {
      const headers: Record<string, string> = {
        Authorization: `Bearer ${requireKey(credentialKey(provider, opts?.zaiPlan))}`,
        "Content-Type": "application/json",
      };
      if (provider === "openrouter") {
        headers["HTTP-Referer"] = "https://atimo.app";
        headers["X-Title"] = "Atimo";
      } else {
        headers["Accept-Language"] = "en-US,en";
      }

      const body: Record<string, unknown> = {
        model: request.model,
        messages: request.messages,
        stream: true,
        ...(request.temperature !== undefined && {
          temperature: request.temperature,
        }),
        ...(request.maxTokens !== undefined && {
          max_tokens: request.maxTokens,
        }),
      };
      if (provider === "openrouter" || provider === "deepseek") {
        body.stream_options = { include_usage: true };
      }
      // Mirrors `Effort` in `src-tauri/src/effort.rs`. Kept in step with it by
      // a test, because the two paths are the same request from the user's
      // point of view and a browser-only difference would be invisible.
      const reasoning = reasoningField(provider, request.effort, request.model);
      if (reasoning) Object.assign(body, reasoning);
      const fastRouting = fastProviderField(provider, request.fast);
      if (fastRouting) Object.assign(body, fastRouting);
      const filePlugin = filePluginField(provider, request);
      if (filePlugin) Object.assign(body, filePlugin);

      const response = await fetch(`${base}/chat/completions`, {
        method: "POST",
        signal: controller.signal,
        headers,
        body: JSON.stringify(body),
      });

      if (!response.ok) {
        throw new Error(await describeFailure(provider, response));
      }
      if (!response.body) {
        throw new Error(`${label} devolveu uma resposta vazia`);
      }

      onEvent({ type: "open" });

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let finishReason: string | null = null;

      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        let split = buffer.indexOf("\n\n");
        while (split !== -1) {
          const frame = buffer.slice(0, split);
          buffer = buffer.slice(split + 2);

          for (const line of frame.split("\n")) {
            if (!line.startsWith("data:")) continue;
            const payload = line.slice(5).trim();
            if (!payload || payload === "[DONE]") continue;

            let event: any;
            try {
              event = JSON.parse(payload);
            } catch {
              continue;
            }

            if (event?.error?.message) throw new Error(event.error.message);

            const choice = event?.choices?.[0];
            const reasoning =
              choice?.delta?.reasoning_content ?? choice?.delta?.reasoning;
            if (reasoning) {
              onEvent({ type: "reasoning", text: reasoning });
            }
            if (choice?.delta?.content) {
              onEvent({ type: "delta", text: choice.delta.content });
            }
            if (choice?.finish_reason) finishReason = choice.finish_reason;

            if (event?.usage) {
              onEvent({
                type: "usage",
                promptTokens: Number(event.usage.prompt_tokens ?? 0),
                completionTokens: Number(event.usage.completion_tokens ?? 0),
                cachedPromptTokens: cachedPromptTokens(event.usage),
                cost: event.usage.cost ?? null,
              });
            }
          }

          split = buffer.indexOf("\n\n");
        }
      }

      onEvent({ type: "done", finishReason, cancelled: false });
    } catch (error) {
      if (controller.signal.aborted) {
        onEvent({ type: "done", finishReason: null, cancelled: true });
      } else {
        onEvent({
          type: "error",
          message: error instanceof Error ? error.message : String(error),
        });
      }
    } finally {
      inFlight.delete(streamId);
    }
  },

  cancel(_provider, streamId) {
    inFlight.get(streamId)?.abort();
  },
};
