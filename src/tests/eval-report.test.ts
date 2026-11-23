import { expect, test } from "bun:test";
import { summarize, type EvalRow } from "../../evals/oracle/report";

const row = (patch: Partial<EvalRow> = {}): EvalRow => ({
  alvo: "deepseek:deepseek-flash", effort: "high", acervo: null, caso: "one", resposta: "Answer", erro: null,
  segundos: 5, colunasInexistentes: [], finishReason: "stop", terminouNormalmente: true,
  respostaCompleta: null, solucaoCorreta: null, chamadas: [{ usage: { prompt_tokens: 100, completion_tokens: 20 } }], ...patch,
});

test("an empty or truncated answer cannot pass the automatic metric or manual grades", () => {
  const stats = summarize([
    row({ resposta: "", respostaCompleta: true, solucaoCorreta: true }),
    row({ finishReason: "length", respostaCompleta: true, solucaoCorreta: true }),
  ]);
  expect(stats).toMatchObject({ terminoNormal: 0, semColunaInexistente: 0, completas: 0, corretas: 0 });
});

test("normal termination leaves completeness and correctness for review", () => {
  expect(summarize([row()])).toMatchObject({ terminoNormal: 1, semColunaInexistente: 1, completas: 0, corretas: 0, revisaoPendente: 1 });
});

test("reviewed solutions are compared alongside tokens and latency", () => {
  expect(summarize([row({ respostaCompleta: true, solucaoCorreta: true }), row({ segundos: 9, respostaCompleta: false, solucaoCorreta: false })]))
    .toMatchObject({ completas: 1, corretas: 1, revisaoPendente: 0, medianaSegundos: 7, mediaTokensEntrada: 100, mediaTokensSaida: 20 });
});

test("cache rates are weighted by measured input tokens and unknown calls stay unknown", () => {
  expect(summarize([
    row({ chamadas: [{ usage: { prompt_tokens: 100, completion_tokens: 20, prompt_tokens_details: { cached_tokens: 80 } } }] }),
    row({ chamadas: [{ usage: { prompt_tokens: 300, completion_tokens: 20, prompt_cache_hit_tokens: 0 } }] }),
    row(),
  ])).toMatchObject({ chamadasComCacheMedido: 2, chamadas: 3, taxaCache: 0.2 });
  expect(summarize([row()]).taxaCache).toBeNull();
});
