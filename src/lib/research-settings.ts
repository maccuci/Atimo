import { create } from "zustand";
import { persist } from "zustand/middleware";
import type { ResearchMode, ResearchProvider } from "./research-provider";
import { uid } from "./utils";

export interface UsageCall {
  id: string;
  at: string;
  provider: string;
  model: string;
  purpose: "answer" | "planning" | "research";
  inputTokens: number | null;
  outputTokens: number | null;
  finishReason?: string | null;
  /** Absent on older calls or when the provider does not report cache usage. */
  cachedInputTokens?: number | null;
  searches: number | null;
  costUsd: number | null;
  estimated: boolean;
  status: "pending" | "done" | "error" | "cancelled";
}
interface ResearchSettings {
  mode: ResearchMode;
  provider: ResearchProvider;
  geminiModel: string;
  openrouterModel: string;
  externalConsent: boolean;
  monthlyBudget: number | null;
  calls: UsageCall[];
  configure: (patch: Partial<Omit<ResearchSettings, "configure" | "calls">>) => void;
}
// v2 (2026-11-12): web research off for everyone once. The local Oracle acervo (Tables and Views, REST,
// FAQs and guides) answered the Person Number regressions without it; it stays available in the controls.
export const migrateResearchSettings = (saved: unknown, version: number) =>
  (version < 2 ? { ...(saved as object), mode: "off" } : saved) as ResearchSettings;

export const useResearchSettings = create<ResearchSettings>()(persist((set) => ({
  mode: "off",
  provider: "gemini",
  geminiModel: "gemini-3.5-flash-lite",
  openrouterModel: "google/gemini-3.5-flash-lite",
  externalConsent: false,
  monthlyBudget: null,
  calls: [],
  configure: (patch) => set(patch),
}), {
  name: "atimo.research.v1",
  version: 2,
  migrate: migrateResearchSettings,
}));

export function monthlyUsage(calls = useResearchSettings.getState().calls, now = new Date()) {
  const month = now.toISOString().slice(0, 7);
  const current = calls.filter((call) => call.at.startsWith(month));
  const measured = current.filter((call) => call.inputTokens !== null && call.cachedInputTokens != null);
  const cacheInput = measured.reduce((sum, call) => sum + call.inputTokens!, 0);
  const cacheHits = measured.reduce((sum, call) => sum + call.cachedInputTokens!, 0);
  return {
    calls: current,
    spent: current.reduce((sum, call) => sum + (call.costUsd ?? 0), 0),
    unknown: current.filter((call) => call.costUsd === null).length,
    cache: { measuredCalls: measured.length, inputTokens: cacheInput, cachedTokens: cacheHits, hitRate: cacheInput ? cacheHits / cacheInput : null },
  };
}

/** Reserve before awaiting the API so simultaneous panel calls cannot spend the same balance. */
export function reserveCall(args: Pick<UsageCall, "provider" | "model" | "purpose">, ceiling: number | null): string {
  const { monthlyBudget, calls } = useResearchSettings.getState();
  if (ceiling !== null && (!Number.isFinite(ceiling) || ceiling < 0)) throw new Error("Estimativa de custo inválida.");
  const { spent } = monthlyUsage(calls);
  if (ceiling !== 0 && monthlyBudget !== null && (spent >= monthlyBudget || (ceiling !== null && spent + ceiling > monthlyBudget))) {
    throw new Error("Orçamento mensal insuficiente. Ajuste o limite nas configurações de pesquisa.");
  }
  const call: UsageCall = {
    ...args, id: uid("call"), at: new Date().toISOString(), inputTokens: null, outputTokens: null,
    searches: null, costUsd: ceiling, estimated: true, status: "pending",
  };
  useResearchSettings.setState({ calls: [...calls, call] });
  return call.id;
}

export function settleCall(id: string, patch: Partial<Pick<UsageCall, "inputTokens" | "outputTokens" | "finishReason" | "cachedInputTokens" | "searches" | "costUsd" | "estimated" | "status">>) {
  useResearchSettings.setState((s) => ({ calls: s.calls.map((call) => call.id === id ? { ...call, ...patch } : call) }));
}
