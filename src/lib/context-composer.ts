import { IMPLEMENTED_KINDS, parseReferences } from "./references";
import { indexTerms, projectChunks, searchChunks } from "./documents";
import { reviewCoverage, reviewExcerpt, reviewTokens } from "./integration-files";
import { cachedQuery, fuse } from "./embeddings";
import { hasVectors, scoreProject } from "./vectors";
import { chatBody, chatExtract, resolveReference } from "./reference-resolver";
import { selectHistory } from "./prompt-builder";
import { workspace } from "./workspace";
import { armSkills } from "./skills";
import { contextBudget, estimateTokens } from "./tokens";
import type {
  ActiveSkill,
  ComposedContext,
  ContextChunk,
  Message,
  Reference,
  DocumentChunk,
} from "./types";

/*
 * Context Composer — the pipeline from the PRD:
 *
 *   Prompt -> Project -> Skills -> Reference Resolver
 *          -> Semantic Search -> Token Optimizer -> Final Prompt -> Model
 *
 * "The user never sees this pipeline." So this module is pure: it returns the
 * chunks and the token math, and the UI decides how much to reveal (the
 * Context panel shows it on demand; the composer never blocks on it).
 *
 * Retrieval is hybrid over the live workspace graph (see `workspace.ts`):
 * embeddings decide what a prompt *means* and the lexical index decides what it
 * literally says, fused in `embeddings.fuse`. Which half is doing the work
 * changes with the query — "how does login work" is answered entirely by the
 * vectors, `ERR_MODULE_NOT_FOUND` entirely by the words.
 *
 * The composition stays synchronous, which is the constraint everything else
 * bends around: this runs on a debounce while the user types, so it reads the
 * prompt's vector out of a cache (`cachedQuery`) rather than awaiting one.
 * A miss costs one pass of lexical-only retrieval — the behaviour this file had
 * before embeddings existed — and the send path in `store.ts` awaits the vector
 * first, because that composition is the actual prompt.
 *
 * Reference resolution and the token estimator live in `reference-resolver` and
 * `tokens`: the composer UI prices a mention with them before this pipeline
 * ever runs, and the two have to produce the same number.
 */

export function compose(
  prompt: string,
  projectId: string,
  modelId: string,
  /** Installed, non-paused skills. Empty for callers that have none. */
  skills: ActiveSkill[] = [],
  /**
   * This chat's prior messages, oldest first. Mentions made in the turns that
   * still travel with the request are re-resolved — see `carriedReferences`.
   * Empty for callers with no transcript (a comparison run, a fresh chat).
   */
  history: Message[] = [],
): ComposedContext {
  const started = performance.now();
  const chunks: ContextChunk[] = [];
  // Read the graph once: the stages below must all price the same workspace,
  // and a publish landing mid-pipeline would otherwise split them across two.
  const { chats, documents, messages, projects } = workspace();

  /* -- 0. Project base context ------------------------------------------- */
  /*
   * The one chunk that does not depend on the prompt. It is what makes a project
   * more than a folder: every chat under it starts from this text, so the second
   * conversation in a project never re-explains what the first one established.
   *
   * `required`, like an explicit reference — the user wrote it for every turn,
   * and a brief the optimizer trimmed in half would quietly answer a different
   * question than the one on screen.
   */
  const project = projects.find((p) => p.id === projectId);
  const instructions = project?.instructions.trim();
  if (project && instructions) {
    chunks.push({
      // The project's own id, not a prefixed one, so that naming the open
      // project with `@project()` dedupes against this chunk instead of sending
      // the same brief twice.
      id: project.id,
      stage: "project",
      kind: "project",
      label: project.name,
      score: 1,
      tokens: estimateTokens(instructions),
      excerpt: instructions,
      included: true,
      required: true,
    });
  }

  /* -- 1. Skills --------------------------------------------------------- */
  // Runs first because a skill changes how the model uses everything after it.
  //
  // Two texts, two prices (progressive disclosure):
  //   description  always present — one line per installed skill, paid every turn
  //   body         only when the skill arms for this prompt
  //
  // Both are `required`. A panel composes once per model against that model's
  // window; if an armed body could be trimmed on a smaller member, the same
  // prompt would tell two models to work differently, and the comparison would
  // be about the budget rather than about the models.
  if (skills.length) {
    const catalog = skills
      .map(({ skill }) => `- **${skill.name}**: ${skill.description}`)
      .join("\n");
    chunks.push({
      id: "skill-catalog",
      stage: "skills",
      kind: "skill",
      label: "Available skills",
      score: 1,
      tokens: estimateTokens(catalog),
      excerpt: catalog,
      included: true,
      required: true,
    });
  }

  for (const armed of armSkills(prompt, skills)) {
    chunks.push({
      id: `skill-${armed.skill.id}`,
      stage: "skills",
      kind: "skill",
      label: armed.skill.name,
      score: armed.score,
      tokens: estimateTokens(armed.skill.body),
      excerpt: armed.skill.body,
      included: true,
      required: true,
    });
  }

  /* -- 2. Reference resolver -------------------------------------------- */
  // Hoisted above the reference loop: a named document resolves to the passages
  // that answer *this* prompt, so the terms have to exist before it runs.
  const terms = tokenize(prompt);

  /*
   * The prompt as meaning, if it has been embedded yet.
   *
   * Read once for the whole pipeline, like the graph above it and for the same
   * reason: a vector landing between stage 3 and stage 4 would score memory
   * lexically and chats semantically, and the token optimizer would then rank
   * two sets of numbers that are not on the same scale against each other.
   *
   * `null` is the ordinary case on the first pass after a keystroke, not an
   * error — see the note at the top of this file.
   */
  //
  // `hasVectors` is checked alongside it because "this project is not indexed
  // yet" and "nothing here is relevant" are the same zero, and treating the
  // first as the second would rank every honest lexical hit in the project at a
  // third of its weight — see the `null` case in `fuse`.
  const meaning =
    prompt.trim() && hasVectors(projectId) ? cachedQuery(prompt) : null;
  /** Every kind of score this project can offer, in one pass over its vectors. */
  const scores = meaning ? scoreProject(projectId, meaning) : null;

  // Named on this turn: required, and priced at the top of the ordering.
  for (const ref of parseReferences(prompt)) {
    const resolved = resolveReference(
      ref.kind,
      ref.target,
      projectId,
      terms,
      scores,
      reviewTokens(modelId),
    );
    if (!resolved) {
      const note = missingChunk(ref);
      if (note) chunks.push({ ...note, score: 1, required: true });
      continue;
    }
    chunks.push({
      id: resolved.id,
      stage: "resolve",
      kind: resolved.kind,
      label: resolved.label,
      score: 1,
      tokens: resolved.tokens,
      excerpt: resolved.excerpt,
      ...(resolved.review ? { review: resolved.review } : {}),
      included: true,
      required: true,
    });
  }

  // Named earlier in the same conversation. Resolution used to die with the turn
  // that made it, so from turn two on the model read a bare `@chat("…")` in its
  // own transcript with nothing attached — worst on a fork, where a fresh model
  // inherits every mention and none of the content, and correctly reports having
  // no context for any of them.
  //
  // Not `required`: the live prompt's mentions outbid these for the budget, and
  // twenty turns of pinned mentions would otherwise blow the window.
  for (const ref of carriedReferences(history)) {
    const resolved = resolveReference(
      ref.kind,
      ref.target,
      projectId,
      terms,
      scores,
      reviewTokens(modelId),
    );
    if (!resolved) {
      const note = missingChunk(ref);
      if (note) chunks.push({ ...note, score: CARRIED_SCORE });
      continue;
    }
    chunks.push({
      id: resolved.id,
      stage: "resolve",
      kind: resolved.kind,
      label: resolved.label,
      score: CARRIED_SCORE,
      tokens: resolved.tokens,
      excerpt: resolved.excerpt,
      ...(resolved.review ? { review: resolved.review } : {}),
      included: true,
    });
  }

  /* -- 4. Semantic search ----------------------------------------------- */
  /*
   * A chat scores as the best of its passages, not as an average of all of them.
   * A conversation that answered the question in one paragraph and then talked
   * about something else for an hour is a conversation that answered the
   * question; averaging would rank it below a short chat that is vaguely on
   * topic throughout, which is precisely backwards. `bestByOwner` is that max,
   * taken once for the project rather than per chat.
   */
  const semanticChat = scores ? chatScores(scores.passage, messages) : null;

  // A named archive is the review's whole evidence. Retrieved chats add ~20k
  // tokens of unrelated threads — and earlier reviews of the same IAR, which a
  // second model then repeats instead of reading the files.
  const namedIntegration = chunks.some((c) => c.stage === "resolve" && c.review);

  const scored: { chat: (typeof chats)[number]; score: number }[] = [];
  for (const chat of namedIntegration ? [] : chats) {
    if (chat.projectId !== projectId) continue;
    const body = chatBody(chat.id);
    if (!body) continue;

    const score = fuse(
      lexicalScore(`${chat.title} ${body}`, terms),
      semanticChat ? (semanticChat.get(chat.id) ?? 0) : null,
    );
    if (score >= 0.1) scored.push({ chat, score });
  }

  /*
   * The few that answer, not every chat that shares a word. Real turns scored
   * their real hits 0.45–0.93 and then trailed off into dozens at 0.2–0.3 —
   * 33 chats and 21k tokens of HDL threads on a question about one IAR. Those
   * near-misses are the distractors long-context models degrade on most. The
   * cut is relative because the scale is: a lone 0.27 can be the best answer.
   */
  scored.sort((a, b) => b.score - a.score);
  const bar = (scored[0]?.score ?? 0) * CHAT_RELATIVE_FLOOR;
  for (const { chat, score } of scored.slice(0, MAX_CHATS)) {
    if (score < bar) break;
    // A chat resolves to its summary, not the transcript (mem-2).
    const { text: excerpt } = chatExtract(chat.id, terms, scores);
    if (!excerpt) continue;
    chunks.push({
      id: `sem-${chat.id}`,
      stage: "semantic",
      kind: "chat",
      label: chat.title,
      score,
      tokens: estimateTokens(excerpt),
      excerpt,
      included: true,
    });
  }

  /*
   * Documents, by passage rather than by file.
   *
   * `searchChunks` walks an inverted index built at upload, so this costs a Map
   * lookup per term and a visit to only the chunks that carry one — where the
   * obvious `text.includes()` over every document would re-scan every byte of
   * every file in the project, on a pipeline that runs while the user types.
   *
   * A file with no chunks is a seed fixture, which has an excerpt and no body.
   * It still scores, on the little it has.
   */
  const byId = new Map(documents.map((doc) => [doc.id, doc]));
  const integrationHits = new Map<string, { chunks: DocumentChunk[]; score: number }>();
  const hits = searchChunks(projectId, terms, DOCUMENT_CHUNKS, scores?.chunk);

  /*
   * Whole files when they fit. Long-context models read a complete document
   * better than four passages a retriever guessed at, and an unchanging prefix
   * is what prompt caching rewards. Retrieval is the fallback for projects
   * whose files would crowd the window — the same rule `selectReviewChunks`
   * applies to an integration archive.
   */
  const plain = projectChunks(projectId).filter((c) => {
    const doc = byId.get(c.documentId);
    return doc && !doc.review;
  });
  const plainTokens = plain.reduce((sum, c) => sum + c.tokens, 0);
  const whole = plain.length > 0 && plainTokens <= contextBudget(modelId) * WHOLE_FILES_SHARE;
  const passages = whole
    ? (() => {
        // One score per file so the optimizer's stable sort keeps parts in order.
        const best = new Map<string, number>();
        for (const { chunk, score } of hits)
          best.set(chunk.documentId, Math.max(best.get(chunk.documentId) ?? 0, score));
        return [
          ...hits.filter(({ chunk }) => byId.get(chunk.documentId)?.review),
          ...[...plain]
            .sort((a, b) => a.documentId.localeCompare(b.documentId) || a.index - b.index)
            .map((chunk) => ({ chunk, score: best.get(chunk.documentId) ?? WHOLE_FILE_SCORE })),
        ];
      })()
    : hits;

  for (const { chunk, score } of passages) {
    const doc = byId.get(chunk.documentId);
    if (!doc) continue;
    if (doc.review) {
      const hit = integrationHits.get(doc.id) ?? { chunks: [], score: 0 };
      hit.chunks.push(chunk);
      hit.score = Math.max(hit.score, score);
      integrationHits.set(doc.id, hit);
      continue;
    }
    chunks.push({
      // Chunk-scoped, so two passages of the same file both survive dedupe —
      // they are different answers, and collapsing them would silently halve
      // what a long document can contribute.
      id: `sem-${chunk.id}`,
      stage: "semantic",
      kind: "document",
      label:
        (doc.chunkCount ?? 1) > 1
          ? `${doc.name} · part ${chunk.index + 1}`
          : doc.name,
      score,
      tokens: chunk.tokens,
      excerpt: chunk.text,
      included: true,
    });
  }

  // Same rule for retrieved fragments of a sibling archive (another export of
  // the same IAR): 70 files "not supplied" and three that were.
  for (const [id, hit] of namedIntegration ? [] : integrationHits) {
    const doc = byId.get(id)!;
    const review = reviewCoverage(doc, hit.chunks);
    const excerpt = reviewExcerpt(doc, hit.chunks, review);
    chunks.push({ id, stage: "semantic", kind: "document", label: doc.name, score: hit.score,
      tokens: estimateTokens(excerpt), excerpt, review, included: true });
  }

  for (const doc of documents) {
    if (doc.projectId !== projectId || doc.chunkCount) continue;
    const score = lexicalScore(`${doc.name} ${doc.excerpt}`, terms);
    if (score < 0.14) continue;
    chunks.push({
      id: `sem-${doc.id}`,
      stage: "semantic",
      kind: "document",
      label: doc.name,
      score,
      tokens: estimateTokens(doc.excerpt),
      excerpt: doc.excerpt,
      included: true,
    });
  }

  /* -- 5. Dedupe + token optimizer -------------------------------------- */
  const deduped = dedupe(chunks);
  const rawTokens = deduped.reduce((sum, c) => sum + c.tokens, 0);
  const budget = contextBudget(modelId);

  // Required chunks are never dropped — explicit references, the skill
  // catalogue, and every armed skill body were all asked for by name.
  const ordered = [...deduped].sort((a, b) => {
    if (Boolean(a.required) !== Boolean(b.required)) return a.required ? -1 : 1;
    return b.score - a.score;
  });

  let spent = 0;
  for (const chunk of ordered) {
    const fits = spent + chunk.tokens <= budget;
    chunk.included = chunk.required === true || fits;
    if (chunk.included) spent += chunk.tokens;
  }

  return {
    chunks: ordered,
    rawTokens,
    finalTokens: spent + estimateTokens(prompt),
    elapsedMs: Math.round(performance.now() - started),
  };
}

/**
 * Scored just under a live mention and above any lexical hit, so trimming eats
 * retrieval before it breaks a mention the model can still read in its
 * transcript. Deduping keeps the higher score, so naming an entity again on this
 * turn upgrades the carried chunk back to `required`.
 */
const CARRIED_SCORE = 0.99;

/**
 * Passages any one turn can pull out of the project's files.
 *
 * A cap, not a budget — the optimizer downstream still decides what fits. This
 * is about the shape of the answer: four well-chosen paragraphs from across the
 * project's documents is retrieval, and forty is the paste this product exists
 * to replace.
 */
const DOCUMENT_CHUNKS = 4;

/** Retrieved chats per turn, and the share of the best score a chat must reach. */
const MAX_CHATS = 5;
const CHAT_RELATIVE_FLOOR = 0.5;

/**
 * Share of the context budget the project's files may take whole. Half, so a
 * turn with whole files still leaves room for references and chat extracts.
 */
const WHOLE_FILES_SHARE = 0.5;

/** A file sent whole that the prompt did not match: below any real hit. */
const WHOLE_FILE_SCORE = 0.1;

/**
 * References mentioned in the turns that travel with this request.
 *
 * Scoped to `selectHistory` on purpose: the invariant worth holding is that
 * every mention the model can *see* has its content attached. A mention in a
 * turn old enough to have been dropped from the tail is not visible to the
 * model, and its substance has been distilled into project memory by then —
 * re-injecting it would pay for context nothing in the request refers to.
 *
 * Only user turns are read. A mention in prose the model wrote itself is it
 * quoting the conversation back, not asking for anything.
 */
function carriedReferences(history: Message[]): Reference[] {
  return selectHistory(history)
    .filter((m) => m.role === "user")
    .flatMap((m) => parseReferences(m.content));
}

/** A chunk before the caller decides how strongly it is held. */
type PendingChunk = Omit<ContextChunk, "score" | "required">;

/**
 * A mention that binds to nothing, said out loud.
 *
 * Resolution failure used to be `continue`, which is the quietest possible way
 * to handle it and the most expensive: the model still reads `@document("Q3
 * numbers")` in the turn it was given, is told the context below was retrieved
 * automatically, and finds no document by that name in it. Nothing in the
 * request distinguishes "that file was deleted" from "that file is here
 * somewhere" — so the sentence in the transcript stands as evidence the numbers
 * were available, and the model supplies them.
 *
 * Restricted to the kinds that resolve at all. `@task("Ship v1")` is grammar the
 * product does not implement yet, and reporting it as deleted would be a
 * different lie about the same project.
 */
function missingChunk(ref: Reference): PendingChunk | null {
  if (!IMPLEMENTED_KINDS.has(ref.kind)) return null;

  const excerpt =
    `Named in this conversation, but no ${ref.kind} called "${ref.target}" is in the project now — ` +
    "it was deleted or renamed after that turn was written. Its contents are not available to you " +
    "and cannot be recovered from this request. Say so if the question depends on them.";

  return {
    // Keyed on the mention, because there is no entity to key on. Stable, so
    // twenty turns of the same dead mention collapse to a single note.
    id: `missing-${ref.kind}-${ref.target.toLowerCase()}`,
    stage: "resolve",
    kind: "missing",
    label: ref.target,
    tokens: estimateTokens(excerpt),
    excerpt,
    included: true,
  };
}

/** Collapse chunks pointing at the same underlying entity, keeping the best. */
function dedupe(chunks: ContextChunk[]): ContextChunk[] {
  const best = new Map<string, ContextChunk>();
  for (const chunk of chunks) {
    const key = chunk.id.replace(/^sem-/, "");
    const existing = best.get(key);
    if (!existing || chunk.score > existing.score) best.set(key, chunk);
  }
  return [...best.values()];
}

/**
 * The prompt's query terms.
 *
 * Delegates to the document index's tokenizer rather than keeping its own list,
 * because the two have to agree: the chunk index is *built* with `indexTerms`,
 * and querying it with terms produced by a different splitter means postings
 * that silently never match. The symptom of that is retrieval which is merely a
 * bit worse than it should be, which is the kind of bug nobody ever reports.
 *
 * Mentions are stripped first — `@chat("Auth")` is a resolved reference by the
 * time this runs, and letting "auth" also drive lexical retrieval would score
 * every chat in the project against a word the user spent on something else.
 */
function tokenize(text: string): string[] {
  return [...new Set(indexTerms(text.replace(/@\w+\([^)]*\)/g, " ")))];
}

/**
 * Message scores, lifted to the chats those messages belong to.
 *
 * One pass over the transcript rather than a lookup per chat, for the reason the
 * transcript map above this function exists: the alternative is a scan of every
 * message per candidate chat, on a pipeline that runs while the user types.
 */
function chatScores(
  byMessage: ReadonlyMap<string, number>,
  messages: Message[],
): Map<string, number> {
  const best = new Map<string, number>();
  for (const message of messages) {
    const score = byMessage.get(message.id);
    if (score === undefined) continue;
    if (score > (best.get(message.chatId) ?? 0)) best.set(message.chatId, score);
  }
  return best;
}

/** Fraction of query terms present in the candidate, length-normalized. */
function lexicalScore(candidate: string, terms: string[]): number {
  if (terms.length === 0) return 0;
  const hay = candidate.toLowerCase();
  const hits = terms.filter((t) => hay.includes(t)).length;
  return hits / terms.length;
}
