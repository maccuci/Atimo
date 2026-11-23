import type { CaptureFile } from "../../src/lib/eval-capture";
import { EFFORTS } from "../../src/lib/effort";

const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);

function content(value: unknown): boolean {
  if (typeof value === "string") return true;
  return Array.isArray(value) && value.length > 0 && value.every((part) => {
    if (!object(part)) return false;
    if (part.type === "text") return typeof part.text === "string";
    if (part.type === "image_url") return object(part.image_url) && typeof part.image_url.url === "string";
    if (part.type === "file") return object(part.file) && typeof part.file.filename === "string" && typeof part.file.file_data === "string";
    if (part.type === "input_audio") return object(part.input_audio) && typeof part.input_audio.data === "string" && typeof part.input_audio.format === "string";
    return false;
  });
}

/** Reject malformed inputs before spending tokens on a replay. */
export function parseCapture(text: string): CaptureFile {
  const data: unknown = JSON.parse(text);
  if (!object(data) || data.format !== "atimo.eval" || data.version !== 1 || !Array.isArray(data.requests) || !data.requests.length) {
    throw new Error("Captura inválida ou vazia: esperado atimo.eval versão 1.");
  }
  const ids = new Set<string>();
  for (const entry of data.requests) {
    if (!object(entry) || typeof entry.id !== "string" || !entry.id || ids.has(entry.id) || !object(entry.request)) throw new Error("Requisição capturada inválida ou duplicada.");
    ids.add(entry.id);
    const request = entry.request;
    if (typeof request.model !== "string" || !request.model || !Array.isArray(request.messages) || !request.messages.length ||
        !request.messages.every((m) => object(m) && ["system", "user", "assistant"].includes(String(m.role)) && content(m.content)) || request.messages.at(-1).role !== "user") {
      throw new Error(`Mensagens inválidas na captura ${entry.id}.`);
    }
    if ((request.effort !== undefined && !EFFORTS.includes(request.effort as typeof EFFORTS[number])) ||
        (request.maxTokens !== undefined && (!Number.isSafeInteger(request.maxTokens) || Number(request.maxTokens) <= 0)) ||
        (request.temperature !== undefined && (typeof request.temperature !== "number" || !Number.isFinite(request.temperature))) ||
        (request.fast !== undefined && typeof request.fast !== "boolean") ||
        (request.pdfEngine !== undefined && !["native", "pdf-text", "mistral-ocr"].includes(String(request.pdfEngine)))) {
      throw new Error(`Configuração inválida na captura ${entry.id}.`);
    }
  }
  return data as unknown as CaptureFile;
}
