import { isAgentKey, type ChatRequest, type ProviderKey, type ZaiPlan } from "./adapter/types";
import { saveExport } from "./export-file";
import { useResearchSettings, type UsageCall } from "./research-settings";

export interface CapturedRequest {
  id: string;
  at: string;
  provider: string;
  request: ChatRequest;
}
export interface CaptureFile {
  format: "atimo.eval";
  version: 1;
  requests: CapturedRequest[];
  observedCalls?: UsageCall[];
}

let recording = false;
let requests: CapturedRequest[] = [];

/** Opt-in, memory only: captures contain the actual project text and attachments. */
export function startCapture() {
  requests = [];
  recording = true;
}

export function captureRequest(id: string, provider: ProviderKey, request: ChatRequest, zaiPlan: ZaiPlan) {
  if (!recording || isAgentKey(provider)) return;
  const { model, messages, temperature, maxTokens, effort, fast, pdfEngine } = request;
  requests.push({
    id, at: new Date().toISOString(), provider: provider === "zai" && zaiPlan === "coding" ? "zai-coding" : provider,
    request: structuredClone({ model, messages, temperature, maxTokens, effort, fast, pdfEngine }),
  });
}

export function stopCapture(): CaptureFile {
  recording = false;
  const ids = new Set(requests.map((request) => request.id));
  return structuredClone({ format: "atimo.eval", version: 1, requests, observedCalls: useResearchSettings.getState().calls.filter((call) => ids.has(call.id)) });
}

export async function saveCapture() {
  return saveExport(`atimo-eval-${new Date().toISOString().replace(/[:.]/g, "-")}`, "json", JSON.stringify(stopCapture(), null, 2));
}
