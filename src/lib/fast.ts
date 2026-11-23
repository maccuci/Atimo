/*
 * Prefer the fastest provider for the chosen model.
 *
 * On OpenRouter this is `provider.sort: "throughput"` — the same thing as the
 * `:nitro` model suffix. Elsewhere it is a no-op: no other provider Atimo
 * speaks to exposes a comparable routing knob, so the toggle stays visible
 * (same shape on every connection) and the panel says so rather than hiding.
 *
 * Same storage shape as `effort` on purpose: both are latency-versus-depth
 * preferences about how the user likes to work, not properties of a chat.
 */

const STORAGE_KEY = "atimo.fast.v1";
const DEFAULT = false;

export function readFast(): boolean {
  try {
    return localStorage.getItem(STORAGE_KEY) === "1";
  } catch {
    return DEFAULT;
  }
}

export function writeFast(value: boolean): void {
  try {
    localStorage.setItem(STORAGE_KEY, value ? "1" : "0");
  } catch {
    /* ignore quota / private mode */
  }
}

/**
 * What Fast actually does on the selected provider, said plainly.
 *
 * Returns null when the toggle does what the label says.
 */
export function fastCaveat(provider: string): string | null {
  if (provider === "openrouter") return null;
  return "O Fast só funciona no OpenRouter — os outros provedores ignoram esta opção.";
}
