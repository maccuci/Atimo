/*
 * How much of a model's scratchpad the chat shows.
 *
 * The provider always streams the full reasoning when it has any — this only
 * governs what reaches the user's eyes. "summary" is a local extract of the
 * already-streamed text, not a second model call.
 */

export type ReasoningVisibility = "full" | "summary" | "hidden";

export const REASONING_VISIBILITY: readonly ReasoningVisibility[] = [
  "full",
  "summary",
  "hidden",
] as const;

export const REASONING_LABEL: Record<ReasoningVisibility, string> = {
  full: "Completo",
  summary: "Resumo",
  hidden: "Nenhum",
};

const STORAGE_KEY = "atimo.reasoning.v1";
const DEFAULT: ReasoningVisibility = "summary";

/** Cap so a wall of thought never becomes a wall of bullets. */
const MAX_BULLETS = 5;
const MAX_BULLET_CHARS = 140;

export function readReasoningVisibility(): ReasoningVisibility {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw === "full" || raw === "summary" || raw === "hidden") return raw;
  } catch {
    /* ignore */
  }
  return DEFAULT;
}

export function writeReasoningVisibility(value: ReasoningVisibility): void {
  try {
    localStorage.setItem(STORAGE_KEY, value);
  } catch {
    /* ignore quota / private mode */
  }
}

export function nextReasoningVisibility(
  current: ReasoningVisibility,
): ReasoningVisibility {
  const i = REASONING_VISIBILITY.indexOf(current);
  return REASONING_VISIBILITY[(i + 1) % REASONING_VISIBILITY.length]!;
}

/**
 * Pull the load-bearing lines out of a reasoning stream. Prefer the model's
 * own bullets/numbered steps when present; otherwise take the first sentence
 * of each substantial paragraph.
 */
export function summarizeReasoning(text: string): string[] {
  const trimmed = text.trim();
  if (!trimmed) return [];

  const blocks = trimmed
    .split(/\n+/)
    .map((line) => line.trim())
    .filter(Boolean);

  const listed = blocks
    .map((line) => line.match(/^(?:[-*•]|\d+[.)])\s+(.*)$/)?.[1] ?? null)
    .filter((line): line is string => Boolean(line));

  const source = listed.length > 0
    ? listed
    : blocks
        .filter((line) => line.length >= 24)
        .map(firstSentence);

  const bullets: string[] = [];
  const seen = new Set<string>();

  for (const raw of source) {
    if (bullets.length >= MAX_BULLETS) break;
    const cleaned = tidyBullet(raw);
    if (!cleaned) continue;
    const key = cleaned.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    bullets.push(cleaned);
  }

  if (bullets.length === 0) {
    const fallback = tidyBullet(firstSentence(trimmed));
    if (fallback) bullets.push(fallback);
  }

  return bullets;
}

function firstSentence(text: string): string {
  const match = text.match(/^(.+?[.!?])(?:\s|$)/);
  return (match?.[1] ?? text).trim();
}

function tidyBullet(text: string): string {
  const oneLine = text.replace(/\s+/g, " ").trim();
  if (!oneLine) return "";
  if (oneLine.length <= MAX_BULLET_CHARS) return oneLine;
  const cut = oneLine.slice(0, MAX_BULLET_CHARS - 1);
  const at = cut.lastIndexOf(" ");
  return `${(at > 40 ? cut.slice(0, at) : cut).trimEnd()}…`;
}
