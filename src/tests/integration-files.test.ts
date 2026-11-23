import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { strToU8, zipSync } from "fflate";
import { ACCEPT_ATTRIBUTE, ensureIndex, indexDocument, isReadable, readFile, resetIndexes, toDocument } from "../lib/documents";
import { integrationChunks, readArchive, reviewExcerpt, reviewTokens, selectReviewChunks } from "../lib/integration-files";
import { compose } from "../lib/context-composer";
import { buildMessages } from "../lib/prompt-builder";
import { publishWorkspace, resetWorkspace } from "../lib/workspace";
import { buildExport, toJson } from "../lib/export";
import { parseImport } from "../lib/import";
import { browserStore } from "../lib/persistence/browser";
import { workspace } from "../lib/workspace";
import { useStore } from "../lib/store";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { IntegrationSources } from "../components/chat/IntegrationSources";

const ROOT = `${import.meta.dir}/fixtures/oic-review`;
const fixture = async () => Object.fromEntries(await Promise.all([
  "flow.xml", "Resources/request.xsl", "Resources/service.wsdl", "Resources/target.xsd",
].map(async (path) => [path, new Uint8Array(await Bun.file(`${ROOT}/${path}`).arrayBuffer())])));
const archive = (files: Record<string, Uint8Array>, level: 0 | 6 = 6) =>
  new File([zipSync(files, { level })], "demo.iar");

class MemoryStorage {
  private map = new Map<string, string>();
  getItem(key: string) { return this.map.get(key) ?? null; }
  setItem(key: string, value: string) { this.map.set(key, String(value)); }
  removeItem(key: string) { this.map.delete(key); }
}

beforeEach(() => {
  globalThis.localStorage = new MemoryStorage() as unknown as Storage;
  resetIndexes();
});
afterEach(() => { resetWorkspace(); resetIndexes(); });

describe("integration import", () => {
  test.each([0, 6] as const)("reads stored and deflated archives (level %i) with exact source locations", async (level) => {
    const input = await fixture();
    const { document, chunks } = toDocument(await readFile(archive(input, level)), "p-1");
    expect(document.review?.files).toHaveLength(4);
    expect(chunks).toHaveLength(4);
    const mapping = chunks.find((c) => c.source?.path === "Resources/request.xsl")!;
    expect(mapping.text).toContain("/w:workers/w:worker/w:personNumber");
    expect(mapping.source?.startLine).toBe(1);
    expect(mapping.source?.endLine).toBe(10);
    expect(document.review?.findings).toEqual([{
      path: "Resources/request.xsl", line: 3,
      message: "Referenced file not supplied in this document/archive: missing-common.xsl. It may exist in another project document or in the Oracle environment.",
    }]);
    expect(document.review?.dependencies).toContainEqual({
      path: "Resources/service.wsdl", line: 5, target: "target.xsd", status: "included",
    });
    expect(document.tokens).toBe(chunks.reduce((sum, c) => sum + c.tokens, 0));
  });

  test.each(["xml", "xsl", "xslt", "xsd", "wsdl"])("accepts standalone .%s with source text", async (ext) => {
    expect(isReadable(`example.${ext}`)).toBe(true);
    expect(ACCEPT_ATTRIBUTE).toContain(`.${ext}`);
    const { document, chunks } = toDocument(await readFile(new File(["<root/>"], `example.${ext}`)), "p-1");
    expect(document.review?.files[0]?.path).toBe(`example.${ext}`);
    expect(chunks[0]?.text).toContain("<root/>");
  });

  test("reports malformed XML and prevents DTD/entity processing", async () => {
    const malformed = toDocument(await readFile(new File(["<root>\n<child></root>"], "bad.xml")), "p-1");
    expect(malformed.document.review?.findings[0]?.message).toContain("XML inspection");
    expect(malformed.document.review?.findings[0]?.line).toBe(2);
    const dtd = toDocument(await readFile(new File([
      '<?xml version="1.0"?>\n<!DOCTYPE root [<!ENTITY x SYSTEM "https://example.invalid/secret">]><root>&x;</root>',
    ], "entity.xml")), "p-1");
    expect(dtd.document.review?.findings[0]?.line).toBe(2);
    expect(dtd.document.review?.findings[0]?.message).toContain("DTD/entity declarations are not processed");
  });

  test("keeps external dependencies unverified and resolves local references relative to the source", () => {
    const text = '<x:schema xmlns:x="http://www.w3.org/2001/XMLSchema">\n<x:include schemaLocation="../types.xsd"/>\n<x:import schemaLocation="https://example.invalid/types.xsd"/>\n</x:schema>';
    const { review } = integrationChunks([
      { path: "schemas/main.xsd", bytes: text.length, text },
      { path: "types.xsd", bytes: 10, reason: "Unsupported format" },
    ], "demo.iar", "doc-1", "p-1");
    expect(review.dependencies.map((d) => d.status)).toEqual(["skipped", "external"]);
    expect(review.findings).toEqual([]);
  });

  test("splits long/minified sources without losing text or original line/column locations", () => {
    const text = `<root>${"a".repeat(4000)}</root>\n<tail/>`;
    const { chunks } = integrationChunks([{ path: "long.xml", bytes: text.length, text }], "demo.iar", "doc-1", "p-1");
    expect(chunks.length).toBeGreaterThan(2);
    const original = chunks.map((c) => c.text.slice(c.text.indexOf("\n") + 1)).join("");
    expect(original).toBe(text);
    expect(chunks[1]?.source?.startColumn).toBe(1601);
    expect(chunks[1]?.source?.startLine).toBe(1);
  });

  test("inventories nested archives, unsupported files and invalid text without indexing their bytes", async () => {
    const file = archive({
      "flow.xml": strToU8("<root/>"), "nested.iar": zipSync({ "inner.xml": strToU8("<root/>") }),
      "library.jar": new Uint8Array([0, 1]), "bad.xml": new Uint8Array([0xff, 0x00]),
    });
    const { document, chunks } = toDocument(await readFile(file), "p-1");
    expect(document.review?.files).toHaveLength(4);
    expect(document.review?.files.filter((f) => f.reason)).toHaveLength(3);
    expect(chunks).toHaveLength(1);
    expect(reviewExcerpt(document, chunks)).toContain('"coverage":"skipped"');
  });

  test.each(["../escape.xml", "/absolute.xml", "C:/drive.xml", "dir\\escape.xml"])("rejects unsafe path %s", async (path) => {
    await expect(readFile(archive({ [path]: strToU8("<root/>") }))).rejects.toThrow("unsafe path");
  });

  test("rejects invalid/truncated archives and excessive entry counts/expanded sizes", async () => {
    await expect(readFile(new File(["not a zip"], "bad.iar"))).rejects.toThrow("Invalid");
    const bytes = zipSync({ "flow.xml": strToU8("<root/>") });
    expect(() => readArchive(bytes.slice(0, -12))).toThrow();
    const many = Object.fromEntries(Array.from({ length: 513 }, (_, i) => [`${i}.xml`, strToU8("<root/>")]));
    await expect(readFile(archive(many))).rejects.toThrow("512 entries");
    await expect(readFile(archive({ "huge.xml": new Uint8Array(21 * 1024 * 1024) }))).rejects.toThrow("expanded limit");
  });

  test("rejects duplicate names and forged uncompressed sizes", () => {
    const duplicates = zipSync({ "a.xml": strToU8("<a/>"), "b.xml": strToU8("<b/>") });
    for (let i = 0; i < duplicates.length - 4; i++) {
      if (duplicates[i] === 98 && duplicates[i + 1] === 46 && duplicates[i + 2] === 120
        && duplicates[i + 3] === 109 && duplicates[i + 4] === 108) duplicates[i] = 97;
    }
    expect(() => readArchive(duplicates)).toThrow("Duplicate archive path");
    const forged = zipSync({ "flow.xml": strToU8(`<root>${"a".repeat(100_000)}</root>`) });
    const view = new DataView(forged.buffer);
    for (let i = 0; i < forged.length - 46; i++) {
      const signature = view.getUint32(i, true);
      if (signature === 0x04034b50) view.setUint32(i + 22, 1, true);
      if (signature === 0x02014b50) view.setUint32(i + 24, 1, true);
    }
    expect(() => readArchive(forged)).toThrow("declared size");
  });

  test("handles UTF-16 BOM and rejects invalid UTF-8 instead of quoting replacement characters", async () => {
    const utf16 = new Uint8Array([0xff, 0xfe, ...new Uint8Array(new Uint16Array(Array.from("<root/>", (c) => c.charCodeAt(0))).buffer)]);
    const { chunks } = toDocument(await readFile(new File([utf16], "utf16.xml")), "p-1");
    expect(chunks[0]?.text).toContain("<root/>");
    await expect(readFile(new File([new Uint8Array([0xff])], "bad.xml"))).rejects.toThrow();
  });

  test("honors declared Windows-1252 encoding used by Oracle's exported schemas", async () => {
    const xml = '<?xml version="1.0" encoding="windows-1252"?><root>a\u00e7\u00e3o</root>';
    const bytes = Uint8Array.from(xml, (c) => c.charCodeAt(0));
    const { document, chunks } = toDocument(await readFile(new File([bytes], "legacy.xsd")), "p-1");
    expect(chunks[0]?.text).toContain("ação");
    expect(document.review?.findings).toEqual([]);
  });
});

test("a named archive reaches the model with inventory, source findings, coverage and preserved backup metadata", async () => {
  const { document, chunks } = toDocument(await readFile(archive(await fixture())), "p-1");
  await browserStore.putChunks(document.id, chunks);
  await ensureIndex("p-1");
  const project = { id: "p-1", workspaceId: "ws-1", name: "Oracle", description: "", instructions: "", memoryTokens: 0 };
  const graph = { workspaces: [{ id: "ws-1", name: "Test" }], projects: [project], documents: [document], chats: [], messages: [], memory: [], decisions: [] };
  publishWorkspace(graph);
  const prompt = 'Revise @document("demo.iar")';
  const context = compose(prompt, "p-1", "claude-opus-5");
  const wire = buildMessages({ context, history: [], prompt, projectName: "Oracle" })[0]!.content as string;
  expect(wire).toContain("INTEGRATION_REVIEW_DATA");
  expect(wire).toContain('"coverage":"complete text supplied"');
  expect(wire).toContain('"path":"Resources/request.xsl","line":3');
  expect(wire).toContain("exact line/range");
  expect(wire).toContain("/w:workers/w:worker/w:personNumber");
  expect(context.chunks.filter((c) => c.id === document.id)).toHaveLength(1);
  const panel = renderToStaticMarkup(createElement(IntegrationSources, { context }));
  expect(panel).toContain("Arquivos e cobertura");
  expect(panel).toContain("Resources/request.xsl:3");
  expect(panel).toContain("arquivo não fornecido");
  const backup = parseImport(toJson(buildExport({ ...graph, timeline: [], chunks, attachments: [] }, { app: "test", label: "test" })));
  expect(backup.documents[0]?.review).toEqual(document.review);
  expect(backup.chunks.map((c) => c.source)).toEqual(chunks.map((c) => c.source));
});

test("a named archive with a question still sends files that do not match its terms", async () => {
  const { document, chunks } = toDocument(await readFile(archive(await fixture())), "p-1");
  await browserStore.putChunks(document.id, chunks);
  await ensureIndex("p-1");
  const project = { id: "p-1", workspaceId: "ws-1", name: "Oracle", description: "", instructions: "", memoryTokens: 0 };
  publishWorkspace({ workspaces: [{ id: "ws-1", name: "Test" }], projects: [project], documents: [document], chats: [], messages: [], memory: [], decisions: [] });
  const context = compose('O que faz ReadWorkers em @document("demo.iar")?', "p-1", "claude-opus-5");
  const excerpt = context.chunks.find((c) => c.id === document.id)!.excerpt;
  expect(excerpt).toContain("ReadWorkers");
  expect(excerpt).toContain("/w:workers/w:worker/w:personNumber");
});

test("a named archive is not joined by retrieved fragments of a sibling export", async () => {
  const named = toDocument(await readFile(archive(await fixture())), "p-1");
  const sibling = toDocument({ ...(await readFile(archive(await fixture()))), name: "demo (1).iar" }, "p-1");
  await browserStore.putChunks(named.document.id, named.chunks);
  await browserStore.putChunks(sibling.document.id, sibling.chunks);
  await ensureIndex("p-1");
  const project = { id: "p-1", workspaceId: "ws-1", name: "Oracle", description: "", instructions: "", memoryTokens: 0 };
  publishWorkspace({ workspaces: [{ id: "ws-1", name: "Test" }], projects: [project], documents: [named.document, sibling.document], chats: [], messages: [], memory: [], decisions: [] });
  const context = compose('O que faz ReadWorkers em @document("demo.iar")?', "p-1", "claude-opus-5");
  expect(context.chunks.filter((c) => c.review).map((c) => c.label)).toEqual(["demo.iar"]);
});

test("a named archive review does not pull in other chats of the project", async () => {
  const { document, chunks } = toDocument(await readFile(archive(await fixture())), "p-1");
  await browserStore.putChunks(document.id, chunks);
  await ensureIndex("p-1");
  const project = { id: "p-1", workspaceId: "ws-1", name: "Oracle", description: "", instructions: "", memoryTokens: 0 };
  const chats = [{ id: "c-old", projectId: "p-1", title: "Revisão anterior ReadWorkers", createdAt: "2026-01-01", updatedAt: "2026-01-01" }];
  const messages = [{ id: "m-old", chatId: "c-old", role: "assistant", content: "Revisão de ReadWorkers: o gate nunca abre.", createdAt: "2026-01-01" }];
  publishWorkspace({ workspaces: [{ id: "ws-1", name: "Test" }], projects: [project], documents: [document], chats, messages, memory: [], decisions: [] } as never);
  expect(compose("Revise ReadWorkers", "p-1", "claude-opus-5").chunks.some((c) => c.kind === "chat")).toBe(true);
  expect(compose('Revise ReadWorkers em @document("demo.iar")', "p-1", "claude-opus-5").chunks.some((c) => c.kind === "chat")).toBe(false);
});

test("large reviews keep files represented and label omitted parts as partial or not supplied", async () => {
  const text = `<root>${"field value\n".repeat(9000)}</root>`;
  const sources = [{ path: "large.xml", text, bytes: text.length }, { path: "small.xml", text: "<small/>", bytes: 8 }];
  const { document, chunks } = toDocument({ name: "large.iar", kind: "code", text: "inventory", bytes: 100, sources }, "p-1");
  const selected = selectReviewChunks(chunks, document);
  expect(selected.some((c) => c.source?.path === "small.xml")).toBe(true);
  expect(selected.length).toBeLessThan(chunks.length);
  expect(Math.ceil(reviewExcerpt(document, selected).length / 4)).toBeLessThanOrEqual(12_000);
  expect(reviewExcerpt(document, selected)).toContain('"coverage":"partial text supplied"');
  expect(reviewExcerpt(document, [])).toContain('"coverage":"not supplied to model"');
  await ensureIndex("p-1");
  indexDocument("p-1", chunks);
  publishWorkspace({ ...workspace(), documents: [document] });
  const context = compose("field", "p-1", "claude-opus-5");
  expect(context.chunks.find((c) => c.id === document.id)?.excerpt).toContain('"coverage":"partial text supplied"');
});

test("IAR-shaped reviews give orchestration and mappings depth, and send identical files once", () => {
  const lines = (tag: string, n: number) => Array.from({ length: n }, (_, i) => `<${tag} id="${i}">${"x".repeat(60)}</${tag}>`).join("\n");
  const fault = "<xsd:schema xmlns:xsd=\"http://www.w3.org/2001/XMLSchema\"/>";
  const sources = [
    { path: "icspackage/project/A/PROJECT-INF/project.xml", text: `<p>\n${lines("step", 800)}\n</p>` },
    ...[350, 207, 248, 291].map((n) => ({ path: `resources/processor_${n}/req_${n}.xsl`, text: `<x>\n${lines("map", 120)}\n</x>` })),
    ...Array.from({ length: 60 }, (_, i) => ({ path: `resources/processor_${i}/stateinfo.json`, text: lines("meta", 30) })),
    ...[1, 2, 3, 4].map((n) => ({ path: `resources/application_${n}/ICSFault.xsd`, text: fault })),
  ].map((source) => {
    // Unique per file, except the deliberate ICSFault.xsd copies.
    const text = source.path.endsWith("ICSFault.xsd") ? source.text : `${source.text}\n<!-- ${source.path} -->`;
    return { path: source.path, text, bytes: text.length };
  });
  const { document, chunks } = toDocument({ name: "adp.iar", kind: "code", text: "inventory", bytes: 1, sources }, "p-1");
  const selected = selectReviewChunks(chunks, document);
  const sent = (path: RegExp) => selected.filter((c) => path.test(c.source!.path)).length;
  expect(sent(/project\.xml$/)).toBeGreaterThan(3);
  for (const n of [350, 207, 248, 291]) expect(sent(new RegExp(`req_${n}\\.xsl$`))).toBeGreaterThan(0);
  // Mappings outrank the 60 metadata files, which would otherwise take one part each first.
  expect(sent(/\.xsl$/)).toBeGreaterThan(sent(/stateinfo\.json$/));
  expect(sent(/ICSFault\.xsd$/)).toBe(1);
  expect(Math.ceil(reviewExcerpt(document, selected).length / 4)).toBeLessThanOrEqual(12_000);
  expect(reviewExcerpt(document, selected)).toContain("identical to resources/application_1/ICSFault.xsd; not resent");
});

test("the review budget follows the model's context, never below 12k", () => {
  const budget = reviewTokens("claude-opus-5");
  expect(budget).toBeGreaterThanOrEqual(12_000);
  const text = Array.from({ length: 6000 }, (_, i) => `<map id="${i}">${"x".repeat(60)}</map>`).join("\n");
  const { document, chunks } = toDocument({ name: "big.iar", kind: "code", text: "inventory", bytes: 1,
    sources: [{ path: "req.xsl", text, bytes: text.length }] }, "p-1");
  const small = selectReviewChunks(chunks, document);
  const large = selectReviewChunks(chunks, document, 48_000);
  expect(large.length).toBeGreaterThan(small.length * 3);
  expect(Math.ceil(reviewExcerpt(document, large).length / 4)).toBeLessThanOrEqual(48_000);
});

test("an archive that fits goes whole; router expressions outrank metadata; layout is dropped", () => {
  const lines = (n: number, tag: string) => Array.from({ length: n }, (_, i) => `<${tag} id="${i}">${"y".repeat(60)}</${tag}>`).join("\n");
  const sources = [
    { path: "PROJECT-INF/project.xml", text: lines(400, "step") },
    { path: "resources/processor_8/layout3.json", text: lines(50, "pos") },
    ...Array.from({ length: 150 }, (_, i) => ({ path: `resources/processor_${i}/stateinfo.json`, text: `${lines(20, "meta")}\n${i}` })),
    { path: "resources/processor_60/expr.properties", text: `condition=$personNumber != ''\n${lines(20, "cond")}` },
  ].map((source) => ({ ...source, bytes: source.text.length }));
  const { document, chunks } = toDocument({ name: "f.iar", kind: "code", text: "inventory", bytes: 1, sources }, "p-1");
  const whole = selectReviewChunks(chunks, document, 200_000);
  expect(whole.length).toBe(chunks.filter((c) => !c.source!.path.endsWith("layout3.json")).length);
  expect(selectReviewChunks([...chunks].reverse(), document, 200_000).map((c) => c.id)).toEqual(whole.map((c) => c.id));
  expect(selectReviewChunks(chunks, document).some((c) => c.source!.path.endsWith("expr.properties"))).toBe(true);
});

test("chat imports queue the archive mention and retain source metadata after persistence", async () => {
  useStore.getState().hydrate({ workspaces: [{ id: "ws-1", name: "Test" }], projects: [
    { id: "p-1", workspaceId: "ws-1", name: "Test", description: "", instructions: "", memoryTokens: 0 },
  ], chats: [], messages: [], memory: [], documents: [], decisions: [], timeline: [] });
  useStore.setState({ projectId: "p-1", documentMentionQueue: [] });
  const result = await useStore.getState().addFiles([archive(await fixture())]);
  expect(result.rejected).toEqual([]);
  expect(result.added).toHaveLength(1);
  expect(useStore.getState().documentMentionQueue).toEqual(["demo.iar"]);
  expect((await browserStore.loadChunks("p-1"))[0]?.source?.path).toBe("flow.xml");
  const again = await useStore.getState().addFiles([archive(await fixture())]);
  expect(again.added[0]?.name).toBe("demo.iar (2)");
  expect(useStore.getState().documentMentionQueue).toEqual(["demo.iar", "demo.iar (2)"]);
});

test("plain documents go whole when they fit and fall back to passages when they do not", async () => {
  const project = { id: "p-1", workspaceId: "ws-1", name: "P", description: "", instructions: "", memoryTokens: 0 };
  const load = async (text: string) => {
    const { document, chunks } = toDocument({ name: "brief.md", kind: "text", text, bytes: text.length }, "p-1");
    resetIndexes();
    await ensureIndex("p-1");
    indexDocument("p-1", chunks);
    publishWorkspace({ workspaces: [{ id: "ws-1", name: "Test" }], projects: [project], documents: [document], chats: [], messages: [], memory: [], decisions: [] });
    return chunks;
  };
  const docParts = (prompt: string) =>
    compose(prompt, "p-1", "claude-opus-5").chunks.filter((c) => c.kind === "document" && c.included);

  const small = await load(Array.from({ length: 30 }, (_, i) => `Paragraph ${i} about billing.\n\n${"filler ".repeat(200)}`).join("\n\n"));
  expect(small.length).toBeGreaterThan(DOCUMENT_PASSAGES);
  const whole = docParts("unrelated question");
  expect(whole).toHaveLength(small.length);
  expect(whole.map((c) => c.excerpt)).toEqual(small.map((c) => c.text));

  const huge = await load(`billing ${"filler ".repeat(200_000)}`);
  expect(huge.length).toBeGreaterThan(DOCUMENT_PASSAGES);
  expect(docParts("billing").length).toBeLessThanOrEqual(DOCUMENT_PASSAGES);
});
const DOCUMENT_PASSAGES = 4;
