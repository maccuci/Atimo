import type { ComponentProps, ReactNode } from "react";
import {
  AiChat02Icon,
  ApiIcon,
  File01Icon,
  File02Icon,
  Folder01Icon,
  GithubIcon,
  Message01Icon,
  PuzzleIcon,
  Task01Icon,
  Unlink01Icon,
  User02Icon,
} from "@hugeicons/core-free-icons";
import type { IconSvgElement } from "@hugeicons/react";
import { Icon } from "@/components/ui/Icon";
import { getModel } from "@/lib/models";
import { modelProviderUi } from "@/lib/provider-ui";
import type { ChunkKind } from "@/lib/types";
import { cn } from "@/lib/utils";

/*
 * Shared primitives for Atimo chrome — soft radii, press feedback, quiet labels.
 */

export function Kbd({ children }: { children: ReactNode }) {
  return (
    <kbd className="rounded-md border border-border bg-bg-inset px-1.5 py-px text-[10px] leading-[1.4] text-fg-dim">
      {children}
    </kbd>
  );
}

export function Label({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div
      className={cn(
        "text-[11px] font-medium tracking-[0.02em] text-fg-faint",
        className,
      )}
    >
      {children}
    </div>
  );
}

/** A dim horizontal rule with an optional inline label. */
export function Rule({ children }: { children?: ReactNode }) {
  if (!children) return <div className="h-px w-full bg-border" />;
  return (
    <div className="flex items-center gap-2">
      <span className="shrink-0 text-[11px] font-medium tracking-[0.02em] text-fg-faint">
        {children}
      </span>
      <div className="h-px flex-1 bg-border" />
    </div>
  );
}

export function IconButton({
  className,
  active,
  ...props
}: ComponentProps<"button"> & { active?: boolean }) {
  return (
    <button
      {...props}
      className={cn(
        "pressable inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-lg",
        "text-fg-faint transition-[background-color,color] duration-150 ease-out hover:bg-bg-hover hover:text-fg",
        active && "bg-bg-active text-fg",
        "disabled:pointer-events-none disabled:opacity-40",
        className,
      )}
    />
  );
}

export function Button({
  className,
  variant = "ghost",
  ...props
}: ComponentProps<"button"> & { variant?: "ghost" | "outline" | "accent" }) {
  return (
    <button
      {...props}
      className={cn(
        "pressable inline-flex h-7 items-center gap-1.5 rounded-lg px-2.5 text-[12px] tracking-[-0.01em] transition-[background-color,border-color,color] duration-150 ease-out",
        "disabled:pointer-events-none disabled:opacity-40",
        variant === "ghost" && "text-fg-dim hover:bg-bg-hover hover:text-fg",
        variant === "outline" &&
          "border border-border text-fg-dim hover:border-border-strong hover:text-fg",
        variant === "accent" &&
          "border border-cyan/40 bg-cyan/10 text-cyan hover:bg-cyan/20",
        className,
      )}
    />
  );
}

/** Provider brand mark for a model. */
export function ProviderSigil({
  modelId,
  className,
  size = 12,
}: {
  modelId: string;
  className?: string;
  size?: number;
}) {
  const model = getModel(modelId);
  const ui = modelProviderUi(modelId);
  return (
    <span
      title={model.label}
      className={cn(
        "inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-md border border-border bg-bg-surface",
        className,
      )}
    >
      <Icon icon={ui.icon} size={size} color={ui.color} strokeWidth={1.5} />
    </span>
  );
}

/**
 * Reference kinds get a semantic icon rather than a color, so the palette stays
 * within the four semantic hues the Codex guide allows.
 */
export const KIND_ICON: Record<ChunkKind, IconSvgElement> = {
  chat: AiChat02Icon,
  project: Folder01Icon,
  document: File01Icon,
  message: Message01Icon,
  task: Task01Icon,
  person: User02Icon,
  api: ApiIcon,
  github: GithubIcon,
  file: File02Icon,
  skill: PuzzleIcon,
  missing: Unlink01Icon,
};

export function KindGlyph({
  kind,
  className,
}: {
  kind: ChunkKind;
  className?: string;
}) {
  return (
    <span className={cn("inline-flex shrink-0 text-fg-faint", className)} aria-hidden>
      {/* Saved turns may still carry retired kinds (memory, decision). */}
      <Icon icon={KIND_ICON[kind] ?? KIND_ICON.missing} size={14} strokeWidth={1.75} />
    </span>
  );
}

/** Score meter: a 5-cell bar, filled proportionally. */
export function ScoreBar({ score }: { score: number }) {
  const filled = Math.round(score * 5);
  return (
    <span
      className="inline-flex items-center gap-px"
      title={score.toFixed(2)}
    >
      {Array.from({ length: 5 }, (_, i) => (
        <span
          key={i}
          className={cn(
            "h-1 w-2 rounded-full",
            i < filled ? "bg-cyan/70" : "bg-border-strong",
          )}
        />
      ))}
    </span>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return (
    <div className="flex h-full items-center justify-center px-8 text-center">
      <div className="max-w-sm text-[13px] leading-relaxed text-fg-dim">
        {children}
      </div>
    </div>
  );
}
