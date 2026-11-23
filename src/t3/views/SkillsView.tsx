import { useMemo, useState, type ReactNode } from "react";
import {
  Add01Icon,
  ArrowRight01Icon,
  SearchIcon,
} from "@hugeicons/core-free-icons";
import { Icon } from "@/components/ui/Icon";
import { SkillSheet } from "@/components/skills/SkillSheet";
import { ModeToggle, skillIcon } from "@/components/skills/skill-chrome";
import { estimateTokens } from "@/lib/tokens";
import { SKILLS } from "@/lib/skills";
import { useStore } from "@/lib/store";
import { cn, formatTokens } from "@/lib/utils";
import type { Skill, SkillMode } from "@/lib/types";

export function SkillsView() {
  const modes = useStore((s) => s.skills);
  const installSkill = useStore((s) => s.installSkill);
  const setSkillMode = useStore((s) => s.setSkillMode);

  const [filter, setFilter] = useState("");
  const [openId, setOpenId] = useState<string | null>(null);

  const matches = useMemo(() => {
    const needle = filter.trim().toLowerCase();
    if (!needle) return SKILLS;
    return SKILLS.filter(
      (s) =>
        s.name.toLowerCase().includes(needle) ||
        s.summary.toLowerCase().includes(needle) ||
        s.description.toLowerCase().includes(needle) ||
        s.triggers.some((t) => t.includes(needle)),
    );
  }, [filter]);

  const installed = matches.filter((s) => modes[s.id]);
  const available = matches.filter((s) => !modes[s.id]);

  const running = SKILLS.filter((s) => {
    const mode = modes[s.id];
    return mode === "auto" || mode === "always";
  });

  const alwaysCost = running.reduce(
    (sum, s) => sum + estimateTokens(s.description),
    0,
  );
  const armedCost = running.reduce((sum, s) => sum + estimateTokens(s.body), 0);

  const open = openId ? SKILLS.find((s) => s.id === openId) : undefined;

  return (
    <div className="scroll-thin flex min-h-0 min-w-0 flex-1 flex-col overflow-y-auto bg-bg">
        <div className="mx-auto w-full max-w-[46rem] px-6 pt-8 pb-16">
          <header className="mb-5 border-b border-border pb-5">
            <h1 className="text-[22px] leading-tight font-semibold tracking-[-0.03em] text-fg">
              Skills
            </h1>
            <p className="mt-1 max-w-[46ch] text-[12.5px] leading-relaxed text-fg-dim">
              Instruções que entram no contexto de qualquer modelo — sempre, ou só
              quando a mensagem pede.
            </p>
            <input
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              placeholder="Filtrar skills…"
              aria-label="Filtrar skills"
              className="mt-4 h-8 w-full max-w-[340px] rounded-lg border border-border bg-bg-surface px-3 text-[12px] tracking-[-0.008em] text-fg outline-none transition-[border-color] duration-150 ease-out placeholder:text-fg-faint focus:border-border-strong"
            />
          </header>
          <Ledger
            count={running.length}
            always={alwaysCost}
            armed={armedCost}
          />

          {installed.length > 0 && (
            <Section
              label="Instaladas"
              hint="Todo modelo deste workspace herda estas"
              count={installed.length}
            >
              {installed.map((skill, i) => (
                <SkillRow
                  key={skill.id}
                  skill={skill}
                  mode={modes[skill.id]!}
                  index={i}
                  onOpen={() => setOpenId(skill.id)}
                  onMode={(mode) => setSkillMode(skill.id, mode)}
                />
              ))}
            </Section>
          )}

          {available.length > 0 && (
            <Section
              label="Catálogo"
              hint="Disponíveis para instalar"
              count={available.length}
            >
              {available.map((skill, i) => (
                <SkillRow
                  key={skill.id}
                  skill={skill}
                  index={i}
                  onOpen={() => setOpenId(skill.id)}
                  onInstall={() => installSkill(skill.id)}
                />
              ))}
            </Section>
          )}

          {matches.length === 0 && (
            <div className="flex flex-col items-center gap-3 px-6 py-16 text-center">
              <span className="flex h-10 w-10 items-center justify-center rounded-xl border border-border bg-bg-raised text-fg-faint">
                <Icon icon={SearchIcon} size={16} strokeWidth={1.75} />
              </span>
              <p className="max-w-sm text-[12px] leading-relaxed text-fg-dim">
                Nenhuma skill encontrada para “{filter}”. Palavras-gatilho também
                contam — tente “hdl” ou “cliente”.
              </p>
              {filter && (
                <button
                  type="button"
                  onClick={() => setFilter("")}
                  className="pressable inline-flex h-7 items-center rounded-md border border-border bg-bg-raised px-2.5 text-[12px] text-fg-dim transition-[background-color,border-color,color] duration-150 ease-out hover:bg-bg-hover hover:text-fg"
                >
                  Limpar filtro
                </button>
              )}
            </div>
          )}
        </div>

      <SkillSheet
        skill={open}
        mode={open ? modes[open.id] : undefined}
        onClose={() => setOpenId(null)}
      />
    </div>
  );
}

function Ledger({
  count,
  always,
  armed,
}: {
  count: number;
  always: number;
  armed: number;
}) {
  const total = always + armed;
  const alwaysPct = total ? Math.max(1.5, (always / total) * 100) : 0;

  return (
    <div className="t3-card mb-5 px-4 py-3.5">
      <div className="flex items-baseline justify-between gap-3">
        <span className="text-[13px] font-medium tracking-[-0.008em] text-fg">
          {count === 0
            ? "Nenhuma skill ativa"
            : `${count} skill${count === 1 ? " ativa" : "s ativas"}`}
        </span>
        <span className="text-[11px] tabular-nums text-fg-faint">
          {formatTokens(total)} tokens no total
        </span>
      </div>

      <div
        role="img"
        aria-label={`${formatTokens(always)} tokens sempre no contexto, ${formatTokens(armed)} tokens só quando acionadas`}
        className="mt-3 flex h-1 w-full overflow-hidden rounded-full bg-bg-inset"
      >
        <div
          className="h-full bg-accent transition-[width] duration-200 ease-[var(--ease-out)]"
          style={{ width: `${alwaysPct}%` }}
        />
        <div className="h-full flex-1 bg-border-strong" />
      </div>

      <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-fg-faint">
        <span className="inline-flex items-center gap-1.5">
          <span className="h-1.5 w-1.5 rounded-full bg-accent" />
          <span className="tabular-nums text-fg-dim">{formatTokens(always)}</span>
          tokens sempre no contexto
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span className="h-1.5 w-1.5 rounded-full bg-border-strong" />
          <span className="tabular-nums text-fg-dim">{formatTokens(armed)}</span>
          tokens só nas mensagens que acionam a skill
        </span>
      </div>
    </div>
  );
}

function Section({
  label,
  hint,
  count,
  children,
}: {
  label: string;
  hint: string;
  count: number;
  children: ReactNode;
}) {
  return (
    <section className="mb-5">
      <div className="mb-1 flex items-baseline gap-2 px-1 py-1">
        <span className="t3-section-label">{label}</span>
        <span className="text-[10.5px] tabular-nums text-fg-faint">{count}</span>
        <span className="min-w-0 flex-1 truncate text-[10.5px] text-fg-faint">
          {hint}
        </span>
      </div>
      <div className="flex flex-col gap-0.5">{children}</div>
    </section>
  );
}

function SkillRow({
  skill,
  mode,
  index,
  onOpen,
  onMode,
  onInstall,
}: {
  skill: Skill;
  mode?: SkillMode;
  index: number;
  onOpen: () => void;
  onMode?: (mode: SkillMode) => void;
  onInstall?: () => void;
}) {
  const on = mode === "auto" || mode === "always";

  return (
    <div
      className={cn(
        "t3-thread-row stagger-in group",
        mode === "off" && "opacity-55",
      )}
      style={{ animationDelay: `${Math.min(index, 8) * 35}ms` }}
    >
      <button
        type="button"
        onClick={onOpen}
        title="Abrir skill"
        className="pressable flex min-w-0 flex-1 items-center gap-2.5 self-center text-left"
      >
        <span
          className={cn(
            "inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-[7px] border transition-colors duration-150 ease-out",
            on
              ? "border-transparent bg-[var(--accent-dim)] text-accent"
              : "border-border bg-bg-inset text-fg-faint",
          )}
        >
          <Icon icon={skillIcon(skill.id)} size={14} strokeWidth={1.75} />
        </span>

        <span className="min-w-0 flex-1">
          <span className="flex items-baseline gap-2">
            <span className="truncate text-[13px] font-medium tracking-[-0.008em] text-fg">
              {skill.name}
            </span>
            <span className="shrink-0 text-fg-faint opacity-0 transition-opacity duration-150 ease-out group-hover:opacity-100">
              <Icon icon={ArrowRight01Icon} size={11} strokeWidth={2} />
            </span>
          </span>

          <span className="mt-0.5 block truncate text-[12px] text-fg-dim">
            {skill.summary}
          </span>

          <span className="mt-0.5 flex items-center gap-1.5 font-mono text-[10px] text-fg-faint">
            {skill.source ? (
              <>
                <span className="truncate">{skill.source.repo}</span>
                <span className="text-fg-faint/40">·</span>
              </>
            ) : null}
            <span className="whitespace-nowrap tabular-nums">
              {estimateTokens(skill.description)} tokens sempre ·{" "}
              {formatTokens(estimateTokens(skill.body))} quando acionada
            </span>
          </span>
        </span>
      </button>

      <div className="flex shrink-0 items-center gap-2 self-center">
        {onInstall ? (
          <button
            type="button"
            onClick={onInstall}
            className="pressable inline-flex h-7 items-center gap-1.5 rounded-md border border-border bg-bg-raised px-2.5 text-[12px] tracking-[-0.008em] text-fg-dim transition-[background-color,border-color,color] duration-150 ease-out hover:bg-bg-hover hover:text-fg"
          >
            <Icon icon={Add01Icon} size={12} strokeWidth={2} />
            Instalar
          </button>
        ) : (
          mode && onMode ? (
            <ModeToggle mode={mode} name={skill.name} onMode={onMode} />
          ) : null
        )}
      </div>
    </div>
  );
}
