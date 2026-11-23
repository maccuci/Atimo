import { useEffect } from "react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import {
  Add01Icon,
  Cancel01Icon,
  Delete02Icon,
  LinkSquare02Icon,
} from "@hugeicons/core-free-icons";
import { Icon } from "@/components/ui/Icon";
import { ModeToggle, skillIcon } from "./skill-chrome";
import { estimateTokens } from "@/lib/tokens";
import { SKILL_CATEGORY_LABEL } from "@/lib/skills";
import { openExternal } from "@/lib/open-external";
import { useStore } from "@/lib/store";
import { cn, formatTokens } from "@/lib/utils";
import type { Skill, SkillMode } from "@/lib/types";

/*
 * One skill, in full.
 *
 * The two texts are shown as two separate blocks with their own price, because
 * that is the decision the user is actually making: the description is rent
 * paid on every turn of the project, the instructions are only ever charged on
 * the turns that arm them.
 *
 * The body is shown verbatim rather than summarised. Injected instructions are
 * invisible at read time — the only place they can be audited is here.
 */

export function SkillSheet({
  skill,
  mode,
  onClose,
}: {
  skill: Skill | undefined;
  mode: SkillMode | undefined;
  onClose: () => void;
}) {
  const installSkill = useStore((s) => s.installSkill);
  const removeSkill = useStore((s) => s.removeSkill);
  const setSkillMode = useStore((s) => s.setSkillMode);
  const reduceMotion = useReducedMotion();

  useEffect(() => {
    if (!skill) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [skill, onClose]);

  const on = mode === "auto" || mode === "always";

  return (
    <AnimatePresence>
      {skill ? (
        <div className="fixed inset-0 z-50 flex items-end justify-center p-0 sm:items-center sm:p-6">
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.18 }}
            onClick={onClose}
            className="absolute inset-0 bg-bg/70 backdrop-blur-[2px]"
          />

          <motion.div
            role="dialog"
            aria-modal
            aria-label={skill.name}
            initial={reduceMotion ? { opacity: 0 } : { opacity: 0, scale: 0.97, y: 8 }}
            animate={reduceMotion ? { opacity: 1 } : { opacity: 1, scale: 1, y: 0 }}
            exit={reduceMotion ? { opacity: 0 } : { opacity: 0, scale: 0.98, y: 4 }}
            transition={
              reduceMotion
                ? { duration: 0.12 }
                : { type: "spring", bounce: 0, duration: 0.4 }
            }
            style={{
              boxShadow: "var(--shadow-panel)",
              paddingBottom: "var(--safe-bottom)",
            }}
            className="relative flex max-h-[min(88dvh,80vh)] w-full max-w-[560px] flex-col overflow-hidden rounded-t-[16px] border border-border-strong bg-bg-raised sm:rounded-[16px]"
          >
            <div
              aria-hidden
              className="mx-auto mt-2 h-1 w-10 shrink-0 rounded-full bg-border-strong sm:hidden"
            />
            <header className="flex shrink-0 items-center gap-3 border-b border-border px-4 py-3.5">
              <span className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-[9px] border border-border bg-bg-surface text-fg-dim">
                <Icon icon={skillIcon(skill.id)} size={15} strokeWidth={1.5} />
              </span>
              <div className="min-w-0 flex-1">
                <h2 className="truncate text-[13px] font-medium tracking-[-0.01em] text-fg">
                  {skill.name}
                </h2>
                <p className="truncate text-[11px] text-fg-faint">
                  {SKILL_CATEGORY_LABEL[skill.category]}
                  {on && (
                    <>
                      {" · "}
                      <span className="text-cyan">
                        {mode === "always" ? "carrega em toda mensagem" : "carrega com um gatilho"}
                      </span>
                    </>
                  )}
                  {mode === "off" && " · paused"}
                </p>
              </div>
              <button
                type="button"
                onClick={onClose}
                aria-label="Fechar"
                className="pressable inline-flex h-10 w-10 items-center justify-center rounded-lg text-fg-faint transition-colors duration-150 ease-out hover:bg-bg-hover hover:text-fg sm:h-8 sm:w-8"
              >
                <Icon icon={Cancel01Icon} size={14} strokeWidth={2} />
              </button>
            </header>

            <div className="scroll-thin min-h-0 flex-1 overflow-y-auto px-4 py-4">
              <Block
                label="Sempre no contexto"
                tokens={estimateTokens(skill.description)}
                note="Todo modelo do painel leva esta linha em toda mensagem. Os gatilhos abaixo decidem quando o corpo carrega."
              >
                <p className="selectable text-[12.5px] leading-relaxed text-fg-dim">
                  {skill.description}
                </p>
              </Block>

              {mode !== "always" && (
                <Block label="Gatilhos" tokens={null} note="Uma mensagem com um destes aciona a skill.">
                  <div className="flex flex-wrap gap-1.5">
                    {skill.triggers.map((trigger) => (
                      <span
                        key={trigger}
                        className="rounded-full border border-border bg-bg-surface px-2 py-0.5 font-mono text-[11px] text-fg-dim"
                      >
                        {trigger}
                      </span>
                    ))}
                  </div>
                </Block>
              )}

              <Block
                label="Carrega quando acionada"
                tokens={estimateTokens(skill.body)}
                note="As instruções que o modelo recebe. Nada mais da skill chega até ele."
              >
                <p className="selectable whitespace-pre-line text-[12.5px] leading-relaxed text-fg-dim">
                  {skill.body}
                </p>
              </Block>

              {skill.source ? (
              <Block label="Origem" tokens={null}>
                <div className="flex items-center gap-2">
                  <code className="selectable min-w-0 flex-1 truncate font-mono text-[11px] text-fg-faint">
                    {skill.source.repo}/{skill.source.path}
                    <span className="text-fg-faint"> · {skill.source.hash}</span>
                  </code>
                  <button
                    type="button"
                    onClick={() =>
                      void openExternal(
                        `https://github.com/${skill.source!.repo}/blob/main/${skill.source!.path}`,
                      )
                    }
                    className="pressable inline-flex h-7 shrink-0 items-center gap-1.5 rounded-lg border border-border px-2.5 text-[11.5px] text-fg-dim transition-[background-color,border-color,color] duration-150 ease-out hover:border-border-strong hover:bg-bg-hover hover:text-fg"
                  >
                    Abrir no GitHub
                    <Icon icon={LinkSquare02Icon} size={11} strokeWidth={1.75} />
                  </button>
                </div>
              </Block>
              ) : null}
            </div>

            <footer className="flex shrink-0 items-center gap-2 border-t border-border bg-bg-inset/60 px-4 py-3">
              {mode ? (
                <>
                  <button
                    type="button"
                    onClick={() => {
                      removeSkill(skill.id);
                      onClose();
                    }}
                    className="pressable inline-flex h-7 items-center gap-1.5 rounded-lg px-2 text-[12px] text-fg-faint transition-colors duration-150 ease-out hover:bg-red/10 hover:text-red"
                  >
                    <Icon icon={Delete02Icon} size={12} strokeWidth={1.75} />
                    Remover
                  </button>
                  <div className="flex-1" />
                  <ModeToggle
                    mode={mode}
                    name={skill.name}
                    onMode={(next) => setSkillMode(skill.id, next)}
                  />
                </>
              ) : (
                <>
                  <span className="min-w-0 flex-1 truncate text-[11.5px] text-fg-faint">
                    Custa {formatTokens(estimateTokens(skill.description))} tokens
                    por mensagem depois de instalada.
                  </span>
                  <button
                    type="button"
                    onClick={() => installSkill(skill.id)}
                    className={cn(
                      "pressable inline-flex h-7 shrink-0 items-center gap-1.5 rounded-lg border border-cyan/40 bg-cyan/10 px-2.5 text-[12px] font-medium tracking-[-0.01em] text-cyan",
                      "transition-[background-color] duration-150 ease-out hover:bg-cyan/20",
                    )}
                  >
                    <Icon icon={Add01Icon} size={12} strokeWidth={2} />
                    Instalar skill
                  </button>
                </>
              )}
            </footer>
          </motion.div>
        </div>
      ) : null}
    </AnimatePresence>
  );
}

function Block({
  label,
  tokens,
  note,
  children,
}: {
  label: string;
  tokens: number | null;
  note?: string;
  children: React.ReactNode;
}) {
  return (
    <section className="mb-4 last:mb-0">
      <div className="mb-1.5 flex items-baseline gap-2">
        <span className="text-[11px] font-medium tracking-[0.02em] text-fg-faint">
          {label}
        </span>
        {tokens !== null && (
          <span className="text-[11px] text-fg-faint tabular-nums">
            {formatTokens(tokens)} tok
          </span>
        )}
      </div>
      {note && (
        <p className="mb-2 text-[11.5px] leading-relaxed text-fg-faint">{note}</p>
      )}
      <div className="rounded-[12px] border border-border bg-bg-surface px-3.5 py-3">
        {children}
      </div>
    </section>
  );
}
