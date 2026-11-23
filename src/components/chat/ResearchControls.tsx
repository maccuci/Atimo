import { useRef, useState } from "react";
import {
  AiSearch02Icon,
  ArrowDown01Icon,
  MagicWand01Icon,
  SearchRemoveIcon,
  Tick02Icon,
} from "@hugeicons/core-free-icons";
import type { IconSvgElement } from "@hugeicons/react";
import { useResearchSettings } from "@/lib/research-settings";
import { useStore } from "@/lib/store";
import type { ResearchMode } from "@/lib/research-provider";
import { BudgetNotice } from "@/components/settings/ResearchSettings";
import { Menu, MenuItem } from "@/components/ui/Menu";
import { Icon } from "@/components/ui/Icon";
import { cn } from "@/lib/utils";

// Labels stay as the orchestrator's error messages name them ("Pesquisa
// profunda", "Sem pesquisa"), so an error points at an option that exists.
const MODES: { id: ResearchMode; label: string; detail: string; icon: IconSvgElement }[] = [
  { id: "auto", label: "Automático", detail: "O modelo decide", icon: MagicWand01Icon },
  { id: "deep", label: "Pesquisa profunda", detail: "Sempre pesquisa", icon: AiSearch02Icon },
  { id: "off", label: "Sem pesquisa", detail: "Só o projeto", icon: SearchRemoveIcon },
];

export function ResearchControls() {
  const mode = useResearchSettings((s) => s.mode);
  const configure = useResearchSettings((s) => s.configure);
  const sending = useStore((s) => s.sending);
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const current = MODES.find((m) => m.id === mode) ?? MODES[0];

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        disabled={sending}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`Modo de pesquisa: ${current.label}`}
        title="Modo de pesquisa"
        onClick={() => setOpen((v) => !v)}
        className={cn(
          "pressable flex h-7 shrink-0 items-center gap-1.5 rounded-full border border-border bg-bg-surface text-[11px] font-medium tracking-[-0.01em] text-fg-dim",
          mode === "off" ? "w-7 justify-center" : "pr-2 pl-2.5",
          "transition-[background-color,border-color,color] duration-150 ease-out hover:border-border-strong hover:text-fg disabled:opacity-50",
          open && "border-border-strong text-fg",
          mode !== "off" && "text-fg",
        )}
      >
        <Icon icon={current.icon} size={12} strokeWidth={1.75} />
        {/* Off is the default; an icon is enough to find it. */}
        {mode !== "off" && (
          <>
            <span className="max-w-[120px] truncate">{current.label}</span>
            <Icon icon={ArrowDown01Icon} size={11} strokeWidth={2} className="text-fg-faint" />
          </>
        )}
      </button>

      <Menu open={open} anchor={triggerRef} onClose={() => setOpen(false)} label="Modo de pesquisa" width={280}>
        {MODES.map((m) => (
          <MenuItem
            key={m.id}
            icon={m.icon}
            label={m.label}
            detail={m.detail}
            active={m.id === mode}
            trailing={
              <Icon
                icon={Tick02Icon}
                size={13}
                strokeWidth={2}
                className={m.id === mode ? "text-fg" : "invisible"}
              />
            }
            onSelect={() => {
              configure({ mode: m.id });
              setOpen(false);
            }}
          />
        ))}
      </Menu>
      <BudgetNotice />
    </>
  );
}
