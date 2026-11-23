import { useStore } from "../lib/store";
import { toModel } from "../lib/catalog";
import { registerCatalog } from "../lib/models";
import { buildExport, toJson, toMarkdown } from "../lib/export";
import { parseImport } from "../lib/import";
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { adapter, credentialKey, type ChatRequest } from "../lib/adapter";
import { reasoningField, webTransport } from "../lib/adapter/web";
import { ResearchOrchestrator, VERIFY_REQUEST, needsVerification, verifiedProblems, assertPublicQuery, cachedResearch, stopResearch, researchContext, type ResearchRecord } from "../lib/research-orchestrator";
import { RESEARCH_BRIEF, normalizeResearch, researchWire, sourceUrl, type ResearchRequest } from "../lib/research-provider";
import { migrateResearchSettings, monthlyUsage, reserveCall, settleCall, useResearchSettings } from "../lib/research-settings";
import { sqlTokens } from "../lib/sql-highlight";
import { inline } from "../components/ui/Markdown";
import { selectHistory } from "../lib/prompt-builder";
import { startCapture, stopCapture } from "../lib/eval-capture";
import { resetAcervoCache } from "../lib/oracle-acervo";

const request: ResearchRequest = { provider: "gemini", model: "gemini-3.5-flash-lite", query: "Oracle HCM 26C" };
const response = (official = true) => ({
  candidates: [{ content: { parts: [{ text: "Evidence for Oracle release 26C. https://invented.example/page" }] },
    groundingMetadata: {
      groundingChunks: [{ web: { title: "HCM 26C", uri: official ? "https://docs.oracle.com/en/cloud/saas/human-resources/26c/" : "https://community.oracle.com/test" } }],
      groundingSupports: [{ segment: { text: "Confirmed excerpt 26C" }, groundingChunkIndices: [0] }],
      webSearchQueries: ["site:docs.oracle.com HCM 26C"],
    },
  }], usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 50, thoughtsTokenCount: 20 },
});
const chat: ChatRequest = { model: "glm-5.3", messages: [{ role: "system", content: "secret project document: client-only" }, { role: "user", content: "Oracle HCM 26C" }] };
const originalResearch = adapter.research;
let localStorageBackup: typeof globalThis.localStorage;

beforeEach(() => {
  resetAcervoCache();
  localStorageBackup = globalThis.localStorage;
  const entries = new Map<string, string>();
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: {
    getItem: (k: string) => entries.get(k) ?? null,
    setItem: (k: string, v: string) => { entries.set(k, v); }, removeItem: (k: string) => entries.delete(k),
  } });
  useResearchSettings.setState({ mode: "off", provider: "gemini", externalConsent: true, geminiModel: request.model, monthlyBudget: null, calls: [] });
});
afterEach(() => {
  resetAcervoCache();
  adapter.research = originalResearch;
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: localStorageBackup });
});

function run(execute = mock(async (_request: ChatRequest, _purpose: "answer" | "planning", _signal: AbortSignal) => ({ text: "Final answer", error: null, cancelled: false })), prior: ResearchRecord[] = []) {
  const records: ResearchRecord[] = [];
  const stages: string[] = [];
  return { execute, records, stages, result: new ResearchOrchestrator().run({ question: request.query, request: chat, prior, execute,
    onStage: (stage) => stages.push(stage), onResearch: (record) => records.push(record) }) };
}

describe("provider boundaries", () => {
  test("desktop and browser send the same focused research instructions to both providers", async () => {
    const rust = await readFile(new URL("../../src-tauri/src/research.rs", import.meta.url), "utf8");
    expect(rust.match(/const BRIEF: &str = r#"([\s\S]*?)"#;/)?.[1]).toBe(RESEARCH_BRIEF);
    expect(researchWire(request).body).toHaveProperty("systemInstruction.parts.0.text", RESEARCH_BRIEF);
    expect(researchWire({ ...request, provider: "openrouter", model: "google/gemini-3.5-flash-lite" }).body).toHaveProperty("messages.0.content", RESEARCH_BRIEF);
    expect(RESEARCH_BRIEF).toContain("investigate related resources in the same Fusion product");
    expect(RESEARCH_BRIEF).toContain("read official FAQs, functional guides and relevant Oracle notes");
    expect(RESEARCH_BRIEF).toContain("target the uncertainty that changes the recommendation");
  });
  test("Gemini enables Google grounding; OpenRouter limits Exa to five results", () => {
    expect(researchWire(request).body).toHaveProperty("tools", [{ google_search: {} }, { url_context: {} }]);
    expect(researchWire({ ...request, provider: "openrouter", model: "google/gemini-3.5-flash-lite" }).body).toHaveProperty("plugins", [{ id: "web", engine: "exa", max_results: 5, search_prompt: "Prioritize docs.oracle.com and identify the Oracle Fusion release." }]);
    expect(() => researchWire({ ...request, model: "x?api_key=secret" })).toThrow();
  });
  test("sources come only from citation metadata, with excerpts and versions", () => {
    const result = normalizeResearch(request, response());
    expect(result.sources).toHaveLength(1);
    expect(result.sources[0]).toMatchObject({ official: true, version: "26C", snippet: "Confirmed excerpt 26C", verification: "provider-reported" });
    expect(result.completionTokens).toBe(70);
    expect(result.sources.some((s) => s.url.includes("invented"))).toBe(false);
  });
  test("passes original page text to the answer model separately from the generated researcher summary", () => {
    const raw = response();
    Object.assign(raw.candidates[0]!.groundingMetadata.groundingChunks[0]!.web, {
      atimoDocument: { excerpt: "Column EXPENSE_CHECK_ADDRESS; dictionary lookup HOME_OFFICE", truncated: false },
      atimoDocumentStatus: "read", atimoLinkChecked: true,
    });
    const result = normalizeResearch(request, raw);
    expect(result.sources[0]?.document).toEqual({ excerpt: "Column EXPENSE_CHECK_ADDRESS; dictionary lookup HOME_OFFICE", truncated: false });
    const prepared = researchContext({ question: request.query, results: [result] });
    expect(prepared).toContain("EXPENSE_CHECK_ADDRESS");
    expect(prepared).toContain("actual page text read by Atimo");
    expect(result.sources[0]?.snippet).toBe("Confirmed excerpt 26C");
  });
  test("URL context records a successful page read without pretending its summary is original page text", () => {
    const raw = response();
    const uri = raw.candidates[0]!.groundingMetadata.groundingChunks[0]!.web.uri;
    Object.assign(raw.candidates[0]!, { urlContextMetadata: { urlMetadata: [
      { retrievedUrl: uri, urlRetrievalStatus: "URL_RETRIEVAL_STATUS_SUCCESS" },
      { retrievedUrl: "https://docs.oracle.com/failed", urlRetrievalStatus: "URL_RETRIEVAL_STATUS_ERROR" },
    ] } });
    const result = normalizeResearch(request, raw);
    expect(result.sources[0]?.providerRead).toBe(true);
    expect(result.sources[0]?.document).toBeUndefined();
    expect(result.sources.some((source) => source.url.endsWith("/failed"))).toBe(false);
  });
  test("URL-context tool input tokens are included in usage and cost estimation", () => {
    const raw = response();
    Object.assign(raw.usageMetadata, { toolUsePromptTokenCount: 1000 });
    expect(normalizeResearch(request, raw).promptTokens).toBe(1100);
  });
  test("malformed page-read metadata cannot mark every citation read", () => {
    const raw = response();
    Object.assign(raw.candidates[0]!, { urlContextMetadata: { urlMetadata: [{ urlRetrievalStatus: "URL_RETRIEVAL_STATUS_SUCCESS" }] } });
    expect(normalizeResearch(request, raw).sources[0]?.providerRead).toBeUndefined();
  });
  test("normalizes OpenRouter annotations without inventing query counts", () => {
    const result = normalizeResearch({ ...request, provider: "openrouter" }, {
      choices: [{ message: { content: "Evidence", annotations: [{ type: "url_citation", url_citation: { title: "ERP 26D", url: "https://docs.oracle.com/erp", content: "ERP excerpt" } }] } }],
      usage: { prompt_tokens: 25, completion_tokens: 10, cost: 0.002 },
    });
    expect(result.sources[0]?.snippet).toBe("ERP excerpt");
    expect(result.costUsd).toBe(0.002);
    expect(result.queries).toEqual([]);
  });
  test("rejects unsafe links and lookalike Oracle domains", () => {
    for (const url of ["javascript:alert(1)", "file:///etc/passwd", "https://127.0.0.1/", "https://user:pass@docs.oracle.com/", "https://secret.internal/", "https://[::1]/"]) expect(sourceUrl(url)).toBeNull();
    const raw = response(); raw.candidates[0]!.groundingMetadata.groundingChunks[0]!.web.uri = "https://docs.oracle.com.evil.example/a";
    expect(normalizeResearch(request, raw).sources[0]?.official).toBe(false);
  });
  test("empty or blocked responses fail clearly", () => { expect(() => normalizeResearch(request, { candidates: [] })).toThrow("não retornou conteúdo"); });
  test("recognizable credentials cannot enter the research provider", () => {
    for (const query of ["senha=production", "Authorization: Bearer abc", "sk-123456789012345", "-----BEGIN RSA PRIVATE KEY-----"]) expect(() => assertPublicQuery(query)).toThrow("credenciais");
  });
  test("Z.ai credentials and GLM-5.3 reasoning stay independent of older GLM", async () => {
    await webTransport.credentialSet(credentialKey("zai", "general"), "general-1234");
    await webTransport.credentialSet(credentialKey("zai", "coding"), "coding-5678");
    expect((await webTransport.credentialStatus("zai")).hint).toBe("1234");
    await webTransport.credentialClear("zai-coding");
    expect((await webTransport.credentialStatus("zai")).present).toBe(true);
    expect(reasoningField("zai", "off", "glm-5.3")).toEqual({ thinking: { type: "enabled" }, reasoning_effort: "low" });
    expect(reasoningField("zai", "high", "glm-5.3")).toHaveProperty("reasoning_effort", "high");
    expect(reasoningField("zai", "off", "glm-5.4")).toEqual({ thinking: { type: "enabled" }, reasoning_effort: "low" });
    expect(reasoningField("zai", "off", "glm-4.7")).toEqual({ thinking: { type: "disabled" } });
    expect((await webTransport.catalog("zai")).some((m) => m.id === "glm-5.3")).toBe(true);
  });
});

describe("ResearchOrchestrator", () => {
  const draft = "```sql\nSELECT 1 FROM per_assignment_supervisors_f sup WHERE sup.primary_flag = 'Y'\n```";
  const fixed = "```sql\nSELECT 1 FROM per_assignment_supervisors_f sup WHERE sup.manager_type = 'LINE_MANAGER'\n```";
  test.each([
    { revision: { text: fixed, error: null, cancelled: false }, final: fixed, rules: undefined },
    { revision: { text: "", error: "429", cancelled: false }, final: draft, rules: 1 },
    { revision: { text: "partial", error: null, cancelled: true }, final: draft, rules: 1 },
  ])("a flagged answer is revised once with the checks, and a failed revision keeps the draft: %#", async ({ revision, final, rules }) => {
    const originalDoc = adapter.oracleDoc;
    adapter.oracleDoc = async () => { throw new Error("offline"); };
    try {
      const answers: ChatRequest[] = [];
      const execute = mock(async (outgoing: ChatRequest, purpose: "answer" | "planning") => {
        if (purpose === "planning") return { text: "", error: null, cancelled: false };
        answers.push(outgoing);
        return answers.length === 1 ? { text: draft, error: null, cancelled: false } : revision;
      });
      const trial = run(execute as unknown as Parameters<typeof run>[0]); // revisions may carry an error
      expect((await trial.result).text).toBe(final);
      expect(answers).toHaveLength(2);
      expect(answers[1]!.messages.at(-2)).toEqual({ role: "assistant", content: draft });
      expect(String(answers[1]!.messages.at(-1)!.content)).toContain("MANAGER_TYPE = 'LINE_MANAGER'");
      expect(trial.stages).toContain("Corrigindo a resposta");
      expect(trial.records.at(-1)?.dictionary?.rules?.length).toBe(rules);
    } finally { adapter.oracleDoc = originalDoc; }
  });
  test.each([
    { verdict: "OK", revised: false },
    { verdict: "- \"resourceUsers não cria pessoa\" contradicts the user's statement \"cria pessoas pelo POST resourceUsers\" without a source", revised: true },
  ])("a restrictive answer is verified against the evidence and the user's facts: %#", async ({ verdict, revised }) => {
    useResearchSettings.setState({ mode: "deep" });
    adapter.research = mock(async () => response());
    const draft = "O PersonNumber é read-only e o resourceUsers não cria pessoa.";
    const outgoing: [ChatRequest, string][] = [];
    const execute = mock(async (sent: ChatRequest, purpose: "answer" | "planning") => {
      outgoing.push([sent, purpose]);
      const last = String(sent.messages.at(-1)?.content);
      if (last === VERIFY_REQUEST) return { text: verdict, error: null, cancelled: false };
      if (purpose === "planning") return { text: "", error: null, cancelled: false };
      return { text: last.startsWith("Checks of your answer") ? "Revised" : draft, error: null, cancelled: false };
    });
    const trial = run(execute);
    expect((await trial.result).text).toBe(revised ? "Revised" : draft);
    const verify = outgoing.find(([sent]) => sent.messages.at(-1)?.content === VERIFY_REQUEST)!;
    expect(verify[1]).toBe("planning");
    expect(verify[0].messages.at(-2)).toEqual({ role: "assistant", content: draft });
    expect(trial.stages).toContain("Verificando a resposta");
    const revision = outgoing.filter(([, purpose]) => purpose === "answer")[1];
    expect(Boolean(revision)).toBe(revised);
    if (revision) {
      expect(String(revision[0].messages.at(-1)!.content)).toContain("- Claim: \"resourceUsers não cria pessoa\"");
      expect(String(revision[0].messages.at(-1)!.content)).toContain("Treat facts the user stated as true");
    }
  });
  test("outside deep research a restrictive answer is not verified", async () => {
    const execute = mock(async (_sent: ChatRequest, purpose: "answer" | "planning") => ({ text: purpose === "answer" ? "O endpoint não permite PersonNumber." : "", error: null, cancelled: false }));
    await run(execute).result;
    expect(execute.mock.calls.some((call) => call[0].messages.at(-1)?.content === VERIFY_REQUEST)).toBe(false);
  });
  test("only restrictive answers are verified", () => {
    expect(needsVerification("O endpoint não permite PersonNumber.")).toBe(true);
    expect(needsVerification("PersonNumber is read-only in this POST.")).toBe(true);
    expect(needsVerification("Use POST workers com PersonNumber.")).toBe(false);
    expect(verifiedProblems("OK")).toEqual([]);
    expect(verifiedProblems("Thinking...\n- a\n-   \n- b")).toEqual(["a", "b"]);
  });
  test("revise: false skips verification and revision but still shows the checks", async () => {
    const draft = "```sql\nSELECT 1 FROM per_assignment_supervisors_f sup\n```\nO resourceUsers não cria pessoa.";
    const execute = mock(async (_sent: ChatRequest, purpose: "answer" | "planning") => ({ text: purpose === "answer" ? draft : "", error: null, cancelled: false }));
    const records: ResearchRecord[] = [];
    const answer = await new ResearchOrchestrator().run({ question: request.query, request: chat, prior: [], execute, revise: false, onStage: () => {}, onResearch: (record) => records.push(record) });
    expect(answer.text).toBe(draft);
    expect(execute.mock.calls.filter((call) => call[1] === "answer")).toHaveLength(1);
    expect(execute.mock.calls.some((call) => call[0].messages.at(-1)?.content === VERIFY_REQUEST)).toBe(false);
    expect(records.at(-1)?.dictionary?.rules?.length).toBe(1);
  });
  test("a clean answer is not revised", async () => {
    const trial = run();
    await trial.result;
    expect(trial.execute.mock.calls.filter((call) => call[1] === "answer")).toHaveLength(1);
    expect(trial.stages).not.toContain("Corrigindo a resposta");
  });

  test("off calls only the main model and never a search provider", async () => {
    adapter.research = mock(async () => { throw new Error("must not search"); });
    const trial = run(); await trial.result;
    expect(trial.execute).toHaveBeenCalledTimes(1);
    expect(adapter.research).not.toHaveBeenCalled();
  });
  test("automatic DIRECT skips search", async () => {
    useResearchSettings.setState({ mode: "auto" });
    adapter.research = mock(async () => response());
    const execute = mock(async (_r: ChatRequest, purpose: "planning" | "answer", _s: AbortSignal) => ({ text: purpose === "planning" ? "DIRECT" : "Answer", error: null, cancelled: false }));
    const trial = run(execute); await trial.result;
    expect(execute).toHaveBeenCalledTimes(2); expect(adapter.research).not.toHaveBeenCalled();
  });
  test("automatic tolerates a malformed planner verdict", async () => {
    useResearchSettings.setState({ mode: "auto" });
    adapter.research = mock(async () => response());
    for (const [verdict, searches] of [["Prezados, a carga do HDL apresentou erro novamente.", 0], ["SEARCH.", 1], ["**DIRECT**", 0]] as const) {
      (adapter.research as ReturnType<typeof mock>).mockClear();
      const execute = mock(async (_r: ChatRequest, purpose: "planning" | "answer", _s: AbortSignal) => ({ text: purpose === "planning" ? verdict : "Answer", error: null, cancelled: false }));
      const trial = run(execute); expect((await trial.result).text).toBe("Answer");
      expect(adapter.research).toHaveBeenCalledTimes(searches);
    }
  });
  test("automatic SEARCH passes cited research to the main model without exporting project documents", async () => {
    useResearchSettings.setState({ mode: "auto" });
    adapter.research = mock(async (_id, query) => { expect(query.query).not.toContain("client-only"); return response(); });
    const execute = mock(async (r: ChatRequest, purpose: "planning" | "answer", _s: AbortSignal) => {
      if (purpose === "answer") expect(JSON.stringify(r.messages)).toContain("UNTRUSTED_RESEARCH_DATA");
      return { text: purpose === "planning" ? "SEARCH" : "Grounded answer", error: null, cancelled: false };
    });
    const trial = run(execute); expect((await trial.result).text).toBe("Grounded answer");
    expect(adapter.research).toHaveBeenCalledTimes(1);
    expect(trial.records[0]?.results[0]?.sources[0]?.official).toBe(true);
    expect(monthlyUsage().calls[0]).toMatchObject({ purpose: "research", inputTokens: 100, outputTokens: 70, searches: 1, status: "done" });
  });
  test("deep research asks the main model to assess sufficiency and complements missing evidence", async () => {
    useResearchSettings.setState({ mode: "deep" });
    adapter.research = mock(async () => response());
    const execute = mock(async (_r: ChatRequest, purpose: "planning" | "answer", _s: AbortSignal) => ({ text: purpose === "planning" ? "INSUFFICIENT" : "Detailed answer", error: null, cancelled: false }));
    const trial = run(execute); await trial.result;
    expect(adapter.research).toHaveBeenCalledTimes(2);
    const complement = (adapter.research as ReturnType<typeof mock>).mock.calls[1]![1].query;
    expect(complement).toContain("FAQs, functional guides or Oracle notes");
    expect(complement).toContain("investigate related resources before ruling out the outcome");
    expect(trial.records.at(-1)?.results).toHaveLength(2);
    expect(trial.stages).toContain("Analisando resultados");
    expect(execute).toHaveBeenCalledTimes(2);
  });
  test.each([
    "Como corrigir este filtro REST que retorna 400 na integração?",
    "Como corrigir esta query SQL sem alterar a população selecionada?",
    "Como verificar se esta configuração funcional tem efeito?",
  ])("deep assessment checks the decisive gap for different tasks without extra model calls: %s", async (question) => {
    useResearchSettings.setState({ mode: "deep" });
    adapter.research = mock(async () => response());
    const execute = mock(async (outgoing: ChatRequest, purpose: "planning" | "answer") => {
      if (purpose === "planning") {
        const assessment = outgoing.messages.at(-1)?.content as string;
        for (const check of ["decision-critical uncertainty", "required headers and defaults", "related resources before ruling out the outcome", "official FAQs or notes", "user-reported test result is scoped evidence", "joins and population filters", "access and dependent records", "costly workaround", "Return ONLY SUFFICIENT or INSUFFICIENT"]) {
          expect(assessment).toContain(check);
        }
        expect(assessment).toContain("Unrelated unknown details do not make evidence insufficient");
      } else {
        expect(outgoing.messages.at(-1)?.content).toBe(question);
        expect(JSON.stringify(outgoing.messages)).toContain("Missing text does not prove an unsupported feature");
      }
      return { text: purpose === "planning" ? "SUFFICIENT" : "Answer", error: null, cancelled: false };
    });
    await new ResearchOrchestrator().run({ question, request: { ...chat, messages: [chat.messages[0]!, { role: "user", content: question }] }, prior: [], execute, onStage: () => {}, onResearch: () => {} });
    expect(adapter.research).toHaveBeenCalledTimes(1);
    expect(execute).toHaveBeenCalledTimes(2);
  });
  test("prior research is reused only in the same context and within 24 hours", async () => {
    useResearchSettings.setState({ mode: "deep" });
    const record: ResearchRecord = { question: request.query, mode: "deep", evidenceVersion: 4, results: [normalizeResearch(request, response())] };
    adapter.research = mock(async () => response());
    const trial = run(undefined, [record]); await trial.result;
    expect(adapter.research).not.toHaveBeenCalled(); expect(trial.records[0]?.reused).toBe(true);
    expect(cachedResearch(request.query, [record], Date.now() + 25 * 3600000)).toBeUndefined();
    expect(cachedResearch(request.query, [record], Date.now(), "Use release 25A instead")).toBeUndefined();
    expect(cachedResearch(request.query, [{ ...record, evidenceVersion: undefined }])).toBeUndefined();
    expect(cachedResearch(request.query, [{ ...record, evidenceVersion: 1 }])).toBeUndefined();
    expect(cachedResearch(request.query, [{ ...record, evidenceVersion: 2 }])).toBeUndefined();
    expect(cachedResearch(request.query, [{ ...record, evidenceVersion: 3 }])).toBeUndefined();
  });
  test("previous research policy is refreshed without modifying historical records", async () => {
    useResearchSettings.setState({ mode: "deep" });
    const previous: ResearchRecord = { question: request.query, mode: "deep", evidenceVersion: 2, results: [normalizeResearch(request, response())] };
    const before = JSON.stringify(previous);
    adapter.research = mock(async () => response());
    const execute = mock(async (_r: ChatRequest, purpose: "planning" | "answer") => ({ text: purpose === "planning" ? "SUFFICIENT" : "Answer", error: null, cancelled: false }));
    const trial = run(execute, [previous]); await trial.result;
    expect(adapter.research).toHaveBeenCalledTimes(1);
    expect(trial.records.at(-1)?.evidenceVersion).toBe(4);
    expect(JSON.stringify(previous)).toBe(before);
  });
  test("Expense regression: dictionary, functional visibility and release evidence all reach the final model before lookup decoding", async () => {
    useResearchSettings.setState({ mode: "deep" });
    const question = "Como checar o Expense Check Send-to Address de um usuário? Cliente ERP sem HCM, Oracle Fusion.";
    const pages = [
      { title: "Assignment dictionary", uri: "https://docs.oracle.com/en/cloud/saas/human-resources/oedmh/perallassignmentsm-25478.html", text: "EXPENSE_CHECK_ADDRESS | HOME_OFFICE" },
      { title: "Default Expense Account", uri: "https://docs.oracle.com/en/cloud/saas/human-resources/faigh/how-you-configure-the-default-expense-account.html", text: "PER_WORKER_ADDRESS_TYPE | Home | Office | hidden out-of-the-box | personalization" },
      { title: "24B Mailing Address", uri: "https://docs.oracle.com/en/cloud/saas/readiness/erp/24b/fins24b/24B-fin-wn-f32280.htm", text: "Person Management | Manage Employment | Expenses Information | Mail" },
    ];
    adapter.research = mock(async () => ({ candidates: [{ content: { parts: [{ text: "Conflicting lookup descriptions need comparison; do not select a default decode." }] }, groundingMetadata: { groundingChunks: pages.map((page) => ({ web: { uri: page.uri, title: page.title, atimoDocument: { excerpt: page.text, truncated: false }, atimoDocumentStatus: "read" } })) } }] }));
    const records: ResearchRecord[] = [];
    const execute = mock(async (outgoing: ChatRequest, purpose: "planning" | "answer") => {
      const text = JSON.stringify(outgoing.messages);
      for (const page of pages) { expect(text).toContain(page.uri); expect(text).toContain(page.text); }
      if (purpose === "planning") expect(text).toContain("An unresolved conflict or missing fact that changes the proposed solution means INSUFFICIENT");
      else {
        expect(text).toContain("never make a disputed name the executable query default");
        expect(outgoing.messages.at(-1)?.content).toBe(question);
      }
      return { text: purpose === "planning" ? "INSUFFICIENT" : "Answer", error: null, cancelled: false };
    });
    await new ResearchOrchestrator().run({ question, request: { ...chat, messages: [chat.messages[0]!, { role: "user", content: question }] }, prior: [], execute, onStage: () => {}, onResearch: (record) => records.push(record) });
    expect(adapter.research).toHaveBeenCalledTimes(2);
    expect((adapter.research as ReturnType<typeof mock>).mock.calls[1]![1].query).toContain("Open and compare the already returned official pages first");
    expect((adapter.research as ReturnType<typeof mock>).mock.calls[0]![1].query).toContain("also search official FAQs and behavior notes");
    expect(records.at(-1)?.evidenceVersion).toBe(4);
  });
  test("a pasted test payload keeps every search query under the 12k provider limit; the answer gets it whole", async () => {
    useResearchSettings.setState({ mode: "deep" });
    const nulls = Array.from({ length: 600 }, (_, i) => `"NameInformation${i}": null,`).join("\n          ");
    const question = `o personnumber da API resourcesusers aceita o número enviado?\nmeus testes:\n{ "PersonNumber": "990000001", ${nulls} "AssignmentNumber": "E990000001" }`;
    expect(question.length).toBeGreaterThan(12000);
    adapter.research = mock(async () => response());
    const execute = mock(async (outgoing: ChatRequest, purpose: "planning" | "answer") => {
      if (purpose === "answer") expect(outgoing.messages.at(-1)?.content).toBe(question);
      return { text: purpose === "planning" ? "INSUFFICIENT" : "Answer", error: null, cancelled: false };
    });
    await new ResearchOrchestrator().run({ question, request: { ...chat, messages: [chat.messages[0]!, { role: "user", content: question }] }, prior: [], execute, onStage: () => {}, onResearch: () => {},
      recentQuestions: [question, "x".repeat(20000)] });
    const queries = (adapter.research as ReturnType<typeof mock>).mock.calls.map((call) => call[1].query as string);
    expect(queries).toHaveLength(2);
    for (const query of queries) {
      expect(query.length).toBeLessThanOrEqual(12000);
      expect(query).toContain('"PersonNumber": "990000001"');
      expect(query).toContain("E990000001"); // nulls dropped, so the payload's real fields survive
      expect(query).not.toContain("NameInformation1");
    }
  });
  test("saved settings from before v2 come back with web research off, keeping the rest", async () => {
    const saved = { mode: "deep", provider: "gemini", geminiModel: "gemini-3.5-flash-lite", externalConsent: true, monthlyBudget: 5 };
    expect(migrateResearchSettings(saved, 1)).toEqual({ ...saved, mode: "off" } as never);
    expect(migrateResearchSettings({ ...saved, mode: "auto" }, 2)).toEqual({ ...saved, mode: "auto" } as never); // a later choice stays
  });
  test("research is blocked without consent, including cached results", async () => {
    useResearchSettings.setState({ mode: "deep", externalConsent: false });
    adapter.research = mock(async () => response());
    const trial = run(); await expect(trial.result).rejects.toThrow("Autorize");
    expect(adapter.research).not.toHaveBeenCalled(); expect(trial.execute).not.toHaveBeenCalled();
  });
  test("an API failure does not silently produce an ungrounded answer", async () => {
    useResearchSettings.setState({ mode: "deep" });
    adapter.research = mock(async () => { throw new Error("HTTP 401"); });
    const trial = run(); await expect(trial.result).rejects.toThrow("401");
    expect(trial.execute).not.toHaveBeenCalled(); expect(monthlyUsage().calls[0]?.status).toBe("error");
  });
  test("retries a rate limit once and records each attempt", async () => {
    useResearchSettings.setState({ mode: "deep" });
    let calls = 0;
    adapter.research = mock(async () => { if (++calls === 1) throw new Error("RETRYABLE: 429"); return response(); });
    const execute = mock(async (_r: ChatRequest, purpose: "planning" | "answer", _s: AbortSignal) => ({ text: purpose === "planning" ? "SUFFICIENT" : "Answer", error: null, cancelled: false }));
    await run(execute).result;
    expect(adapter.research).toHaveBeenCalledTimes(2);
    expect(monthlyUsage().calls.map((c) => c.status)).toEqual(["error", "done"]);
  });
  test("stops after the second retryable failure", async () => {
    useResearchSettings.setState({ mode: "deep" });
    adapter.research = mock(async () => { throw new Error("RETRYABLE: 503"); });
    const trial = run(); await expect(trial.result).rejects.toThrow("503");
    expect(adapter.research).toHaveBeenCalledTimes(2); expect(trial.execute).not.toHaveBeenCalled();
  });
  test("blocked model output still records usage reported by the API", async () => {
    useResearchSettings.setState({ mode: "deep" });
    adapter.research = mock(async () => ({ usageMetadata: { promptTokenCount: 20, candidatesTokenCount: 5 } }));
    const trial = run(); await expect(trial.result).rejects.toThrow("não retornou conteúdo");
    expect(monthlyUsage().calls[0]).toMatchObject({ inputTokens: 20, outputTokens: 5, status: "error" });
    expect(monthlyUsage().spent).toBeGreaterThan(0);
  });
  test("cancel stops before the final answer", async () => {
    useResearchSettings.setState({ mode: "deep" });
    adapter.research = mock(async () => { stopResearch(); return response(); });
    const trial = run(); await expect(trial.result).rejects.toThrow("cancelada");
    expect(trial.execute).not.toHaveBeenCalled();
  });
});

describe("budget and rendering", () => {
  test("reserves concurrent calls and reconciles real costs", () => {
    useResearchSettings.setState({ monthlyBudget: 1 });
    const id = reserveCall({ provider: "zai", model: "glm-5.3", purpose: "answer" }, 0.7);
    expect(() => reserveCall({ provider: "zai", model: "glm-5.3", purpose: "answer" }, 0.4)).toThrow("Orçamento");
    settleCall(id, { costUsd: 0.1, status: "done" });
    expect(() => reserveCall({ provider: "zai", model: "glm-5.3", purpose: "answer" }, 0.4)).not.toThrow();
    expect(monthlyUsage().spent).toBeCloseTo(0.5);
  });
  test("at the limit, blocks unknown paid costs but permits subscriptions", () => {
    useResearchSettings.setState({ monthlyBudget: 0 });
    expect(() => reserveCall({ provider: "gemini", model: request.model, purpose: "research" }, null)).toThrow();
    expect(() => reserveCall({ provider: "zai-coding", model: "glm-5.3", purpose: "answer" }, 0)).not.toThrow();
  });
  test("month rollover and unknown costs are kept distinct from zero", () => {
    reserveCall({ provider: "gemini", model: "unknown-model", purpose: "research" }, null);
    expect(monthlyUsage().unknown).toBe(1);
    expect(monthlyUsage(undefined, new Date("2050-01-01T00:00:00Z")).spent).toBe(0);
  });
  test("SQL highlighting preserves all bytes, including malformed fragments", () => {
    for (const sql of ["SELECT 'O''Brien', 123abc, :p_id FROM dual -- comentário\nWHERE x = 1", "/* hello */ select 10.5, q'[x]' from dual", "select \"CaseSensitive\", 🦉 from dual"]) expect(sqlTokens(sql).map((t) => t.text).join("")).toBe(sql);
    expect(sqlTokens("SELECT 'from' -- where").filter((t) => t.kind === "keyword").map((t) => t.text)).toEqual(["SELECT"]);
  });
  test("uncited model-invented links do not render as clickable references", () => {
    const nodes = inline("[invented](https://invented.example/a)", "", new Set(["https://docs.oracle.com/"]));
    expect((nodes[0] as any).type).toBe("span");
  });
});


describe("chat integration", () => {
  test.each([
    { text: "", cancelled: false, budget: null, planning: false },
    { text: "SELECT person_id FROM", cancelled: false, budget: 1, planning: false },
    { text: "", cancelled: true, budget: null, planning: false },
    { text: "", cancelled: false, budget: null, planning: true },
  ])("token-limit responses preserve text and billing: %j", async ({ text, cancelled, budget, planning }) => {
    const saved = useStore.getState();
    const originalChat = adapter.chat;
    const originalDoc = adapter.oracleDoc;
    const raf = Object.getOwnPropertyDescriptor(globalThis, "requestAnimationFrame");
    const caf = Object.getOwnPropertyDescriptor(globalThis, "cancelAnimationFrame");
    Object.defineProperty(globalThis, "requestAnimationFrame", { configurable: true, value: (callback: FrameRequestCallback) => Number(setTimeout(() => callback(0), 0)) });
    Object.defineProperty(globalThis, "cancelAnimationFrame", { configurable: true, value: (id: number) => clearTimeout(id) });
    try {
      useResearchSettings.setState({ mode: "off", monthlyBudget: budget });
      const catalog = (await webTransport.catalog("deepseek")).map(toModel);
      registerCatalog(catalog);
      useStore.setState({
        workspaces: [{ id: "w-limit", name: "Test" }],
        projects: [{ id: "p-limit", workspaceId: "w-limit", name: "Test", description: "", instructions: "", memoryTokens: 0 }],
        chats: [{ id: "c-limit", projectId: "p-limit", title: "Test", modelId: "deepseek-flash", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() }],
        messages: [], memory: [], decisions: [], documents: [], timeline: [],
        workspaceId: "w-limit", projectId: "p-limit", chatId: "c-limit", sending: false,
        catalog, catalogStatus: "ready", composerAttachments: [], skills: {},
        connection: { ...saved.connection, provider: "deepseek", status: "connected" },
      });
      adapter.oracleDoc = async (page) => {
        if (!planning) throw new Error("offline");
        return page === "toc.htm" ? '<a href="perallpeoplef-1.html">PER_ALL_PEOPLE_F</a>' : '<html><title>PER_ALL_PEOPLE_F</title></html>';
      };
      adapter.chat = mock(async (_provider, _id, outgoing, event) => {
        const suggestion = String(outgoing.messages[0]?.content).startsWith("List up to");
        expect(outgoing.maxTokens).toBe(suggestion || budget !== null ? 8192 : undefined);
        if (planning && !suggestion) {
          event({ type: "delta", text: "Complete answer after the failed suggestion" });
          event({ type: "done", finishReason: "stop", cancelled: false });
          return;
        }
        event({ type: "reasoning", text: "Thinking..." });
        if (text) event({ type: "delta", text });
        event({ type: "usage", promptTokens: 200, completionTokens: 8192, cachedPromptTokens: 120, cost: 0.01 });
        event({ type: "done", finishReason: "length", cancelled });
      });
      await useStore.getState().send(planning ? "SQL de PER_ALL_PEOPLE_F" : "Olá");
      const answer = useStore.getState().messages.find((m) => m.role === "assistant")!;
      expect(answer.content).toBe(planning ? "Complete answer after the failed suggestion" : text);
      expect(answer.pending).toBe(false);
      expect(Boolean(answer.error)).toBe(!cancelled && !planning);
      expect(Boolean(answer.stopped)).toBe(cancelled);
      if (!cancelled && !planning) expect(selectHistory([answer])).toEqual([]);
      const measured = planning ? monthlyUsage().calls.find((call) => call.purpose === "planning") : monthlyUsage().calls.at(-1);
      expect(measured).toMatchObject({
        status: cancelled ? "cancelled" : "error", finishReason: "length", outputTokens: 8192, costUsd: 0.01, cachedInputTokens: 120,
      });
    } finally {
      adapter.chat = originalChat;
      adapter.oracleDoc = originalDoc;
      useStore.setState(saved);
      if (raf) Object.defineProperty(globalThis, "requestAnimationFrame", raf); else Reflect.deleteProperty(globalThis, "requestAnimationFrame");
      if (caf) Object.defineProperty(globalThis, "cancelAnimationFrame", caf); else Reflect.deleteProperty(globalThis, "cancelAnimationFrame");
    }
  });

  test("Gemini → GLM settles the chat, logs all calls and preserves source metadata in backups", async () => {
    const saved = useStore.getState();
    const originalChat = adapter.chat;
    const raf = Object.getOwnPropertyDescriptor(globalThis, "requestAnimationFrame");
    const caf = Object.getOwnPropertyDescriptor(globalThis, "cancelAnimationFrame");
    Object.defineProperty(globalThis, "requestAnimationFrame", { configurable: true, value: (callback: FrameRequestCallback) => Number(setTimeout(() => callback(0), 0)) });
    Object.defineProperty(globalThis, "cancelAnimationFrame", { configurable: true, value: (id: number) => clearTimeout(id) });
    try {
      useResearchSettings.setState({ mode: "deep" });
      const catalog = (await webTransport.catalog("zai")).map(toModel);
      registerCatalog(catalog);
      useStore.setState({
        workspaces: [{ id: "w-oracle-test", name: "Oracle test" }],
        projects: [{ id: "p-oracle-test", workspaceId: "w-oracle-test", name: "Oracle", description: "", instructions: "", memoryTokens: 0 }],
        chats: [{ id: "c-oracle-test", projectId: "p-oracle-test", title: "Oracle", modelId: "glm-5.3", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() }],
        messages: [], memory: [], decisions: [], documents: [], timeline: [],
        workspaceId: "w-oracle-test", projectId: "p-oracle-test", chatId: "c-oracle-test", sending: false,
        catalog, catalogStatus: "ready", composerAttachments: [], skills: {},
        connection: { ...saved.connection, provider: "zai", zaiPlan: "general", status: "connected" },
      });
      adapter.research = mock(async () => response());
      startCapture();
      adapter.chat = mock(async (_provider, _id, outgoing, event) => {
        const instruction = JSON.stringify(outgoing.messages.at(-1));
        const assessment = instruction.includes("SUFFICIENT");
        if (!assessment) expect(JSON.stringify(outgoing.messages)).toContain("UNTRUSTED_RESEARCH_DATA");
        event({ type: "delta", text: assessment ? "SUFFICIENT" : "Solução com fonte: [Oracle](https://docs.oracle.com/en/cloud/saas/human-resources/26c/)" });
        event({ type: "usage", promptTokens: 200, completionTokens: 40, cost: 0.001 });
        event({ type: "done", finishReason: "stop", cancelled: false });
      });
      await useStore.getState().send("Como investigar uma Fast Formula no HCM 26C?");
      const state = useStore.getState();
      expect(state.sending).toBe(false);
      const answer = state.messages.find((m) => m.role === "assistant")!;
      expect(answer.pending).toBe(false); expect(answer.error).toBeUndefined();
      expect(answer.research?.results[0]?.sources[0]?.official).toBe(true);
      expect(answer.content).toContain("Solução com fonte");
      expect(monthlyUsage().calls.map((c) => c.purpose)).toEqual(["research", "planning", "answer"]);
      const capture = stopCapture();
      expect(capture.requests).toHaveLength(1);
      expect(JSON.stringify(capture.requests[0]!.request.messages)).toContain("UNTRUSTED_RESEARCH_DATA");
      expect(capture.observedCalls).toHaveLength(1);
      expect(capture.observedCalls![0]!.purpose).toBe("answer");
      const doc = buildExport({ ...state, chunks: [], attachments: [] }, { app: "test", label: "Oracle test" });
      expect(parseImport(toJson(doc)).messages.find((m) => m.id === answer.id)?.research).toEqual(answer.research);
      expect(toMarkdown(doc)).toContain("Sources consulted:");
      expect(toMarkdown(doc)).toContain("https://docs.oracle.com/en/cloud/saas/human-resources/26c/");

      // With no remaining budget, the store still settles its placeholder and does not call an API.
      useResearchSettings.setState({ mode: "off", monthlyBudget: 0 });
      const count = (adapter.chat as ReturnType<typeof mock>).mock.calls.length;
      await state.send("Qual o próximo passo?");
      expect(useStore.getState().sending).toBe(false);
      expect(useStore.getState().messages.at(-1)?.error).toContain("Orçamento");
      expect((adapter.chat as ReturnType<typeof mock>).mock.calls.length).toBe(count);
    } finally {
      adapter.chat = originalChat;
      stopCapture();
      useStore.setState(saved);
      if (raf) Object.defineProperty(globalThis, "requestAnimationFrame", raf); else Reflect.deleteProperty(globalThis, "requestAnimationFrame");
      if (caf) Object.defineProperty(globalThis, "cancelAnimationFrame", caf); else Reflect.deleteProperty(globalThis, "cancelAnimationFrame");
    }
  });
});
