import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { acervoContext, resetAcervoCache } from "../lib/oracle-acervo";
import { EMPS_RULE, checkHdl, checkRest, checkRestRules, ERP_SUGGEST_PROMPT, noteErpRelease, opSummary, parseRestIndex, parseRestSuggestion, resetRestCache, restContext, REST_SUGGEST_PROMPT, restUrl } from "../lib/oracle-rest";

// Same markup as docs.oracle.com/.../farws pages, trimmed.
const toc = `<a href="op-workers-get.html">Get all workers</a>
<a href="op-workers-workersuniqid-child-emails-get.html">Get all worker emails</a>
<a href="op-dataloaddatasets-get.html">Get all data sets</a>
<a href="op-dataloaddatasets-requestid-get.html">Get a data set</a>
<a href="op-dataloaddatasets-action-uploadfile-post.html">Upload file to HDL import account</a>
<a href="op-dataloaddatasets-requestid-action-generatefailedlinesfile-post.html">Generate failed lines files</a>`;
const op = (path: string, query: string, body = "") => `<html><body><h1>x</h1><p>${path}</p>
<h2>Query Parameters</h2><ul>${query}</ul><h2>Header Parameters</h2>
${body ? `<h2>Request Body - application/vnd.oracle.adf.action+json</h2><p>Root Schema : schema Type: object Show Source ${body}</p><pre>{ "type":"object" }</pre>` : ""}
<h2>Response</h2><p>hasMore(required): boolean Indicates whether more resources are available.</p></body></html>`;
const pages: Record<string, string> = {
  "rest/toc.htm": toc,
  "rest/op-workers-get.html": op("/hcmRestApi/resources/11.13.18.05/workers",
    "<li>effectiveDate: string This query parameter is used to fetch resources which are effective dated as of the specified start date.</li><li>limit: integer This parameter restricts the number.</li>"),
  "rest/op-dataloaddatasets-get.html": op("/hcmRestApi/resources/11.13.18.05/dataLoadDataSets", "<li>q: string Where clause.</li>"),
  "rest/op-dataloaddatasets-requestid-get.html": op("/hcmRestApi/resources/11.13.18.05/dataLoadDataSets/{RequestId}", "<li>fields: string Fields.</li>")
    .replace("</body>", "<p>/hcmRestApi/resources/11.13.18.05/dataLoadDataSets/{RequestId}/action/generateFailedLinesFile</p></body>"),
  "rest/op-dataloaddatasets-action-uploadfile-post.html": op("/hcmRestApi/resources/11.13.18.05/dataLoadDataSets/action/uploadFile", "",
    "content: string Base 64 encoded file to upload. fileName: string Name of the file to upload."),
};
const fetchPage = async (p: string) => { if (!(p in pages)) throw new Error(`HTTP 404 ${p}`); return pages[p]!; };

beforeEach(() => { resetRestCache(); resetAcervoCache(); });
afterEach(() => { resetRestCache(); resetAcervoCache(); });

describe("REST API acervo", () => {
  test("discovery can attach an alternative's POST contract when the question names a different resource", async () => {
    for (const prompt of [REST_SUGGEST_PROMPT, ERP_SUGGEST_PROMPT]) {
      expect(prompt).toContain("Include related resources that could achieve the requested outcome");
      expect(prompt).toContain("only when their schema is needed for the requested outcome");
    }
    const question = "REST resourceUsers: posso criar a pessoa com PersonNumber informado?";
    const result = await restContext({ question,
      suggest: async (system, actualQuestion) => {
        expect(system).toBe(REST_SUGGEST_PROMPT);
        expect(actualQuestion).toBe(question);
        return '{"resources": ["workers"], "tables": []}';
      },
      fetchPage: async (p) => p === "rest/toc.htm" ? `${toc}<a href="op-workers-post.html">Create a worker</a>`
        : p === "rest/op-workers-post.html" ? op("/hcmRestApi/resources/11.13.18.05/workers", "", "PersonNumber: string Number assigned to a person.")
        : fetchPage(p),
    });
    expect(result.context).toContain("POST /hcmRestApi/resources/11.13.18.05/workers");
    expect(result.context).toContain("PersonNumber (Number assigned to a person.)");
    expect(result.dictionary.tables).toContainEqual({ name: "REST workers", url: restUrl("op-workers-post.html") });
    expect(result.tables).toEqual([]);
  });

  test("index, suggestion and operation summary come from Oracle's pages", () => {
    const index = parseRestIndex(toc);
    expect([...index.resources].sort()).toEqual(["dataloaddatasets", "workers"]);
    expect(index.children.has("emails") && index.actions.has("uploadfile")).toBe(true);
    // Invented resources (seen live: hcmLoaderApi) never survive; a full path is reduced to its name.
    expect(parseRestSuggestion('{"resources": ["hcmLoaderApi", "/hcmRestApi/resources/11.13.18.05/dataLoadDataSets", "workers"]}', index)).toEqual(["dataloaddatasets", "workers"]);
    // A name the index lacks is matched by words against operation titles (seen live: hcmDataLoader).
    const full = parseRestIndex(toc.replace("Upload file to HDL import account", "Submit HCM Data Loader"));
    expect(parseRestSuggestion('{"resources": ["hcmDataLoader", "personAbsence"]}', full)).toEqual(["dataloaddatasets"]);
    const upload = opSummary("op-dataloaddatasets-action-uploadfile-post.html", "Upload", pages["rest/op-dataloaddatasets-action-uploadfile-post.html"]!);
    expect(upload.text).toContain("POST /hcmRestApi/resources/11.13.18.05/dataLoadDataSets/action/uploadFile");
    expect(upload.text).toContain("content (Base 64 encoded file to upload.); fileName (Name of the file to upload.)");
    const workers = opSummary("op-workers-get.html", "Get all workers", pages["rest/op-workers-get.html"]!);
    expect(workers.params).toEqual(["effectiveDate", "limit"]);
    expect(workers.text).toContain("effectiveDate (This query parameter");
    expect(workers.text).toContain("limit\n"); // standard parameter: name only
    expect(workers.text).toContain("hasMore");
  });

  test("context carries the documented operations and the OIC rule", async () => {
    const result = await restContext({ question: "HDL pelo OIC", suggest: async () => '{"resources": ["dataLoadDataSets"]}', fetchPage });
    expect(result.context.startsWith("UNTRUSTED_DICTIONARY_DATA")).toBe(true);
    expect(result.context).toContain("/dataLoadDataSets/action/uploadFile");
    expect(result.context).toContain("/dataLoadDataSets/{RequestId}/action/generateFailedLinesFile");
    expect(result.context).toContain("ExternalReportWSSService");
    expect(result.dictionary.tables.map((t) => t.name)).toEqual(["REST dataloaddatasets", "Oracle Integration (HCM adapter, BIP via SOAP)", "HCM Atom feeds", "HCM Data Loader: Worker.dat de exemplo"]);
    expect(result.context).toContain("METADATA|PersonEmail|SourceSystemOwner|SourceSystemId|PersonId(SourceSystemId)|DateFrom|EmailType|EmailAddress");
    expect(result.context).toContain("/hcmRestApi/atomservlet/employee/<collection>");
    // ERP questions use the Financials index and the FBDI note, not the HCM notes.
    resetRestCache();
    const erp = await restContext({ question: "Importar invoices no Payables pelo OIC", suggest: async () => '{"resources": []}',
      fetchPage: async (p) => p === "erp/toc.htm" ? '<a href="op-erpintegrations-post.html">Create</a>' : fetchPage(p) });
    expect(erp.dictionary.tables.map((t) => t.name)).toEqual(["Oracle Integration (ERP adapter, FBDI)"]);
    expect(erp.context).toContain("ESSJobExecutionDetailsRF");
    expect(erp.context).not.toContain("atomservlet");
    // A resource named bare in the question gets its card even when the suggester returns nothing.
    resetRestCache();
    const bare = await restContext({ question: "Reprocessar a importação de invoices pelo REST erpintegrations", suggest: async () => '{"resources": []}',
      fetchPage: async (p) => p === "erp/toc.htm" ? '<a href="op-erpintegrations-post.html">Create</a>' : '<p>Request Body</p><p>OperationName: string</p>' });
    expect(bare.dictionary.tables.map((t) => t.name)).toEqual(["REST erpintegrations", "Oracle Integration (ERP adapter, FBDI)"]);
  });

  test("Person Number run: a misspelled resourceUsers gets the Sales POST card and its Read Only PersonNumber", async () => {
    const salesPages: Record<string, string> = {
      "sales/toc.htm": '<a href="op-resourceusers-post.html">Create a resource user</a><a href="op-contacts-get.html">Get all contacts</a>',
      "sales/op-resourceusers-post.html": `<p>/crmRestApi/resources/11.13.18.05/resourceUsers</p><h2>Request Body - application/json</h2>
<p>Root Schema : schema Type: object Show Source FirstName: string Title: First Name The first name.</p><pre>{ }</pre>
<h2>Default Response</h2><p>Body ( ) Root Schema : resourceUsers-item-response Type: object Show Source FirstName: string Title: First Name The first name.
PersonNumber: string Title: Person Number Read Only: true The person number identifier of the worker record of the resource.</p><pre>{ }</pre>`,
    };
    const result = await restContext({ question: "o personnumber do payload da API resourcesusers, eu consigo mandar um numero e ele aceita ou sobrescreve? contacts",
      suggest: async () => '{"resources": []}', fetchPage: async (p) => salesPages[p] ?? fetchPage(p) });
    expect(result.dictionary.tables.map((t) => t.name)).toEqual(["REST resourceusers", "Oracle Integration (HCM adapter, BIP via SOAP)", "HCM Atom feeds"]);
    expect(result.context).toContain("POST /crmRestApi/resources/11.13.18.05/resourceUsers");
    expect(result.context).toContain("Body fields: FirstName");
    expect(result.context).toContain("Read Only in the response schema: PersonNumber");
    expect(result.context).not.toContain("REST contacts"); // common Sales names stay out
    // Without a shared Sales resource in the question, the Sales toc is never fetched.
    resetRestCache();
    await restContext({ question: "Listar workers pelo REST", suggest: async () => '{"resources": []}',
      fetchPage: async (p) => { expect(p.startsWith("sales/")).toBe(false); return fetchPage(p); } });
  });

  test("checkRest flags an action called with a method other than POST", async () => {
    const issues = await checkRest("`DELETE /hcmRestApi/resources/11.13.18.05/dataLoadDataSets/300/action/deleteDataSet` e POST /hcmRestApi/resources/11.13.18.05/dataLoadDataSets/action/uploadFile", async () => { throw new Error("offline"); });
    expect(issues).toEqual(["REST DELETE …/action/deleteDataSet (ações são POST)"]);
  });

  test("checkRest flags invented resources, children, actions and parameters, in prose and code", async () => {
    const answer = `Chame POST /hcmRestApi/resources/11.13.18.05/hcmLoaderApi/uploads e depois
\`GET /hcmRestApi/resources/latest/workers?effectiveDate=2026-01-01&expand=emails&bogus=1\`,
/hcmRestApi/resources/11.13.18.05/workers/{id}/child/kids e
/hcmRestApi/resources/11.13.18.05/dataLoadDataSets/300/action/generateFailedLinesFile e /dataLoadDataSets/action/fly
/hcmRestApi/resources/11.13.18.05/dataLoadDataSets/action/fly`;
    expect((await checkRest(answer, fetchPage)).sort()).toEqual([
      "REST /dataLoadDataSets/…/action/fly", "REST /hcmLoaderApi", "REST /workers/…/child/kids", "REST /workers?bogus"]);
    expect(await checkRest("Sem endpoint.", fetchPage)).toEqual([]);
    // Atom collections come from the documented list; ERP paths are checked against the ERP index.
    expect(await checkRest("/hcmRestApi/atomservlet/employee/newhire e /hcmRestApi/atomservlet/employee/hires", fetchPage)).toEqual(["Atom /employee/hires"]);
    const erpFetch = async (p: string) => p === "erp/toc.htm" ? '<a href="op-erpintegrations-post.html">Create</a>' : fetchPage(p);
    expect(await checkRest("POST /fscmRestApi/resources/11.13.18.05/erpintegrations e /fscmRestApi/resources/11.13.18.05/invoiceImports", erpFetch)).toEqual(["REST /invoiceImports"]);
    expect(await checkRest("/hcmRestApi/resources/11.13.18.05/workers", async () => { throw new Error("offline"); })).toEqual([]);
  });

  test("checkHdl flags components outside Oracle's sample Worker.dat", () => {
    const dat = "METADATA|Worker|SourceSystemId\nMETADATA|PersonEmail|SourceSystemId\nMETADATA|Email|SourceSystemId\nMETADATA|WorkContactDetails|X";
    expect(checkHdl(dat)).toEqual([
      "HDL METADATA|Email (fora do Worker.dat de exemplo; confirme em View Business Objects)",
      "HDL METADATA|WorkContactDetails (fora do Worker.dat de exemplo; confirme em View Business Objects)"]);
    expect(checkHdl("Sem HDL.")).toEqual([]);
  });

  test("integration questions route to REST; asking for SQL keeps the tables", async () => {
    const suggest = async (system: string) => system.includes("REST API resources") ? '{"resources": ["workers"]}' : "";
    const oic = await acervoContext({ question: "Como rodar um relatório BI Publisher pelo OIC?", suggest, fetchPage });
    expect(oic?.dictionary.tables[0]?.name).toBe("REST workers");
    expect(oic?.context).not.toContain("Securing HCM");
    const sql = await acervoContext({ question: "SQL do data model que o OIC vai chamar", suggest, fetchPage: async () => { throw new Error("offline"); } });
    // Asking for SQL keeps the tables, and the integration notes come on top (the BIP SOAP call is relevant here).
    expect(sql?.context ?? "").toContain("ExternalReportWSSService");
  });
});

test("ERP links follow the release named in the toc", async () => {
  noteErpRelease('{"release":{"short_name":"27a","element_name":"27A"}}');
  expect(restUrl("op-x-get.html", "erp")).toBe("https://docs.oracle.com/en/cloud/saas/financials/27a/farfa/op-x-get.html");
  noteErpRelease('{"release":{"short_name":"26d","element_name":"26D"}}');
});

test("the card keeps each documented request body, cutting only Base64", () => {
  const body = (json: string) => `<h3>Example Request Body</h3><p>The following example shows the contents of the request body in JSON format:</p><pre>${json}</pre>`;
  const html = body(`{ "OperationName":"importBulkData", "DocumentContent":"${"A".repeat(500)}", "JobName":"oracle/apps/ess/financials/payables/invoices/transactions,APXIIMPT" }`)
    + body(`{ "OperationName":"submitESSJobRequest", "JobDefName":"InterfaceLoaderController", "ESSParameters":"1,10420,N,N" }`);
  const { text } = opSummary("op-erpintegrations-post.html", "Create", html);
  expect(text).toContain('"JobDefName":"InterfaceLoaderController", "ESSParameters":"1,10420,N,N"');
  expect(text).toContain("transactions,APXIIMPT");
  expect(text).not.toContain("A".repeat(100));
});

test("checkRestRules flags /emps unless the answer already calls it deprecated", () => {
  // GLM-5.4 on 15-resourceusers-person-number (2026-11-23): "POST /hcmRestApi/resources/11.13.18.05/emps".
  expect(checkRestRules("Use `POST /hcmRestApi/resources/11.13.18.05/emps` com PersonNumber.")).toEqual([EMPS_RULE]);
  expect(checkRestRules("O recurso `emps` também aceita PersonNumber.")).toEqual([EMPS_RULE]);
  expect(checkRestRules("Não use /emps: está depreciado; use /workers.")).toEqual([]);
  expect(checkRestRules("Os employees do Fusion e o POST workers.")).toEqual([]);
});
