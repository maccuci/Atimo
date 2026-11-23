import { isAgentKey, type ProviderKey } from "./adapter";
import type { Chat, Message } from "./types";

/*
 * The panel — several models answering one prompt inside one chat.
 *
 * This is the product thesis run forwards rather than a second Compare view.
 * Compare is a bench: a throwaway prompt, three columns, no transcript, nothing
 * kept. The panel is the conversation itself, so it has to answer the question
 * Compare never faces — *which* of those answers is the chat, from the next turn
 * onwards. Everything here exists to keep that answer to exactly one.
 *
 * Kept out of the store because all of it is a pure function of a chat and a
 * transcript, and because the two rules worth being sure about — how many models
 * answer, and how the answers group back into turns — are the two that are
 * cheapest to test in isolation and most expensive to get wrong in place.
 */

/**
 * Models per turn, primary included.
 *
 * Four, and the ceiling is economic rather than technical. Every model in the
 * panel receives the project's full composed context, so the *input* side — the
 * expensive side in a workspace that prepends project knowledge to every turn —
 * multiplies by the size of the panel. Beyond about four the marginal answer
 * stops paying for itself, and the transcript stops being readable well before
 * the bill stops being tolerable.
 */
export const MAX_PANEL_MODELS = 4;

/**
 * The extra models of a panel, as they should be stored.
 *
 * The primary is deliberately not one of them. Storing the whole set in one
 * field would mean two sources of truth for "which model is this chat" — the
 * header, the context meter, the status bar and `newChat`'s carry-forward all
 * read `chat.modelId`, and a set that merely happens to have it first would
 * make every one of them a lookup that can disagree.
 */
export function normalisePanel(
  primary: string,
  extras: readonly string[] | undefined,
): string[] {
  if (!extras?.length) return [];

  const seen = new Set([primary]);
  const kept: string[] = [];
  for (const id of extras) {
    if (seen.has(id)) continue;
    seen.add(id);
    kept.push(id);
    if (kept.length === MAX_PANEL_MODELS - 1) break;
  }
  return kept;
}

/** Store the panel, or drop the field entirely when there is none. */
export function panelPatch(
  primary: string,
  extras: readonly string[] | undefined,
): Pick<Chat, "panel"> {
  const kept = normalisePanel(primary, extras);
  return { panel: kept.length ? kept : undefined };
}

/**
 * Promote one of a panel's models to primary without shrinking the comparison.
 *
 * `setChatModel` intentionally replaces the primary model when a person picks
 * a new one from the catalog. Choosing a response is different: the chosen
 * model already answered alongside the current primary, so that model set must
 * keep its membership and only change order.
 */
export function promotePanelPrimary(
  chat: Pick<Chat, "modelId" | "panel">,
  modelId: string,
): Pick<Chat, "modelId" | "panel"> {
  return {
    modelId,
    ...panelPatch(modelId, [chat.modelId, ...(chat.panel ?? [])]),
  };
}

/**
 * The models that will actually answer the next turn, primary first.
 *
 * Collapses to the primary alone on a CLI provider, and that is a correctness
 * rule rather than a policy: `claude-cli` and `codex-cli` answer as whatever
 * the installed tool is configured to be, so a panel over one of them would
 * spawn N child processes to receive N copies of the same answer — N times the
 * wait, N times the subscription usage, and a comparison between a model and
 * itself.
 */
export function panelModels(
  chat: Pick<Chat, "modelId" | "panel">,
  provider: ProviderKey,
): string[] {
  if (isAgentKey(provider)) return [chat.modelId];
  return [chat.modelId, ...normalisePanel(chat.modelId, chat.panel)];
}

/**
 * The answers of the turn at the end of the transcript, in transcript order.
 *
 * Empty when the transcript does not end in an answer at all. Regenerate reads
 * this rather than the last row alone: re-running one member of a panel would
 * leave its siblings answering a prompt that member no longer answers, and the
 * group would stop being a comparison of anything.
 */
export function lastAnswerGroup(transcript: readonly Message[]): Message[] {
  const last = transcript.at(-1);
  if (!last || last.role !== "assistant") return [];
  if (!last.turnId) return [last];

  const group: Message[] = [];
  for (let i = transcript.length - 1; i >= 0; i--) {
    const message = transcript[i]!;
    if (message.turnId !== last.turnId) break;
    group.unshift(message);
  }
  return group;
}

/** Every answer belonging to one persisted panel turn, in transcript order. */
export function answersForTurn(
  messages: readonly Message[],
  chatId: string,
  turnId: string,
): Message[] {
  return messages.filter(
    (message) =>
      message.chatId === chatId &&
      message.role === "assistant" &&
      message.turnId === turnId,
  );
}

/**
 * Answers a person can meaningfully choose to continue from.
 *
 * A stopped answer is still eligible when it has text: it is an incomplete but
 * real response. Pending and failed rows are not choices yet.
 */
export function selectablePanelAnswers(answers: readonly Message[]): Message[] {
  return answers.filter(
    (answer) => !answer.pending && !answer.error && answer.content.trim() !== "",
  );
}

/** Whether a completed panel contains a real choice for the person to make. */
export function canReviewPanelTurn(answers: readonly Message[]): boolean {
  return (
    answers.length > 1 &&
    answers.every((answer) => !answer.pending) &&
    selectablePanelAnswers(answers).length >= 2
  );
}

/** How one row of a settling turn stands, for `canonicalAfter`. */
export interface TurnRow {
  id: string;
  /** Currently the conversation. True unless the row was explicitly demoted. */
  canonical: boolean;
  /** The attempt in this row failed. */
  failed: boolean;
  /** Holds an answer worth promoting: no error, and some text. */
  usable: boolean;
}

/**
 * Which answer of a turn is the conversation, once the runs have landed.
 *
 * Pure, and separate from the store, because it is the rule the panel actually
 * turns on and the one with no visible symptom when it breaks. A turn with two
 * canonical rows carries both into the next request; a turn with none carries
 * neither, and the chat quietly loses a reply it can still see on screen.
 * Neither shows up until several turns later, as a model that has lost the
 * thread — which is not a bug report anyone can act on.
 *
 * The rows are the whole turn, not just the ones that were re-run. A retry
 * repairing one failed member of a panel decides this against siblings it never
 * touched, and demoting one of those is sometimes the correct outcome.
 *
 * A user's promotion is never overruled: rescue applies only when the current
 * canonical row *failed*, which is the absence of a choice rather than a choice
 * this could contradict. Promoting a worse answer over a working one is a
 * different act, and it stays the user's.
 */
export function canonicalAfter(rows: readonly TurnRow[]): string {
  const current = rows.find((row) => row.canonical) ?? rows[0];
  if (!current) return "";
  if (!current.failed) return current.id;

  return (rows.find((row) => row.usable) ?? current).id;
}

/**
 * One rendered unit of a transcript: a plain message, or a panel's answers
 * gathered back into the single turn they came from.
 */
export type TranscriptEntry =
  | { kind: "message"; key: string; message: Message }
  | { kind: "panel"; key: string; answers: Message[] };

/**
 * Fold a transcript into what the chat should render.
 *
 * Grouping happens here rather than in the view because it is the one place the
 * *order* of a panel's rows matters and the one place it can be checked: the
 * store appends a group contiguously, and a reader that assumed contiguity
 * without saying so would break silently the day anything inserted between them.
 * A group whose rows are not adjacent is therefore split rather than gathered —
 * the transcript stays honest about the order it was actually written in.
 */
export function groupTranscript(transcript: readonly Message[]): TranscriptEntry[] {
  const entries: TranscriptEntry[] = [];

  for (let i = 0; i < transcript.length; i++) {
    const message = transcript[i]!;
    if (!message.turnId) {
      entries.push({ kind: "message", key: message.id, message });
      continue;
    }

    const answers: Message[] = [message];
    while (i + 1 < transcript.length && transcript[i + 1]!.turnId === message.turnId) {
      answers.push(transcript[++i]!);
    }

    // A group of one is not a panel — it is a panel turn whose siblings were
    // forked away, and it should read as the ordinary answer it now is.
    if (answers.length === 1) {
      entries.push({ kind: "message", key: message.id, message });
      continue;
    }

    // Keyed by the first row, not by `turnId`: a split group would otherwise
    // hand React the same key twice.
    entries.push({ kind: "panel", key: message.id, answers });
  }

  return entries;
}

/** What a finished panel turn cost, summed across its answers. */
export function panelTotals(answers: readonly Message[]): {
  costUsd: number | undefined;
  outTokens: number;
  /** The slowest answer — a parallel turn is as long as its longest run. */
  latencyMs: number;
  settled: boolean;
} {
  let costUsd: number | undefined;
  let outTokens = 0;
  let latencyMs = 0;
  let settled = true;

  for (const answer of answers) {
    if (answer.pending) settled = false;
    if (answer.costUsd !== undefined) costUsd = (costUsd ?? 0) + answer.costUsd;
    if (!answer.usage) continue;
    outTokens += answer.usage.out;
    latencyMs = Math.max(latencyMs, answer.usage.latencyMs);
  }

  return { costUsd, outTokens, latencyMs, settled };
}
