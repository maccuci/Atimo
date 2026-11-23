import { memo, useRef } from "react";
import { motion, useReducedMotion } from "motion/react";
import {
  CircleArrowReload01Icon,
  Edit02Icon,
} from "@hugeicons/core-free-icons";
import {
  EFFORTS,
  EFFORT_HINT,
  EFFORT_LABEL,
  effortCaveat,
  type Effort,
} from "@/lib/effort";
import { fastCaveat } from "@/lib/fast";
import { useStore } from "@/lib/store";
import { Icon } from "@/components/ui/Icon";
import { Menu } from "@/components/ui/Menu";
import { StepSlider } from "@/components/ui/StepSlider";
import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/utils";

/*
 * Effort + Fast — global routing prefs, not properties of a catalog row.
 *
 * Lives beside the model search (picker chrome), never on a selected row:
 * gating these on `model.id === modelId` made Edit vanish whenever the
 * current model was filtered out or past the list window.
 */

/* Wider than the old list needed: the effort scale has to fit six notches and
   two end labels without the notches reading as a crowd. */
const FLYOUT_W = 252;

/** The slider takes names, not levels — `EFFORTS` stays the ordering authority. */
const EFFORT_LABEL_LIST = EFFORTS.map((level) => EFFORT_LABEL[level]);

/** Quiet secondary label for the model trigger — omit defaults. */
export function summariseOptions(effort: Effort, fast: boolean): string | null {
  const parts: string[] = [];
  if (effort !== "auto") parts.push(EFFORT_LABEL[effort]);
  if (fast) parts.push("Fast");
  return parts.length ? parts.join(" ") : null;
}

export function ModelOptionsEdit({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const effort = useStore((s) => s.effort);
  const setEffort = useStore((s) => s.setEffort);
  const fast = useStore((s) => s.fast);
  const setFast = useStore((s) => s.setFast);
  const provider = useStore((s) => s.connection.provider);
  const reduceMotion = useReducedMotion();

  const canReset = effort !== "auto" || fast;
  const triggerRef = useRef<HTMLButtonElement>(null);

  return (
    <div className="relative shrink-0">
      <div className="flex items-center gap-0.5">
        {canReset ? (
          <button
            type="button"
            title="Restaurar esforço e Fast"
            aria-label="Restaurar esforço e Fast"
            onClick={() => {
              setEffort("auto");
              setFast(false);
            }}
            className={cn(
              "pressable inline-flex size-6 items-center justify-center rounded-md text-fg-faint",
              "transition-[background-color,color,transform] duration-150 ease-out",
              "hover:bg-bg-active hover:text-fg active:scale-[0.97]",
            )}
          >
            <Icon icon={CircleArrowReload01Icon} size={12} strokeWidth={2} />
          </button>
        ) : null}
        <button
          ref={triggerRef}
          type="button"
          aria-expanded={open}
          aria-haspopup="dialog"
          onClick={() => onOpenChange(!open)}
          className={cn(
            "pressable inline-flex h-6 items-center gap-1 rounded-md px-1.5 text-[11px] tracking-[-0.01em]",
            "transition-[background-color,color,transform] duration-150 ease-out",
            "active:scale-[0.97]",
            open
              ? "bg-bg-active text-fg"
              : "text-fg-faint hover:bg-bg-active hover:text-fg",
          )}
        >
          <Icon icon={Edit02Icon} size={11} strokeWidth={2} />
          Editar
        </button>
      </div>

      {/* The shared anchored layer, as a dialog: it holds a switch and a
          slider, so Tab moves between them rather than arrow keys between
          items. Portaled, so the picker's overflow can never clip it. */}
      <Menu
        open={open}
        anchor={triggerRef}
        onClose={() => onOpenChange(false)}
        label="Opções do modelo"
        width={FLYOUT_W}
        role="dialog"
      >
        <ModelOptionsFlyout
          effort={effort}
          fast={fast}
          provider={provider}
          reduceMotion={!!reduceMotion}
          onEffort={setEffort}
          onFast={setFast}
        />
      </Menu>
    </div>
  );
}

const ModelOptionsFlyout = memo(function ModelOptionsFlyout({
  effort,
  fast,
  provider,
  reduceMotion,
  onEffort,
  onFast,
}: {
  effort: Effort;
  fast: boolean;
  provider: string;
  reduceMotion: boolean;
  onEffort: (value: Effort) => void;
  onFast: (value: boolean) => void;
}) {
  const effortNote = effortCaveat(provider, effort);
  const fastNote = fast ? fastCaveat(provider) : null;
  const note = effortNote ?? fastNote;

  return (
    <>
      <div className="px-2.5 pt-2.5 pb-1">
        <p className="px-1.5 pb-1 text-[10px] font-medium tracking-[0.04em] text-fg-faint uppercase">
          Opções
        </p>
        <label
          className={cn(
            "flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5",
            "transition-colors duration-100 ease-out hover:bg-bg-hover",
          )}
        >
          <span className="min-w-0 flex-1 text-[12.5px] tracking-[-0.01em] text-fg">
            Fast
          </span>
          <Switch
            checked={fast}
            onCheckedChange={onFast}
            aria-label="Roteamento Fast"
          />
        </label>
      </div>

      {/*
        Effort is a scale, so it gets a scale. The list this replaced spent six
        rows saying what one row of notches says, and said nothing about the
        ordering — that low sits between off and medium is the whole point of
        the setting, and a column of ticks hides it.
      */}
      <div className="border-t border-border px-2.5 pt-2 pb-2.5">
        <div className="flex items-baseline justify-between gap-2 px-1.5 pb-1.5">
          <p className="text-[10px] font-medium tracking-[0.04em] text-fg-faint uppercase">
            Esforço
          </p>
          {/* Keyed, so the name re-enters on every step the drag crosses. */}
          <motion.span
            key={effort}
            initial={reduceMotion ? false : { opacity: 0, y: -3 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.14, ease: [0.23, 1, 0.32, 1] }}
            className="text-[11px] tracking-[-0.01em] text-fg"
          >
            {EFFORT_LABEL[effort]}
          </motion.span>
        </div>

        <div className="px-1.5">
          <StepSlider
            label="Esforço de raciocínio"
            steps={EFFORT_LABEL_LIST}
            index={Math.max(EFFORTS.indexOf(effort), 0)}
            onIndexChange={(i) => onEffort(EFFORTS[i])}
            // The top of this scale is literally bought with thinking time, so
            // it wears the thinking loader's own idiom. Keyed to the level by
            // name — reordering `EFFORTS` must not silently move the threshold.
            intensityFrom={EFFORTS.indexOf("high")}
            boosted={fast}
          />

          <div className="flex items-center justify-between pt-1.5 text-[10px] tracking-[0.03em] text-fg-faint uppercase">
            <span>{EFFORT_LABEL[EFFORTS[0]]}</span>
            <span>{EFFORT_LABEL[EFFORTS[EFFORTS.length - 1]]}</span>
          </div>

          {/* Fixed height: the hint runs one or two lines depending on the
              level, and a flyout that changed height under the pointer while
              you dragged would be its own bug. */}
          <p className="min-h-[28px] pt-1 text-[10.5px] leading-relaxed text-fg-faint">
            {EFFORT_HINT[effort]}
          </p>
        </div>
      </div>

      {note ? (
        <p className="border-t border-border bg-bg-surface px-3 py-2 text-[10.5px] leading-relaxed text-fg-faint">
          {note}
        </p>
      ) : null}
    </>
  );
});
