import { workspace } from "./workspace";
import { cachedQuery, fuse } from "./embeddings";
import { hasVectors, scoreProject } from "./vectors";
import type { SearchResult } from "./types";

/*
 * Semantic search, per the PRD: "Not keyword matching. Meaning matching."
 *
 * Both halves, and the split is the point. Meaning comes from the vector index
 * (`vectors.ts`), which is what makes a chat about session cookies findable from
 * "login flow" — the case the synonym table this replaced could never reach,
 * because reaching it would mean writing down every pair of words two people
 * might use for one idea. Words come from term overlap, which is what makes
 * `p-atimo` and `ERR_MODULE_NOT_FOUND` findable — the case a model trained
 * on prose can never reach, because it has never seen either
 * string and puts both roughly where it puts all the other identifiers.
 *
 * `fuse` weights the two. The seven-entry synonym table is gone: it was a
 * hand-written approximation of the first half, and keeping it alongside the
 * real thing would mean those seven word pairs were scored by a different rule
 * than every other pair in the language.
 *
 * Synchronous, like `compose()`, and for the same reason — this runs on every
 * keystroke in the command palette. It reads the query's vector out of a cache;
 * a miss is one render of lexical-only results, and `subscribeEmbeddings` says
 * when to render again. Vectors are resident per project, so the unscoped search
 * reaches other projects only once `ensureWorkspaceVectors()` has loaded them —
 * until then those projects are ranked by their words, which is the same
 * degradation every caller of this layer gets and never a wrong answer.
 */

const STOPWORDS = new Set([
  "the", "and", "for", "with", "that", "this", "from", "did", "we", "you",
  "did", "where", "what", "when", "why", "how", "our", "was", "are", "is",
  "about", "discuss", "discussed", "talk", "talked",
]);

/**
 * Lowercase without accents, so "integração" and "integracao" are one word.
 * Splitting raw text on `[^a-z0-9]` used to cut "integração" into "integra"
 * and "o". Stripping combining marks keeps NFC text the same length, which is
 * what lets `excerptAround` use an index from the folded copy on the original.
 */
const fold = (text: string) => text.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();

function termsOf(query: string): string[] {
  return [
    ...new Set(
      fold(query)
        .split(/[^a-z0-9]+/)
        .filter((w) => w.length > 1 && !STOPWORDS.has(w)),
    ),
  ];
}

function score(text: string, terms: string[]): number {
  if (terms.length === 0) return 0;
  const hay = fold(text);
  let hits = 0;
  for (const term of terms) if (hay.includes(term)) hits += 1;
  return hits / terms.length;
}

/**
 * The window of text a result is shown as.
 *
 * Still centred on a matched *word*, even when the hit came from the vectors,
 * and the opening when no word matched at all. A vector says a passage is about
 * the right thing; it cannot say which sentence in it to point at, and inventing
 * a highlight for a match with no literal position would be a worse answer than
 * showing the text from the top.
 */
function excerptAround(text: string, terms: string[], width = 160): string {
  const hay = fold(text);
  const at = terms
    .map((t) => hay.indexOf(t))
    .filter((i) => i >= 0)
    .sort((a, b) => a - b)[0];

  if (at === undefined) return text.slice(0, width).trim();

  const start = Math.max(0, at - width / 3);
  const slice = text.slice(start, start + width).replace(/\s+/g, " ").trim();
  return (start > 0 ? "…" : "") + slice + (start + width < text.length ? "…" : "");
}

export interface SearchOptions {
  /** Restrict to one project; omit to search the whole workspace. */
  projectId?: string;
  limit?: number;
}

/**
 * Below this, a hit is noise.
 *
 * A floor rather than the old `score === 0`, because a fused score is almost
 * never exactly zero: a vector puts *some* distance between any two texts, so
 * without this every chat in the workspace would be a result for every query,
 * ordered by a difference of hundredths.
 */
const FLOOR = 0.08;

/**
 * Words in the name count in full; words only in the body count for less.
 * Someone typing a file's name is looking for that file, not for every chat
 * that mentioned one of its words in passing.
 */
const lexical = (name: string, body: string, terms: string[]) =>
  Math.max(score(name, terms), 0.8 * score(`${name} ${body}`, terms));

export function semanticSearch(
  query: string,
  { projectId, limit = 12 }: SearchOptions = {},
): SearchResult[] {
  const terms = termsOf(query);
  const meaning = query.trim() ? cachedQuery(query) : null;
  if (!terms.length && !meaning) return [];

  const { chats, messages, documents } = workspace();
  const results: SearchResult[] = [];
  const inScope = (id: string) => !projectId || id === projectId;

  /*
   * Scores are gathered per project, because that is how vectors are resident.
   *
   * `hasVectors` decides per project whether there is a semantic half at all,
   * and the distinction matters more than it looks: "this project is not indexed
   * yet" and "nothing in this project is relevant" are the same zero, and fusing
   * the first as if it were the second would rank a whole project's honest
   * lexical hits at a third of their weight. See the `null` case in `fuse`.
   */
  const scopes = new Set<string>(
    projectId
      ? [projectId]
      : [
          ...chats.map((c) => c.projectId),
          ...documents.map((d) => d.projectId),
        ],
  );

  const indexed = new Set<string>();
  const byMessage = new Map<string, number>();
  const byDocument = new Map<string, number>();

  if (meaning) {
    for (const scope of scopes) {
      if (!hasVectors(scope)) continue;
      indexed.add(scope);

      // One pass per project, not one per kind. Documents are scored by their
      // best chunk rather than as files: a runbook is forty pages about forty
      // things, and whether the *file* is relevant has no useful answer.
      const scores = scoreProject(scope, meaning);
      for (const [id, s] of scores.passage) byMessage.set(id, s);
      for (const [id, s] of scores.document) byDocument.set(id, s);
    }
  }

  /** A semantic score, or `null` when this project has nothing to compare to. */
  const meaningOf = (
    best: Map<string, number>,
    owner: string,
    ownerProject: string,
  ) => (indexed.has(ownerProject) ? (best.get(owner) ?? 0) : null);

  // One pass over the transcript instead of a scan per chat: this used to be
  // `MESSAGES.filter(...)` inside the chat loop, which is fine against four
  // fixtures and quadratic against a real workspace. The same pass lifts each
  // message's passage score to the chat it belongs to.
  const transcripts = new Map<string, string[]>();
  const chatMeaning = new Map<string, number>();
  for (const message of messages) {
    const lines = transcripts.get(message.chatId);
    if (lines) lines.push(message.content);
    else transcripts.set(message.chatId, [message.content]);

    const passage = byMessage.get(message.id);
    if (passage !== undefined && passage > (chatMeaning.get(message.chatId) ?? 0)) {
      chatMeaning.set(message.chatId, passage);
    }
  }

  for (const chat of chats) {
    if (!inScope(chat.projectId)) continue;
    const body = transcripts.get(chat.id)?.join("\n") ?? "";
    // Best passage, never an average: a conversation that answered the question
    // in one paragraph and moved on is a conversation that answered it.
    const s = fuse(
      lexical(chat.title, body, terms),
      meaningOf(chatMeaning, chat.id, chat.projectId),
    );
    if (s < FLOOR) continue;
    results.push({
      id: chat.id,
      kind: "chat",
      title: chat.title,
      excerpt: excerptAround(body || chat.title, terms),
      projectId: chat.projectId,
      score: s,
    });
  }

  for (const doc of documents) {
    if (!inScope(doc.projectId)) continue;
    /*
     * The name and the opening are all the words there are to match — the text
     * is in `document_chunks` and deliberately not in memory here. That is
     * exactly the asymmetry the vectors fix: a chunk index that never surfaced
     * page thirty by keyword now surfaces it by meaning, through the document's
     * best chunk. A seed fixture has no chunks and so no vector, and falls back
     * to its excerpt, which is all it ever had.
     */
    const s = fuse(
      lexical(doc.name, doc.excerpt, terms),
      meaningOf(byDocument, doc.id, doc.projectId),
    );
    if (s < FLOOR) continue;
    results.push({
      id: doc.id,
      kind: "document",
      title: doc.name,
      excerpt: excerptAround(doc.excerpt, terms),
      projectId: doc.projectId,
      score: s,
    });
  }

  return results
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((r) => ({ ...r, score: Math.min(1, r.score) }));
}
