import { cachedPromptTokens } from "../../src/lib/adapter/usage";

export interface EvalRow {
  alvo: string;
  effort?: string;
  acervo: boolean | null;
  caso: string;
  resposta: string;
  erro: string | null;
  segundos: number;
  colunasInexistentes: string[];
  finishReason?: string | null;
  terminouNormalmente?: boolean;
  respostaCompleta?: boolean | null;
  solucaoCorreta?: boolean | null;
  /** evals/oracle/judge.ts verdict; null when the judge gave none. */
  juiz?: { nota: number; reprova: boolean } | null;
  chamadas: { usage: unknown }[];
}

function judged(rows: EvalRow[]) {
  const verdicts = rows.map((r) => r.juiz).filter((v) => v);
  return verdicts.length ? { media: verdicts.reduce((sum, v) => sum + v!.nota, 0) / verdicts.length, reprova: verdicts.filter((v) => v!.reprova).length, n: verdicts.length } : null;
}

export function summarize(rows: EvalRow[]) {
  const finished = rows.filter((r) => !r.erro && r.resposta.trim() && r.terminouNormalmente === true && r.finishReason === "stop");
  const seconds = rows.map((r) => r.segundos).sort((a, b) => a - b);
  const usage = rows.flatMap((r) => r.chamadas.map((c) => c.usage as Record<string, unknown> | null));
  const tokens = (key: string) => usage.length && usage.every((u) => typeof u?.[key] === "number")
    ? Math.round(usage.reduce((sum, u) => sum + Number(u![key]), 0) / rows.length) : null;
  const measuredCache = usage.filter((u) => typeof u?.prompt_tokens === "number" && cachedPromptTokens(u!) !== null);
  const cacheInput = measuredCache.reduce((sum, u) => sum + Number(u!.prompt_tokens), 0);
  const cacheHits = measuredCache.reduce((sum, u) => sum + cachedPromptTokens(u!)!, 0);
  return {
    total: rows.length,
    erros: rows.filter((r) => r.erro).length,
    terminoNormal: finished.length,
    semColunaInexistente: finished.filter((r) => !r.colunasInexistentes.length).length,
    completas: finished.filter((r) => r.respostaCompleta === true).length,
    corretas: finished.filter((r) => r.respostaCompleta === true && r.solucaoCorreta === true).length,
    revisaoPendente: finished.filter((r) => r.respostaCompleta == null || r.solucaoCorreta == null).length,
    medianaSegundos: seconds.length ? (seconds[Math.floor((seconds.length - 1) / 2)]! + seconds[Math.floor(seconds.length / 2)]!) / 2 : null,
    mediaTokensEntrada: tokens("prompt_tokens"),
    mediaTokensSaida: tokens("completion_tokens"),
    chamadasComCacheMedido: measuredCache.length,
    chamadas: usage.length,
    taxaCache: cacheInput ? cacheHits / cacheInput : null,
    notaJuiz: judged(rows),
  };
}

export function report(rows: EvalRow[]) {
  const groups = new Map<string, EvalRow[]>();
  for (const row of rows) {
    const key = `${row.alvo} · ${row.effort ?? "auto"} · ${row.acervo === null ? "captura" : row.acervo ? "+acervo" : "sem acervo"} · ${row.caso}`;
    const group = groups.get(key) ?? [];
    group.push(row);
    groups.set(key, group);
  }
  for (const [group, runs] of groups) {
    const s = summarize(runs);
    console.log(`${group}: término normal ${s.terminoNormal}/${s.total} · sem coluna inexistente ${s.semColunaInexistente}/${s.total} · completas ${s.completas}/${s.total} · corretas ${s.corretas}/${s.total} · revisão pendente ${s.revisaoPendente} · erros ${s.erros} · mediana ${s.medianaSegundos}s · média tokens ${s.mediaTokensEntrada ?? "?"} in / ${s.mediaTokensSaida ?? "?"} out · cache ${s.taxaCache === null ? "?" : `${(s.taxaCache * 100).toFixed(1)}%`} (${s.chamadasComCacheMedido}/${s.chamadas} chamadas medidas)${s.notaJuiz ? ` · juiz ${s.notaJuiz.media.toFixed(1)} (${s.notaJuiz.n} notas, ${s.notaJuiz.reprova} reprova)` : ""}`);
  }
}

if (import.meta.main) {
  const file = Bun.argv[2];
  if (!file) throw new Error("uso: bun evals/oracle/report.ts resultados/arquivo.json");
  const rows: unknown = await Bun.file(file).json();
  if (!Array.isArray(rows) || rows.some((r) => !r || typeof r.resposta !== "string" || !Array.isArray(r.chamadas) || !Array.isArray(r.colunasInexistentes))) throw new Error("Arquivo de resultados inválido.");
  report(rows);
}
