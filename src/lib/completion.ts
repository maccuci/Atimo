/** A token limit can consume the whole response in reasoning, leaving no answer. */
export function completionError(text: string, finishReason: string | null): string | null {
  if (finishReason === "length" || finishReason === "max_tokens") {
    return text.trim()
      ? "Resposta incompleta: o modelo atingiu o limite de tokens. O trecho recebido foi preservado."
      : "O modelo atingiu o limite de tokens sem produzir uma resposta final. O limite também inclui o raciocínio.";
  }
  return text.trim() ? null : "O modelo encerrou a chamada sem produzir uma resposta final.";
}
