import { describe, expect, test } from "bun:test";
import { getSchema } from "@tiptap/core";
import { Node as PMNode } from "@tiptap/pm/model";
import Document from "@tiptap/extension-document";
import Paragraph from "@tiptap/extension-paragraph";
import Text from "@tiptap/extension-text";
import HardBreak from "@tiptap/extension-hard-break";
import {
  Mention,
  canonicalOffset,
  fromCanonical,
  joinPrompt,
  serialize,
} from "../components/chat/composer-editor";

const schema = getSchema([Document, Paragraph, Text, HardBreak, Mention]);
const load = (text: string) => {
  const { content, docs } = fromCanonical(text);
  return { doc: PMNode.fromJSON(schema, content), docs };
};

// The editor is only a view: the canonical string is the contract the
// resolver, cost preview, drafts and sent messages all read.
describe("composer canonical bridge", () => {
  test("bound mentions become chips and serialize back unchanged", () => {
    const text = 'compare @chat("Architecture") com isso\nsegunda linha';
    const { doc, docs } = load(text);
    expect(docs).toEqual([]);
    let chips = 0;
    doc.descendants((n) => void (n.type.name === "mention" && chips++));
    expect(chips).toBe(1);
    expect(serialize(doc)).toBe(text);
  });

  test("unbound references stay prose", () => {
    const text = 'veja @chat("Não existe")';
    const { doc } = load(text);
    let chips = 0;
    doc.descendants((n) => void (n.type.name === "mention" && chips++));
    expect(chips).toBe(0);
    expect(serialize(doc)).toBe(text);
  });

  test("caret offset counts a chip as its canonical length", () => {
    const { doc } = load('@chat("Architecture") x');
    // doc(0) > paragraph(1) > mention(1..2) > " x"
    expect(canonicalOffset(doc, 2)).toBe('@chat("Architecture")'.length);
  });

  test("document cards are appended to the prompt", () => {
    expect(joinPrompt("resuma ", ["a.md"])).toBe('resuma @document("a.md")');
    expect(joinPrompt("", ["a.md", "b.md"])).toBe('@document("a.md") @document("b.md")');
    expect(joinPrompt("só texto", [])).toBe("só texto");
  });
});
