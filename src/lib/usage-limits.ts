import { create } from "zustand";
import { adapter, type ProviderKey, type ZaiPlan } from "./adapter";
import { formatCost } from "./utils";

/*
 * Plan limits and balances, one shape for every provider.
 *
 * Each source is the vendor's own sanctioned channel, never a lifted token:
 *   codex-cli   `account/rateLimits/read` over `codex app-server`
 *   claude-cli  `rate_limit_event` in each turn's stream-json (no `claude usage`
 *               exists, so Claude's numbers are "as of the last answer")
 *   openrouter  `GET /api/v1/key` (`/credits` needs a management key: no balance)
 *   zai         Coding Plan quota, via the endpoint Z.AI's own usage plugin calls.
 *               Pay-as-you-go has no balance endpoint.
 *   deepseek    `GET /user/balance`
 * The ACP CLIs (Cursor, Gemini, Grok, Kimi, Devin) expose no usage at all.
 */

export interface UsageRow {
  label: string;
  /** Share of the window still available, 0–100. Null for a plain amount. */
  left: number | null;
  value: string;
  /** Unix ms. */
  resetsAt: number | null;
}

export interface UsageSnapshot {
  /** Finishes the sentence "Fonte de uso: …". */
  source: string;
  rows: UsageRow[];
  /** Unix ms of the reading. */
  at: number;
}

export function supportsUsage(provider: ProviderKey, plan: ZaiPlan): boolean {
  return provider === "zai" ? plan === "coding" : provider in SOURCES;
}

const SOURCES: Partial<Record<ProviderKey, true>> = {
  "claude-cli": true,
  "codex-cli": true,
  openrouter: true,
  deepseek: true,
  zai: true,
};

/** Where the vendor lets the user see or buy more. Only links known to exist. */
export const MANAGE_USAGE: Partial<Record<ProviderKey, string>> = {
  "claude-cli": "https://claude.ai/settings/usage",
  "codex-cli": "https://chatgpt.com/codex/settings/usage",
  "cursor-cli": "https://cursor.com/dashboard",
  openrouter: "https://openrouter.ai/settings/credits",
  deepseek: "https://platform.deepseek.com/usage",
};

/* ---- parsing ------------------------------------------------------------ */

// Provider payloads are untrusted JSON; every field is checked before use.
type Json = Record<string, any>;

const num = (v: unknown): number | null =>
  typeof v === "number" && Number.isFinite(v) ? v : typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v)) ? Number(v) : null;
const clamp = (pct: number) => Math.min(100, Math.max(0, pct));
const secs = (v: unknown) => (num(v) === null ? null : num(v)! * 1000);
const titleCase = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
const plural = (n: number, one: string, many: string) =>
  `${n.toLocaleString("pt-BR", { maximumFractionDigits: 2 })} ${n === 1 ? one : many}`;

export function windowLabel(minutes: number | null): string {
  if (minutes === 300) return "Limite de 5 horas";
  if (minutes === 1440) return "Limite diário";
  if (minutes === 10080) return "Limite semanal";
  if (minutes && minutes >= 40320 && minutes <= 44640) return "Limite mensal";
  if (minutes && minutes % 60 === 0) return `Limite de ${minutes / 60} horas`;
  return minutes ? `Limite de ${minutes} min` : "Limite";
}

function percentRow(label: string, usedPercent: number, resetsAt: number | null): UsageRow {
  const left = clamp(100 - usedPercent);
  return { label, left, value: `${Math.round(left)}% restante`, resetsAt };
}

const planSource = (plan: unknown) =>
  typeof plan === "string" && plan && plan !== "unknown" ? `seu plano ${titleCase(plan)}` : "sua assinatura";

function fromCodex(raw: Json): UsageSnapshot {
  const limits: Json = raw?.rateLimits ?? {};
  const rows: UsageRow[] = [];
  for (const w of [limits.primary, limits.secondary]) {
    if (w && num(w.usedPercent) !== null) {
      rows.push(percentRow(windowLabel(num(w.windowDurationMins)), num(w.usedPercent)!, secs(w.resetsAt)));
    }
  }
  const credits: Json | null = limits.credits ?? null;
  if (credits) {
    rows.push({
      label: "Créditos",
      left: null,
      value: credits.unlimited ? "Ilimitados" : plural(num(credits.balance) ?? 0, "crédito", "créditos"),
      resetsAt: null,
    });
  }
  return { source: planSource(limits.planType), rows, at: Date.now() };
}

const CLAUDE_WINDOWS: Record<string, number> = { five_hour: 300, seven_day: 10080 };

/** `rate_limit_info` from Claude Code's `rate_limit_event`. Utilization is 0–1. */
export function fromClaude(info: unknown, plan: string | null): UsageSnapshot | null {
  const data = (info ?? {}) as Json;
  const rows: UsageRow[] = [];
  const windows: Json | null = data.unifiedWindows && typeof data.unifiedWindows === "object" ? data.unifiedWindows : null;
  for (const [key, minutes] of Object.entries(CLAUDE_WINDOWS)) {
    // Older builds send only the window closest to its limit, at the top level.
    const w: Json | undefined = windows ? windows[key] : data.rateLimitType === key ? data : undefined;
    if (w && num(w.utilization) !== null) {
      rows.push(percentRow(windowLabel(minutes), num(w.utilization)! * 100, secs(w.resetsAt)));
    }
  }
  return rows.length ? { source: planSource(plan), rows, at: Date.now() } : null;
}

const OPENROUTER_RESET: Record<string, string> = {
  daily: "Limite diário da chave",
  weekly: "Limite semanal da chave",
  monthly: "Limite mensal da chave",
};

function fromOpenRouter(d: Json): UsageSnapshot {
  const rows: UsageRow[] = [];
  const limit = num(d.limit);
  const remaining = num(d.limit_remaining);
  if (limit && limit > 0 && remaining !== null) {
    rows.push({
      label: OPENROUTER_RESET[d.limit_reset] ?? "Limite da chave",
      left: clamp((remaining / limit) * 100),
      value: `${formatCost(remaining)} de ${formatCost(limit)}`,
      resetsAt: null,
    });
  }
  // Only worth a row when free models are actually in play.
  const free: Json | null = d.free_model_daily_requests ?? null;
  const freeLimit = num(free?.limit);
  const freeLeft = num(free?.remaining);
  if (freeLimit && freeLeft !== null && (d.is_free_tier || (num(free?.used) ?? 0) > 0)) {
    const midnight = new Date();
    midnight.setUTCHours(24, 0, 0, 0);
    rows.push({
      label: "Modelos grátis hoje",
      left: clamp((freeLeft / freeLimit) * 100),
      value: `${freeLeft} de ${freeLimit}`,
      resetsAt: midnight.getTime(),
    });
  }
  if (num(d.usage_daily) !== null) rows.push({ label: "Gasto hoje", left: null, value: formatCost(num(d.usage_daily)!), resetsAt: null });
  if (num(d.usage_monthly) !== null) rows.push({ label: "Gasto no mês", left: null, value: formatCost(num(d.usage_monthly)!), resetsAt: null });
  return { source: d.is_free_tier ? "chave sem créditos comprados" : "créditos da OpenRouter", rows, at: Date.now() };
}

/** `unit` → minutes per unit, as Z.AI's quota payload counts them. */
const ZAI_UNIT_MINUTES: Record<number, number> = { 1: 1440, 3: 60, 5: 1, 6: 10080 };

function fromZai(d: Json): UsageSnapshot {
  const limits: Json[] = Array.isArray(d?.limits) ? d.limits.filter((l: unknown) => l && typeof l === "object") : [];
  const minutes = (l: Json) => {
    const n = num(l.number);
    const per = ZAI_UNIT_MINUTES[num(l.unit) ?? -1];
    return n && per ? n * per : null;
  };
  // Shortest window first: the 5-hour quota, then the weekly one when the plan has it.
  const rows = limits
    .filter((l) => l.type === "TOKENS_LIMIT" && num(l.percentage) !== null)
    .sort((a, b) => (minutes(a) ?? Infinity) - (minutes(b) ?? Infinity))
    .map((l) => percentRow(windowLabel(minutes(l)), num(l.percentage)!, num(l.nextResetTime)));
  const mcp = limits.find((l) => l.type === "TIME_LIMIT" && num(l.percentage) !== null);
  if (mcp) rows.push(percentRow("Ferramentas MCP no mês", num(mcp.percentage)!, num(mcp.nextResetTime)));
  const plan = [d.planName, d.packageName, d.level].find((p) => typeof p === "string" && p);
  return { source: plan ? `plano ${plan}` : "GLM Coding Plan", rows, at: Date.now() };
}

function fromDeepSeek(b: Json): UsageSnapshot {
  const infos: Json[] = Array.isArray(b?.balance_infos) ? b.balance_infos : [];
  const rows = infos.map((info) => {
    const amount = num(info.total_balance) ?? 0;
    const currency = typeof info.currency === "string" && /^[A-Z]{3}$/.test(info.currency) ? info.currency : "USD";
    return {
      label: infos.length > 1 ? `Saldo em ${currency}` : "Saldo",
      left: null,
      value: amount.toLocaleString("pt-BR", { style: "currency", currency }),
      resetsAt: null,
    };
  });
  return { source: "créditos da DeepSeek", rows, at: Date.now() };
}

export function parseUsage(provider: ProviderKey, raw: unknown): UsageSnapshot {
  const data = (raw ?? {}) as Json;
  switch (provider) {
    case "codex-cli":
      return fromCodex(data);
    case "openrouter":
      return fromOpenRouter(data);
    case "zai":
      return fromZai(data);
    case "deepseek":
      return fromDeepSeek(data);
    default:
      throw new Error(`${provider} não informa uso`);
  }
}

/* ---- reading it --------------------------------------------------------- */

/** A window whose reset has passed is fresh again, whatever the last reading said. */
export function currentLeft(row: UsageRow, now = Date.now()): number | null {
  if (row.left === null) return null;
  return row.resetsAt !== null && row.resetsAt <= now ? 100 : row.left;
}

/** The tightest window: what the sidebar ring draws. */
export function tightestLeft(snapshot: UsageSnapshot | undefined, now = Date.now()): number | null {
  const lefts = (snapshot?.rows ?? []).map((r) => currentLeft(r, now)).filter((v): v is number => v !== null);
  return lefts.length ? Math.min(...lefts) : null;
}

export function resetLabel(at: number, now = Date.now()): string {
  const date = new Date(at);
  const time = date.toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" });
  if (at <= now) return `Renovou às ${time}`;
  const days = Math.round((startOfDay(date) - startOfDay(new Date(now))) / 86_400_000);
  if (days === 0) return `Renova às ${time}`;
  if (days === 1) return `Renova amanhã às ${time}`;
  if (days < 7) return `Renova ${date.toLocaleDateString("pt-BR", { weekday: "long" })} às ${time}`;
  return `Renova em ${date.toLocaleDateString("pt-BR", { day: "numeric", month: "short" })}`;
}

const startOfDay = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();

/* ---- state -------------------------------------------------------------- */

const CACHE_KEY = "atimo.usage.v1";
/** Opening the popover twice in a row should not spawn `codex app-server` twice. */
const FRESH_MS = 30_000;

interface UsageState {
  snapshots: Partial<Record<string, UsageSnapshot>>;
  loading: boolean;
  error: string | null;
}

/** Z.AI's two plans are different accounts as far as limits go. */
export const usageKey = (provider: ProviderKey, plan: ZaiPlan) => (provider === "zai" ? `zai-${plan}` : provider);

function readCache(): UsageState["snapshots"] {
  try {
    return JSON.parse(localStorage.getItem(CACHE_KEY) ?? "{}") ?? {};
  } catch {
    return {};
  }
}

// Persisted so Claude's last reading survives a restart; nothing here is secret.
export const useUsage = create<UsageState>(() => ({ snapshots: readCache(), loading: false, error: null }));

function save(key: string, snapshot: UsageSnapshot) {
  useUsage.setState((s) => ({ snapshots: { ...s.snapshots, [key]: snapshot }, error: null }));
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify(useUsage.getState().snapshots));
  } catch {
    /* private window: the in-memory copy still works */
  }
}

export async function refreshUsage(provider: ProviderKey, plan: ZaiPlan): Promise<void> {
  if (provider === "claude-cli" || !supportsUsage(provider, plan)) return;
  const key = usageKey(provider, plan);
  const last = useUsage.getState().snapshots[key];
  if ((last && Date.now() - last.at < FRESH_MS) || useUsage.getState().loading) return;
  useUsage.setState({ loading: true, error: null });
  try {
    save(key, parseUsage(provider, await adapter.usage(provider, { zaiPlan: plan })));
  } catch (error) {
    useUsage.setState({ error: error instanceof Error ? error.message : String(error) });
  } finally {
    useUsage.setState({ loading: false });
  }
}

/** A turn's stream reported the plan's windows (Claude Code only, today). */
export function recordRateLimits(provider: ProviderKey, info: unknown, plan: string | null) {
  if (provider !== "claude-cli") return;
  const snapshot = fromClaude(info, plan);
  if (snapshot) save(provider, snapshot);
}
