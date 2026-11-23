import type { CSSProperties, ReactNode } from "react";
import { cn } from "@/lib/utils";

/**
 * Shared atoms for the t3-derived chrome. Pure presentation — anything that
 * needs store data takes it as props or reads the store itself.
 */

export function T3Section({
  title,
  right,
  className,
  children,
}: {
  title?: string;
  right?: ReactNode;
  className?: string;
  children: ReactNode;
}) {
  return (
    <section className={cn("px-2 pb-4", className)}>
      {title ? (
        <div className="mb-1 flex items-center justify-between gap-2 px-1 py-1">
          <span className="t3-section-label">{title}</span>
          {right ? <div className="flex items-center">{right}</div> : null}
        </div>
      ) : null}
      {children}
    </section>
  );
}

export function T3Row({
  icon,
  label,
  value,
  active,
  onClick,
  title,
}: {
  icon?: ReactNode;
  label: ReactNode;
  value?: ReactNode;
  active?: boolean;
  onClick?: () => void;
  title?: string;
}) {
  const Comp = onClick ? "button" : "div";
  return (
    <Comp
      type={onClick ? "button" : undefined}
      data-active={active || undefined}
      title={title}
      onClick={onClick}
      className="t3-row pressable"
    >
      {icon ? <span className="flex shrink-0 items-center text-fg-dim">{icon}</span> : null}
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {value ? <span className="t3-row-value shrink-0">{value}</span> : null}
    </Comp>
  );
}

export function T3ChevronValue({ children }: { children: ReactNode }) {
  return (
    <span className="inline-flex items-center gap-1.5 text-fg-faint">
      <span className="max-w-[120px] truncate">{children}</span>
      <svg width="10" height="10" viewBox="0 0 10 10" fill="none" aria-hidden>
        <path
          d="M3.5 1.5L7 5L3.5 8.5"
          stroke="currentColor"
          strokeWidth="1.25"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    </span>
  );
}

/** Raised surface card — the t3 `.t3-card` with optional className merge. */
export function T3Card({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return <div className={cn("t3-card", className)}>{children}</div>;
}

/** Small colored tile for a project — hash-seeded so it's stable per name. */
const TILE_HUES = [210, 160, 280, 24, 330, 96, 190, 0];

export function projectTileStyle(name: string): CSSProperties {
  let hash = 0;
  for (let i = 0; i < name.length; i++) {
    hash = (hash * 31 + name.charCodeAt(i)) >>> 0;
  }
  const hue = TILE_HUES[hash % TILE_HUES.length]!;
  return {
    background: `linear-gradient(155deg, hsl(${hue} 42% 34%) 0%, hsl(${hue} 46% 22%) 100%)`,
    boxShadow: `inset 0 1px 0 hsl(${hue} 60% 60% / 35%), inset 0 0 0 1px hsl(${hue} 40% 55% / 25%)`,
  };
}

export function projectTileText(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  if (words.length >= 2) return (words[0]![0]! + words[1]![0]!).toUpperCase();
  return name.slice(0, 2).toUpperCase();
}

export function relativeTime(iso: string): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return "";
  const seconds = Math.max(0, Math.floor((Date.now() - then) / 1000));
  if (seconds < 60) return "agora";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days} d`;
  return `${Math.floor(days / 30)} meses`;
}
