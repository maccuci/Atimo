import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";
import type { ReferenceCost } from "./reference-resolver";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(n >= 10_000 ? 0 : 1)}k`;
  return String(n);
}

/** " · 82% em cache" for a footer, or "" when the provider reported no cache figure. */
export function formatCached(usage: { in: number; cached?: number }): string {
  return usage.cached === undefined || usage.in <= 0
    ? ""
    : ` · ${Math.round((Math.min(usage.cached, usage.in) / usage.in) * 100)}% em cache`;
}

/**
 * A fraction of a context window as a percentage. Windows are up to 2M tokens
 * wide, so most single chunks round to 0% — which reads as free rather than
 * small. Below a tenth of a percent it says `<0.1%` instead of lying.
 */
export function formatShare(fraction: number): string {
  const pct = fraction * 100;
  if (pct <= 0) return "0%";
  if (pct < 0.1) return "<0.1%";
  if (pct < 10) return `${pct.toFixed(1)}%`;
  return `${Math.round(pct)}%`;
}

/**
 * One line explaining what a mention costs the current model, for the tooltip
 * behind the compact number. Says where the figure comes from when the entity
 * is injected distilled — otherwise a chat looks suspiciously cheap. Reads the
 * same for one reference or a summed set of them.
 */
export function describeReferenceCost(cost: ReferenceCost): string {
  const head = `~${cost.tokens.toLocaleString()} tokens · ${formatShare(
    cost.share,
  )} da janela de ${formatTokens(cost.model.contextWindow)} do ${cost.model.label}`;

  return cost.fullTokens > cost.tokens
    ? `${head} — resumido de ${cost.fullTokens.toLocaleString()} tokens da fonte`
    : head;
}

export function formatDay(iso: string): string {
  return new Date(iso).toLocaleDateString("pt-BR", {
    month: "short",
    day: "numeric",
  });
}

export function formatTime(iso: string): string {
  return new Date(iso).toLocaleTimeString("pt-BR", {
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function relativeDay(iso: string, from = new Date()): string {
  const days = Math.round(
    (from.getTime() - new Date(iso).getTime()) / 86_400_000,
  );
  if (days <= 0) return "hoje";
  if (days === 1) return "ontem";
  if (days < 30) return `há ${days} dias`;
  return formatDay(iso);
}

/**
 * USD per 1M tokens, at the precision the number actually carries. Sub-dollar
 * models are the majority of the catalog and `$0` for all of them would be
 * worse than useless — it would read as free.
 */
export function formatPrice(usdPerMillion: number): string {
  if (usdPerMillion === 0) return "grátis";
  if (usdPerMillion < 0.01) return `$${usdPerMillion.toFixed(3)}`;
  if (usdPerMillion < 1) return `$${usdPerMillion.toFixed(2)}`;
  if (usdPerMillion < 10) return `$${usdPerMillion.toFixed(2).replace(/\.?0+$/, "")}`;
  return `$${Math.round(usdPerMillion)}`;
}

/** Small USD amounts — a single turn costs fractions of a cent. */
export function formatCost(usd: number): string {
  if (usd === 0) return "$0";
  if (usd < 0.01) return `$${usd.toFixed(4)}`;
  if (usd < 1) return `$${usd.toFixed(3)}`;
  return `$${usd.toFixed(2)}`;
}

export function uid(prefix: string): string {
  return `${prefix}-${Math.random().toString(36).slice(2, 9)}`;
}
