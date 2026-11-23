// Oracle eval: runs the app's own pipeline (ResearchOrchestrator with "Sem pesquisa", acervo, prompt)
// against real models and saves every answer to resultados/. Grading is manual (gabarito in casos.ts).
//
//   bun evals/oracle/run.ts zai:glm-5.3 openrouter:anthropic/claude-opus-5 [--acervo=on|off|both] [--casos=5-partial,6-contradiction] [--repeticoes=3]
//
// Keys: ZAI_CODING_API_KEY / ZAI_API_KEY / OPENROUTER_API_KEY, otherwise the app's Keychain entry.
// Live pipeline mode omits web research; --capture replays evidence already assembled by the app.
import { adapter, type ChatRequest } from "../../src/lib/adapter";
import { complete, parseTarget, type Provider } from "../provider";
import { buildMessages, contentText } from "../../src/lib/prompt-builder";
import { completionError } from "../../src/lib/completion";
import { EFFORTS } from "../../src/lib/effort";
import { ResearchOrchestrator, VERIFY_REQUEST } from "../../src/lib/research-orchestrator";
import { checkOuterJoins, checkSql, checkSqlRules, resetAcervoCache } from "../../src/lib/oracle-acervo";
import { checkHdl, checkRest, checkRestRules, resetRestCache } from "../../src/lib/oracle-rest";
import type { ComposedContext } from "../../src/lib/types";
import { casos } from "./casos";
import { parseCapture } from "./capture";
import { report } from "./report";
import { judge } from "./judge";

const args = Bun.argv.slice(2);
const flag = (name: string) => args.find((a) => a.startsWith(`--${name}=`))?.split("=")[1];
const targets = args.filter((a) => !a.startsWith("--"));
const acervoModes = ({ on: [true], off: [false], both: [false, true] } as Record<string, boolean[]>)[flag("acervo") ?? "on"];
const only = flag("casos")?.split(",");
const capturePath = flag("capture");
const captured = capturePath ? parseCapture(await Bun.file(capturePath).text()) : null;
if (captured && flag("acervo")) throw new Error("Replay mantém as mensagens capturadas; não use --acervo com --capture.");
// The same model answers the same case differently between runs; one run per case is anecdote.
const repeticoes = Number(flag("repeticoes") ?? 1);
// A/B baseline for the orchestrator's verification and revision: the draft is the final answer.
const semRevisao = args.includes("--sem-revisao");
// Grades each answer against the gabarito after the run (evals/oracle/judge.ts); use another vendor.
const juiz = flag("juiz");
// Effort of the answer call; the suggest call keeps "medium" as in the app.
const efforts = flag("effort")?.split(",") as NonNullable<ChatRequest["effort"]>[] | undefined;
if (!Number.isSafeInteger(repeticoes) || repeticoes < 1 || efforts?.some((e) => !EFFORTS.includes(e))) throw new Error("Repetições ou esforço inválidos.");
if (!targets.length || !acervoModes) {
  console.error("uso: bun evals/oracle/run.ts <zai|zai-coding|openrouter|deepseek>:<modelo> ... [--capture=arquivo.json | --acervo=on|off|both] [--casos=a,b] [--effort=auto,low] [--sem-revisao] [--juiz=<alvo>]");
  process.exit(1);
}

interface Call { purpose: string; status: number; seconds: number; usage: unknown; finishReason: string | null }

const context = {
  chunks: [{ id: "project-brief", stage: "project", kind: "project", label: "Oracle project", score: 1, tokens: 20, included: true,
    excerpt: "Oracle Fusion Cloud. Ambiente de testes interno, dados fictícios." }],
  rawTokens: 20, finalTokens: 20, elapsedMs: 0,
} as unknown as ComposedContext;

// The desktop fetch, without Tauri: same page rule, no redirects.
const oracleDoc = async (page: string) => {
  const rest = /^(rest|erp|sales|faq|faigh|fahcc|fajqa|falqa|faeqa|faibo|fahdl|fin)\//.exec(page)?.[1];
  const guide = /^(faq|faigh|fahcc|fajqa|falqa|faeqa|faibo|fahdl)$/.test(rest ?? "");
  if (guide ? !/^[a-z]+\/(toc\.htm|[a-z0-9-]+\.html)$/.test(page) : !(rest && rest !== "fin" ? /^(rest|erp|sales)\/(toc\.htm|op-[a-z0-9-]+\.html)$/ : /^(fin\/)?(toc\.htm|[a-z0-9_]+-\d+\.html)$/).test(page)) throw new Error(`página inválida: ${page}`);
  const base = { rest: "human-resources/farws/", erp: "financials/26d/farfa/", sales: "sales/faaps/", faq: "human-resources/faqpr/", faigh: "human-resources/faigh/", fahcc: "human-resources/fahcc/", fajqa: "human-resources/fajqa/", falqa: "human-resources/falqa/", faeqa: "human-resources/faeqa/", faibo: "human-resources/faibo/", fahdl: "human-resources/fahdl/", fin: "financials/26d/oedmf/" }[rest ?? ""] ?? "human-resources/oedmh/";
  const res = await fetch(`https://docs.oracle.com/en/cloud/saas/${base}${rest ? page.slice(rest.length + 1) : page}`, { redirect: "manual", signal: AbortSignal.timeout(15_000) });
  if (res.status !== 200) throw new Error(`docs.oracle.com ${page}: HTTP ${res.status}`);
  return res.text();
};

const resultados = [];
const parsedTargets = targets.map(parseTarget);

async function execute(provider: Provider, prepared: ChatRequest, purpose: string, signal: AbortSignal, calls: Call[]) {
  const { res, json, message, seconds, finishReason } = await complete(provider, prepared, signal);
  calls.push({ purpose, status: res.status, seconds, usage: json.usage ?? null, finishReason });
  const text = message.content ?? "";
  const error = res.ok ? completionError(text, finishReason) : JSON.stringify(json.error ?? json).slice(0, 500);
  return { text, reasoning: message.reasoning_content ?? message.reasoning ?? "", error, cancelled: false, finishReason };
}

if (captured) {
  const entries = captured.requests.filter((entry) => !only || only.includes(entry.id));
  if (!entries.length) throw new Error("Nenhuma requisição capturada selecionada.");
  for (const { target, provider, model } of parsedTargets) {
    for (const entry of entries) for (const effort of efforts ?? [entry.request.effort ?? "auto"]) for (let repeticao = 1; repeticao <= repeticoes; repeticao++) {
      const calls: Call[] = [];
      const request = { ...entry.request, model, effort };
      const pergunta = contentText(request.messages.findLast((m) => m.role === "user")!.content);
      const started = Date.now();
      const answer = await execute(provider, request, "answer", new AbortController().signal, calls)
        .catch((error) => ({ text: "", reasoning: "", error: String(error), cancelled: false, finishReason: null }));
      const seconds = (Date.now() - started) / 1000;
      const terminouNormalmente = !answer.error && answer.finishReason === "stop";
      const inexistentes = [...await checkSql(answer.text, oracleDoc), ...await checkRest(answer.text, oracleDoc), ...checkHdl(answer.text)];
      const outerJoin = checkOuterJoins(answer.text);
      console.log(`${target} effort=${effort} captura=${entry.id} #${repeticao}: ${answer.error ?? (terminouNormalmente ? "término normal" : "motivo de término não informado")} · ${seconds.toFixed(1)}s`);
      resultados.push({ alvo: target, effort, acervo: null, caso: entry.id, repeticao, pergunta,
        captura: capturePath, request, gabarito: casos.find((c) => c.pergunta === pergunta)?.gabarito ?? "Revisar a solução contra a pergunta e as evidências capturadas.",
        tabelas: [], colunasInexistentes: inexistentes, outerJoinIncompleto: outerJoin, regrasOracle: [...checkSqlRules(answer.text), ...checkRestRules(answer.text)], segundos: seconds,
        chamadas: calls, resposta: answer.text, erro: answer.error, raciocinio: answer.reasoning,
        finishReason: answer.finishReason, terminouNormalmente, respostaCompleta: terminouNormalmente ? null : false, solucaoCorreta: null,
      });
    }
  }
} else for (const { target, provider, model } of parsedTargets) {
  for (const acervo of acervoModes) {
    adapter.oracleDoc = acervo ? oracleDoc : async () => { throw new Error("acervo desligado"); };
    resetAcervoCache();
    resetRestCache();
    for (const effort of efforts ?? ["auto"]) for (const caso of casos.filter((c) => !only || only.includes(c.id))) for (let repeticao = 1; repeticao <= repeticoes; repeticao++) { // sequential: concurrent calls hit 429
      resetAcervoCache(); // checkSql below fills the cache; without this "sem acervo" would reuse it
      resetRestCache();
      const calls: Call[] = [];
      let tables: string[] = [];
      let rascunho: string | null = null;
      let verificacao: string | null = null;
      const t0 = Date.now();
      const request: ChatRequest = { model, effort, messages: buildMessages({ context, history: [], prompt: caso.pergunta, projectName: "Oracle project" }) };
      const answer = await new ResearchOrchestrator().run({
        question: caso.pergunta, request, prior: [], onStage: () => {}, onResearch: () => {}, revise: !semRevisao,
        execute: async (prepared, purpose, signal) => {
          // "off" must remove all of it: the secured-views rule is static and reaches the answer even offline.
          if (!acervo) {
            if (String(prepared.messages[0]?.content ?? "").startsWith("List up to")) return { text: "", reasoning: "", error: null, cancelled: false, finishReason: null };
            prepared = { ...prepared, messages: prepared.messages.filter((m) => !(typeof m.content === "string" && m.content.startsWith("UNTRUSTED_DICTIONARY_DATA"))) };
          }
          const dictionary = prepared.messages.find((m) => typeof m.content === "string" && m.content.startsWith("UNTRUSTED_DICTIONARY_DATA"));
          if (purpose === "answer" && dictionary) tables = [
            ...((dictionary.content as string).includes("BI Publisher data security (Securing HCM") ? ["SECURED_LIST_VIEWS"] : []),
            ...([["HCM Atom feeds, employee workspace", "ATOM"], ["file-based data import", "FBDI"], ["HCM Data Loader file format", "HDL"]] as const)
              .filter(([marker]) => (dictionary.content as string).includes(marker)).map(([, label]) => label),
            ...[...(dictionary.content as string).matchAll(/^((?:REST [a-z0-9]+)|[A-Z][A-Z0-9_$#]+) — /gm)].map((m) => m[1]!),
          ];
          const result = await execute(provider, prepared, purpose, signal, calls);
          if (purpose === "answer" && rascunho === null) rascunho = result.text;
          if (prepared.messages.at(-1)?.content === VERIFY_REQUEST) verificacao = result.text;
          return result;
        },
      }).catch((error) => ({ text: "", reasoning: "", error: String(error), cancelled: false, finishReason: null }));
      const seconds = Math.round((Date.now() - t0) / 1000);
      // Checked in both modes, so "sem acervo" also shows the invented columns.
      const inexistentes = [...await checkSql(answer.text, oracleDoc), ...await checkRest(answer.text, oracleDoc), ...checkHdl(answer.text)];
      const outerJoin = checkOuterJoins(answer.text);
      const regras = [...checkSqlRules(answer.text), ...checkRestRules(answer.text)];
      // A second answer call is the orchestrator's revision after its own checks flagged the draft.
      const revisado = calls.filter((call) => call.purpose === "answer").length > 1;
      console.log(`${target} effort=${effort} ${acervo ? "+acervo" : "sem acervo"} ${caso.id}${repeticoes > 1 ? ` #${repeticao}` : ""}: ${answer.error ? `ERRO ${answer.error.slice(0, 120)}` : "ok"} · ${seconds}s · ${calls.length} chamadas${revisado ? " (revisada)" : ""} · tabelas ${tables.join(",") || "-"} · colunas inexistentes ${inexistentes.join(",") || "nenhuma"}${outerJoin.length ? ` · (+) incompleto ${outerJoin.join(",")}` : ""}${regras.length ? ` · regras ${regras.length}` : ""}`);
      const terminouNormalmente = !answer.error && answer.finishReason === "stop";
      resultados.push({ alvo: target, effort, acervo, caso: caso.id, repeticao, pergunta: caso.pergunta, gabarito: caso.gabarito, tabelas: tables, colunasInexistentes: inexistentes, outerJoinIncompleto: outerJoin, regrasOracle: regras, semRevisao, revisado, verificacao, rascunho: revisado ? rascunho : null, segundos: seconds, chamadas: calls, resposta: answer.text, erro: answer.error, raciocinio: answer.reasoning,
        finishReason: answer.finishReason, terminouNormalmente, respostaCompleta: terminouNormalmente ? null : false, solucaoCorreta: null });
    }
  }
}

const file = `${import.meta.dir}/resultados/${new Date().toISOString().replace(/[:.]/g, "-")}-${captured ? "capture-" : ""}${targets.map((t) => t.replace(/[^\w.-]+/g, "_")).join("-")}.json`;
if (juiz) await judge(resultados, juiz);
await Bun.write(file, JSON.stringify(resultados, null, 2));

report(resultados);
console.log(`\n→ ${file}`);
