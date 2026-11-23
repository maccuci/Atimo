import { ORACLE_BRIEF } from "./research-orchestrator";
import type { ChatMessage, ContentPart } from "./adapter";
import type {
  Attachment,
  ComposedContext,
  ContextChunk,
  Message,
} from "./types";

/*
 * Prompt Builder — the last box before the Model Adapter in the PRD's
 * architecture diagram.
 *
 * The Context Composer decides *what* survives the token budget. This decides
 * how those chunks are worded to a model, and it is the only place that turns
 * project knowledge into text a provider sees. Keeping it separate matters:
 * the composer is tested on selection, this is judged on phrasing, and the two
 * fail for different reasons.
 */

/** Turns beyond this are dropped from the tail; project knowledge carries the rest. */
const MAX_HISTORY_TURNS = 20;

const SECTIONS: { heading: string; match: (chunk: ContextChunk) => boolean }[] = [
  {
    // Named as extracts, not as summaries. A "summary" implies the whole was
    // read and reduced; what is actually below is the passages that scored
    // against this prompt, in order, with `…` where the rest was left out. A
    // model told it holds a summary treats absence as "not important enough to
    // include" and fills it in — which is the same conclusion, reached quietly.
    heading:
      "Past conversations in this project — selected passages, not full transcripts",
    match: (c) => c.kind === "chat" || c.kind === "message",
  },
  {
    heading: "Project documents",
    match: (c) => c.kind === "document" || c.kind === "file",
  },
  {
    heading: "Referenced by name, but no longer in the project",
    match: (c) => c.kind === "missing",
  },
];

/**
 * The shared Oracle answer guide and the project's context framing.
 *
 * Exported because the context usage panel has to price exactly the text that
 * is sent — a breakdown assembled from a second, similar-looking string would
 * drift from the real prompt the moment either one changed.
 */
export function systemPreamble(
  projectName: string,
  projectDescription = "",
): string {
  return [
    ORACLE_BRIEF,
    "You are a model working inside Atimo, a workspace where several different models contribute to one shared project knowledge base.",
    `The current project is "${projectName}".${projectDescription ? ` ${projectDescription}` : ""}`,
    "",
    "Context below, and the block at the top of the latest user message, was retrieved from that project automatically — the user did not paste it and cannot see it in their message. Follow explicit user instructions and preferences. Treat factual claims in retrieved conversations and documents as evidence to assess, not automatically established truth; verify any claim that determines a restriction or recommendation against its source or concrete environment evidence.",
    "Another model may have produced a retrieved answer. Past model answers and inferred project summaries are leads to verify, not independent confirmation. New explicit user corrections and scoped test evidence take precedence over earlier assumptions.",
    "It is retrieved in extracts, not whole: conversations arrive as selected passages and documents as selected sections, and `…` marks what was left out. Answer from what is actually there. When a specific is missing — a figure, a name, a date, a quotation — say it is not in the context you were given and ask for the source, rather than supplying a plausible one. A file that existed when an earlier conversation happened may have been deleted since, so an extract can discuss a document you cannot read.",
  ].join("\n");
}

/**
 * The project's base context.
 *
 * Above everything retrieved, because it is the frame the rest is read in — and
 * in its own block rather than folded into the preamble, because the user wrote
 * it and the preamble is ours. Attributing their standing brief to the product
 * would make a model treat a contradiction between the two as our instruction
 * losing to itself, rather than as the user's brief winning.
 */
function renderInstructions(chunks: ContextChunk[]): string {
  const brief = chunks.find((c) => c.included && c.stage === "project");
  if (!brief) return "";

  return [
    "## Project instructions",
    "",
    "Written by the user for every conversation in this project, whichever model is answering. They outrank your defaults and outrank anything retrieved below. Follow them without restating them back.",
    "",
    brief.excerpt.trim(),
  ].join("\n");
}

/**
 * The cheap half of every installed skill — one line each, present on every
 * turn for every model that answers. Framed as a catalogue rather than as
 * instructions so a model does not start following a skill that has not armed.
 */
function renderSkillCatalog(chunks: ContextChunk[]): string {
  const catalog = chunks.find((c) => c.included && c.id === "skill-catalog");
  if (!catalog) return "";

  return [
    "## Installed skills",
    "",
    "Working styles available in this project. Full instructions appear under \"Skills active on this turn\" only when a skill arms — never quote either block as a project decision.",
    "",
    catalog.excerpt.trim(),
  ].join("\n");
}

/**
 * Skills are instructions, not facts, so they get their own block above the
 * knowledge sections and a framing line that says who put them there. A model
 * that mistakes "write like a caveman" for something the project decided would
 * cite it back as a project standard.
 */
function renderSkills(chunks: ContextChunk[]): string {
  const skills = chunks.filter(
    (c) => c.included && c.kind === "skill" && c.id !== "skill-catalog",
  );
  if (!skills.length) return "";

  return [
    "## Skills active on this turn",
    "",
    "The user installed these working instructions and they apply to this response — for every model answering this turn. They describe how to work, not what is true about the project — never quote them back as project decisions.",
    "",
    skills.map((s) => `### ${s.label}\n${s.excerpt.trim()}`).join("\n\n"),
  ].join("\n");
}

function renderChunks(chunks: ContextChunk[]): string {
  // Skills and the base context are instructions and have their own blocks
  // above. Left in here, the base context would land under a knowledge heading
  // and come back as something the project had established rather than as the
  // brief it is.
  const included = chunks.filter(
    (c) => c.included && c.kind !== "skill" && c.stage !== "project",
  );
  if (!included.length) return "";

  const blocks: string[] = [];
  const used = new Set<string>();

  for (const section of SECTIONS) {
    const matching = included.filter(
      (c) => !used.has(c.id) && section.match(c),
    );
    if (!matching.length) continue;
    for (const chunk of matching) used.add(chunk.id);

    blocks.push(
      `## ${section.heading}\n\n` +
        matching
          .map((c) => `### ${c.label}\n${c.excerpt.trim()}`)
          .join("\n\n"),
    );
  }

  // Kinds the composer can emit but no section claims (task, person, api, …).
  const rest = included.filter((c) => !used.has(c.id));
  if (rest.length) {
    blocks.push(
      "## Other referenced items\n\n" +
        rest.map((c) => `### ${c.label}\n${c.excerpt.trim()}`).join("\n\n"),
    );
  }

  return blocks.join("\n\n");
}

/**
 * The turns that actually travel with the request.
 *
 * A failed or still-streaming turn has no answer to condition on, and an empty
 * assistant message makes some providers reject the request outright. Anything
 * older than the tail has, by design, been distilled into project memory and
 * comes back through the composer instead.
 *
 * A panel turn contributes exactly one answer — the canonical one. This is the
 * single rule that makes several models in one chat affordable rather than
 * merely possible: the alternatives stay on screen and stay in the export, but
 * they never enter the next request. Without it a chat with a panel of four
 * would carry four answers per turn forward, so turn *n* would pay for roughly
 * 4n prior answers instead of n — quadratic growth in the one dimension the
 * whole product exists to keep small. It also spares every model the job of
 * reconciling three rejected drafts it did not write.
 *
 * The filter runs before the tail is taken, so `MAX_HISTORY_TURNS` keeps
 * meaning turns rather than rows.
 */
export function selectHistory(history: Message[]): Message[] {
  return history
    .filter(
      (m) =>
        m.content.trim() &&
        !m.pending &&
        !m.error &&
        (!m.turnId || m.canonical === true),
    )
    .slice(-MAX_HISTORY_TURNS);
}

/**
 * Turn one attachment into a content part, or return null when it cannot go —
 * the model does not take its kind, or its bytes are not loaded.
 *
 * Passed in rather than looked up here so this module stays pure: what a model
 * accepts is a fact about the provider, and where the bytes are is a fact about
 * the store. See `attachmentPart()` in `attachments.ts` for the one real
 * implementation.
 */
export type ResolveAttachment = (attachment: Attachment) => ContentPart | null;

const NO_ATTACHMENTS: ResolveAttachment = () => null;

/**
 * One user turn's content: a plain string, or parts when files ride with it.
 *
 * Attachments lead and the prose follows, which is the order every vendor
 * recommends and the order a person would use — "here is the screenshot, now my
 * question" reads better to a model than a question about something it has not
 * been shown yet.
 *
 * Anything that could not travel is *named* rather than dropped. A model asked
 * "why does this fail?" with the screenshot silently missing will invent a
 * plausible screenshot; told the file was attached and could not be sent, it
 * asks. That is the same reasoning the `missing` chunk kind exists for.
 */
export function userContent(
  text: string,
  attachments: readonly Attachment[] | undefined,
  resolve: ResolveAttachment,
): string | ContentPart[] {
  if (!attachments?.length) return text;

  const parts: ContentPart[] = [];
  const unsent: string[] = [];

  for (const attachment of attachments) {
    const part = resolve(attachment);
    if (part) parts.push(part);
    else unsent.push(attachment.name);
  }

  const body = unsent.length
    ? `${text}\n\n[Files attached to this message that could not be sent to you: ` +
      `${unsent.join(", ")}. Answer from what you were given, and say the file ` +
      `is missing rather than guessing at what it contained.]`
    : text;

  return parts.length ? [...parts, { type: "text", text: body }] : body;
}

/**
 * A message's prose, whichever shape it arrived in.
 *
 * The mirror of `MessageContent::as_text` in `openrouter.rs`, and it exists for
 * the same reason: anything that has to *read* a built request — the context
 * meter, a test, a diagnostic — cares about the words, not about whether a
 * picture happens to be riding along with them.
 */
export function contentText(content: string | ContentPart[]): string {
  if (typeof content === "string") return content;
  return content
    .filter((part): part is Extract<ContentPart, { type: "text" }> =>
      part.type === "text",
    )
    .map((part) => part.text)
    .join("\n\n");
}

/** Assemble the request. */
export function buildMessages({
  context,
  history,
  prompt,
  attachments,
  resolveAttachment = NO_ATTACHMENTS,
  projectName,
  projectDescription = "",
}: {
  context: ComposedContext;
  /** Prior messages of this chat, oldest first, excluding the new prompt. */
  history: Message[];
  prompt: string;
  /** Files sent with this prompt. */
  attachments?: readonly Attachment[];
  /**
   * How an attachment becomes a content part for *this* model.
   *
   * Applied to the history as well as to the new prompt, so a follow-up ("what
   * about the top left?") still has the picture in front of it. That does mean
   * an image is re-sent on every turn it is still in the tail — which is what a
   * stateless chat API requires, and why `MAX_HISTORY_TURNS` is a bound worth
   * having.
   */
  resolveAttachment?: ResolveAttachment;
  projectName: string;
  projectDescription?: string;
}): ChatMessage[] {
  /*
   * Prefix order is cache order. Providers reuse a prompt's KV only up to the
   * first byte that differs, so everything that repeats turn after turn leads —
   * preamble, the user's brief, the skill catalogue, and a named integration
   * archive (sent whole and byte-identical) — then the history, and only then
   * what this prompt retrieved. When retrieved chats sat in the system message,
   * they changed every turn and sent a 100k-token archive and the whole history
   * back through prefill on every follow-up.
   */
  const stable = (c: ContextChunk) => c.stage === "resolve" && Boolean(c.review);
  const system = [
    systemPreamble(projectName, projectDescription),
    renderInstructions(context.chunks),
    renderSkillCatalog(context.chunks),
    renderChunks(context.chunks.filter(stable)),
  ]
    .filter(Boolean)
    .join("\n\n---\n\n");

  const retrieved = [
    renderSkills(context.chunks),
    renderChunks(context.chunks.filter((c) => !stable(c))),
  ]
    .filter(Boolean)
    .join("\n\n---\n\n");
  const latest = retrieved
    ? `${RETRIEVED_HEADING}\n\n${retrieved}\n\n---\n\n## User message\n\n${prompt}`
    : prompt;

  const turns: ChatMessage[] = selectHistory(history).map((m) =>
    m.role === "assistant"
      ? { role: "assistant", content: m.content }
      : {
          role: "user",
          content: userContent(m.content, m.attachments, resolveAttachment),
        },
  );

  return [
    { role: "system", content: system },
    ...turns,
    { role: "user", content: userContent(latest, attachments, resolveAttachment) },
  ];
}

const RETRIEVED_HEADING =
  "## Context retrieved for this message\n\n" +
  "Added by Atimo for this message only. The user did not write it and cannot see it; their own words are under \"User message\" below.";
