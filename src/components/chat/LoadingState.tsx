import { useEffect, useState } from "react";
import { useReducedMotion } from "motion/react";
import { cn } from "@/lib/utils";

/*
 * Pixel-grid loader for the wait before the first token — composing context,
 * thinking, or a panel still settling. Paired with a shimmering label and a
 * live elapsed timer in mono tabular figures.
 *
 * Variants:
 *   drive — square cells, chevron wavefront driving right
 *   dots  — same wavefront, circular cells
 *   orbit — a comet lapping the grid perimeter
 *
 * Reduced motion freezes the grid to its dim state; the timer still ticks.
 */

const chevron = Array.from({ length: 9 }, (_, i) => {
  const r = Math.floor(i / 3);
  const c = i % 3;
  return (c + Math.abs(r - 1)) * 90;
});

const ORBIT_ORDER = [0, 1, 2, 5, 8, 7, 6, 3];
const orbit = Array.from({ length: 9 }, (_, i) => {
  const k = ORBIT_ORDER.indexOf(i);
  return k === -1 ? null : k * 110;
});

export type LoadingVariant = "drive" | "dots" | "orbit";

const PATTERNS: Record<
  LoadingVariant,
  { delays: (number | null)[]; dur: number; round: boolean }
> = {
  drive: { delays: chevron, dur: 650, round: false },
  dots: { delays: chevron, dur: 650, round: true },
  orbit: { delays: orbit, dur: 950, round: false },
};

function toEpoch(since?: number | string): number | undefined {
  if (since == null) return undefined;
  if (typeof since === "number") return since;
  const ms = Date.parse(since);
  return Number.isFinite(ms) ? ms : undefined;
}

function useElapsed(since?: number | string) {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 100);
    return () => clearInterval(t);
  }, []);

  const start = toEpoch(since) ?? now;
  const total = Math.max(0, (now - start) / 1000);
  if (total < 60) return `${total.toFixed(1)}s`;
  return `${Math.floor(total / 60)}m ${(total % 60).toFixed(1)}s`;
}

export function LoadingState({
  label = "Pensando",
  variant = "drive",
  since,
  size = "md",
  className,
}: {
  label?: string;
  variant?: LoadingVariant;
  /** When the wait started (epoch ms or ISO) — timer survives remounts. */
  since?: number | string;
  size?: "sm" | "md";
  className?: string;
}) {
  const reduceMotion = useReducedMotion();
  const elapsed = useElapsed(since);
  const { delays, dur, round } = PATTERNS[variant];
  const compact = size === "sm";

  return (
    <div
      role="status"
      aria-live="polite"
      aria-label={`${label}, ${elapsed}`}
      className={cn(
        "flex w-fit items-center",
        compact ? "gap-2" : "gap-2.5",
        className,
      )}
    >
      <span
        aria-hidden
        className={cn(
          "grid",
          compact
            ? "grid-cols-[repeat(3,3px)] gap-[1px]"
            : "grid-cols-[repeat(3,4px)] gap-[1.5px]",
        )}
      >
        {delays.map((d, i) => (
          <span
            key={i}
            className={cn(
              "bg-fg",
              compact ? "size-[3px]" : "size-[4px]",
              round ? "rounded-full" : "rounded-[1px]",
            )}
            style={{
              opacity: d === null ? 0.07 : 0.15,
              animation:
                reduceMotion || d === null
                  ? "none"
                  : `pixel-on ${dur}ms ease-in-out ${d}ms infinite`,
            }}
          />
        ))}
      </span>
      <span
        className={cn(
          "font-medium tracking-[-0.01em]",
          compact ? "text-[11px]" : "text-[13px]",
          reduceMotion
            ? "text-fg-dim"
            : "bg-clip-text text-transparent [background-size:200%_100%]",
        )}
        style={
          reduceMotion
            ? undefined
            : {
                backgroundImage:
                  "linear-gradient(90deg, var(--fg-faint) 35%, var(--fg) 50%, var(--fg-faint) 65%)",
                animation: "shimmer-text 1.4s linear infinite",
              }
        }
      >
        {label}
      </span>
      <span
        className={cn(
          "font-mono text-fg-faint tabular-nums",
          compact ? "text-[11px]" : "text-[12px]",
        )}
      >
        {elapsed}
      </span>
    </div>
  );
}
