import { REFERENCE_KINDS } from "./types";
import type { Reference, ReferenceKind, Referenceable } from "./types";
import { workspace } from "./workspace";

/*
 * The `@kind("target")` grammar from the PRD's "Feature: References".
 *
 * Pass 1 of the resolver (parse) lives here and runs on every keystroke, so it
 * stays a single regex over the raw string — no tokenizer, no AST.
 */

const KIND_ALTERNATION = REFERENCE_KINDS.join("|");

/** Matches `@chat("Architecture")`, `@chat('Architecture')` and `@chat(Architecture)`. */
const REFERENCE_RE = new RegExp(
  `@(${KIND_ALTERNATION})\\(\\s*(?:"([^"]*)"|'([^']*)'|([^)]*?))\\s*\\)`,
  "g",
);

/** Matches a reference the user is still typing, for the autocomplete popup. */
const PARTIAL_RE = new RegExp(
  `@(${KIND_ALTERNATION})?\\(?\\s*(?:"([^"]*)|'([^']*)|([^)"']*))?$`,
);

export function parseReferences(text: string): Reference[] {
  const refs: Reference[] = [];
  REFERENCE_RE.lastIndex = 0;

  let match: RegExpExecArray | null;
  while ((match = REFERENCE_RE.exec(text)) !== null) {
    const target = (match[2] ?? match[3] ?? match[4] ?? "").trim();
    refs.push({
      kind: match[1] as ReferenceKind,
      target,
      entityId: bind(match[1] as ReferenceKind, target)?.id,
      start: match.index,
      end: match.index + match[0].length,
    });
  }
  return refs;
}

/**
 * What the user is typing right now, if the caret sits inside an unclosed
 * reference. Returns null when the caret is in ordinary prose.
 */
export interface PartialReference {
  /** Undefined while the user has typed `@` but no kind yet. */
  kind?: ReferenceKind;
  /** Text typed inside the parens so far. */
  query: string;
  /** Offset of the leading `@`. */
  start: number;
  /** True once the opening paren exists. */
  open: boolean;
}

export function parsePartial(
  text: string,
  caret: number,
): PartialReference | null {
  const head = text.slice(0, caret);

  // A closed reference before the caret means we are not inside one.
  const at = head.lastIndexOf("@");
  if (at === -1) return null;
  if (head.slice(at).includes(")")) return null;
  // `@` must start a token.
  if (at > 0 && /[\w)"']/.test(head[at - 1]!)) return null;

  const match = PARTIAL_RE.exec(head);
  if (!match) return null;

  return {
    kind: match[1] as ReferenceKind | undefined,
    query: (match[2] ?? match[3] ?? match[4] ?? "").trim(),
    start: at,
    open: head.slice(at).includes("("),
  };
}

/* ---------------------------------------------------------------------- */
/* The referenceable index                                                  */
/* ---------------------------------------------------------------------- */

/**
 * Everything `@…()` can point at. In production this is a query against the
 * project index; here it is derived from the live workspace graph.
 */
export function buildIndex(projectId: string): Referenceable[] {
  const items: Referenceable[] = [];
  const { chats, projects, documents } = workspace();

  for (const chat of chats) {
    if (chat.projectId !== projectId) continue;
    items.push({
      id: chat.id,
      kind: "chat",
      label: chat.title,
      hint: chat.modelId,
      projectId,
    });
  }

  for (const project of projects) {
    items.push({
      id: project.id,
      kind: "project",
      label: project.name,
      hint: project.description,
      projectId: project.id,
    });
  }

  for (const doc of documents) {
    if (doc.projectId !== projectId) continue;
    items.push({
      id: doc.id,
      kind: "document",
      label: doc.name,
      hint: `${doc.kind} · ${doc.tokens.toLocaleString()} tokens`,
      projectId,
    });
  }

  return items;
}

/** Every project's entities, for global binding and search. */
function allReferenceables(): Referenceable[] {
  return workspace().projects.flatMap((p) => buildIndex(p.id));
}

function bind(kind: ReferenceKind, target: string): Referenceable | undefined {
  if (!target) return undefined;
  const needle = target.toLowerCase();
  return allReferenceables().find(
    (item) => item.kind === kind && item.label.toLowerCase() === needle,
  );
}

/**
 * Autocomplete candidates for a partial reference. Subsequence match rather
 * than prefix, so `arch` finds "System Architecture".
 */
export function suggest(
  partial: PartialReference,
  projectId: string,
  limit = 8,
): Referenceable[] {
  const pool = buildIndex(projectId);
  const query = partial.query.toLowerCase();

  const candidates = partial.kind
    ? pool.filter((item) => item.kind === partial.kind)
    : pool;

  if (!query) return candidates.slice(0, limit);

  return candidates
    .map((item) => ({ item, score: subsequenceScore(item.label, query) }))
    .filter((r) => r.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((r) => r.item);
}

/** Higher is better; 0 means no match. Contiguous runs and word starts win. */
function subsequenceScore(haystack: string, needle: string): number {
  const h = haystack.toLowerCase();
  let score = 0;
  let hi = 0;
  let streak = 0;

  for (const ch of needle) {
    const found = h.indexOf(ch, hi);
    if (found === -1) return 0;
    streak = found === hi ? streak + 1 : 0;
    score += 1 + streak * 2 + (found === 0 || h[found - 1] === " " ? 3 : 0);
    hi = found + 1;
  }
  // Prefer shorter labels among equal matches.
  return score + Math.max(0, 20 - haystack.length) / 10;
}

/** Kinds that resolve against seeded data today; the rest are grammar-only. */
export const IMPLEMENTED_KINDS = new Set<ReferenceKind>([
  "chat",
  "project",
  "document",
]);

export function formatReference(kind: ReferenceKind, label: string): string {
  return `@${kind}("${label}")`;
}
