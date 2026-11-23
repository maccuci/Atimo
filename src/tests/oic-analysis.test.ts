import { expect, test } from "bun:test";
import { archiveFacts, reviewCoverage, reviewExcerpt } from "../lib/integration-files";
import { analyzeOic } from "../lib/oic-analysis";
import type { Document } from "../lib/types";

const P = "icspackage/project/DEMO_01.00.0000/";
const expr = (path: string, body: Record<string, string>) => ({
  path: `${P}resources/${path}/expr.properties`,
  text: Object.entries(body).map(([k, v]) => `${k} : ${v}`).join("\n"),
});
const res = (path: string) => `<ns2:resource name="r" location="../resources/${path}/expr.properties" type="properties"/>`;

/*
 * A schedule with one parameter (since) that the end of the flow updates — the
 * watermark pattern — and one global variable (flag) that the router reads
 * before anything assigns it.
 */
const project = `<?xml version="1.0"?>
<ns2:icsproject xmlns:ns2="http://www.oracle.com/2014/03/ics/flow/definition">
  <ns2:processor name="processor_8"><ns2:type>scheduleReceive</ns2:type>
    <ns2:output name="output_1"><ns2:role>variable</ns2:role><ns2:messageContextRef refUri="mc_since"/>
      <ns2:resourceGroup name="g">${res("processor_8/output_1/g")}</ns2:resourceGroup></ns2:output>
  </ns2:processor>
  <ns2:processor name="processor_20"><ns2:type>contentBasedRouter</ns2:type>
    <ns2:resourceRef refUri="mc_flag"><ns2:role>secondary-source</ns2:role><ns2:subRole>flag</ns2:subRole></ns2:resourceRef>
    <ns2:resourceRef refUri="mc_since"><ns2:role>secondary-source</ns2:role><ns2:subRole>since</ns2:subRole></ns2:resourceRef>
    <ns2:output name="output_21"><ns2:resourceGroup name="g">${res("processor_20/output_21/g")}</ns2:resourceGroup></ns2:output>
  </ns2:processor>
  <ns2:processor name="processor_30"><ns2:type>transformer</ns2:type>
    <ns2:output name="o"><ns2:messageContextRef refUri="mc_req"/></ns2:output></ns2:processor>
  <ns2:processor name="processor_40"><ns2:type>assignment</ns2:type>
    <ns2:resourceGroup name="g">${res("processor_40/g")}</ns2:resourceGroup>
    <ns2:output name="o"><ns2:messageContextRef refUri="mc_flag"/></ns2:output></ns2:processor>
  <ns2:processor name="processor_41"><ns2:type>assignment</ns2:type>
    <ns2:resourceGroup name="g">${res("processor_41/g")}</ns2:resourceGroup>
    <ns2:output name="o"><ns2:messageContextRef refUri="mc_since"/></ns2:output></ns2:processor>
  <ns2:processor name="processor_50"><ns2:type>activityStreamLogger</ns2:type></ns2:processor>
  <ns2:application name="application_9"><ns2:adapter><ns2:name>SendThing</ns2:name></ns2:adapter>
    <ns2:inbound name="in"><ns2:operation>POST</ns2:operation>
      <ns2:output name="r"><ns2:role>response</ns2:role><ns2:messageContextRef refUri="mc_resp"/></ns2:output></ns2:inbound>
  </ns2:application>
  <ns2:orchestration><ns2:globalTry id="gt0">
    <ns2:scheduleReceive id="sr0" refUri="processor_8"/>
    <ns2:router id="s0" refUri="processor_20">
      <ns2:route id="sc0" refUri="processor_20/output_21">
        <ns2:try id="t0" name="ScopeSend">
          <ns2:transformer id="m0" refUri="processor_30"/>
          <ns2:invoke id="i0" refUri="application_9" name="Integration1"/>
          <ns2:catchAll id="ta0" refUri="processor_49"><ns2:activityStreamLogger id="lg0" refUri="processor_50"/></ns2:catchAll>
        </ns2:try>
      </ns2:route>
    </ns2:router>
    <ns2:label id="l1" name="AssignEndVars">
      <ns2:assignment id="a0" refUri="processor_40"/>
      <ns2:assignment id="a1" refUri="processor_41"/>
    </ns2:label>
    <ns2:stop id="st0"/>
  </ns2:globalTry></ns2:orchestration>
</ns2:icsproject>`;

const sources = [
  { path: `${P}PROJECT-INF/project.xml`, text: project },
  expr("processor_8/output_1/g", { XpathExpression: "", VariableName: "since" }),
  expr("processor_20/output_21/g", { XpathExpression: "$flag != '' or $since != ''" }),
  expr("processor_40/g", { XpathExpression: "'Y'", VariableName: "flag" }),
  expr("processor_41/g", { XpathExpression: "$now", VariableName: "since" }),
  { path: `${P}resources/processor_30/g/req.xsl`, text: `<ns:process_status><xsl:value-of select="&quot;S&quot;"/></ns:process_status><xsl:value-of select="dvm:lookupValue('LKP','K','Used','V','')"/>` },
  { path: `${P}resources/application_9/in/g/Send.jca`, text: `<property name="csfkey" value="aaaaaaaa1111"/><property name="endpointURL" value="https://host.example/service"/><property name="targetWSDLURL" value="%%CONN_targetWSDLURL"/>` },
  { path: "icspackage/appinstances/CONN.xml", text: `<instanceCode>CONN</instanceCode><name>csfkey</name><value>bbbbbbbb2222</value>` },
  { path: "icspackage/dvms/LKP.dvm", text: `<dvm name="LKP"><rows><row><cell>Used</cell><cell>1</cell></row><row><cell>Ambiente</cell><cell>DEV</cell></row></rows></dvm>` },
];

test("the analyzer states what an OIC archive provably does, including the OIC semantics models get wrong", () => {
  const facts = analyzeOic(sources);
  const by = (rule: string) => facts.filter((f) => f.rule === rule).map((f) => f.message);

  // A global variable read before it is assigned is empty on every run…
  expect(by("variable-read-before-assigned")).toHaveLength(1);
  expect(by("variable-read-before-assigned")[0]).toContain("Variable flag is read by router s0");
  expect(by("variable-read-before-assigned")[0]).toContain("The schedule parameters are since");
  // …while a schedule parameter updated at the end is the watermark, not a defect.
  expect(by("schedule-parameter-updated")[0]).toContain("persists and becomes the input of the next run");
  expect(facts.some((f) => f.message.includes("Variable since"))).toBe(false);

  expect(by("router-without-default")[0]).toContain('continues at label l1 "AssignEndVars"');
  expect(by("invoke-response-unread")[0]).toContain("SendThing, POST");
  expect(by("catch-only-logs")[0]).toContain('scope "ScopeSend"');
  expect(by("literal-status")[0]).toContain('literal "S" to process_status');
  expect(by("endpoint-literal")[0]).toContain("https://host.example/service");
  expect(by("csfkey-mismatch")[0]).toContain("(aaaaaaaa…) and connection CONN (bbbbbbbb…)");
  expect(by("csfkey-mismatch")[0]).toContain("not a secret");
  expect(by("dvm-contents")[0]).toContain("Not looked up by any transform here: Ambiente.");
});

test("a non-OIC archive yields no facts rather than failing", () => {
  expect(analyzeOic([{ path: "flow.xml", text: "<root/>" }])).toEqual([]);
  expect(analyzeOic([{ path: "x/PROJECT-INF/project.xml", text: "not xml <" }])).toEqual([]);
});

test("a review built from stored parts carries the facts and tells the model how to use them", () => {
  const parts = sources.map((s, index) => ({
    id: `k${index}`, documentId: "d", projectId: "p", index, tokens: 1,
    text: `Source "demo.iar" / ${JSON.stringify(s.path)} [1:1-2:1, end exclusive]\n${s.text}`,
    source: { path: s.path, startLine: 1, endLine: 2, startColumn: 1, endColumn: 1 },
  }));
  const facts = archiveFacts("d", parts);
  expect(facts.map((f) => f.message)).toEqual(analyzeOic(sources).map((f) => f.message));
  const doc = { name: "demo.iar", review: { files: [], findings: [], dependencies: [] } } as unknown as Document;
  const excerpt = reviewExcerpt(doc, [], reviewCoverage(doc, [], facts));
  expect(excerpt).toContain('"staticFacts"');
  expect(excerpt).toContain("Treat them as verified observations");
});

test("report parameters are checked against the names the report echoes in DATA_DS", () => {
  const report = (names: string[]) => [
    { path: `${P}PROJECT-INF/project.xml`, text: project },
    { path: `${P}resources/processor_30/g/run.xsl`, text: `<tns:parameterNameValues>${names.map((n) => `<tns:item><tns:name><xsl:value-of select="&quot;${n}&quot;"/></tns:name></tns:item>`).join("")}</tns:parameterNameValues>` },
    { path: `${P}resources/processor_60/g/nxsdmetadata.properties`, text: "DATA_DS P_PERSON_NUMBER P_INTEGRATION_DATE" },
  ];
  const rule = (names: string[]) => analyzeOic(report(names)).filter((f) => f.rule === "report-parameter-names");
  expect(rule(["personNumber", "integrationDate"])[0]?.message).toContain("so personNumber, integrationDate would not filter the report");
  expect(rule(["p_person_number", "p_integration_date"])).toEqual([]);
});
