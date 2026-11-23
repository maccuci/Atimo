/*
 * Domain model — mirrors the "Core Concepts" section of docs/prd.md.
 *
 *   Workspace > Project > Chat > Message
 *
 * with everything a project accumulates hanging off the project, not the chat:
 * memory, decisions, documents, timeline. That inversion is the whole product
 * thesis ("Projects own knowledge. Models simply access it.").
 */

/** Providers we carry a brand mark for. */
export type KnownProviderId =
  | "anthropic"
  | "openai"
  | "google"
  | "xai"
  | "deepseek"
  | "mistral"
  | "meta"
  | "alibaba"
  | "perplexity"
  | "microsoft"
  | "amazon"
  | "copilot"
  | "cursor"
  | "kimi"
  | "devin"
  | "openrouter"
  | "zai";

/**
 * Open on purpose. The live catalog carries several hundred vendors and grows
 * without us; an unrecognised one still has to render, so it keeps its slug and
 * falls back to a generic mark rather than being dropped.
 */
export type ProviderId = KnownProviderId | (string & {});

export interface Model {
  id: string;
  label: string;
  provider: ProviderId;
  /** Short form for the status bar. */
  short: string;
  contextWindow: number;
  /** USD per 1M input / output tokens, for the comparison view. */
  costIn: number;
  costOut: number;
  /**
   * USD per 1M input tokens served from a cached prefix, when the model has
   * one. Absent, not zero, when it does not.
   *
   * This app prepends the same project knowledge to every turn in a project,
   * so the cached rate is often the input price that actually applies.
   */
  costCacheRead?: number;
  costCacheWrite?: number;

  /* ---- present only on models from the live provider catalog ---------- */

  /** True when this came from the provider, not the built-in seed list. */
  live?: boolean;
  maxOutput?: number;
  supportsVision?: boolean;
  /**
   * Reads documents (PDFs) handed to it as a message part.
   *
   * A different capability from `supportsVision`, not a stronger one: plenty of
   * models look at an image and reject a `file` part outright. It matters for
   * routing rather than for permission — a gateway that can extract a PDF to
   * text will serve one to any model, so this decides *how* the document is
   * turned into tokens, not whether it may be attached. See `attachments.ts`.
   */
  supportsFiles?: boolean;
  supportsAudio?: boolean;
  supportsTools?: boolean;
  supportsReasoning?: boolean;
  /** Unix seconds — the picker sorts newest-first within a vendor. */
  created?: number;
  description?: string;
}

export interface Workspace {
  id: string;
  name: string;
}

export interface Project {
  id: string;
  workspaceId: string;
  name: string;
  /**
   * One line, for people. Shown on cards, in the rail and in search results.
   *
   * Deliberately not the same field as `instructions`: a subtitle that has to
   * fit a card and a standing brief that has to steer a model are different
   * texts with different lengths, and making one field do both meant every
   * project either had a description too long to render or a brief too short to
   * be worth sending.
   */
  description: string;
  /**
   * The project's base context — the standing brief every chat in this project
   * inherits, whichever model it runs on.
   *
   * This is the authored half of project knowledge, as opposed to the half
   * `distill()` mines out of conversations. Both reach the model, but they are
   * asserted differently: memory is "this is true of the project", instructions
   * are "this is how work in this project is done". The Prompt Builder keeps
   * them in separate blocks for exactly that reason.
   *
   * Exempt from the retrieval budget. The user wrote it for every turn, so a
   * turn that silently dropped half of it would be answering a different brief
   * than the one on screen.
   */
  instructions: string;
  /** Tokens of distilled knowledge currently held in project memory. */
  memoryTokens: number;
}

export interface Chat {
  id: string;
  projectId: string;
  title: string;
  /**
   * The chat's primary model: the one whose answer becomes the conversation,
   * the one the context meter prices against, and the one the header names.
   */
  modelId: string;
  createdAt: string;
  updatedAt: string;
  /**
   * Extra models that answer *alongside* `modelId` on every turn — the panel.
   *
   * A panel turn is still one turn: one prompt, one place in the transcript,
   * one entry in project knowledge. What changes is how many models get to
   * attempt it. Absent (not `[]`) on the ordinary single-model chat, which is
   * the overwhelming majority — see `panel.ts` for why the primary is kept out
   * of this list rather than the whole set being stored in one field.
   */
  panel?: string[];
  /** Set when this chat was forked from another. */
  forkedFrom?: { chatId: string; messageId: string };
}

export type MessageRole = "user" | "assistant" | "system";

export interface Message {
  id: string;
  chatId: string;
  role: MessageRole;
  content: string;
  createdAt: string;
  /** Only on assistant messages. */
  modelId?: string;
  research?: import("./research-orchestrator").ResearchRecord;
  researchStage?: import("./research-orchestrator").ResearchStage;
  /**
   * Groups the answers one prompt produced when a panel of models attempted it.
   *
   * Absent on a single-model turn, which is what makes the ordinary case cost
   * nothing: no group to look up, no flag to check, and a transcript written
   * before this existed reads back exactly as it did.
   */
  turnId?: string;
  /**
   * The one answer of its `turnId` that *is* the conversation.
   *
   * Exactly one per group, and it is the only one that travels in history or
   * reaches the distiller. The alternatives are kept — they were paid for, and
   * they are the evidence for having run the panel at all — but a chat whose
   * history carried four answers to every prompt would spend its window
   * arguing with itself, and each turn would cost the square of the last.
   *
   * Meaningless without `turnId`: a lone answer is trivially the conversation.
   */
  canonical?: boolean;
  /** Context Composer output that produced this turn. */
  context?: ComposedContext;
  /** `cached`: input tokens the provider served from its prompt cache, when it reports them. */
  usage?: { in: number; out: number; latencyMs: number; cached?: number };
  /** USD, as billed by the provider. Absent when it reported no cost. */
  costUsd?: number;
  /** Reasoning tokens, for models that stream them separately from the answer. */
  reasoning?: string;
  /** Streaming placeholder. */
  pending?: boolean;
  /** Why the turn failed. Set instead of content when the provider errored. */
  error?: string;
  /** The user pressed stop; whatever streamed in before that is still real. */
  stopped?: boolean;
  /**
   * Knowledge this turn proposed for the project, still awaiting the user's
   * call. Cleared as each one is accepted or dismissed.
   */
  candidates?: KnowledgeCandidate[];
  /**
   * Files sent with this prompt — a screenshot, a PDF, a voice note.
   *
   * Metadata only, deliberately. The bytes live in `attachment_blobs`, outside
   * the workspace snapshot, for the same reason document text does: this row is
   * read whole on every launch and diffed on every store transition, and one
   * screenshot outweighs a year of transcripts. What is here is what a
   * transcript has to draw and what the composer has to price.
   *
   * Absent, not `[]`, on the overwhelming majority of turns.
   */
  attachments?: Attachment[];
}

/* ---------------------------------------------------------------------- */
/* Attachments — files that travel with one prompt                          */
/* ---------------------------------------------------------------------- */

/**
 * What an attached file *is*, in the only terms that matter to a request.
 *
 * Three, because the OpenAI-shaped content-part union has three non-text
 * members and each maps to a different model capability. Deliberately not the
 * same axis as `DocumentKind`: that one describes text the project keeps and
 * retrieval slices, this one describes bytes one turn carries. A `.md` file is a
 * document; a screenshot of the same file is an attachment.
 */
export type AttachmentKind = "image" | "document" | "audio";

export interface Attachment {
  id: string;
  /** The prompt it was sent with. */
  messageId: string;
  /** Denormalised from the message, so bytes load per chat in one query. */
  chatId: string;
  name: string;
  /** IANA media type, normalised — what actually goes in the `data:` URL. */
  mime: string;
  kind: AttachmentKind;
  /** Size of the bytes as sent, after any downscaling. */
  bytes: number;
  /** Images only, and only once decoded. The token estimate comes from these. */
  width?: number;
  height?: number;
  /**
   * Roughly what this costs the model in input tokens.
   *
   * An estimate, and labelled as one everywhere it is shown: the real number
   * depends on how the provider tiles an image or paginates a PDF. It exists so
   * the context meter does not report a turn as costing only its prose when
   * three photographs are riding along with it.
   */
  tokens: number;
}

/**
 * A fact the distiller believes should outlive this chat. It is a proposal:
 * nothing reaches project memory until the user accepts it, because injected
 * context is invisible at read time and a bad entry would silently steer every
 * future prompt in the project.
 */
export interface KnowledgeCandidate {
  id: string;
  projectId: string;
  chatId: string;
  /** Model that produced the turn this came from. */
  modelId: string;
  type: "memory" | "decision";
  /** Set when `type` is "memory". */
  kind?: MemoryKind;
  /** Which half of the turn it was mined from. */
  source: "prompt" | "response";
  /** 0..1 — how strong the lexical signal was. */
  confidence: number;
  title: string;
  /** Reason, for a decision; the fact itself, for memory. */
  body: string;
  /** Only meaningful for decisions. */
  alternatives: string[];
}

/* ---------------------------------------------------------------------- */
/* References — the `@chat()` / `@document()` syntax from the PRD           */
/* ---------------------------------------------------------------------- */

export const REFERENCE_KINDS = [
  "chat",
  "project",
  "document",
  "message",
  "task",
  "person",
  "api",
  "github",
  "file",
] as const;

export type ReferenceKind = (typeof REFERENCE_KINDS)[number];

export interface Reference {
  kind: ReferenceKind;
  /** The literal inside the parens, e.g. `Claude Backend`. */
  target: string;
  /** Resolved entity id, absent when the reference does not match anything. */
  entityId?: string;
  /** Character offsets in the raw prompt. */
  start: number;
  end: number;
}

/** A referenceable entity, i.e. anything `@…()` can point at. */
export interface Referenceable {
  id: string;
  kind: ReferenceKind;
  label: string;
  /** Shown dim next to the label in the autocomplete popup. */
  hint: string;
  projectId: string;
}

/* ---------------------------------------------------------------------- */
/* Context Composer — the pipeline in the PRD's "Feature: Context Composer" */
/* ---------------------------------------------------------------------- */

export type ComposerStage =
  /** The project's own base context. Runs first; every chat in the project gets it. */
  | "project"
  | "skills"
  | "resolve"
  | "semantic"
  | "optimize"
  | "build";

/**
 * What a context chunk can be.
 *
 * `missing` is the one member that carries no content: it is a named reference
 * that binds to nothing, kept as a chunk so the prompt can say so out loud
 * rather than leaving the model to explain the gap to itself.
 *
 * Named rather than inlined so the chrome that draws a glyph per kind is typed
 * against this and fails to build when a kind is added without one.
 */
export type ChunkKind = ReferenceKind | "skill" | "missing";

export interface ContextChunk {
  id: string;
  /** Which stage pulled this in. */
  stage: ComposerStage;
  kind: ChunkKind;
  label: string;
  /** 0..1, how relevant the retrieval scored it. */
  score: number;
  tokens: number;
  excerpt: string;
  /** False when the token optimizer dropped it from the final prompt. */
  included: boolean;
  /**
   * Exempt from the token budget. Set on the project's base context, on explicit
   * references, and on skills (the always-present catalogue and any armed body):
   * all were asked for by name, and half of any of them changes the answer
   * without saying so. Armed bodies stay required across a panel so every model
   * is told to work the same way.
   */
  required?: boolean;
  review?: IntegrationCoverage;
}

export interface ComposedContext {
  chunks: ContextChunk[];
  /** Tokens before the optimizer ran, i.e. naive "paste everything". */
  rawTokens: number;
  /** Tokens actually sent. */
  finalTokens: number;
  elapsedMs: number;
}

/* ---------------------------------------------------------------------- */
/* Project knowledge                                                        */
/* ---------------------------------------------------------------------- */

export const MEMORY_KINDS = [
  "architecture",
  "standard",
  "library",
  "business-rule",
  "glossary",
  "api",
] as const;

export type MemoryKind = (typeof MEMORY_KINDS)[number];

export interface MemoryEntry {
  id: string;
  projectId: string;
  kind: MemoryKind;
  title: string;
  body: string;
  /** Chat this was distilled from. */
  sourceChatId?: string;
  createdAt: string;
  /** How many times it has been injected into a prompt. */
  hits: number;
}

export interface Decision {
  id: string;
  projectId: string;
  title: string;
  reason: string;
  alternatives: string[];
  date: string;
  /** Model ids + human names that participated. */
  participants: string[];
  affectedFiles: string[];
  sourceChatId?: string;
  /** Superseded decisions stay in the log; the timeline shows the chain. */
  supersedes?: string;
}

export interface TimelineEvent {
  id: string;
  projectId: string;
  date: string;
  modelId: string;
  summary: string;
  kind: "decision" | "chat" | "document" | "fork";
  refId?: string;
}

export type DocumentKind = "markdown" | "code" | "text" | "data" | "pdf";

/**
 * A file the project owns, as everything except its text.
 *
 * The split is the point. This row travels in the workspace snapshot, which is
 * read whole on every launch and diffed on every store transition — so it holds
 * only what a list has to render and what retrieval has to price. The text
 * itself lives in `DocumentChunk` rows that are never part of that snapshot,
 * because a handful of uploaded files is megabytes, and megabytes parsed at
 * launch and walked on every keystroke is how a workspace gets slow in a way no
 * single feature looks responsible for.
 */
export interface Document {
  id: string;
  projectId: string;
  name: string;
  kind: DocumentKind;
  /** Tokens across the whole document, summed from its chunks. */
  tokens: number;
  updatedAt: string;
  /** The opening, for the UI. Retrieval scores chunks, not this. */
  excerpt: string;
  /** Size of the file as uploaded. Absent on the seed fixtures. */
  bytes?: number;
  /** How many chunks the text was split into. Absent on the seed fixtures. */
  chunkCount?: number;
  /** Inventory and static checks; source text remains in the chunk rows. */
  review?: IntegrationReview;
}

export interface SourceLocation {
  path: string;
  startLine: number;
  endLine: number;
  startColumn: number;
  endColumn: number;
}

export interface IntegrationReview {
  /** `sameAs`: byte-identical text to an earlier file, so a review sends it once. */
  files: { path: string; bytes: number; parts: number; reason?: string; sameAs?: string }[];
  findings: { path: string; line: number; message: string }[];
  dependencies: {
    path: string;
    line: number;
    target: string;
    status: "included" | "missing" | "external" | "skipped";
  }[];
}

export interface IntegrationCoverage {
  document: string;
  coverage: (IntegrationReview["files"][number] & {
    sentParts: number;
    coverage: string;
    ranges: Omit<SourceLocation, "path">[];
  })[];
  findings: IntegrationReview["findings"];
  dependencies: IntegrationReview["dependencies"];
  /** Facts the OIC analyzer derived from the archive text (`oic-analysis.ts`). */
  staticFacts?: { rule: string; path: string; message: string }[];
}

/**
 * One upload batch's receipt — shown above the composer until dismissed.
 * Both sides of a mixed drop live here so the banner tells one story.
 */
export interface DocumentNotice {
  added: Pick<Document, "id" | "name">[];
  rejected: string[];
}

/**
 * One retrievable slice of a document.
 *
 * Documents go into a prompt in pieces rather than whole, which is the PRD's
 * "Smart Context Injection" applied to files: a 40-page brief has three relevant
 * paragraphs, and sending the other thirty-nine pages buys nothing but tokens.
 * Chunking at upload time is also what lets retrieval stay cheap — the index is
 * built once, not rebuilt per keystroke.
 */
export interface DocumentChunk {
  id: string;
  documentId: string;
  /** Denormalised from the document so chunks load per project in one query. */
  projectId: string;
  /** Position in the document, 0-based. Ordering is how they read back. */
  index: number;
  text: string;
  tokens: number;
  source?: SourceLocation;
}

/* ---------------------------------------------------------------------- */
/* Skills — installable instruction packs                                   */
/* ---------------------------------------------------------------------- */

export type SkillCategory = "output" | "approach" | "deliverable" | "technical";

/**
 * How an installed skill runs.
 *
 *   auto    the body loads on the turns whose prompt hits a trigger
 *   always  the body loads on every turn
 *   off     installed but inert — nothing of it reaches the model
 */
export type SkillMode = "auto" | "always" | "off";

export interface Skill {
  id: string;
  name: string;
  category: SkillCategory;
  /** One line for the card — what it does, in the user's terms. */
  summary: string;
  /** The line the model carries on every turn, and what arming matches on. */
  description: string;
  /** Words in a prompt that arm an `auto` skill. */
  triggers: string[];
  /** Where it came from, mirroring `skills-lock.json`. Absent for Atimo's own. */
  source?: { repo: string; path: string; hash: string };
  /** The working instructions, injected only once the skill arms. */
  body: string;
}

export interface ActiveSkill {
  skill: Skill;
  mode: Exclude<SkillMode, "off">;
}

export interface ArmedSkill {
  skill: Skill;
  /** Why it applies to this turn. */
  reason: "always" | "match";
  score: number;
  /** Triggers the prompt hit. Empty for an always-on skill. */
  matched: string[];
}

/* ---------------------------------------------------------------------- */
/* Search                                                                   */
/* ---------------------------------------------------------------------- */

export interface SearchResult {
  id: string;
  kind: ReferenceKind;
  title: string;
  excerpt: string;
  projectId: string;
  /** Semantic similarity, 0..1. */
  score: number;
}
