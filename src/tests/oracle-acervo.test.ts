import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { SECURED_SOURCE, SUPERVISOR_RULE, acervoContext, card, checkOuterJoins, checkSql, checkSqlRules, mentioned, parseIndex, parseSuggestion, resetAcervoCache } from "../lib/oracle-acervo";
import { resetRestCache } from "../lib/oracle-rest";

// Same markup as docs.oracle.com/.../oedmh pages, trimmed.
const toc = `<a href="perallpeoplef-17159.html#perallpeoplef-17159">PER_ALL_PEOPLE_F</a>
<a href="perallpeoplef-10472.html#perallpeoplef-10472">PER_ALL_PEOPLE_F_</a>
<a href="peremailaddresses-10682.html#peremailaddresses-10682">PER_EMAIL_ADDRESSES</a>
<a href="perpeoplef-6356.html#perpeoplef-6356">PER_PEOPLE_F</a>`;
const page = (name: string, description: string, pk: string, columns: string[][]) => `<html><head>
<meta name="description" content="${description}"><title>${name}</title></head><body>
<table class="customlayout" summary="Primary Key"><thead><tr><th>Name</th><th>Columns</th></tr></thead>
<tbody><tr><td><p class="p">${name}_PK</p></td><td><p class="p">${pk}</p></td></tr></tbody></table>
<table class="customlayout" summary="Columns"><thead><tr><th>Name</th></tr></thead><tbody>
${columns.map((c) => `<tr>${c.map((v) => `<td><p class="p">${v}</p></td>`).join("")}</tr>`).join("\n")}
</tbody></table></body></html>`;
const pages: Record<string, string> = {
  "toc.htm": toc,
  "perallpeoplef-17159.html": page("PER_ALL_PEOPLE_F", "Person details.", "PERSON_ID, EFFECTIVE_START_DATE, EFFECTIVE_END_DATE",
    [["PERSON_ID", "NUMBER", "18", "", "Yes", "Person."], ["PERSON_NUMBER", "VARCHAR2", "30", "", "Yes", "Number."]]),
  // Views list every column in one cell.
  "perpeoplef-6356.html": page("PER_PEOPLE_F", "Person view.", "", [["PERSON_ID PERSON_NUMBER EFFECTIVE_START_DATE ATTRIBUTE1"]]),
  "peremailaddresses-10682.html": page("PER_EMAIL_ADDRESSES", "This table stores email addresses of different types for a person.", "EMAIL_ADDRESS_ID",
    [["EMAIL_ADDRESS_ID", "NUMBER", "18", "", "Yes", "Surrogate key."], ["PERSON_ID", "NUMBER", "18", "", "Yes", "Person."], ["EMAIL_ADDRESS", "VARCHAR2", "240", "", "", "E-mail address."], ["DATE_FROM", "DATE", "", "", "", "Date from which e-mail address commences."],
      ["ATTRIBUTE1", "VARCHAR2", "150", "", "", "DFF"], ["ATTRIBUTE2", "VARCHAR2", "150", "", "", "DFF"]]),
};

function fetcher() {
  const calls: string[] = [];
  return { calls, fetchPage: async (p: string) => { calls.push(p); if (!(p in pages)) throw new Error(`HTTP 302 ${p}`); return pages[p]!; } };
}

beforeEach(resetAcervoCache);
afterEach(resetAcervoCache); // the module cache is shared with other test files in the same process

describe("Tables and Views acervo", () => {
  test("index, exact mentions and the card come from the page, not from the model", () => {
    const index = parseIndex(toc);
    expect(index.get("PER_ALL_PEOPLE_F")).toBe("perallpeoplef-17159.html");
    expect(mentioned("select * from per_all_people_f papf join FOO_BAR", index)).toEqual(["PER_ALL_PEOPLE_F"]);
    const email = card("PER_EMAIL_ADDRESSES", "peremailaddresses-10682.html", pages["peremailaddresses-10682.html"]!);
    expect(email).toContain("DATE_FROM DATE — Date from which");
    expect(email).toContain("Primary key: PER_EMAIL_ADDRESSES_PK: EMAIL_ADDRESS_ID");
    expect(email).toContain("Plus 2 descriptive flexfield segments");
    expect(email).not.toContain("ATTRIBUTE1 ");
    expect(email).toContain("https://docs.oracle.com/en/cloud/saas/human-resources/oedmh/peremailaddresses-10682.html");
  });

  test("a suggested table only counts if Oracle's index has it", () => {
    const index = parseIndex(toc);
    expect(parseSuggestion('```json\n{"tables": ["per_email_addresses", "PER_INVENTED_F", 7]}\n```', index)).toEqual(["PER_EMAIL_ADDRESSES"]);
    expect(parseSuggestion("SELECT nonsense", index)).toEqual([]);
  });

  test("named and suggested tables are attached as untrusted evidence with their source", async () => {
    const { calls, fetchPage } = fetcher();
    let asked = "";
    const result = await acervoContext({
      question: "Quero o SQL do e-mail de trabalho usando PER_ALL_PEOPLE_F",
      suggest: async (_, q) => { asked = q; return '{"tables": ["PER_EMAIL_ADDRESSES", "PER_ALL_PEOPLE_F"]}'; },
      fetchPage,
    });
    expect(asked).toContain("e-mail de trabalho");
    expect(result?.dictionary.tables.map((t) => t.name)).toEqual(["PER_ALL_PEOPLE_F", "PER_EMAIL_ADDRESSES"]);
    expect(result?.dictionary.tables[1]?.url).toBe("https://docs.oracle.com/en/cloud/saas/human-resources/oedmh/peremailaddresses-10682.html");
    expect(result?.context).toStartWith("UNTRUSTED_DICTIONARY_DATA");
    expect(result?.context).toContain("DATE_FROM");
    // Second question reuses the index and the cards.
    await acervoContext({ question: "e o PER_EMAIL_ADDRESSES?", suggest: async () => "", fetchPage });
    expect(calls).toEqual(["toc.htm", "perallpeoplef-17159.html", "peremailaddresses-10682.html"]);
  });

  test("no dictionary for questions without SQL, nor when docs.oracle.com is unreachable", async () => {
    const { calls, fetchPage } = fetcher();
    let suggested = false;
    const suggest = async () => { suggested = true; return ""; };
    expect(await acervoContext({ question: "Escreva um texto curto para o cliente.", suggest, fetchPage })).toBeNull();
    expect(calls).toEqual([]);
    expect(suggested).toBe(false);
    const offline = async () => { throw new Error("Tables and Views disponível só no desktop."); };
    expect(await acervoContext({ question: "SQL de PER_ALL_PEOPLE_F", suggest, fetchPage: offline })).toBeNull();
    // A stale page (redirect) drops that table and keeps the answer going.
    pages["toc.htm"] = toc + `<a href="perstale-1.html#x">PER_STALE_F</a>`;
    resetAcervoCache();
    const stale = await acervoContext({ question: "SQL com PER_STALE_F e PER_ALL_PEOPLE_F", suggest: async () => "", fetchPage });
    expect(stale?.dictionary.tables.map((t) => t.name)).toEqual(["PER_ALL_PEOPLE_F"]);
    pages["toc.htm"] = toc;
  });

  test("translated names bring the _TL table of each attached table", async () => {
    const { fetchPage } = fetcher();
    const tl = (name: string, page: string) => { pages["toc.htm"] += `<a href="${page}#x">${name}</a>`; pages[page] = page_(name); };
    const page_ = (name: string) => page(name, "Translations.", "", [["JOB_ID NAME LANGUAGE"]]);
    const original = pages["toc.htm"];
    tl("PER_JOBS_F", "perjobsf-1.html");
    tl("PER_JOBS_F_TL", "perjobsftl-1.html");
    tl("HR_ALL_ORGANIZATION_UNITS_F", "hrallorg-1.html");
    tl("HR_ORGANIZATION_UNITS_F_TL", "hrorgtl-1.html");
    const suggest = async () => '{"tables": ["PER_JOBS_F", "HR_ALL_ORGANIZATION_UNITS_F"]}';
    const pt = await acervoContext({ question: "SQL do cargo e departamento em português", suggest, fetchPage });
    expect(pt?.dictionary.tables.map((t) => t.name)).toEqual(["PER_JOBS_F", "PER_JOBS_F_TL", "HR_ALL_ORGANIZATION_UNITS_F", "HR_ORGANIZATION_UNITS_F_TL"]);
    resetAcervoCache();
    const plain = await acervoContext({ question: "SQL do cargo e departamento", suggest, fetchPage });
    expect(plain?.dictionary.tables.map((t) => t.name)).toEqual(["PER_JOBS_F", "HR_ALL_ORGANIZATION_UNITS_F"]);
    // Seen live: PER_JOBS_TL and HR_ALL_ORGANIZATION_UNITS_F_TL (no such tables), PER_DEPARTMENTS (a view, no _TL of its own).
    resetAcervoCache();
    tl("PER_DEPARTMENTS", "perdepartments-1.html");
    const live = await acervoContext({ question: "SQL com nome do cargo e do departamento, traduzido", suggest: async () => '{"tables": ["PER_JOBS_TL", "PER_DEPARTMENTS", "HR_ALL_ORGANIZATION_UNITS_F_TL"]}', fetchPage });
    expect(live?.dictionary.tables.map((t) => t.name)).toEqual(["PER_JOBS_F_TL", "PER_DEPARTMENTS", "HR_ORGANIZATION_UNITS_F_TL"]);
    pages["toc.htm"] = original!;
  });

  test("checkSqlRules flags a supervisor join without MANAGER_TYPE, even with the filter commented out", () => {
    // The GLM-5.4 answer to 7-report-hard (2026-11-23): PRIMARY_FLAG as "line manager", MANAGER_TYPE only in prose.
    const sql = (filter: string) => `\`\`\`sql
SELECT ppsv.person_number FROM per_assignment_secured_list_v pasv
LEFT JOIN per_assignment_supervisors_f sup ON sup.assignment_id = pasv.assignment_id
       ${filter}
\`\`\`
MANAGER_TYPE distingue functional de project leader.`;
    expect(checkSqlRules(sql("AND sup.primary_flag = 'Y'"))).toEqual([SUPERVISOR_RULE]);
    expect(checkSqlRules(sql("-- AND sup.manager_type = 'LINE_MANAGER'"))).toEqual([SUPERVISOR_RULE]);
    expect(checkSqlRules(sql("AND sup.manager_type = 'LINE_MANAGER'"))).toEqual([]);
    expect(checkSqlRules("Use PER_ASSIGNMENT_SUPERVISORS_F para o gestor.")).toEqual([]); // prose only, no SQL block
    // A dashed block comment must not swallow the SQL after it (DeepSeek, 7-report-hard, 2026-11-23).
    expect(checkSqlRules("```sql\nSELECT 1 FROM a x /* ---- bloco do gestor ---- */\nLEFT JOIN per_assignment_supervisors_f sup ON 1 = 1\nWHERE x.y = 'a--b' /* fim */\n```")).toEqual([SUPERVISOR_RULE]);
  });

  test("checkOuterJoins flags an outer table filtered without (+), not the driving side", () => {
    // The 2026-11-10 eval answer: BETWEEN with (+) on one side only, and a salary date filter without (+).
    const broken = `\`\`\`sql
SELECT ppsv.person_number, sal.annual_salary -- sal.x in a comment is ignored
  FROM per_person_secured_list_v ppsv, per_person_secured_list_v mgrpsv, per_person_names_f mgrnf, cmp_salary sal,
       (SELECT pos.person_id FROM per_periods_of_service pos WHERE pos.date_start <= :p_data) pos
 WHERE mgrpsv.person_id (+) = ppsv.person_id
   AND :p_data BETWEEN mgrpsv.effective_start_date (+) AND mgrpsv.effective_end_date
   AND mgrnf.person_id (+) = mgrpsv.person_id
   AND mgrnf.name_type (+) = 'GLOBAL'
   AND :p_data BETWEEN mgrnf.effective_start_date (+) AND mgrnf.effective_end_date (+)
   AND sal.assignment_id (+) = ppsv.person_id
   AND :p_data BETWEEN sal.date_from AND NVL(sal.date_to, DATE '4712-12-31')
\`\`\``;
    expect(checkOuterJoins(broken).sort()).toEqual(["mgrpsv", "sal"]);
    const fixed = broken.replace("AND mgrpsv.effective_end_date", "AND mgrpsv.effective_end_date (+)")
      .replace("BETWEEN sal.date_from AND NVL(sal.date_to, DATE '4712-12-31')", "BETWEEN sal.date_from (+) AND sal.date_to (+)");
    expect(checkOuterJoins(fixed)).toEqual([]);
    expect(checkOuterJoins("```sql\nSELECT a.x FROM t a, u b WHERE a.id (+) = b.id AND a.id IS NULL\n```")).toEqual([]);
    expect(checkOuterJoins("Sem SQL.")).toEqual([]);
  });

  test("report questions keep every base table: secured views don't count toward the cap", async () => {
    const { fetchPage } = fetcher();
    const original = pages["toc.htm"];
    const names = ["PER_ALL_ASSIGNMENTS_M", "PER_ASSIGNMENT_SECURED_LIST_V", "PER_ASSIGNMENT_SUPERVISORS_F", "PER_PERIODS_OF_SERVICE", "CMP_SALARY", "CMP_SALARY_SECURED_LIST_V", "PER_PERSON_SECURED_LIST_V"];
    for (const [i, name] of names.entries()) { pages["toc.htm"] += `<a href="t${i}-1.html#x">${name}</a>`; pages[`t${i}-1.html`] = page(name, "x", "", [["PERSON_ID"]]); }
    const suggest = async () => '{"tables": ["PER_ALL_ASSIGNMENTS_M", "PER_ASSIGNMENT_SUPERVISORS_F", "PER_PERIODS_OF_SERVICE", "CMP_SALARY", "PER_ALL_PEOPLE_F"]}';
    const r = await acervoContext({ question: "Data model BIP com gestor, salário e contratação", suggest, fetchPage });
    expect(r?.dictionary.tables.map((t) => t.name)).toEqual(["PER_ALL_ASSIGNMENTS_M", "PER_ASSIGNMENT_SECURED_LIST_V", "PER_ASSIGNMENT_SUPERVISORS_F", "PER_PERIODS_OF_SERVICE",
      "CMP_SALARY", "CMP_SALARY_SECURED_LIST_V", "PER_ALL_PEOPLE_F", "PER_PERSON_SECURED_LIST_V", "BI Publisher Secured List Views", "Line manager (MANAGER_TYPE)"]);
    // A manager question gets the supervisor card and the LINE_MANAGER note even when the model leaves it out.
    const omitted = await acervoContext({ question: "Relatório SQL com o gestor de linha de cada empregado", suggest: async () => '{"tables": ["PER_ALL_ASSIGNMENTS_M"]}', fetchPage });
    expect(omitted?.dictionary.tables.map((t) => t.name)).toContain("PER_ASSIGNMENT_SUPERVISORS_F");
    expect(omitted?.context).toContain("MANAGER_TYPE = 'LINE_MANAGER'");
    const none = await acervoContext({ question: "Relatório SQL de salário por empregado", suggest: async () => '{"tables": ["CMP_SALARY"]}', fetchPage });
    expect(none?.dictionary.tables.map((t) => t.name)).not.toContain("PER_ASSIGNMENT_SUPERVISORS_F");
    pages["toc.htm"] = original!;
  });

  test("checkSql flags columns the table's page does not list, and judges nothing else", async () => {
    const { fetchPage } = fetcher();
    const answer = `Resposta.
\`\`\`sql
-- pea.effective_start_date would be wrong here: comments are ignored
WITH x AS (SELECT 1 AS n FROM dual)
SELECT papf.person_number, pea.email_address, x.n, sub.whatever, 'pea.fake_in_string'
  FROM per_all_people_f papf
  LEFT JOIN per_email_addresses pea ON pea.person_id = papf.person_id
   AND TRUNC(SYSDATE) BETWEEN pea.effective_start_date AND pea.effective_end_date
  JOIN ap_invoices_all aia ON aia.no_such_erp_column = 1
  JOIN (SELECT 1 whatever FROM dual) sub ON 1 = 1
 WHERE papf.person_number = :p_person_number AND per_email_addresses.date_from IS NOT NULL
\`\`\`
\`\`\`text
pea.not_sql
\`\`\``;
    expect(await checkSql(answer, fetchPage)).toEqual(["PER_EMAIL_ADDRESSES.EFFECTIVE_START_DATE", "PER_EMAIL_ADDRESSES.EFFECTIVE_END_DATE"]);
    expect(await checkSql("Sem SQL aqui.", fetchPage)).toEqual([]);
    const view = "```sql\nSELECT ppf.person_number, ppf.full_name FROM per_people_f ppf\n```";
    expect(await checkSql(view, fetchPage)).toEqual(["PER_PEOPLE_F.FULL_NAME"]);
    // Comma joins bind every table, not only the first; a comma in the SELECT list binds nothing.
    const comma = "```sql\nSELECT papf.person_number, pea.email_address\n  FROM per_all_people_f papf,\n       per_email_addresses pea\n WHERE pea.person_id (+) = papf.person_id AND pea.effective_end_date (+) IS NULL\n```";
    expect(await checkSql(comma, fetchPage)).toEqual(["PER_EMAIL_ADDRESSES.EFFECTIVE_END_DATE"]);
    const viewCard = card("PER_PEOPLE_F", "perpeoplef-6356.html", pages["perpeoplef-6356.html"]!);
    expect(viewCard).toContain("\nPERSON_NUMBER\n");
    expect(viewCard).not.toContain("undefined");
    expect(viewCard).toContain("Plus 1 descriptive flexfield segments");
    resetAcervoCache();
    expect(await checkSql(answer, async () => { throw new Error("offline"); })).toEqual([]);
  });

  test("report questions get the secured list view rule, with the view of each named table", async () => {
    const { fetchPage } = fetcher();
    pages["toc.htm"] = toc + `<a href="perpersonsecuredlistv-1.html#x">PER_PERSON_SECURED_LIST_V</a>`;
    pages["perpersonsecuredlistv-1.html"] = page("PER_PERSON_SECURED_LIST_V", "Secured person list.", "", [["PERSON_ID PERSON_NUMBER"]]);
    const bip = await acervoContext({ question: "Data model BIP com PER_ALL_PEOPLE_F: o usuário só vê quem pode?", suggest: async () => "", fetchPage });
    expect(bip?.context).toContain("isn't subject to data-security restrictions");
    expect(bip?.context).toContain("PER_ALL_PEOPLE_F -> PER_PERSON_SECURED_LIST_V (Report Person Data");
    // The whole mapping, always: a filtered list read as "this table has no secured view".
    expect(bip?.context).toContain("CMP_SALARY -> CMP_SALARY_SECURED_LIST_V");
    expect(bip?.dictionary.tables.map((t) => t.name)).toEqual(["PER_ALL_PEOPLE_F", "PER_PERSON_SECURED_LIST_V", "BI Publisher Secured List Views"]);
    expect(bip?.dictionary.tables.at(-1)?.url).toBe(SECURED_SOURCE);
    // No table named: the whole mapping. Offline: the static rule still goes.
    resetAcervoCache();
    const offline = await acervoContext({ question: "Como proteger um relatório BI Publisher?", suggest: async () => "", fetchPage: async () => { throw new Error("offline"); } });
    expect(offline?.context).toContain("PER_ALL_ASSIGNMENTS_M -> PER_ASSIGNMENT_SECURED_LIST_V");
    expect(offline?.dictionary.tables.map((t) => t.name)).toEqual(["BI Publisher Secured List Views"]);
    // No table named or suggested, online: the example base goes in, so the example SQL has real columns.
    resetAcervoCache();
    const generic = await acervoContext({ question: "Como proteger um relatório BI Publisher?", suggest: async () => '{"tables": []}', fetchPage });
    expect(generic?.dictionary.tables.map((t) => t.name)).toEqual(["PER_ALL_PEOPLE_F", "PER_PERSON_SECURED_LIST_V", "BI Publisher Secured List Views"]);
    expect(generic?.context).toContain("base for an illustrative SQL");
    expect(bip?.context).not.toContain("base for an illustrative SQL");
    // SQL that is not about reports: no rule.
    resetAcervoCache();
    const sql = await acervoContext({ question: "SQL de PER_ALL_PEOPLE_F por pessoa", suggest: async () => "", fetchPage });
    expect(sql?.context).not.toContain("Securing HCM");
    pages["toc.htm"] = toc;
  });

  test("a long card keeps PK, key and asked-for columns in detail and every other column by name", () => {
    const long = "x".repeat(200);
    const columns = [
      ["ASSIGNMENT_ID", "NUMBER", "18", "", "Yes", "Surrogate key."],
      ["ASSIGNMENT_TYPE", "VARCHAR2", "30", "", "Yes", `Identifies the type of record: either assignment (employee, CWK, applicant, non-workers) or a set of Terms. ${long}`],
      ["EFFECTIVE_LATEST_CHANGE", "VARCHAR2", "30", "", "Yes", "'Y' indicates that this row represents the latest change in the day."],
      ["CREATION_DATE", "TIMESTAMP", "", "", "Yes", "Who column: indicates the date and time of the creation of the row."],
      ["STEP_ENTRY_DATE", "DATE", "", "", "", "obsolete"],
      ["LABOUR_UNION_MEMBER", "VARCHAR2", "30", "", "", `Free text. ${long}`],
      ...Array.from({ length: 60 }, (_, i) => [`FILLER_COLUMN_${i}`, "VARCHAR2", "150", "", "", long]),
    ];
    const html = page("PER_ALL_ASSIGNMENTS_M", "Assignments.", "ASSIGNMENT_ID, EFFECTIVE_LATEST_CHANGE", columns);
    const short = card("PER_ALL_ASSIGNMENTS_M", "a-1.html", html);
    expect(short).not.toContain(long.slice(0, 120)); // no column keeps a long comment
    expect(short).toContain("Shortened card");
    expect(short).toMatch(/^ASSIGNMENT_TYPE VARCHAR2\(30\) NOT NULL — .*non-workers\) or a set of Terms/m);
    expect(short).toMatch(/^EFFECTIVE_LATEST_CHANGE VARCHAR2\(30\) NOT NULL — 'Y'/m);
    expect(short).not.toMatch(/^CREATION_DATE TIMESTAMP/m);
    expect(short).not.toMatch(/^LABOUR_UNION_MEMBER /m);
    expect(short).toMatch(/Other columns \(name only\): .*CREATION_DATE.*LABOUR_UNION_MEMBER/);
    expect(card("PER_ALL_ASSIGNMENTS_M", "a-1.html", html, new Set(["LABOUR_UNION_MEMBER"]))).toMatch(/^LABOUR_UNION_MEMBER VARCHAR2\(30\) — Free text/m);
    // Short pages are untouched.
    expect(card("PER_EMAIL_ADDRESSES", "peremailaddresses-10682.html", pages["peremailaddresses-10682.html"]!)).not.toContain("Shortened card");
  });

  test("Financials tables: ERP questions use the 26D book, and checkSql reads both books", async () => {
    const erpPages: Record<string, string> = {
      "fin/toc.htm": `<a href="apinterfacerejections-11043.html#apinterfacerejections-11043">AP_INTERFACE_REJECTIONS</a>
<a href="apinvoicesinterface-11053.html#apinvoicesinterface-11053">AP_INVOICES_INTERFACE</a>`,
      "fin/apinterfacerejections-11043.html": page("AP_INTERFACE_REJECTIONS", "Rejections.", "",
        [["PARENT_TABLE", "VARCHAR2", "30", "", "Yes", "Parent."], ["PARENT_ID", "NUMBER", "18", "", "Yes", "Id."], ["REJECT_LOOKUP_CODE", "VARCHAR2", "30", "", "Yes", "Code."]]),
      "fin/apinvoicesinterface-11053.html": page("AP_INVOICES_INTERFACE", "Invoices.", "INVOICE_ID", [["INVOICE_ID", "NUMBER", "18", "", "Yes", "Id."]]),
    };
    const { fetchPage: hcmFetch } = fetcher();
    const fetchPage = async (p: string) => p in erpPages ? erpPages[p]! : hcmFetch(p);
    const erp = await acervoContext({ question: "SQL das rejeições de invoices no Payables", suggest: async () => '{"tables": ["AP_INTERFACE_REJECTIONS"]}', fetchPage });
    expect(erp?.dictionary.tables).toEqual([{ name: "AP_INTERFACE_REJECTIONS", url: "https://docs.oracle.com/en/cloud/saas/financials/26d/oedmf/apinterfacerejections-11043.html" }]);
    expect(erp?.context).toContain("Official Oracle Financials documentation");
    expect(erp?.context).not.toContain("Securing HCM");
    const sql = "```sql\nSELECT r.parent_id, r.reject_code, papf.person_number FROM ap_interface_rejections r, per_all_people_f papf WHERE r.parent_table = 'AP_INVOICES_INTERFACE'\n```";
    expect(await checkSql(sql, fetchPage)).toEqual(["AP_INTERFACE_REJECTIONS.REJECT_CODE"]);
    // Integration question: the REST suggestion also names tables, which come from the ERP book.
    resetAcervoCache();
    const oic = await acervoContext({ question: "Importar invoices no Payables pelo OIC e ver as rejeitadas",
      suggest: async () => '{"resources": [], "tables": ["AP_INTERFACE_REJECTIONS", "AP_INVENTED_T"]}',
      fetchPage: async (p) => p === "erp/toc.htm" ? '<a href="op-erpintegrations-post.html">Create</a>' : fetchPage(p) });
    expect(oic?.dictionary.tables.map((t) => t.name)).toEqual(["Oracle Integration (ERP adapter, FBDI)", "AP_INTERFACE_REJECTIONS"]);
    expect(oic?.context).toContain("REJECT_LOOKUP_CODE");
    // SQL and REST in one question: the table cards and the erpintegrations card both come.
    resetAcervoCache();
    resetRestCache();
    const both = await acervoContext({ question: "Como faço um SQL das rejeitadas (AP_INTERFACE_REJECTIONS) e reprocesso pelo REST erpintegrations?",
      suggest: async () => '{"resources": [], "tables": []}',
      fetchPage: async (p) => p === "erp/toc.htm" ? '<a href="op-erpintegrations-post.html">Create</a>'
        : p === "erp/op-erpintegrations-post.html" ? '<p>Request Body</p><p>JobDefName: string</p>' : fetchPage(p) });
    expect(both?.dictionary.tables.map((t) => t.name)).toEqual(["AP_INTERFACE_REJECTIONS", "REST erpintegrations", "Oracle Integration (ERP adapter, FBDI)"]);
    expect(both?.context).toContain("REJECT_LOOKUP_CODE");
    expect(both?.context).toContain("JobDefName");
  });
});
