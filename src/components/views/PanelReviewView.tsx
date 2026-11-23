import { useEffect, useRef, type CSSProperties } from "react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { Markdown } from "@/components/ui/Markdown";
import { Button, ProviderSigil } from "@/components/ui/primitives";
import { getModel } from "@/lib/models";
import { answersForTurn, selectablePanelAnswers } from "@/lib/panel";
import { useStore, type PanelReview } from "@/lib/store";
import type { Message } from "@/lib/types";
import { cn, formatCached, formatCost, formatTokens } from "@/lib/utils";

/**
 * A focused decision surface, not another transcript or bench. It appears only
 * when a completed panel has two or more answers that are actually usable.
 */
export function PanelReviewView() {
  const review = useStore((s) => s.panelReview);

  return (
    <AnimatePresence>
      {review ? <Review key={`${review.chatId}:${review.turnId}`} target={review} /> : null}
    </AnimatePresence>
  );
}

function Review({ target }: { target: PanelReview }) {
  const messages = useStore((s) => s.messages);
  const closePanelReview = useStore((s) => s.closePanelReview);
  const choosePanelReviewAnswer = useStore((s) => s.choosePanelReviewAnswer);
  const reduceMotion = useReducedMotion();
  const closeRef = useRef<HTMLButtonElement>(null);
  const returnFocusRef = useRef<HTMLElement | null>(null);

  const answers = selectablePanelAnswers(
    answersForTurn(messages, target.chatId, target.turnId),
  );

  useEffect(() => {
    if (answers.length < 2) closePanelReview();
  }, [answers.length, closePanelReview]);

  useEffect(() => {
    returnFocusRef.current =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    closeRef.current?.focus();

    return () => {
      returnFocusRef.current?.focus();
    };
  }, []);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      closePanelReview();
    };

    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [closePanelReview]);

  if (answers.length < 2) return null;

  return (
    <motion.section
      role="dialog"
      aria-modal
      aria-labelledby="panel-review-title"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      transition={{ duration: reduceMotion ? 0.12 : 0.18 }}
      className="fixed inset-0 z-100 flex flex-col overflow-hidden bg-bg"
    >
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0"
        style={{
          background:
            "radial-gradient(ellipse 70% 45% at 50% 28%, color-mix(in srgb, var(--cyan) 8%, transparent), transparent 70%)",
        }}
      />

      <div className="scroll-thin relative flex min-h-0 flex-1 flex-col overflow-y-auto">
        <div className="mx-auto flex w-full max-w-5xl flex-col px-4 pt-12 pb-[max(3rem,var(--safe-bottom))] sm:px-6 sm:pt-16">
          <header className="stagger-in text-center">
            <img
              src="/logo.png"
              alt=""
              className="mx-auto mb-4 size-9 select-none rounded-[7px]"
            />
            <h2
              id="panel-review-title"
              className="text-[24px] font-semibold tracking-[-0.035em] text-fg sm:text-[28px]"
              style={{ lineHeight: 1.1 }}
            >
              Escolha uma resposta
            </h2>
            <p className="mx-auto mt-2 max-w-md text-[14px] leading-relaxed tracking-[-0.01em] text-fg-dim">
              {answers.length} respostas prontas — escolha a que deve guiar a
              próxima mensagem.
              <span className="text-fg-faint">
                {" "}
                Dá para voltar sem mudar nada.
              </span>
            </p>
          </header>

          <div
            className="stagger-in mt-8 grid grid-cols-1 gap-3 md:grid-cols-2"
            style={{ animationDelay: "40ms" }}
          >
            {answers.map((answer, index) => (
              <ReviewAnswerCard
                key={answer.id}
                message={answer}
                onChoose={choosePanelReviewAnswer}
                style={{ animationDelay: `${80 + index * 40}ms` }}
              />
            ))}
          </div>

          <div
            className="stagger-in mt-8 flex justify-center"
            style={{ animationDelay: `${120 + answers.length * 40}ms` }}
          >
            <button
              ref={closeRef}
              type="button"
              onClick={closePanelReview}
              className="pressable rounded-[12px] px-4 py-2.5 text-[13px] tracking-[-0.01em] text-fg-dim transition-[background-color,color] duration-150 ease-out hover:bg-bg-hover hover:text-fg"
            >
              Voltar ao chat
            </button>
          </div>
        </div>
      </div>
    </motion.section>
  );
}

function ReviewAnswerCard({
  message,
  onChoose,
  style,
}: {
  message: Message;
  onChoose: (messageId: string) => void;
  style?: CSSProperties;
}) {
  const model = message.modelId ? getModel(message.modelId) : null;
  const label = model?.label ?? "Resposta do modelo";
  const action = message.canonical ? "Manter esta resposta" : "Continuar com esta";

  return (
    <article
      style={style}
      className={cn(
        "stagger-in flex min-h-[min(420px,calc(100vh-16rem))] flex-col overflow-hidden rounded-[16px] border bg-bg-raised shadow-[0_8px_28px_rgb(0_0_0/0.12),0_1px_3px_rgb(0_0_0/0.06)]",
        message.canonical
          ? "border-cyan/40 ring-1 ring-cyan/15"
          : "border-border-strong",
      )}
    >
      <header className="flex shrink-0 items-center gap-2.5 border-b border-border px-4 py-3.5">
        {message.modelId ? (
          <ProviderSigil
            modelId={message.modelId}
            className="h-9 w-9 shrink-0 rounded-[9px]"
            size={14}
          />
        ) : null}
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[14px] font-medium tracking-[-0.02em] text-fg">
            {label}
          </span>
          {message.usage ? (
            <span className="mt-0.5 block truncate text-[11.5px] tabular-nums text-fg-faint">
              {formatTokens(message.usage.in)} entrada · {formatTokens(message.usage.out)} saída ·{" "}
              {(message.usage.latencyMs / 1000).toFixed(1)}s
              {formatCached(message.usage)}
              {message.costUsd !== undefined ? ` · ${formatCost(message.costUsd)}` : ""}
            </span>
          ) : (
            <span className="mt-0.5 block text-[11.5px] text-fg-faint">
              Resposta pronta
            </span>
          )}
        </span>
        {message.canonical ? (
          <span className="shrink-0 rounded-full border border-cyan/30 bg-cyan/8 px-2 py-0.5 text-[10px] font-medium tracking-[0.02em] text-cyan">
            Atual
          </span>
        ) : null}
        {message.stopped ? (
          <span className="shrink-0 rounded-full border border-border px-2 py-0.5 text-[10px] text-fg-faint">
            Parcial
          </span>
        ) : null}
      </header>

      <div className="scroll-thin selectable min-h-0 flex-1 overflow-y-auto px-4 py-4">
        <Markdown source={message.content} className="text-[14px] leading-relaxed" />
      </div>

      <footer className="shrink-0 border-t border-border px-4 py-3">
        <Button
          type="button"
          variant={message.canonical ? "outline" : "accent"}
          onClick={() => onChoose(message.id)}
          aria-label={`${action}: ${label}`}
          className={cn(
            "pressable h-9 w-full",
            !message.canonical &&
              "shadow-[0_1px_2px_rgb(0_0_0/0.08)] transition-[background-color,transform] duration-150 ease-[var(--ease-out)]",
          )}
        >
          {action}
        </Button>
      </footer>
    </article>
  );
}
