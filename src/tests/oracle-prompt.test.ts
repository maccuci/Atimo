import { describe, expect, test } from "bun:test";
import { buildMessages, contentText, systemPreamble } from "../lib/prompt-builder";
import { compose } from "../lib/context-composer";
import { activeSkills, DEFAULT_SKILL_MODES, getSkill } from "../lib/skills";
import type { ComposedContext, Message } from "../lib/types";

const context: ComposedContext = {
  chunks: [{ id: "project-brief", stage: "project", kind: "project", label: "Oracle project", score: 1, tokens: 30, included: true,
    excerpt: "Release 26C. ERP only. BIP data models. Classic UI." }],
  rawTokens: 30, finalTokens: 30, elapsedMs: 0,
};

const history: Message[] = [{ id: "m-prior", chatId: "c-oracle", role: "user", content: "Responda em português brasileiro.", createdAt: "2026-10-27T12:00:00Z" }];

function messages(prompt: string) {
  return buildMessages({ context, history, prompt, projectName: "Oracle project" });
}

describe("Oracle response guide", () => {
  test("the wire carries the guide, actual project context, evidence and user task without replacing them with template placeholders", () => {
    const prompt = `Corrija somente o SQL usando as colunas fornecidas.\n<schema_and_evidence>\nColumn list: PERSON_ID, DISPLAY_NAME\nSample: 42, Example Person\nError: ORA-00904 INVALID_IDENTIFIER\n</schema_and_evidence>`;
    const outgoing = messages(prompt);
    const system = contentText(outgoing[0]!.content);
    for (const block of ["role", "context", "task", "schema_and_evidence", "instructions", "constraints", "output_format", "examples"]) {
      expect(system).toContain(`<${block}>`);
      expect(system).toContain(`</${block}>`);
    }
    expect(system).toContain(context.chunks[0]!.excerpt);
    expect(outgoing[1]).toEqual({ role: "user", content: history[0]!.content });
    expect(outgoing.at(-1)).toEqual({ role: "user", content: prompt });
    expect(system).not.toMatch(/\{\{[^}]*\}\}/);
    expect(context.chunks[0]!.excerpt).toBe("Release 26C. ERP only. BIP data models. Classic UI.");
  });

  test.each([
    "Quero somente o SQL, usando bind :p_person_number.",
    "Desenhe uma integração OIC para o payload que vou fornecer.",
    "Explique este erro de Fast Formula e como testar a correção.",
    "Escreva um texto curto para enviar ao cliente.",
    "Answer in English and give only the REST request.",
  ])("preserves the requested deliverable: %s", (prompt) => {
    const outgoing = messages(prompt);
    const system = contentText(outgoing[0]!.content);
    expect(outgoing.at(-1)?.content).toBe(prompt);
    expect(system).toContain("Honor an explicit request for a particular format, scope or length");
    expect(system).toContain("For SQL-only requests");
    expect(system).toContain("defaulting to Brazilian Portuguese when unclear");
    expect(system).toContain("at most two focused questions");
    // Repeated PER_ALL_PEOPLE_F index details and an unsourced "a few hundred records" cut in the 2026-11-12 runs.
    expect(system).toContain("are evidence, not content to restate");
    expect(system).toContain("undocumented threshold or rule of thumb as your judgment");
  });

  test("unknown environment details and examples cannot be promoted to confirmed Oracle facts", () => {
    const system = systemPreamble("Oracle project");
    expect(system).toContain("otherwise unknown");
    expect(system).toContain("Do not invent values");
    expect(system).toContain("Distinguish documented behavior, observed behavior in a supplied test, and an untested hypothesis");
    expect(system).toContain("not a universal rule or a minimum supported version");
    expect(system).toContain("Missing evidence is not evidence of an unsupported feature");
    expect(system).toContain("A source URL, an official-domain flag or a reachable link does not establish that a particular claim is documented");
    expect(system).toContain("Examples below calibrate response behavior, not Oracle facts");
    expect(system).toContain("Concrete evidence about the user's environment takes precedence over generic recollection");
    expect(system).toContain("never infer them from a table suffix alone");
    expect(system).not.toContain("PER_WORKER_ADDRESS_TYPE");
  });

  test("default skills and retrieved assumptions preserve the user's REST goal and observed access", () => {
    const prompt = "No DEV, GET resourceUsers retorna 200. Como criar a pessoa pela REST com o número informado?";
    const composed = compose(prompt, "oracle-prompt-regression", "claude-opus-5", activeSkills(DEFAULT_SKILL_MODES));
    const outgoing = buildMessages({
      context: { ...composed, chunks: [...context.chunks, ...composed.chunks,
        { id: "old-answer", stage: "semantic", kind: "message", label: "Resposta antiga", score: 1, tokens: 20, included: true,
          excerpt: "Cliente só ERP; resourceUsers não está provisionada." },
      ] },
      history, prompt, projectName: "Oracle project",
    });
    const system = outgoing.map((m) => contentText(m.content)).join("\n\n");
    expect(system).toContain(getSkill("minimal-solution")!.body);
    expect(system).toContain("Follow explicit user instructions and preferences");
    expect(system).toContain("Past model answers and inferred project summaries are leads to verify");
    expect(system).toContain("Licensed scope alone does not establish whether an endpoint is provisioned or accessible");
    expect(system).toContain("Cliente só ERP; resourceUsers não está provisionada.");
    expect(system).toContain("A file load does not automatically take precedence over an API");
    expect(system).toContain("Keep internal methodology and skill labels out of the final answer");
    expect(system).not.toContain("Treat what the project has already established as authoritative");
    expect(system).not.toContain("HDL/HSDL or FBDI before any API");
    expect(system).not.toContain("Say which rung you stopped at");
    expect(contentText(outgoing.at(-1)!.content).endsWith(`## User message\n\n${prompt}`)).toBe(true);
  });

  test("documented facts, unresolved mappings and dependent-record checks retain their scope", () => {
    const system = systemPreamble("Oracle project");
    expect(system).toContain("Do not downgrade documented facts merely because tenant access or an unrelated mapping is unknown");
    expect(system).toContain("Never choose a disputed lookup or column as a default in executable code");
    expect(system).toContain("Never derive a SQL column by mechanically converting a UI label or REST property");
    expect(system).toContain("narrow SELECT DISTINCT on a verified column before decoding");
    expect(system).toContain("Check dependent records and their validity when they determine the outcome, even for a request to check a setting");
    expect(system).toContain("distinguish a documented dependency from a diagnosed cause");
    expect(system).not.toContain("Label every material Oracle technical claim");
  });

  test("SQL revisions require dictionary evidence and retain the intended population without hardcoded case facts", () => {
    const prompt = "Revise esta query preservando os filtros de vigência e seleção da população original.";
    const outgoing = messages(prompt);
    const system = contentText(outgoing[0]!.content);
    expect(system).toContain("read the relevant official Tables and Views pages (docs.oracle.com/.../oedmh or oedmf) for every table/view and column used");
    expect(system).toContain("A functional guide naming a table does not confirm its columns");
    expect(system).toContain("Cross-check final code against that evidence and preserve exact physical names");
    expect(system).toContain("primary/latest-change/type and language/name-type predicates where applicable");
    expect(system).toContain("preserve existing population filters or explain the evidence and population/cardinality impact of each change");
    expect(system).toContain("Do not hide faulty joins with DISTINCT");
    for (const caseFact of ["EXPENSE_CHECK_ADDRESS", "PER_ALL_ASSIGNMENTS_M", "emails.EmailAddress", "REST-Framework-Version: 4"]) {
      expect(system).not.toContain(caseFact);
    }
    expect(outgoing.at(-1)?.content).toBe(prompt);
  });

  test("general decision and answer rules investigate direct solutions and adapt detail to the task", () => {
    const system = systemPreamble("Oracle project");
    expect(system).toContain("Apply only the guidance relevant to the task");
    expect(system).toContain("decision-critical uncertainty");
    expect(system).toContain("runtime cost, implementation effort and maintenance");
    expect(system).toContain("required headers, defaults and child-resource query behavior");
    expect(system).toContain("recommend full scans, exports or local matching only when a concrete limitation justifies them");
    for (const check of ["Does the recommendation solve the requested task?", "Is any conclusion stronger than its evidence?", "Is there a simpler viable solution that still needs investigation?"]) {
      expect(system).toContain(check);
    }
    expect(system).toContain("Lead with the solution or conclusion");
    expect(system).toContain("there is no mandatory section template");
    expect(system).toContain("Scope a restriction to the verified operation; investigate related resources");
    expect(system).toContain("consult official FAQs, functional guides and relevant Oracle notes");
    expect(system).toContain("Choose a validation that resolves the uncertainty changing the recommendation");
    expect(system).not.toContain("## Confirmado vs. inferido");
  });

  // Person Number HDL runs 2026-11-12 (GLM 5.3 default/high/max, DeepSeek): bare "Automatic",
  // "clean up DEV" after "workers can't be deleted", unsourced inferences, off-topic HDL hygiene.
  test("answers name exact options, stay consistent and actionable, mark inferences and skip adjacent hygiene", () => {
    const system = systemPreamble("Oracle project");
    expect(system).toContain("Name a setting's options exactly as its own setup documentation lists them");
    expect(system).toContain("Does any step contradict another");
    expect(system).toContain("Does every recommended action name how to perform it");
    expect(system).toContain("is your inference: say so in the sentence");
    expect(system).toContain("Do not append adjacent best practices");
  });

  test("answer formatting does not override the orchestrator's single-token planning protocol", () => {
    const system = systemPreamble("Oracle project");
    expect(system).toContain("Internal routing and evidence-sufficiency checks must return only their requested decision token (DIRECT/SEARCH or SUFFICIENT/INSUFFICIENT), without answer sections or evidence labels");
  });

  test("diagram requests carry rendering instructions and separate observed integrations from proposed designs", () => {
    const prompt = "Desenhe do zero uma integração entre nosso sistema e o Fusion, incluindo o tratamento de falhas.";
    const outgoing = messages(prompt);
    const system = contentText(outgoing[0]!.content);
    expect(system).toContain("include a complete fenced mermaid block");
    expect(system).toContain("sequenceDiagram for ordered calls");
    expect(system).toContain("derive the diagram only from supplied readable files and evidence");
    expect(system).toContain("draw the smallest viable proposed design");
    expect(system).toContain("Never present a proposed diagram as an integration already deployed or tested");
    expect(outgoing.at(-1)?.content).toBe(prompt);
  });
});
