// Automatic grading of eval answers against each case's gabarito.
//   bun evals/oracle/judge.ts <juiz> resultados/arquivo.json [mais.json ...]
// The verdict goes in `juiz`; respostaCompleta/solucaoCorreta stay for the human review. Use a judge from
// another vendor than the graded model: knowledge conflicts bias a model judging its own family's answers
// (Sun, Bai and Dredze, "Task Matters", arXiv 2506.06485). Check a sample of verdicts by hand.
import { complete, parseTarget, type Provider } from "../provider";
import { report, type EvalRow } from "./report";

export interface Verdict {
  alvo: string;
  nota: number;
  reprova: boolean;
  respostaCompleta: boolean;
  solucaoCorreta: boolean;
  justificativa: string;
}

export const JUDGE_PROMPT = `You grade an answer from an Oracle Fusion assistant against an expert answer key (gabarito). The key lists weighted items as "(n) ..." and failing conditions after "Reprova". Grade only what the key asks; do not reward length, extra sections or caveats, and do not penalize a correct point worded differently. An identifier or endpoint the key calls wrong counts against the item it belongs to even when hedged.
Score: with weights, the sum of points earned (partial credit allowed) scaled to 0-10; without weights, 0-10 by how many key points the answer meets. Any "Reprova" condition caps the score at 3 ("máx. N" in the key overrides 3).
Return ONLY a JSON object: {"nota": number, "reprova": boolean, "respostaCompleta": boolean, "solucaoCorreta": boolean, "justificativa": "one or two sentences in Portuguese naming the points lost"}. respostaCompleta: it answers everything asked. solucaoCorreta: no failing condition and the main recommendation matches the key.`;

/** The judge's JSON, from the last {...} in the reply; null when it is missing or malformed. */
export function parseVerdict(text: string, alvo: string): Verdict | null {
  // The object that ends the reply: try each "{" from the right until one parses.
  const end = text.lastIndexOf("}") + 1;
  let v: Record<string, unknown> | null = null;
  for (let at = text.lastIndexOf("{", end); at >= 0 && !v; at = text.lastIndexOf("{", at - 1)) {
    try { v = JSON.parse(text.slice(at, end)); } catch { /* a nested or earlier brace; keep looking */ }
  }
  if (!v || typeof v.nota !== "number" || v.nota < 0 || v.nota > 10 || typeof v.reprova !== "boolean"
    || typeof v.respostaCompleta !== "boolean" || typeof v.solucaoCorreta !== "boolean") return null;
  return { alvo, nota: v.nota as number, reprova: v.reprova as boolean, respostaCompleta: v.respostaCompleta as boolean,
    solucaoCorreta: v.solucaoCorreta as boolean, justificativa: String(v.justificativa ?? "") };
}

type Gradable = EvalRow & { pergunta: string; gabarito: string; juiz?: Verdict | null };

/** Grades each answered row in place, sequentially (concurrent calls hit 429). */
export async function judge(rows: Gradable[], target: string) {
  const { provider, model } = parseTarget(target);
  const graded = new Set(rows.map((r) => r.alvo.split(":")[0]));
  if (graded.has(provider) || (provider.startsWith("zai") && [...graded].some((p) => p.startsWith("zai")))) {
    console.warn(`aviso: o juiz ${target} é do mesmo fornecedor de um modelo avaliado; o veredito tende a ser enviesado.`);
  }
  for (const row of rows) {
    if (row.erro || !row.resposta.trim()) { row.juiz = null; continue; }
    const { message } = await complete(provider as Provider, { model, messages: [
      { role: "system", content: JUDGE_PROMPT },
      { role: "user", content: `<pergunta>\n${row.pergunta}\n</pergunta>\n<gabarito>\n${row.gabarito}\n</gabarito>\n<resposta>\n${row.resposta}\n</resposta>` },
    ] }, new AbortController().signal).catch(() => ({ message: { content: "" } }));
    row.juiz = parseVerdict(message.content ?? "", target);
    console.log(`juiz ${row.alvo} ${row.caso}: ${row.juiz ? `${row.juiz.nota}${row.juiz.reprova ? " (reprova)" : ""} · ${row.juiz.justificativa}` : "sem veredito"}`);
  }
}

if (import.meta.main) {
  const [target, ...files] = Bun.argv.slice(2);
  if (!target || !files.length) throw new Error("uso: bun evals/oracle/judge.ts <juiz> resultados/arquivo.json ...");
  for (const file of files) {
    const rows: Gradable[] = await Bun.file(file).json();
    await judge(rows, target);
    await Bun.write(file, JSON.stringify(rows, null, 2));
    report(rows);
  }
}
