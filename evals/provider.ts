// Shared by the eval runners: one endpoint table, one key lookup, one request body,
// so every eval sends exactly what the app sends.
import type { ChatRequest } from "../src/lib/adapter";
import { fastProviderField, filePluginField, reasoningField } from "../src/lib/adapter/web";

export const ENDPOINTS = {
  "zai": { url: "https://api.z.ai/api/paas/v4/chat/completions", env: "ZAI_API_KEY", keychain: "zai" },
  "zai-coding": { url: "https://api.z.ai/api/coding/paas/v4/chat/completions", env: "ZAI_CODING_API_KEY", keychain: "zai-coding" },
  "openrouter": { url: "https://openrouter.ai/api/v1/chat/completions", env: "OPENROUTER_API_KEY", keychain: "openrouter" },
  "deepseek": { url: "https://api.deepseek.com/chat/completions", env: "DEEPSEEK_API_KEY", keychain: "deepseek" },
} as const;
export type Provider = keyof typeof ENDPOINTS;

export function key(provider: Provider) {
  const { env, keychain } = ENDPOINTS[provider];
  const value = process.env[env] ?? Bun.spawnSync(["security", "find-generic-password", "-s", "com.maccuci.atimo", "-a", keychain, "-w"]).stdout.toString().trim();
  if (!value) throw new Error(`sem chave para ${provider}: defina ${env} ou conecte no app`);
  return value;
}

// Use the app's effort mapping so the eval measures the same settings.
export function body(provider: Provider, request: ChatRequest) {
  const out: Record<string, unknown> = { model: request.model, messages: request.messages, stream: false };
  if (request.maxTokens) out.max_tokens = request.maxTokens;
  if (request.temperature !== undefined) out.temperature = request.temperature;
  if (provider === "openrouter") out.usage = { include: true };
  const reasoning = reasoningField(provider === "zai-coding" ? "zai" : provider, request.effort, request.model);
  if (reasoning) Object.assign(out, reasoning);
  const gateway = provider === "zai-coding" ? "zai" : provider;
  Object.assign(out, fastProviderField(gateway, request.fast), filePluginField(gateway, request));
  return out;
}

export async function complete(provider: Provider, request: ChatRequest, signal: AbortSignal) {
  for (let attempt = 0; ; attempt++) {
    const t0 = Date.now();
    const res = await fetch(ENDPOINTS[provider].url, {
      method: "POST", signal: AbortSignal.any([signal, AbortSignal.timeout(600_000)]),
      headers: { Authorization: `Bearer ${key(provider)}`, "Content-Type": "application/json", "Accept-Language": "en-US,en" },
      body: JSON.stringify(body(provider, request)),
    });
    const json = (await res.json().catch(() => ({}))) as any;
    if (res.status === 429 && attempt < 3) { await Bun.sleep(5000 * (attempt + 1)); continue; }
    const message = json.choices?.[0]?.message ?? {};
    return { res, json, message, finishReason: json.choices?.[0]?.finish_reason ?? null, seconds: (Date.now() - t0) / 1000 };
  }
}

export function parseTarget(target: string) {
  const [provider, ...rest] = target.split(":");
  const model = rest.join(":");
  if (!Object.hasOwn(ENDPOINTS, provider ?? "") || !model) throw new Error(`alvo inválido: ${target}`);
  return { target, provider: provider as Provider, model };
}
