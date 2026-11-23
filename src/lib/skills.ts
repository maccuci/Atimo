import type { ActiveSkill, ArmedSkill, Skill, SkillMode } from "./types";

/*
 * Skills — installable instruction packs, in the shape `skills.sh` installs
 * them into `.agents/skills/<name>/SKILL.md`.
 *
 * A skill is two texts with very different costs:
 *
 *   description  one line, in every answering model's context on every turn
 *   body         the working instructions, injected only when the skill arms
 *
 * That split is the whole mechanic (progressive disclosure), and it is what the
 * Skills view puts on screen: a project can carry twenty skills for the price
 * of twenty lines, and pay for a body only on the turns that need it. A panel
 * of several models gets the same catalogue and the same armed bodies — the
 * comparison is about the models, not about who was told to work differently.
 *
 * A skill arms when its mode is `always`, or when the prompt hits one of its
 * triggers. Arming is deliberately keyword matching rather than the composer's
 * fractional overlap: a skill either applies to this turn or it does not, and
 * half a body would change the answer without explaining why.
 *
 * The registry below is seeded from the repo's own `.agents/skills` — same
 * sources, same lockfile hashes as `skills-lock.json`. Fetching it from GitHub
 * instead of shipping it changes this file only.
 */

/** Registry entry. Bodies are condensed from the upstream `SKILL.md`. */
export const SKILLS: Skill[] = [
  {
    id: "caveman",
    name: "Caveman",
    category: "output",
    summary: "Corta ~65% do tamanho da resposta sem perder conteúdo técnico",
    description:
      "Ultra-compressed replies: drop filler, articles and hedging while keeping every technical fact, code block and error string exact. Use when the user asks to be brief, terse, or to spend fewer tokens.",
    triggers: [
      "caveman",
      "brief",
      "terse",
      "concise",
      "short",
      "shorter",
      "tokens",
      "compress",
      "summarize",
      "tldr",
      "resumo",
      "resumido",
      "curto",
      "direto",
    ],
    source: {
      repo: "juliusbrussee/caveman",
      path: "skills/caveman/SKILL.md",
      hash: "d18cdf7",
    },
    body: `Respond terse, like a smart caveman. All technical substance stays; only fluff dies.

Drop articles (a/an/the), filler (just, really, basically, actually, simply), pleasantries, and hedging. Fragments are fine. Prefer short synonyms — "big" not "extensive", "fix" not "implement a solution for". No tool-call narration, no decorative tables or emoji, no dumping long raw logs: quote the shortest decisive line.

Never invent abbreviations (cfg, impl, req, fn) and never use arrows (→). The tokenizer splits them the same as the full word, so they save nothing and read worse.

Keep the user's language. A Portuguese prompt gets a Portuguese caveman answer — compress the style, not the language. Technical terms, code, API names, CLI commands and exact error strings stay verbatim.

Never announce the mode or refer to it. Pattern: [thing] [action] [reason]. [next step].

Drop the style entirely for security warnings, irreversible actions, and any sequence where a missing conjunction could be misread. Resume after that part is clear.`,
  },
  {
    id: "minimal-solution",
    name: "Solução mínima",
    category: "approach",
    summary: "Escolhe a solução Fusion suportada mais simples para o resultado pedido",
    description:
      "Compare viable Fusion options by fit, documented support, runtime cost, implementation effort and maintenance; prefer the simplest solution that meets the user's requirement.",
    triggers: [
      "solucao", "solução", "como fazer", "como faço", "melhor forma", "abordagem",
      "customizar", "customização", "extensao", "extensão", "integracao", "integração",
      "automatizar", "approach", "best way", "customize", "extension", "integration",
    ],
    body: `Choose the simplest supported solution that meets the requested outcome, volume, frequency and access. Compare only relevant options: standard setup, personalization, existing reports, file loads, direct REST/SOAP, ESS jobs, OIC or a PaaS extension. A file load does not automatically take precedence over an API; account for the user's existing integration and the effort to operate and maintain it.

Respect the user's chosen interface. Before recommending a workaround because an operation cannot do something, investigate related resources in the same Fusion product that could meet the requirement. Scope a documented limitation to the operation it actually covers; verify alternative contracts and access before recommending them as available.

Reuse standard functionality when it fits. Add customization only when a concrete limitation justifies it. Keep selection criteria internal; explain the chosen solution and decisive tradeoff in ordinary language, without methodology labels or numbered solution levels.`,
  },
  {
    id: "client-text",
    name: "Texto pro cliente",
    category: "deliverable",
    summary: "Transforma a resposta técnica em e-mail ou status pronto para o cliente",
    description:
      "Rewrite the answer as client-facing text in Brazilian Portuguese: plain language, no internal jargon, ready to paste into an e-mail or status report.",
    triggers: [
      "email", "e mail", "texto pro cliente", "texto para o cliente",
      "mensagem pro cliente", "mensagem para o cliente", "responder o cliente",
      "explicar para o cliente", "status report", "client email", "stakeholder",
    ],
    body: `Deliver copy-ready text the consultant can paste to the client. Default to Brazilian Portuguese unless the user asks otherwise.

Shape: a one-line subject (for e-mail), a direct opening that states the outcome or the decision needed, then at most three short paragraphs or bullets: what happened / what we found, what we will do or what we need from them, and when. Close with one clear next step.

Tone: professional and calm, first person plural ("identificamos", "vamos ajustar"). No blame, no internal ticket chatter, no model or tool names.

Translate jargon: say "a carga de dados" rather than "o HDL", "o relatório" rather than "o data model do BIP", unless the reader is technical. Keep exact object names only when the client must act on them. Never invent dates, owners or commitments — leave a bracketed placeholder like [data] for anything the user did not give you.

Put the client text first, inside a quote block or clearly separated. Add internal notes for the consultant after it, only if something needs checking before sending.`,
  },
  {
    id: "functional-spec",
    name: "Documento funcional",
    category: "deliverable",
    summary: "Estrutura a resposta como especificação funcional",
    description:
      "Write the answer as a functional design document: requirement, proposed solution, setup steps, data and integration impact, test scenarios and open points.",
    triggers: [
      "documento funcional", "especificacao", "especificação", "spec", "md050",
      "md070", "desenho funcional", "functional design", "functional spec",
    ],
    body: `Produce a functional design document the consultant can drop into the project's template. Use these sections, in this order, and omit a section only when it truly does not apply (say so in one line):

1. Objetivo — the business requirement in one or two sentences.
2. Escopo — in scope / out of scope, business units, legislations, roles affected.
3. Solução proposta — the chosen approach and why; alternatives considered in one line each.
4. Configuração — numbered setup steps with the exact Setup and Maintenance task or navigation path, and the values to set.
5. Dados e integrações — data loads (HDL/FBDI), reports, integrations, with object names.
6. Segurança — roles, privileges and data access needed.
7. Cenários de teste — a table: ID, cenário, pré-condição, passos, resultado esperado. Cover the happy path and the most likely failure.
8. Pontos em aberto — questions for the client, each with who should answer.

Write in Brazilian Portuguese unless the user asks otherwise. Use placeholders such as [BU] or [legislação] for unknown client values; never invent them.`,
  },
  {
    id: "sql-review",
    name: "Revisão de SQL/BIP",
    category: "technical",
    summary: "Revisa uma query SQL de BIP/OTBI com um checklist fixo de Fusion",
    description:
      "Review a Fusion SQL query (BIP data model, OTBI logical SQL or ad-hoc) against a fixed checklist and return findings plus the corrected query.",
    triggers: [
      "revisar", "revisa", "revisao", "revisão", "review", "lento", "lenta",
      "performance", "otimizar", "duplicando", "duplicado", "duplicate", "slow query",
    ],
    body: `Return a review, not a rewrite from scratch. Start with a table: | # | Severity | Line/part | Problem | Fix |. Severity is Bug (wrong rows), Risk (breaks on other data), or Perf. Then give the corrected query in one fenced sql block, changing only what the findings justify.

Check, in this order:
1. Joins and cardinality — every join on the full key; no row multiplication hidden by DISTINCT or GROUP BY.
2. Date effectivity — :p_date (or SYSDATE, stated) BETWEEN effective_start_date AND effective_end_date on every date-tracked table, including joined ones.
3. Current-row predicates — primary assignment/flag, latest change, assignment type, name type, as applicable.
4. Translations — _TL / _VL tables filtered by LANGUAGE = USERENV('LANG') (or the bind used by the report).
5. Security — secured list views when the report runs as the end user; note when the base table bypasses data access.
6. Binds and nulls — bind variables instead of literals; optional parameters written as (col = :p OR :p IS NULL) only where needed.
7. Performance — no functions on indexed columns in WHERE, no SELECT *, no correlated subquery per row when a join works.

If a table or column cannot be verified against the supplied schema or Tables and Views, flag it as Unverified rather than assuming it exists.`,
  },
  {
    id: "hdl-load",
    name: "Carga HDL",
    category: "technical",
    summary: "Monta arquivos .dat do HCM Data Loader com a ordem e as chaves certas",
    description:
      "Build or fix an HCM Data Loader (HDL) file: METADATA and MERGE lines, object load order, source keys, and the most common load errors.",
    triggers: [
      "hdl", "hsdl", "data loader", "carga hdl", "carga de dados", "arquivo dat",
      "worker dat", "spreadsheet loader", "metadata merge",
    ],
    body: `Deliver the .dat content in a fenced block, pipe-delimited, ready to zip and load.

File rules: one METADATA line per component before its MERGE (or DELETE) lines; attribute names exactly as in the component's business object (verify against the supplied documentation or say they need checking); dates as YYYY/MM/DD; effective-dated components carry EffectiveStartDate and, when relevant, EffectiveEndDate; use SourceSystemOwner and SourceSystemId keys rather than surrogate IDs, and keep the same key across loads.

Order: parent before child in the same file (e.g. Worker, PersonName, WorkRelationship, WorkTerms, Assignment); separate files for objects that depend on another object's load (e.g. load Worker before ElementEntry).

After the file, list: the prerequisites that must exist (business unit, job, grade, location, legislative data group), how to validate in Import and Load Data, and the two or three errors this load is most likely to hit with their fix (missing reference data, overlapping date ranges, key mismatch on an update).

Never invent attribute names, lookup codes or legislative values; use [placeholder] for client-specific data.`,
  },
];

/** The skills a fresh install ships with, and how they run. */
export const DEFAULT_SKILL_MODES: Record<string, SkillMode> = {
  caveman: "auto",
  "minimal-solution": "always",
};

export const SKILL_CATEGORY_LABEL = {
  output: "Output style",
  approach: "Approach",
  deliverable: "Deliverables",
  technical: "Technical",
} as const;

const BY_ID = new Map(SKILLS.map((s) => [s.id, s]));

export function getSkill(id: string): Skill | undefined {
  return BY_ID.get(id);
}

/** Installed skills that are not paused, in registry order. */
export function activeSkills(modes: Record<string, SkillMode>): ActiveSkill[] {
  const active: ActiveSkill[] = [];
  for (const skill of SKILLS) {
    const mode = modes[skill.id];
    if (mode === "auto" || mode === "always") active.push({ skill, mode });
  }
  return active;
}

/**
 * Which skills apply to this prompt.
 *
 * `always` skills arm unconditionally. `auto` skills arm on a trigger hit; the
 * score is how much of the trigger list matched, floored so a single decisive
 * hit still reads as a real match rather than as noise.
 */
export function armSkills(prompt: string, active: ActiveSkill[]): ArmedSkill[] {
  // Both sides are flattened the same way, so a trigger matches whole words
  // ("design" does not arm on "designation") and punctuation in either the
  // trigger or the prompt stops mattering ("next.js" arms on "next js").
  // Accents are folded first: "configuração" must match "configuracao" and
  // must not be split into "configura o" by the punctuation pass.
  const flatten = (text: string) =>
    ` ${text
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, " ")
      .trim()} `;
  const haystack = flatten(prompt);
  const armed: ArmedSkill[] = [];

  for (const { skill, mode } of active) {
    if (mode === "always") {
      armed.push({ skill, reason: "always", score: 1, matched: [] });
      continue;
    }

    const matched = skill.triggers.filter((t) => haystack.includes(flatten(t)));
    if (matched.length === 0) continue;

    armed.push({
      skill,
      reason: "match",
      score: Math.min(1, 0.55 + 0.15 * matched.length),
      matched,
    });
  }

  // Always-on first, then by how strongly the prompt asked for it.
  return armed.sort((a, b) => {
    if ((a.reason === "always") !== (b.reason === "always")) {
      return a.reason === "always" ? -1 : 1;
    }
    return b.score - a.score;
  });
}

/* ---------------------------------------------------------------------- */
/* Installed state — a preference, so it survives a reload even though the  */
/* rest of the workspace is still in memory.                                */
/* ---------------------------------------------------------------------- */

// v2: the catalogue was replaced (web-dev skills out, Fusion skills in), so
// everyone starts again from the new defaults.
const STORAGE_KEY = "atimo.skills.v2";

export function readSkillModes(): Record<string, SkillMode> {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { ...DEFAULT_SKILL_MODES };
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return { ...DEFAULT_SKILL_MODES };

    // Drop ids the registry no longer carries, so an uninstalled skill cannot
    // linger as an entry that nothing can turn off.
    const modes: Record<string, SkillMode> = {};
    for (const [id, mode] of Object.entries(parsed as Record<string, unknown>)) {
      if (!BY_ID.has(id)) continue;
      if (mode === "auto" || mode === "always" || mode === "off") modes[id] = mode;
    }
    return modes;
  } catch {
    return { ...DEFAULT_SKILL_MODES };
  }
}

export function writeSkillModes(modes: Record<string, SkillMode>): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(modes));
  } catch {
    /* ignore quota / private mode */
  }
}
