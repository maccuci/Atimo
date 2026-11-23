import { memo } from "react";
import { Layers02Icon } from "@hugeicons/core-free-icons";
import { Icon } from "@/components/ui/Icon";
import { Button, ProviderSigil } from "@/components/ui/primitives";
import { canReviewPanelTurn, panelTotals } from "@/lib/panel";
import { useStore } from "@/lib/store";
import { cn, formatCost, formatTokens } from "@/lib/utils";
import type { Message } from "@/lib/types";
import { LoadingState } from "./LoadingState";
import { MessageItem } from "./MessageItem";

/*
 * One prompt, several answers.
 *
 * Stacked rather than columned, which is the opposite of what Compare does and
 * deliberately so. Compare owns the whole width and is read once; this sits in
 * a 760px transcript that will be scrolled past for the rest of the project's
 * life. Three columns inside it would be 240px each — narrow enough that code
 * blocks wrap to nothing and the answers stop being comparable on their merits
 * and start being comparable on how badly they were squeezed.
 *
 * So the transcript keeps one readable answer. The full comparison belongs to
 * the focused review surface, where the decision does not compete with the
 * next prompt or the rest of the conversation.
 */

export const PanelTurn = memo(function PanelTurn({
  answers,
  isLast = false,
}: {
  /** The answers of one turn, in the order they were sent. */
  answers: Message[];
  isLast?: boolean;
}) {
  const openPanelReview = useStore((s) => s.openPanelReview);
  const totals = panelTotals(answers);
  const canonical = answers.find((answer) => answer.canonical) ?? answers[0];

  if (!canonical) return null;

  const canReview = Boolean(canonical.turnId) && canReviewPanelTurn(answers);

  return (
    <div className="mb-1.5 overflow-hidden rounded-[12px] border border-border bg-bg-surface/30">
      <div className="flex min-h-10 items-center gap-2 px-3.5 py-2 text-[11px] text-fg-faint">
        <Icon icon={Layers02Icon} size={12} strokeWidth={1.75} />
        <span className="text-fg-dim">{answers.length} models</span>

        <span className="flex shrink-0 items-center gap-1">
          {answers.map((answer) => (
            <ProviderSigil
              key={answer.id}
              modelId={answer.modelId ?? ""}
              className={cn(
                "h-4 w-4 border-0 bg-transparent",
                answer.canonical ? "" : "opacity-45",
              )}
              size={11}
            />
          ))}
        </span>

        <div className="min-w-2 flex-1" />

        {totals.settled ? (
          <span className="hidden tabular-nums sm:inline">
            {formatTokens(totals.outTokens)} out
            {totals.costUsd !== undefined ? ` · ${formatCost(totals.costUsd)}` : ""}
            {/* Wall clock, not the sum: the models ran at the same time, so the
                turn took as long as its slowest. Summing would report a wait
                nobody actually had. */}
            {totals.latencyMs
              ? ` · ${(totals.latencyMs / 1000).toFixed(1)}s`
              : ""}
          </span>
        ) : (
          <LoadingState
            label="Respondendo"
            variant="orbit"
            size="sm"
            since={canonical.createdAt}
          />
        )}

        {canReview ? (
          <Button
            type="button"
            variant="outline"
            onClick={() => openPanelReview(canonical.chatId, canonical.turnId!)}
            className="ml-1 h-7 shrink-0"
          >
            Revisar respostas
          </Button>
        ) : null}
      </div>

      <MessageItem message={canonical} isLast={isLast} inPanel />
    </div>
  );
});
