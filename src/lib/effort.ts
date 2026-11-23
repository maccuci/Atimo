/*
 * How hard the model should think.
 *
 * One scale for every provider. The translation into each provider's own
 * spelling lives in Rust (`src-tauri/src/effort.rs`) — the names here are the
 * wire contract with it, and a rename on either side has to be a rename on
 * both.
 *
 * Why a global setting rather than one per chat: this is a latency-versus-depth
 * preference about how the user likes to work, not a property of a
 * conversation, and it is the same shape as `reasoningVisibility` — which is
 * the other "how do I want answers delivered" control and already lives here.
 * A per-chat version would mean a schema migration on every stored chat to
 * carry a value most users set once.
 */

export type Effort = "auto" | "off" | "low" | "medium" | "high" | "max";

export const EFFORTS: readonly Effort[] = [
  "auto",
  "off",
  "low",
  "medium",
  "high",
  "max",
] as const;

export const EFFORT_LABEL: Record<Effort, string> = {
  auto: "Automático",
  off: "Sem raciocínio",
  low: "Baixo",
  medium: "Médio",
  high: "Alto",
  max: "Máximo",
};

/** The one-line explanation each option owes the user. */
export const EFFORT_HINT: Record<Effort, string> = {
  auto: "O provedor escolhe; nenhum nível de raciocínio é enviado.",
  off: "Sem raciocínio. Resposta mais rápida quando o modelo permite.",
  low: "Raciocínio mínimo antes de responder.",
  medium: "Equilibrado: boa profundidade com velocidade moderada.",
  high: "Raciocínio detalhado. Demora mais e usa mais tokens.",
  max: "O máximo de raciocínio que o provedor permite.",
};

const STORAGE_KEY = "atimo.effort.v1";

/**
 * `auto` on purpose. It sends no reasoning field at all, so an install that
 * never touches this control keeps making byte-identical requests to the ones
 * it made before the control existed.
 */
const DEFAULT: Effort = "auto";

function isEffort(value: unknown): value is Effort {
  return (EFFORTS as readonly unknown[]).includes(value);
}

export function readEffort(): Effort {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (isEffort(raw)) return raw;
  } catch {
    /* ignore */
  }
  return DEFAULT;
}

export function writeEffort(value: Effort): void {
  try {
    localStorage.setItem(STORAGE_KEY, value);
  } catch {
    /* ignore quota / private mode */
  }
}

/**
 * What this setting actually does on the selected provider, said plainly.
 *
 * The control stays visible and identically shaped for every provider — one
 * that appeared and disappeared as you switched model would be worse — so the
 * places where a level is a no-op or gets clamped are stated here instead of
 * being silently different.
 */
export function effortCaveat(
  provider: string,
  effort: Effort,
): string | null {
  if (effort === "auto") return null;

  if (["cursor-cli", "gemini-cli", "grok-cli", "kimi-cli", "devin-cli"].includes(provider)) {
    return "A CLI usa o raciocínio configurado na sua conta; este nível não é enviado.";
  }
  if (provider === "zai") {
    return effort === "off"
      ? "O GLM-5.3+ não desliga o raciocínio; usa o nível baixo."
      : "O GLM-5.3+ sempre raciocina: sem/baixo usam baixo; médio, alto e máximo mantêm o nível. Modelos GLM anteriores só ligam ou desligam.";
  }
  if (provider === "deepseek" && effort === "medium") {
    return "O DeepSeek só tem baixo/alto/máximo; médio usa alto.";
  }
  if (provider === "claude-cli" && effort === "off") {
    return "O Claude Code não desliga o raciocínio; envia o nível mais baixo.";
  }
  return null;
}
