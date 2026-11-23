import { Node, type Editor, type JSONContent } from "@tiptap/core";
import type { Node as PMNode } from "@tiptap/pm/model";
import {
  NodeViewWrapper,
  ReactNodeViewRenderer,
  type NodeViewProps,
} from "@tiptap/react";
import { MentionChip } from "@/components/chat/ReferenceText";
import { formatReference, parseReferences } from "@/lib/references";
import type { ReferenceKind } from "@/lib/types";

/*
 * The composer document: ProseMirror text with bound mentions as atomic inline
 * nodes. The prompt that leaves the composer is still the canonical
 * `@kind("label")` string — `serialize` is the only bridge, so the resolver,
 * cost preview, drafts and sent messages never learn there is an editor.
 *
 * `document` mentions are not painted inline: they ride as attachment cards
 * above the field, so they live beside the editor as a plain label list.
 */

export const ELEVATED_KIND: ReferenceKind = "document";

const leafText = (node: PMNode): string =>
  node.type.name === "mention"
    ? formatReference(node.attrs.kind, node.attrs.label)
    : node.type.name === "hardBreak"
      ? "\n"
      : "";

/** Canonical text of the whole editor. */
export function serialize(doc: PMNode): string {
  return doc.textBetween(0, doc.content.size, "\n", leafText);
}

/** Canonical offset of a document position — what `parsePartial` reads. */
export function canonicalOffset(doc: PMNode, pos: number): number {
  return doc.textBetween(0, pos, "\n", leafText).length;
}

/** Canonical draft → editor content plus the elevated document labels. */
export function fromCanonical(text: string): {
  content: JSONContent;
  docs: string[];
} {
  const docs: string[] = [];
  const inline: JSONContent[] = [];
  const pushText = (chunk: string) =>
    chunk.split("\n").forEach((line, i) => {
      if (i > 0) inline.push({ type: "hardBreak" });
      if (line) inline.push({ type: "text", text: line });
    });

  let cursor = 0;
  for (const ref of parseReferences(text)) {
    if (!ref.entityId || !ref.target) continue; // unbound stays prose
    pushText(text.slice(cursor, ref.start));
    if (ref.kind === ELEVATED_KIND) {
      if (!docs.includes(ref.target)) docs.push(ref.target);
    } else {
      inline.push({
        type: "mention",
        attrs: { kind: ref.kind, label: ref.target },
      });
    }
    cursor = ref.end;
  }
  pushText(text.slice(cursor));

  return {
    content: { type: "doc", content: [{ type: "paragraph", content: inline }] },
    docs,
  };
}

/** Editor text + document cards → the prompt that is sent. */
export function joinPrompt(text: string, docs: string[]): string {
  const tail = docs.map((d) => formatReference(ELEVATED_KIND, d)).join(" ");
  if (!tail) return text;
  return text.trim() ? `${text.replace(/\s+$/, "")} ${tail}` : tail;
}

/**
 * Turn any bound `@kind("…")` typed or pasted as plain text into a chip.
 * Returns the document labels it lifted out of the text.
 */
export function bindTypedReferences(editor: Editor): string[] {
  const { state } = editor;
  const hits: { from: number; to: number; kind: ReferenceKind; label: string }[] = [];
  state.doc.descendants((node, pos) => {
    if (!node.isText || !node.text?.includes("@")) return;
    for (const ref of parseReferences(node.text)) {
      if (!ref.entityId || !ref.target) continue;
      hits.push({
        from: pos + ref.start,
        to: pos + ref.end,
        kind: ref.kind,
        label: ref.target,
      });
    }
  });
  if (hits.length === 0) return [];

  const lifted: string[] = [];
  const tr = state.tr;
  for (const hit of hits.reverse()) {
    if (hit.kind === ELEVATED_KIND) {
      tr.delete(hit.from, hit.to);
      lifted.push(hit.label);
    } else {
      tr.replaceWith(
        hit.from,
        hit.to,
        state.schema.nodes.mention!.create({ kind: hit.kind, label: hit.label }),
      );
    }
  }
  editor.view.dispatch(tr);
  return lifted.reverse();
}

/**
 * Document range of the in-progress `@…` token ending at the caret.
 * The partial is plain text by construction (a chip's canonical form contains
 * `)`, which `parsePartial` rejects), so canonical lengths equal positions.
 * The end extends past the caret over the rest of the token — clicking the
 * popup can leave the caret behind a typed `"` or `(`.
 */
export function partialRange(
  editor: Editor,
  partialStart: number,
  caret: number,
): { from: number; to: number } {
  const { selection } = editor.state;
  const from = selection.from - (caret - partialStart);
  const $to = selection.$from;
  const after = $to.parent
    .textBetween($to.parentOffset, $to.parent.content.size, undefined, "￼")
    .split("￼")[0]!;
  const token = editor.state.doc.textBetween(from, selection.from) + after;
  const m =
    token.match(/^@\w+\(\s*(?:"[^"]*|'[^']*|[^)"']*)/) ?? token.match(/^@\w*/);
  const end = Math.max(caret - partialStart, m ? m[0].length : 0);
  return { from, to: from + end };
}

/* ---------------------------------------------------------------------- */

export interface MentionOptions {
  /** Chip tooltip; read on every render so it follows the current model. */
  describe: (kind: ReferenceKind, label: string) => string;
}

export const Mention = Node.create<MentionOptions>({
  name: "mention",
  group: "inline",
  inline: true,
  atom: true,
  selectable: true,

  addOptions() {
    return { describe: (kind, label) => formatReference(kind, label) };
  },

  addAttributes() {
    return {
      kind: { default: "chat", parseHTML: (el) => el.getAttribute("data-kind") },
      label: { default: "", parseHTML: (el) => el.getAttribute("data-label") },
    };
  },

  parseHTML() {
    return [{ tag: "span[data-mention]" }];
  },

  renderHTML({ node }) {
    return [
      "span",
      { "data-mention": "", "data-kind": node.attrs.kind, "data-label": node.attrs.label },
      node.attrs.label,
    ];
  },

  // Plain-text copy carries the canonical form, so pasting it back rebinds.
  renderText({ node }) {
    return formatReference(node.attrs.kind, node.attrs.label);
  },

  addNodeView() {
    return ReactNodeViewRenderer(MentionView, { as: "span" });
  },
});

function MentionView({ node, selected, extension }: NodeViewProps) {
  const { kind, label } = node.attrs as { kind: ReferenceKind; label: string };
  return (
    <NodeViewWrapper as="span" className="inline">
      <MentionChip
        kind={kind}
        label={label}
        selected={selected}
        title={(extension.options as MentionOptions).describe(kind, label)}
      />
    </NodeViewWrapper>
  );
}
