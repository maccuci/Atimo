import { useMemo } from "react";
import { AiBrain01Icon } from "@hugeicons/core-free-icons";
import { Icon } from "@/components/ui/Icon";
import {
  summarizeReasoning,
  type ReasoningVisibility,
} from "@/lib/reasoning";
import { cn } from "@/lib/utils";
import { LoadingState } from "./LoadingState";

/*
 * Renders a model's scratchpad according to the account preference.
 *
 * During the reasoning-only phase, "hidden" still shows a quiet pulse so the
 * turn does not look stuck — it just never dumps the stream.
 */

export function ReasoningBlock({
  reasoning,
  hasAnswer,
  visibility,
  since,
}: {
  reasoning: string;
  hasAnswer: boolean;
  visibility: ReasoningVisibility;
  /** When the turn started — feeds the thinking loader's elapsed timer. */
  since?: number | string;
}) {
  const bullets = useMemo(() => summarizeReasoning(reasoning), [reasoning]);

  if (visibility === "hidden") {
    if (hasAnswer) return null;
    return (
      <LoadingState label="Pensando" variant="dots" since={since} />
    );
  }

  if (visibility === "summary") {
    if (bullets.length === 0) {
      return hasAnswer ? null : (
        <LoadingState label="Pensando" variant="dots" since={since} />
      );
    }
    return (
      <div className="border-l border-border pl-3">
        <ul className="space-y-1 text-[12.5px] leading-relaxed text-fg-faint">
          {bullets.map((bullet) => (
            <li key={bullet} className="selectable flex gap-2">
              <span className="mt-[0.55em] h-1 w-1 shrink-0 rounded-full bg-fg-faint/70" />
              <span>{bullet}</span>
            </li>
          ))}
        </ul>
      </div>
    );
  }

  return (
    <div className="border-l border-border pl-3">
      <p className="selectable text-[12.5px] leading-relaxed whitespace-pre-wrap text-fg-faint">
        {reasoning}
      </p>
    </div>
  );
}

/** Footer control — reveal the full scratchpad when the preference summarised it. */
export function ReasoningToggle({
  visibility,
  active,
  onClick,
}: {
  visibility: ReasoningVisibility;
  active: boolean;
  onClick: () => void;
}) {
  if (visibility !== "summary") return null;

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
      <Icon icon={AiBrain01Icon} size={12} strokeWidth={1.75} />
      {active ? "Resumo" : "Raciocínio completo"}
    </button>
  );
}
