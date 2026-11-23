import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { encodeVector, setEmbedderForTests } from "../lib/embeddings";
import { BOOKS, FAQ_REWRITE_PROMPT, faqContext, parseBookIndex, parseFaqIndex, rankFaqs, resetFaqCache, words } from "../lib/oracle-faq";

// Same markup as docs.oracle.com/.../faqpr/toc.htm, trimmed (titles wrap across lines there).
const toc = `<a href="index.html">Title and Copyright Information</a>
<a href="what-s-the-person-number-used-for.html#u1">What&rsquo;s the Person Number used for?</a>
<a href="how-can-i-enter-a-custom-person-number.html#u2">How can I enter a custom Person Number?</a>
<a href="can-i-load-legacy-person-numbers-when-the-person-number-generation-method-is-set-to-automatic.html#u3">Can I load legacy Person Numbers when the Person Number Generation Method is set to
                        Automatic?</a>
<a href="how-do-i-hide-buttons-on-redwood-workforce-structures-pages.html#u4">How do I hide buttons on Redwood workforce structures pages?</a>
<a href="how-do-i-default-a-country-when-creating-locations.html#u5">How do I default a country when creating locations?</a>`;
const legacy = "Can I load legacy Person Numbers when the Person Number Generation Method is set to Automatic?";
const pages: Record<string, string> = {
  "faq/toc.htm": toc,
  "faq/can-i-load-legacy-person-numbers-when-the-person-number-generation-method-is-set-to-automatic.html":
    `<html><head><script>var x = 1;</script></head><body><h1>${legacy}</h1><nav>Global Human Resources Questions and Answers</nav><h2>${legacy}</h2>
<p>When you use HDL to load legacy Person Numbers for new employees, you don't need to switch the Person Number Generation Method from Automatic to Manual.</p></body></html>`,
};
const fetchPage = async (p: string) => { if (!(p in pages)) throw new Error(`HTTP 404 ${p}`); return pages[p]!; };

beforeEach(() => { resetFaqCache(); setEmbedderForTests(null); });
afterEach(() => { resetFaqCache(); setEmbedderForTests(null); });

describe("FAQ acervo", () => {
  test("parses the toc into question titles, one per page", () => {
    const faqs = parseFaqIndex(toc);
    expect(faqs.map((f) => f.page)).toHaveLength(5);
    expect(faqs[0]!.title).toBe("What's the Person Number used for?");
    expect(faqs[2]!.title).toBe(legacy);
  });

  test("a joined identifier meets the title words, and one common word alone is not enough", async () => {
    expect(words("PersonNumber").get("person")).toBe(1);
    expect(words("Person Numbers").get("personnumber")).toBe(2);
    const faqs = parseFaqIndex(toc);
    const asked = await rankFaqs("o personnumber do payload da API resourcesusers, eu consigo mandar um numero e ele aceita?", faqs);
    expect(asked.map((f) => f.page)).toContain("how-can-i-enter-a-custom-person-number.html");
    expect(asked.map((f) => f.page)).not.toContain("how-do-i-default-a-country-when-creating-locations.html");
    expect(await rankFaqs("Como ver locations no Fusion?", faqs)).toEqual([]); // "locations" alone
  });

  test("Person Number regression: the HDL question gets the legacy FAQ text, scoped, with its URL", async () => {
    const found = await faqContext({ question: "Na migração por HDL, preciso preservar os números de pessoa do legado. A geração de Person Number está em Automatic. Preciso mudar para Manual?", fetchPage });
    expect(found!.dictionary.tables[0]).toEqual({ name: `FAQ: ${legacy}`, url: "https://docs.oracle.com/en/cloud/saas/human-resources/faqpr/can-i-load-legacy-person-numbers-when-the-person-number-generation-method-is-set-to-automatic.html" });
    expect(found!.context).toContain("you don't need to switch the Person Number Generation Method from Automatic to Manual");
    expect(found!.context).toContain("do not extend it to another channel such as REST");
    expect(found!.context).not.toContain("var x"); // page script stripped
    expect(found!.context).not.toContain("Global Human Resources Questions and Answers " + legacy); // header dropped
    // Pages that fail to load are left out rather than failing the turn.
    expect(found!.dictionary.tables.map((t) => t.name)).not.toContain("FAQ: What's the Person Number used for?");
  });

  test("a question that ranks no page is rewritten in English once and ranked again", async () => {
    const question = "Dá pra subir as matrículas antigas sem trocar pra digitação à mão?";
    expect(await rankFaqs(question, parseFaqIndex(toc))).toEqual([]);
    const asked: string[] = [];
    const found = await faqContext({ question, fetchPage, rewrite: async (q) => { asked.push(q); return "load legacy Person Numbers Automatic generation method"; } });
    expect(asked).toEqual([question]);
    expect(found!.dictionary.tables[0]!.name).toBe(`FAQ: ${legacy}`);
    // NONE, a failed call or a short greeting leave the question without pages.
    expect(await faqContext({ question, fetchPage, rewrite: async () => "NONE" })).toBeNull();
    expect(await faqContext({ question, fetchPage, rewrite: async () => { throw new Error("429"); } })).toBeNull();
    const greeting: string[] = [];
    await faqContext({ question: "Olá, tudo bem?", fetchPage, rewrite: async (q) => { greeting.push(q); return ""; } });
    expect(greeting).toEqual([]);
    expect(FAQ_REWRITE_PROMPT).toContain("NONE");
  });

  test("with the local model loaded, a Portuguese question reaches an English title by meaning plus one shared word", async () => {
    const faqs = parseFaqIndex(toc);
    const question = "como esconder botões nas páginas Redwood?";
    expect(await rankFaqs(question, faqs)).toEqual([]); // words alone: only "redwood" is shared
    setEmbedderForTests(async (texts) => texts.map((t) => encodeVector(/button|botõ/i.test(t) ? [1, 0] : [0, 1])));
    expect((await rankFaqs(question, faqs)).map((f) => f.page)).toEqual(["how-do-i-hide-buttons-on-redwood-workforce-structures-pages.html"]);
    // No shared word at all (the 2026-11-12 app run missed the FAQ this way): a strong vector alone is enough.
    const migration = "Queremos manter a numeração antiga dos funcionários migrados; a numeração está automática. Precisa trocar para manual?";
    resetFaqCache(); // title vectors are kept for the session
    setEmbedderForTests(async (texts) => texts.map((t) => encodeVector(/legacy|numeração antiga/i.test(t) ? [1, 0] : [0, 1])));
    expect((await rankFaqs(migration, faqs)).map((f) => f.page)).toEqual(["can-i-load-legacy-person-numbers-when-the-person-number-generation-method-is-set-to-automatic.html"]);
  });

  test("the implementing guide (faigh) is indexed by topic titles and read alongside the FAQs", async () => {
    const guideToc = `<a href="index.html">Title</a><a href="person-number-generation-methods.html">Person Number Generation Methods</a>
<a href="position-synchronization.html">Position Synchronization</a>`;
    expect(parseBookIndex(guideToc, BOOKS[1]).map((f) => f.title)).toEqual(["Person Number Generation Methods", "Position Synchronization"]);
    const guide: Record<string, string> = {
      "faigh/toc.htm": guideToc,
      "faigh/person-number-generation-methods.html": "<h1>Person Number Generation Methods</h1><p>You can select one of the following person number generation methods for your enterprise on the Edit Enterprise page of the Manage Enterprise HCM Information task.</p>",
    };
    const found = await faqContext({ question: "Onde configuro o Person Number Generation Method?", fetchPage: async (p) => guide[p] ?? fetchPage(p) });
    expect(found!.dictionary.tables).toContainEqual({ name: "Implementing Global HR: Person Number Generation Methods", url: "https://docs.oracle.com/en/cloud/saas/human-resources/faigh/person-number-generation-methods.html" });
    expect(found!.context).toContain("Manage Enterprise HCM Information");
    // One book down leaves the other searchable.
    resetFaqCache();
    const onlyFaq = await faqContext({ question: "Person Number Generation Method legacy HDL", fetchPage: async (p) => p.startsWith("faigh/") ? Promise.reject(new Error("404")) : fetchPage(p) });
    expect(onlyFaq!.dictionary.tables.map((t) => t.name)).toEqual([`FAQ: ${legacy}`]);
  });

  test("the setting's setup page survives the cut next to the FAQ that names it", async () => {
    // The real titles that tied at 4 on 2026-11-12, with the setup page dropped by MAX_FAQS.
    const faqs = parseFaqIndex(toc).concat(parseBookIndex(`<a href="person-number-generation-methods.html">Person Number Generation Methods</a>
<a href="what-happens-when-the-person-number-is-generated-upon-final-save.html">What happens when the person number is generated upon final save?</a>`, BOOKS[1]));
    const ranked = await rankFaqs("Na migração por HDL, preciso preservar os números de pessoa do legado. A geração de Person Number está em Automatic. Preciso mudar para Manual?", faqs);
    expect(ranked.map((f) => f.page)).toContain("person-number-generation-methods.html");
    // With the local model loaded, the setup page sits well behind the legacy FAQ by meaning; its word match keeps it.
    resetFaqCache();
    setEmbedderForTests(async (texts) => texts.map((t) => encodeVector(/legacy|migração/i.test(t) ? [1, 0] : /^Person Number Generation Methods$/.test(t) ? [0.9, 0.436] : [0, 1])));
    const withVectors = await rankFaqs("Na migração por HDL, preciso preservar os números de pessoa do legado. A geração de Person Number está em Automatic. Preciso mudar para Manual?", faqs);
    expect(withVectors.map((f) => f.page)).toContain("person-number-generation-methods.html");
    // The app question of 2026-11-12 says neither "Person Number" nor "geração": Portuguese order, Portuguese words.
    const asked = words("Hoje a numeração de pessoas está automática.", true);
    expect(asked.get("personnumber")).toBe(2);
    expect(asked.has("automatic")).toBe(true);
    expect(words("numeração de pessoas").has("personnumber")).toBe(false); // titles keep their own order
  });

  test("Portuguese words reach English titles through the glossary, and product names don't count", () => {
    expect(words("Como apagar registros carregados pelo HDL?").has("delet")).toBe(true);
    expect(words("número de pessoa").has("person")).toBe(true);
    expect(words("Oracle Fusion Cloud").size).toBe(0);
    // Same crude stem on both sides, and "HCM Data Loader" also reads as HDL.
    const title = words("Data Deletion Using HCM Data Loader");
    expect(title.has("hdl")).toBe(true);
    expect([...words("apagar pelo HDL")].filter(([w]) => title.has(w)).map(([w]) => w).sort()).toEqual(["delet", "hdl"]);
  });

  test("a page with no shared word gets in by meaning alone, but only one", async () => {
    const faqs = parseFaqIndex(toc);
    setEmbedderForTests(async (texts) => texts.map((t) => encodeVector(/legacy|custom|fluxo legado/i.test(t) ? [1, 0] : [0, 1])));
    expect(await rankFaqs("fluxo legado de migração", faqs)).toHaveLength(1);
  });

  test("an unreachable book (web build, offline) adds nothing", async () => {
    expect(await faqContext({ question: "Person Number legacy HDL", fetchPage: async () => { throw new Error("offline"); } })).toBeNull();
  });
});
