import { useEffect, useRef, useState } from "react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import type { ContextUsage, UsageSegment } from "@/lib/context-usage";
import { useContextUsage } from "@/lib/use-context-usage";
import { cn, formatTokens } from "@/lib/utils";

/*
 * Context usage meter — estimated breakdown of the next turn, with the
 * provider's measured last-turn total beside it so the estimate's error
 * stays visible. No provider returns a per-category split.
 */

export function ContextUsageTrigger({
  className,
}: {
  className?: string;
}) {
  const { usage, measured } = useContextUsage();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const reduceMotion = useReducedMotion();

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  if (!usage) return null;

  const pct = Math.min(100, Math.round((usage.total / usage.window) * 100));

  return (
    <div ref={ref} className={cn("relative inline-flex items-center", className)}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        title={`Contexto da próxima mensagem: ~${formatTokens(usage.total)} de ${formatTokens(usage.window)} tokens`}
        aria-label={`Contexto ${pct}% da janela`}
        className={cn(
          "pressable flex h-7 items-center gap-1.5 rounded-full border border-border px-2 text-[11px] tabular-nums transition-[background-color,border-color,color] duration-150 ease-out",
          open
            ? "border-border-strong bg-bg-active text-fg"
            : "bg-bg-surface hover:border-border-strong hover:bg-bg-hover hover:text-fg-dim",
          pct > 80 ? "text-red" : pct > 50 ? "text-fg-dim" : "text-fg-faint",
        )}
      >
        {/* Ring, not a number with a unit: the detail lives one click away. */}
        <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden className="-rotate-90">
          <circle cx="8" cy="8" r="6" fill="none" stroke="currentColor" strokeOpacity="0.2" strokeWidth="2" />
          <circle
            cx="8"
            cy="8"
            r="6"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            pathLength="100"
            strokeDasharray={`${Math.max(pct, 2)} 100`}
            className="transition-[stroke-dasharray] duration-200 ease-out"
          />
        </svg>
        {pct}%
      </button>

      <AnimatePresence>
        {open ? (
          <motion.div
            initial={
              reduceMotion ? { opacity: 0 } : { opacity: 0, scale: 0.96, y: 6 }
            }
            animate={
              reduceMotion ? { opacity: 1 } : { opacity: 1, scale: 1, y: 0 }
            }
            exit={
              reduceMotion ? { opacity: 0 } : { opacity: 0, scale: 0.97, y: 4 }
            }
            transition={
              reduceMotion
                ? { duration: 0.12 }
                : { type: "spring", bounce: 0, duration: 0.32 }
            }
            style={{
              transformOrigin: "bottom left",
              boxShadow: "var(--shadow-panel)",
            }}
            className="absolute bottom-full left-0 z-30 mb-2 w-[min(320px,calc(100vw-1.5rem))] overflow-hidden rounded-[12px] border border-border-strong bg-bg-raised max-sm:left-1/2 max-sm:-translate-x-1/2"
          >
            <UsageBody usage={usage} measured={measured} />
          </motion.div>
        ) : null}
      </AnimatePresence>
    </div>
  );
}

/** Compact status-bar chip — same numbers, no panel of its own. */
export function ContextUsageChip() {
  const { usage, measured } = useContextUsage();
  if (!usage) return null;

  const pct = Math.min(100, Math.round((usage.total / usage.window) * 100));

  return (
    <span
      title={
        measured != null
          ? `Próxima mensagem ~${usage.total.toLocaleString("pt-BR")} tokens estimados · última ${measured.toLocaleString("pt-BR")} medidos`
          : `Próxima mensagem ~${usage.total.toLocaleString("pt-BR")} tokens estimados (${pct}% da janela)`
      }
    >
      contexto{" "}
      <span
        className={cn(
          pct > 80 ? "text-red" : pct > 0 ? "text-cyan" : "",
        )}
      >
        {pct}%
      </span>
    </span>
  );
}

function UsageBody({
  usage,
  measured,
}: {
  usage: ContextUsage;
  measured: number | null;
}) {
  const pct = Math.min(100, Math.round((usage.total / usage.window) * 100));
  const visible = usage.segments.filter((s) => s.tokens > 0);

  return (
    <div className="px-4 py-3.5">
      <div className="flex items-baseline justify-between gap-3">
        <span className="text-[13px] font-medium tracking-[-0.01em] text-fg">
          {pct}% da janela
        </span>
        <span className="text-[12px] tabular-nums text-fg-dim">
          ~{formatTokens(usage.total)} de {formatTokens(usage.window)} tokens
        </span>
      </div>

      <StackedBar segments={visible} window={usage.window} />

      <ul className="mt-3 space-y-1.5">
        {visible.map((segment) => (
          <li
            key={segment.id}
            className="flex items-center gap-2 text-[12px] tracking-[-0.01em]"
            title={segment.hint}
          >
            <span
              className="h-2 w-2 shrink-0 rounded-[3px]"
              style={{ background: segment.tint }}
            />
            <span className="min-w-0 flex-1 truncate text-fg-dim">
              {segment.label}
            </span>
            <span className="shrink-0 tabular-nums text-fg-faint">
              {formatTokens(segment.tokens)}
            </span>
          </li>
        ))}
      </ul>

      <div className="mt-3 space-y-1 border-t border-border pt-2.5 text-[11px] leading-relaxed text-fg-faint">
        <p>Divisão estimada · ~4 caracteres por token</p>
        {measured != null ? (
          <p className="tabular-nums">
            Última mensagem:{" "}
            <span className="text-fg-dim">{formatTokens(measured)}</span>{" "}
            tokens medidos pelo provedor
          </p>
        ) : (
          <p>Envie uma mensagem para ver o total medido pelo provedor</p>
        )}
        {usage.dropped > 0 && (
          <p>
            −{formatTokens(usage.dropped)} tokens deixados de fora para caber no
            orçamento de contexto
          </p>
        )}
      </div>
    </div>
  );
}

function StackedBar({
  segments,
  window,
}: {
  segments: UsageSegment[];
  window: number;
}) {
  return (
    <div className="mt-2.5 flex h-2 w-full overflow-hidden rounded-full bg-bg-inset">
      {segments.map((segment) => {
        const width = Math.max(0.4, (segment.tokens / window) * 100);
        return (
          <div
            key={segment.id}
            title={`${segment.label}: ${formatTokens(segment.tokens)}`}
            className="h-full min-w-px transition-[width] duration-200 ease-out"
            style={{ width: `${width}%`, background: segment.tint }}
          />
        );
      })}
    </div>
  );
}
