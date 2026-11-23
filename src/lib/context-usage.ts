import { contextBudget, estimateTokens } from "./tokens";
import { getModel } from "./models";
import { selectHistory, systemPreamble } from "./prompt-builder";
import type { ComposedContext, Message } from "./types";

/*
 * What the next turn will cost, broken down.
 *
 * Two honesty rules govern this file, because a context meter that overstates
 * its own precision is worse than no meter:
 *
 * 1. No provider returns a per-category breakdown — only a total, and only
 *    after the turn. So every number here is an estimate at ~4 chars per token,
 *    the same estimator the composer budgets with, and the UI says so.
 *
 * 2. The estimate is priced off the exact text `buildMessages` sends: the same
 *    preamble function, the same history selection. A breakdown assembled from
 *    a lookalike would drift the first time either side changed.
 *
 * The one measured number available is the provider's own prompt-token count
 * for the last turn. It is reported next to the estimate rather than folded
 * into it, so the size of the error stays visible.
 */

export interface UsageSegment {
  id: string;
  label: string;
  tokens: number;
  /** What sits in this bucket, in one line. */
  hint: string;
  /** Swatch colour, as a theme token so both themes stay in step. */
  tint: string;
}

export interface ContextUsage {
  segments: UsageSegment[];
  /** Estimated input tokens for the next turn. */
  total: number;
  /** The model's full context window. */
  window: number;
  /** The composer's retrieval ceiling — 30% of the window. */
  budget: number;
  /** Retrieved tokens the optimizer dropped to stay under that ceiling. */
  dropped: number;
}

export interface UsageInput {
  context: ComposedContext;
  /** Prior turns of this chat, oldest first, excluding the draft. */
  history: Message[];
  /** What is in the composer right now. */
  draft: string;
  modelId: string;
  projectName: string;
  projectDescription?: string;
  /**
   * Files staged for the next turn, and the ones already in its history.
   *
   * Passed in rather than read off `history`, because half of them are not in
   * the transcript yet — an attachment is staged in the composer, exactly like
   * the draft text beside it, and a meter that only counted the sent ones would
   * report a turn as costing nothing extra right up until it was sent.
   */
  attachments?: readonly { tokens: number }[];
}

/**
 * Sum the chunks a stage contributed, counting only the ones that survived the
 * token optimizer — a dropped chunk costs nothing because it is never sent.
 */
function stageTokens(context: ComposedContext, stages: string[]): number {
  return context.chunks
    .filter((c) => c.included && stages.includes(c.stage))
    .reduce((sum, c) => sum + c.tokens, 0);
}

export function contextUsage({
  context,
  history,
  draft,
  modelId,
  projectName,
  projectDescription = "",
  attachments = [],
}: UsageInput): ContextUsage {
  const selected = selectHistory(history);

  const conversation = selected.reduce(
    (sum, m) => sum + estimateTokens(m.content),
    0,
  );

  /*
   * Staged files plus every one still inside the history window.
   *
   * The second half is the one worth stating: a stateless chat API has no memory
   * of a picture, so an image stays in the request for as long as the turn that
   * carried it stays in the tail. That is a recurring cost, not a one-off, and a
   * meter that priced it only on the turn it was attached would under-report
   * every turn afterwards — which is exactly when the window starts to matter.
   */
  const files =
    attachments.reduce((sum, a) => sum + a.tokens, 0) +
    selected.reduce(
      (sum, m) =>
        sum + (m.attachments?.reduce((n, a) => n + a.tokens, 0) ?? 0),
      0,
    );

  const segments: UsageSegment[] = [
    {
      id: "brief",
      label: "Instruções do sistema",
      tokens: estimateTokens(systemPreamble(projectName, projectDescription)),
      hint: "As instruções fixas que toda mensagem deste projeto leva",
      tint: "var(--fg-faint)",
    },
    {
      id: "instructions",
      label: "Contexto base",
      tokens: stageTokens(context, ["project"]),
      // Named as a fixed cost on purpose: it is the one segment the user can
      // shrink by editing rather than by typing less.
      hint: "O contexto base do projeto — em toda mensagem, nunca cortado",
      // Neutral, one step brighter than the system brief it sits next to in the
      // bar: both are standing preamble, and this is the half the user wrote.
      // Cyan is already spoken for by References, and two cyan bands touching
      // would read as one segment.
      tint: "var(--fg-dim)",
    },
    {
      id: "skills",
      label: "Skills",
      tokens: stageTokens(context, ["skills"]),
      hint: "Descrições das skills instaladas, mais as que esta mensagem acionou",
      tint: "var(--magenta)",
    },
    {
      id: "references",
      label: "Referências",
      tokens: stageTokens(context, ["resolve"]),
      hint: "O que você citou com @ — nunca cortado",
      tint: "var(--cyan)",
    },
    {
      id: "knowledge",
      label: "Conhecimento do projeto",
      tokens: stageTokens(context, ["semantic"]),
      hint: "Chats e documentos encontrados pela busca",
      tint: "var(--green)",
    },
    {
      id: "conversation",
      label: "Conversa",
      tokens: conversation,
      hint: "As mensagens recentes deste chat; as mais antigas são cortadas",
      tint: "var(--red)",
    },
    {
      id: "attachments",
      label: "Anexos",
      tokens: files,
      // "Roughly" is not hedging for its own sake: unlike every other segment,
      // this one is not even a character count — an image is priced by its
      // pixels and a PDF by pages nobody here has counted.
      hint: "Arquivos desta mensagem e das recentes — aproximado, imagens contam pela área",
      tint: "var(--amber)",
    },
    {
      id: "draft",
      label: "Rascunho",
      tokens: draft.trim() ? estimateTokens(draft) : 0,
      hint: "O que você está digitando agora",
      tint: "var(--fg)",
    },
  ];

  const window = getModel(modelId).contextWindow;

  return {
    segments,
    total: segments.reduce((sum, s) => sum + s.tokens, 0),
    window,
    budget: contextBudget(modelId),
    dropped: context.chunks
      .filter((c) => !c.included)
      .reduce((sum, c) => sum + c.tokens, 0),
  };
}

/** The single number, for callers that only need the total (the status bar). */
export function estimateInputTokens(input: UsageInput): number {
  return contextUsage(input).total;
}
