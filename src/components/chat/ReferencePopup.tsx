import { useEffect, useRef } from "react";
import { KindGlyph, Kbd } from "@/components/ui/primitives";
import { IMPLEMENTED_KINDS } from "@/lib/references";
import {
  cn,
  describeReferenceCost,
  formatShare,
  formatTokens,
} from "@/lib/utils";
import type { ReferenceCost } from "@/lib/reference-resolver";
import type { Referenceable, ReferenceKind } from "@/lib/types";
import { REFERENCE_KINDS } from "@/lib/types";

/*
 * The `@` autocomplete. Kind first (`@` alone), then target (`@chat(` onward).
 *
 * Target rows carry the price of the mention against the current chat's model,
 * because that is the moment the choice is made. Afterwards the chip is atomic
 * and the cost is already spent.
 */

export interface KindOption {
  kind: ReferenceKind;
  implemented: boolean;
}

// Only kinds that resolve today. A menu of "coming soon" rows teaches the user
// that `@` mostly doesn't work.
export const KIND_OPTIONS: KindOption[] = REFERENCE_KINDS.filter((kind) =>
  IMPLEMENTED_KINDS.has(kind),
).map((kind) => ({ kind, implemented: true }));

interface Props {
  mode: "kind" | "target";
  kinds: KindOption[];
  items: Referenceable[];
  /** Cost of each item against the current model, index-aligned with `items`. */
  costs?: (ReferenceCost | null)[];
  active: number;
  onPick: (index: number) => void;
  onHover: (index: number) => void;
}

export function ReferencePopup({
  mode,
  kinds,
  items,
  costs,
  active,
  onPick,
  onHover,
}: Props) {
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    listRef.current
      ?.querySelector<HTMLElement>(`[data-index="${active}"]`)
      ?.scrollIntoView({ block: "nearest" });
  }, [active]);

  const count = mode === "kind" ? kinds.length : items.length;
  if (count === 0) return null;

  return (
    <div
      className="fade-up absolute bottom-full left-0 z-20 mb-2 w-[min(420px,100%)] overflow-hidden rounded-[14px] border border-border-strong bg-bg-raised"
      style={{ boxShadow: "var(--shadow-panel)" }}
    >
      <div ref={listRef} className="scroll-thin max-h-56 overflow-y-auto py-1.5">
        {mode === "kind"
          ? kinds.map((option, index) => (
              <Row
                key={option.kind}
                index={index}
                active={index === active}
                onPick={onPick}
                onHover={onHover}
              >
                <KindGlyph kind={option.kind} />
                <span className="text-[13px] tracking-[-0.01em] text-fg">
                  @{option.kind}
                </span>
              </Row>
            ))
          : items.map((item, index) => (
              <Row
                key={item.id}
                index={index}
                active={index === active}
                onPick={onPick}
                onHover={onHover}
              >
                <KindGlyph kind={item.kind} />
                <span className="min-w-0 truncate text-[13px] tracking-[-0.01em] text-fg">
                  {item.label}
                </span>
                <span className="min-w-0 flex-1 truncate text-[12px] text-fg-faint">
                  {item.hint}
                </span>
                <CostTag cost={costs?.[index] ?? null} />
              </Row>
            ))}
      </div>

      <div className="flex items-center gap-3 border-t border-border bg-bg-inset/80 px-3 py-2 text-[11px] text-fg-faint">
        <span className="flex items-center gap-1.5">
          <Kbd>↑↓</Kbd> navegar
        </span>
        <span className="flex items-center gap-1.5">
          <Kbd>⏎</Kbd> escolher
        </span>
        <span className="flex items-center gap-1.5">
          <Kbd>esc</Kbd> fechar
        </span>
        {mode === "target" && (
          <>
            <span className="flex-1" />
            <span className="truncate">custo no modelo deste chat</span>
          </>
        )}
      </div>
    </div>
  );
}

/**
 * What this candidate would add to the next prompt. Turns red once a single
 * mention would use up the whole retrieval budget on its own — references are
 * never dropped, so past that point it is project knowledge that gets cut.
 */
function CostTag({ cost }: { cost: ReferenceCost | null }) {
  if (!cost) return null;

  return (
    <span
      title={describeReferenceCost(cost)}
      className={cn(
        "shrink-0 tabular-nums text-[11px]",
        cost.budgetShare >= 1 ? "text-red" : "text-fg-faint",
      )}
    >
      ~{formatTokens(cost.tokens)}
      <span className="text-fg-faint"> · {formatShare(cost.share)}</span>
    </span>
  );
}

function Row({
  index,
  active,
  onPick,
  onHover,
  children,
}: {
  index: number;
  active: boolean;
  onPick: (i: number) => void;
  onHover: (i: number) => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      data-index={index}
      onMouseDown={(e) => {
        e.preventDefault();
        onPick(index);
      }}
      onMouseEnter={() => onHover(index)}
      className={cn(
        "flex w-full items-center gap-2.5 px-3 py-2 text-left transition-colors duration-150 ease-out",
        active ? "bg-bg-active" : "hover:bg-bg-hover",
      )}
    >
      {children}
    </button>
  );
}
