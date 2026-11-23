import { ResearchSources } from "@/components/chat/ResearchSources";
import { IntegrationSources } from "@/components/chat/IntegrationSources";
import { memo, useMemo, useState } from "react";
import {
  Alert02Icon,
  Copy01Icon,
  GitForkIcon,
  Layers01Icon,
  RefreshIcon,
} from "@hugeicons/core-free-icons";
import { Markdown } from "@/components/ui/Markdown";
import { Icon } from "@/components/ui/Icon";
import { ProviderSigil } from "@/components/ui/primitives";
import { getModel } from "@/lib/models";
import { providerUi } from "@/lib/provider-ui";
import { useStore } from "@/lib/store";
import { useSelectableModels } from "@/lib/use-models";
import { cn, formatCached, formatCost, formatTime, formatTokens } from "@/lib/utils";
import type { Message } from "@/lib/types";
import { SentAttachments } from "@/components/chat/AttachmentTray";
import { LoadingState } from "@/components/chat/LoadingState";
import { ReasoningBlock, ReasoningToggle } from "@/components/chat/ReasoningBlock";
import { ReferenceText } from "@/components/chat/ReferenceText";

/** Hoisted so the selector below returns one stable reference, not a new `{}`. */
const NO_BLOBS: Record<string, string> = {};

/**
 * Memoised, because a streaming turn rewrites one message row on every
 * animation frame and a panel rewrites several. Without this, sixty frames a
 * second re-render the entire transcript to repaint one paragraph — and the
 * cost of that grows with the length of the conversation, which is exactly
 * backwards.
 */
export const T3MessageItem = memo(function T3MessageItem({
  message,
  isLast = false,
  inPanel = false,
}: {
  message: Message;
  /** Last turn in its chat, which is the only turn `retry` will run again. */
  isLast?: boolean;
  /** One answer of a panel turn — framed by `PanelTurn`, not on its own. */
  inPanel?: boolean;
}) {
  const inspectMessage = useStore((s) => s.inspectMessage);
  const inspectedMessageId = useStore((s) => s.inspectedMessageId);
  const forkChat = useStore((s) => s.forkChat);
  const retry = useStore((s) => s.retry);
  const sending = useStore((s) => s.sending);
  const reasoningVisibility = useStore((s) => s.reasoningVisibility);
  const forkModels = useSelectableModels();
  /*
   * The blob map is replaced wholesale whenever a chat opens or a file is
   * staged, so subscribing to it directly would re-render every row of the
   * transcript for a picture that belongs to one of them. Selecting a frozen
   * empty object for the rows with nothing attached keeps the reference stable
   * for all of them — which is nearly all of them.
   */
  const attachmentBlobs = useStore((s) =>
    message.attachments?.length ? s.attachmentBlobs : NO_BLOBS,
  );

  const [forkOpen, setForkOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const [forceFullReasoning, setForceFullReasoning] = useState(false);

  const allowedUrls = useMemo(() => message.research
    ? new Set(message.research.results.flatMap((r) => r.sources.map((source) => source.url))) : undefined, [message.research]);
  const isUser = message.role === "user";
  const model = message.modelId ? getModel(message.modelId) : null;
  const inspected = inspectedMessageId === message.id;
  const injected =
    message.context?.chunks.filter((c) => c.included).length ?? 0;

  // Forking is a quick "what would another model say?", not catalog browsing —
  // a list of three hundred here would bury the one useful choice. One model
  // per vendor is enough to make the point; the picker handles the rest.
  const forkChoices = useMemo(() => {
    const seen = new Set<string>();
    const picks = [];
    for (const model of forkModels) {
      if (seen.has(model.provider) || model.id === message.modelId) continue;
      seen.add(model.provider);
      picks.push(model);
      if (picks.length === 8) break;
    }
    return picks;
  }, [forkModels, message.modelId]);

  const copy = async () => {
    await navigator.clipboard.writeText([message.content, ...(message.research?.results.flatMap((r) => r.sources).map((s) => `${s.title}: ${s.url}`) ?? [])].join("\n\n"));
    setCopied(true);
    setTimeout(() => setCopied(false), 1_200);
  };

  // Same action either way — the difference is only whether the last attempt
  // produced anything. It is offered on a stopped turn too: stopping is how you
  // cut off an answer going the wrong way, and the next thing wanted is almost
  // always another one.
  const canRerun = !isUser && isLast && !message.pending && !sending;
  // Regenerate re-runs the whole panel, so offering it on each answer would put
  // three buttons that do one thing next to each other. It sits on the answer
  // that is the conversation; a failed sibling still gets one in its error box,
  // where the user is looking when they need it.
  const showRegenerate =
    canRerun && !message.error && (!inPanel || message.canonical === true);

  return (
    <div
      className={cn(
        "group relative transition-[background-color] duration-150 ease-out",
        inPanel
          ? "px-3.5 py-3"
          : cn(
              "mb-3 rounded-[12px]",
              isUser ? "px-1 py-0.5" : "px-1 py-1",
              inspected && "bg-bg-raised",
            ),
        inPanel && inspected && "bg-bg-raised",
        // The alternatives read as secondary to the answer that is the
        // conversation — same content, one step back in the hierarchy, so the
        // transcript still has a spine to follow.
        inPanel && !message.canonical && "opacity-80 hover:opacity-100",
      )}
    >
      {!isUser || inPanel ? (
      <div className="mb-1.5 flex items-center gap-2 px-1">
        {inPanel ? (
        <span className={cn(
          "inline-flex h-6 items-center gap-1.5 rounded-full px-2 text-[11px] font-medium tracking-[-0.01em]",
          "bg-magenta/15 text-magenta",
        )}>
          {message.modelId && (
            <ProviderSigil
              modelId={message.modelId}
              className="h-4 w-4 border-0 bg-transparent"
              size={11}
            />
          )}
          {model?.label ?? "Modelo"}
        </span>
        ) : (
          <>
            {message.modelId && (
              <ProviderSigil
                modelId={message.modelId}
                className="h-4 w-4 border-0 bg-transparent opacity-80"
                size={13}
              />
            )}
            <span className="text-[11px] font-medium tracking-[-0.005em] text-fg-faint">
              {model?.label ?? "Modelo"}
            </span>
          </>
        )}
        <span className="text-[10.5px] tabular-nums text-fg-faint">
          {formatTime(message.createdAt)}
        </span>

        {/* Which answer the next turn will build on, stated where the answer is
            rather than in a legend somewhere else. Injected context is already
            invisible at read time; which of four answers the model will inherit
            must not be. */}
        {inPanel && message.canonical ? (
          <span
            title="A resposta da qual este chat continua — é o que o próximo turno vê"
            className="inline-flex h-5 shrink-0 items-center rounded-full border border-cyan/30 bg-cyan/10 px-2 text-[10px] font-medium tracking-[-0.01em] text-cyan"
          >
            No histórico
          </span>
        ) : null}

      </div>
      ) : null}

      <div className="min-w-0">
        {/* Above the prompt, matching both the order they were composed in and
            the order they reach the model — the picture, then the question
            about it. */}
        {message.attachments?.length ? (
          <SentAttachments
            attachments={message.attachments}
            blobs={attachmentBlobs}
          />
        ) : null}

        {isUser ? (
          <div className="t3-user-bubble selectable">
            <ReferenceText value={message.content} />
          </div>
        ) : message.reasoning && !message.content ? (
          <ReasoningBlock
            reasoning={message.reasoning}
            hasAnswer={false}
            since={message.createdAt}
            visibility={
              forceFullReasoning ? "full" : reasoningVisibility
            }
          />
        ) : message.pending && !message.content ? (
          <LoadingState
            label={message.researchStage ?? "Montando contexto"}
            variant="drive"
            since={message.createdAt}
          />
        ) : (
          <Markdown source={message.content} streaming={message.pending} allowedUrls={allowedUrls} className="text-[14px] leading-relaxed" />
        )}

        {message.reasoning && message.content && reasoningVisibility !== "hidden" ? (
          <div className="mt-2.5">
            <ReasoningBlock
              reasoning={message.reasoning}
              hasAnswer
              since={message.createdAt}
              visibility={
                forceFullReasoning ? "full" : reasoningVisibility
              }
            />
          </div>
        ) : null}

        {message.research ? <ResearchSources research={message.research} /> : null}
        {!isUser && message.content && message.context ? <IntegrationSources context={message.context} /> : null}

        {message.error ? (
          <TurnError
            message={message.error}
            // Passed rather than read inside, because a failed turn that is no
            // longer the last one cannot be re-run and must not offer to be.
            onRetry={canRerun ? () => void retry(message.id) : null}
          />
        ) : null}

        {message.stopped ? (
          <p className="mt-2 text-[11px] text-fg-faint">
            Interrompida — a resposta parou aqui.
          </p>
        ) : null}


        <div
          className={cn(
            "mt-2.5 flex min-h-7 flex-wrap items-center gap-1.5 text-[11px] text-fg-faint transition-opacity duration-150 ease-out",
            inspected
              ? "opacity-100"
              : "opacity-0 group-hover:opacity-100 touch-visible",
          )}
        >
          {message.usage && (
            <span title="Tokens de entrada / saída">
              {formatTokens(message.usage.in)} entrada ·{" "}
              {formatTokens(message.usage.out)} saída ·{" "}
              {(message.usage.latencyMs / 1000).toFixed(1)}s
              {formatCached(message.usage)}
              {message.costUsd !== undefined ? ` · ${formatCost(message.costUsd)}` : ""}
            </span>
          )}

          <div className="flex-1" />

          {message.reasoning && message.content ? (
            <ReasoningToggle
              visibility={reasoningVisibility}
              active={forceFullReasoning}
              onClick={() => setForceFullReasoning((v) => !v)}
            />
          ) : null}

          {message.context && (
            <ActionButton
              active={inspected}
              onClick={() => inspectMessage(inspected ? null : message.id)}
            >
              <Icon icon={Layers01Icon} size={12} strokeWidth={1.75} />
              {injected} no contexto
            </ActionButton>
          )}

          <ActionButton onClick={copy}>
            <Icon icon={Copy01Icon} size={12} strokeWidth={1.75} />
            {copied ? "Copiado" : "Copiar"}
          </ActionButton>

          {/* Not shown on a failed turn: that one already carries its own retry
              in the error box, where it does not need hovering to find. */}
          {showRegenerate ? (
            <ActionButton onClick={() => void retry(message.id)}>
              <Icon icon={RefreshIcon} size={12} strokeWidth={1.75} />
              Gerar de novo
            </ActionButton>
          ) : null}

          <div className="relative">
            <ActionButton onClick={() => setForkOpen((v) => !v)}>
              <Icon icon={GitForkIcon} size={12} strokeWidth={1.75} />
              Fork
            </ActionButton>

            {forkOpen && (
              <div
                className="fade-up absolute right-0 bottom-full z-30 mb-1.5 w-56 overflow-hidden rounded-[12px] border border-border-strong bg-bg-raised py-1.5"
                style={{ boxShadow: "var(--shadow-panel)" }}
              >
                <div className="px-3 pb-1.5 text-[10px] font-medium tracking-[0.04em] text-fg-faint uppercase">
                  Continuar com
                </div>
                {forkChoices.map((m) => {
                  const ui = providerUi(m.provider);
                  return (
                    <button
                      key={m.id}
                      type="button"
                      onMouseDown={(e) => {
                        e.preventDefault();
                        forkChat(message.chatId, message.id, m.id);
                        setForkOpen(false);
                      }}
                      className="pressable flex w-full items-center gap-2 px-3 py-1.5 text-left text-[12.5px] text-fg-dim transition-colors duration-150 ease-out hover:bg-bg-hover hover:text-fg"
                    >
                      <Icon
                        icon={ui.icon}
                        size={13}
                        color={ui.color}
                        strokeWidth={1.5}
                      />
                      <span className="min-w-0 flex-1 truncate">{m.label}</span>
                    </button>
                  );
                })}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
});

/**
 * A failed turn. Kept inside the message rather than raised as a toast: the
 * failure belongs to this prompt, and the user needs to see which one while
 * deciding whether to retry it.
 *
 * The retry lives here rather than in the hover row below, because that row is
 * `opacity-0` until the mouse is over the message. A recovery from an error the
 * user can see, hidden behind a gesture they have no reason to try, is the same
 * as not having one — and free models rate-limit often enough that this is the
 * failure testers will meet most.
 */
function TurnError({
  message,
  onRetry,
}: {
  message: string;
  onRetry: (() => void) | null;
}) {
  const setConnectOpen = useStore((s) => s.setConnectOpen);
  const needsKey = message.startsWith("Nenhum provedor conectado");

  return (
    <div className="mt-1 flex items-start gap-2 rounded-[10px] border border-red/25 bg-red/5 px-3 py-2.5">
      <Icon
        icon={Alert02Icon}
        size={13}
        strokeWidth={1.75}
        className="mt-px text-red"
      />
      <div className="min-w-0 flex-1">
        <p className="selectable text-[12.5px] leading-relaxed text-fg-dim">{message}</p>
        {needsKey || onRetry ? (
          <div className="mt-1.5 flex flex-wrap items-center gap-3">
            {/* Connecting first, when that is what is missing: retrying without
                a key only reproduces the same sentence. */}
            {needsKey ? (
              <button
                type="button"
                onClick={() => setConnectOpen(true)}
                className="pressable rounded-md text-[11.5px] text-cyan hover:underline"
              >
                Conectar provedor
              </button>
            ) : null}
            {onRetry ? (
              <button
                type="button"
                onClick={onRetry}
                className={cn(
                  "pressable inline-flex items-center gap-1 rounded-md text-[11.5px] hover:underline",
                  needsKey ? "text-fg-dim" : "text-cyan",
                )}
              >
                <Icon icon={RefreshIcon} size={11} strokeWidth={1.75} />
                Tentar de novo
              </button>
            ) : null}
          </div>
        ) : null}
      </div>
    </div>
  );
}

function ActionButton({
  children,
  onClick,
  active,
}: {
  children: React.ReactNode;
  onClick: () => void;
  active?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "pressable inline-flex h-7 items-center gap-1.5 rounded-lg px-2 text-[11px] transition-[background-color,color] duration-150 ease-out",
        active
          ? "bg-cyan/15 text-cyan"
          : "text-fg-faint hover:bg-bg-hover hover:text-fg",
      )}
    >
      {children}
    </button>
  );
}
