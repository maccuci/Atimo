// IAR review eval: sends an archive to real models exactly as the app builds a
// review turn (reader, review selection, coverage inventory, prompt order), then
// scores each answer against the verified gabarito in casos.ts.
//
//   bun evals/iar/run.ts deepseek:deepseek-flash openrouter:baidu/ernie-5.5-flash-preview:free [--effort=high,max] [--repeticoes=3] [--iar=caminho.iar] [--janela=1000000] [--seco]
//   bun evals/iar/run.ts --respostas=a.md,b.md        # only scores saved answers, no model calls
//
// The archive is client data: keep it in evals/iar/archives/ (ignored by Git) or pass --iar.
import type { ChatRequest } from "../../src/lib/adapter";
import { completionError } from "../../src/lib/completion";
import { readFile, toDocument } from "../../src/lib/documents";
import { EFFORTS } from "../../src/lib/effort";
import { archiveFacts, reviewCoverage, reviewExcerpt, reviewTokens, selectReviewChunks } from "../../src/lib/integration-files";
import { buildMessages } from "../../src/lib/prompt-builder";
import { getModel, registerCatalog, SEED_MODELS } from "../../src/lib/models";
import { estimateTokens } from "../../src/lib/tokens";
import type { ComposedContext } from "../../src/lib/types";
import { complete, parseTarget } from "../provider";
import { casos } from "./casos";
import { score } from "./score";

const args = Bun.argv.slice(2);
const flag = (name: string) => args.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);
const caso = casos.find((c) => c.id === (flag("caso") ?? casos[0]!.id));
if (!caso) throw new Error(`caso inválido; disponíveis: ${casos.map((c) => c.id).join(", ")}`);

const respostas = flag("respostas")?.split(",");
if (respostas) {
  for (const path of respostas) {
    const r = score(await Bun.file(path).text(), caso);
    console.log(`${path}: nota ${r.nota} · acertos ${r.acertos.join(",") || "-"} · faltas ${r.faltas.join(",") || "-"} · erros ${r.erros.join(",") || "-"}`);
  }
  process.exit(0);
}

const targets = args.filter((a) => !a.startsWith("--")).map(parseTarget);
const repeticoes = Number(flag("repeticoes") ?? 1);
const efforts = (flag("effort")?.split(",") ?? ["auto"]) as NonNullable<ChatRequest["effort"]>[];
if (!targets.length || !Number.isSafeInteger(repeticoes) || repeticoes < 1 || efforts.some((e) => !EFFORTS.includes(e))) {
  console.error("uso: bun evals/iar/run.ts <deepseek|openrouter|zai|zai-coding>:<modelo> ... [--effort=high,max] [--repeticoes=3] [--iar=arquivo] [--caso=id] | --respostas=a.md,b.md");
  process.exit(1);
}

// The app sizes a review from the live catalog; outside it an unknown id falls back to a
// 128k placeholder and the archive goes partial. --janela gives the window the app would use.
const janela = flag("janela") ? Number(flag("janela")) : null;
for (const { target, model } of targets) {
  if (!janela && !SEED_MODELS.some((m) => m.id === getModel(model).id)) console.warn(`aviso: janela de ${target} desconhecida fora do app; usando ${getModel(model).contextWindow}. Passe --janela=1000000 para um modelo de 1M.`);
}
registerCatalog(targets.map(({ model }) => ({ ...getModel(model), id: model, ...(janela ? { contextWindow: janela } : {}) })));

const iarPath = flag("iar") ?? `${import.meta.dir}/archives/${caso.arquivo}`;
const bytes = await Bun.file(iarPath).bytes().catch(() => { throw new Error(`IAR não encontrado: ${iarPath} (use --iar=)`); });
const { document, chunks } = toDocument(await readFile(new File([bytes], caso.arquivo)), "eval-iar");

/** The review turn the app sends for `@document(...)`: the archive, nothing retrieved. */
function request(model: string, effort: NonNullable<ChatRequest["effort"]>): { request: ChatRequest; cobertura: string } {
  const selected = selectReviewChunks(chunks, document, reviewTokens(model));
  const review = reviewCoverage(document, selected, archiveFacts(document.id, chunks));
  const excerpt = reviewExcerpt(document, selected, review);
  const context = {
    chunks: [{ id: document.id, stage: "resolve", kind: "document", label: document.name, score: 1, tokens: estimateTokens(excerpt),
      excerpt, review, included: true, required: true }],
    rawTokens: estimateTokens(excerpt), finalTokens: estimateTokens(excerpt), elapsedMs: 0,
  } as ComposedContext;
  const complete = review.coverage.filter((c) => c.coverage === "complete text supplied").length;
  return {
    request: { model, effort, messages: buildMessages({ context, history: [], prompt: caso!.pergunta, projectName: "Eval IAR" }) },
    cobertura: `${complete}/${review.coverage.length} arquivos completos`,
  };
}

if (args.includes("--seco")) {
  for (const { target, model } of targets) {
    const { request: req, cobertura } = request(model, efforts[0]!);
    const tokens = req.messages.reduce((sum, m) => sum + estimateTokens(typeof m.content === "string" ? m.content : JSON.stringify(m.content)), 0);
    console.log(`${target}: orçamento ${reviewTokens(model)} · ${cobertura} · ~${tokens} tokens no pedido`);
  }
  process.exit(0);
}

const resultados = [];
for (const { target, provider, model } of targets) for (const effort of efforts) for (let repeticao = 1; repeticao <= repeticoes; repeticao++) {
  const { request: req, cobertura } = request(model, effort);
  const { res, json, message, seconds, finishReason } = await complete(provider, req, new AbortController().signal)
    .catch((error) => ({ res: { ok: false, status: 0 }, json: { error: String(error) }, message: {} as any, seconds: 0, finishReason: null }));
  const text: string = message.content ?? "";
  const erro = res.ok ? completionError(text, finishReason) : JSON.stringify(json.error ?? json).slice(0, 500);
  const usage = json.usage ?? null;
  const cached = usage?.prompt_tokens_details?.cached_tokens ?? usage?.prompt_cache_hit_tokens ?? null;
  const r = score(text, caso);
  console.log(`${target} effort=${effort} #${repeticao}: ${erro ? `ERRO ${erro.slice(0, 120)}` : `nota ${r.nota}`} · ${seconds.toFixed(0)}s · ${cobertura}` +
    `${usage ? ` · ${usage.prompt_tokens} in${cached != null ? ` (${cached} em cache)` : ""} / ${usage.completion_tokens} out` : ""}` +
    `${r.erros.length ? ` · erros ${r.erros.join(",")}` : ""}`);
  resultados.push({ alvo: target, effort, caso: caso.id, repeticao, cobertura, segundos: seconds, usage, finishReason, erro,
    ...r, resposta: text, raciocinio: message.reasoning_content ?? message.reasoning ?? "" });
}

// Per target and effort: mean grade, and how often each finding was caught — one run is anecdote.
console.log("\nresumo");
const groups = new Map<string, typeof resultados>();
for (const r of resultados.filter((r) => !r.erro)) {
  const group = `${r.alvo} effort=${r.effort}`;
  groups.set(group, [...(groups.get(group) ?? []), r]);
}
for (const [group, rows] of groups) {
  const mean = rows.reduce((sum, r) => sum + r.nota, 0) / rows.length;
  const rate = (id: string) => `${id} ${rows.filter((r) => r.acertos.includes(id)).length}/${rows.length}`;
  console.log(`${group}: nota média ${mean.toFixed(1)} (n=${rows.length}) · ${caso.achados.map((f) => rate(f.id)).join(" · ")}`);
}

const file = `${import.meta.dir}/resultados/${new Date().toISOString().replace(/[:.]/g, "-")}-${caso.id}-${targets.map((t) => t.target.replace(/[^\w.-]+/g, "_")).join("-")}.json`;
await Bun.write(file, JSON.stringify(resultados, null, 2));
console.log(`\n→ ${file}`);
