import {
  Bone01Icon,
  DatabaseIcon,
  FileUploadIcon,
  Layers01Icon,
  Mail01Icon,
  PuzzleIcon,
  TaskDaily01Icon,
} from "@hugeicons/core-free-icons";
import type { IconSvgElement } from "@hugeicons/react";
import { cn } from "@/lib/utils";
import type { SkillMode } from "@/lib/types";

/* Shared between the skills list and the skill sheet. */

/**
 * A mark per skill, monochrome on purpose: the four semantic hues are reserved
 * for state, and six tinted tiles would drown the one cyan switch that matters.
 */
const SKILL_ICON: Record<string, IconSvgElement> = {
  caveman: Bone01Icon,
  "minimal-solution": Layers01Icon,
  "client-text": Mail01Icon,
  "functional-spec": TaskDaily01Icon,
  "sql-review": DatabaseIcon,
  "hdl-load": FileUploadIcon,
};

export const skillIcon = (id: string): IconSvgElement =>
  SKILL_ICON[id] ?? PuzzleIcon;

const MODE_LABEL: Record<SkillMode, string> = { off: "Desligada", auto: "Auto", always: "Sempre" };
const MODE_HINT: Record<SkillMode, string> = {
  off: "Não carrega em nenhuma mensagem",
  auto: "Carrega nas mensagens que batem com um gatilho",
  always: "Carrega em toda mensagem",
};

/**
 * Off, auto or always — one control, because they are one choice. A switch
 * beside an auto/always pair asked the same question twice.
 */
export function ModeToggle({
  mode,
  onMode,
  name,
}: {
  mode: SkillMode;
  onMode: (mode: SkillMode) => void;
  name: string;
}) {
  return (
    <div
      role="group"
      aria-label={`Quando ${name} carrega`}
      className="inline-flex h-7 shrink-0 items-center rounded-lg border border-border p-0.5"
    >
      {(["off", "auto", "always"] as const).map((option) => (
        <button
          key={option}
          type="button"
          onClick={() => onMode(option)}
          aria-pressed={mode === option}
          title={MODE_HINT[option]}
          className={cn(
            "pressable rounded-[6px] px-2 py-0.5 text-[11px] tracking-[-0.01em] transition-[background-color,color] duration-150 ease-out",
            mode === option
              ? option === "off"
                ? "bg-bg-active text-fg-dim"
                : "bg-bg-active text-fg"
              : "text-fg-dim hover:text-fg",
          )}
        >
          {MODE_LABEL[option]}
        </button>
      ))}
    </div>
  );
}
