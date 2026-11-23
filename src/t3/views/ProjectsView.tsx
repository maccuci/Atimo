import { useMemo, useState } from "react";
import {
  Folder01Icon,
  SearchIcon,
  Tick02Icon,
} from "@hugeicons/core-free-icons";
import { Icon } from "@/components/ui/Icon";
import { ProjectMenu, ProjectNameInput } from "@/components/projects/ProjectActions";
import { useStore } from "@/lib/store";
import { estimateTokens } from "@/lib/tokens";
import { cn, formatTokens } from "@/lib/utils";
import type { Project } from "@/lib/types";
import { projectTileStyle, projectTileText } from "@/t3/primitives";

interface Tally {
  chats: number;
}

export function ProjectsView() {
  const workspaceId = useStore((s) => s.workspaceId);
  const projects = useStore((s) => s.projects);
  const chats = useStore((s) => s.chats);
  const projectId = useStore((s) => s.projectId);
  const selectProject = useStore((s) => s.selectProject);
  const setView = useStore((s) => s.setView);
  const messages = useStore((s) => s.messages);
  const setProjectSheet = useStore((s) => s.setProjectSheet);

  const [query, setQuery] = useState("");
  const [renaming, setRenaming] = useState<string | null>(null);

  const tallies = useMemo(() => {
    const map = new Map<string, Tally>();
    const used = new Set(messages.map((m) => m.chatId));
    for (const chat of chats) {
      // Same rule as Recents: a chat nobody wrote in is not counted.
      if (!used.has(chat.id)) continue;
      const tally = map.get(chat.projectId);
      if (tally) tally.chats += 1;
      else map.set(chat.projectId, { chats: 1 });
    }
    return map;
  }, [chats, messages]);

  // Projects are scoped to the workspace picked in the rail; other workspaces
  // are one switch away, not mixed in here.
  const items = useMemo(() => {
    const q = query.trim().toLowerCase();
    return projects
      .filter((p) => p.workspaceId === workspaceId)
      .filter(
        (p) =>
          !q ||
          p.name.toLowerCase().includes(q) ||
          p.description.toLowerCase().includes(q) ||
          p.instructions.toLowerCase().includes(q),
      )
      .map((project, i) => ({ project, tally: tallies.get(project.id) ?? { chats: 0 }, i }));
  }, [workspaceId, projects, tallies, query]);

  const openProject = (id: string) => {
    selectProject(id);
    setView("chat");
  };

  return (
    <div className="scroll-thin flex min-h-0 min-w-0 flex-1 flex-col overflow-y-auto bg-bg">
      <div className="mx-auto w-full max-w-[46rem] px-6 pt-8 pb-16">
        <header className="flex flex-wrap items-end justify-between gap-4 border-b border-border pb-5">
          <div className="min-w-0">
            <h1 className="text-[22px] leading-tight font-semibold tracking-[-0.03em] text-fg">
              Projetos
            </h1>
            <p className="mt-1 max-w-[46ch] text-[12.5px] leading-relaxed text-fg-dim">
              Os modelos mudam — escolha um projeto e todo chat começa do que
              ele já sabe.
            </p>
          </div>
          <button
            type="button"
            onClick={() => setProjectSheet("new")}
            className="pressable inline-flex h-8 shrink-0 items-center gap-1.5 rounded-lg bg-accent px-3.5 text-[12.5px] font-medium text-white transition-opacity duration-150 ease-out hover:opacity-90"
          >
            <Icon icon={Folder01Icon} size={14} strokeWidth={1.75} />
            Novo projeto
          </button>
        </header>

        <label className="relative mt-4 block">
          <span className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-fg-faint">
            <Icon icon={SearchIcon} size={14} strokeWidth={1.75} />
          </span>
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Buscar projetos…"
            aria-label="Buscar projetos"
            className="h-9 w-full rounded-lg border border-border bg-bg-surface pr-3 pl-9 text-[13px] tracking-[-0.008em] text-fg outline-none transition-[border-color] duration-150 ease-out placeholder:text-fg-faint focus:border-border-strong"
          />
        </label>

        <div className="mt-4 grid grid-cols-1 gap-2 sm:grid-cols-2">
          {items.map(({ project, tally, i }) => (
            <ProjectCard
              key={project.id}
              project={project}
              tally={tally}
              active={project.id === projectId}
              editing={renaming === project.id}
              delay={80 + i * 35}
              onOpen={() => openProject(project.id)}
              onRename={() => setRenaming(project.id)}
              onRenameDone={() => setRenaming(null)}
            />
          ))}
        </div>

        {items.length === 0 && (
          <p className="px-1 py-8 text-center text-[12.5px] text-fg-faint">
            {query.trim() ? `Nada encontrado para “${query.trim()}”.` : "Nenhum projeto neste workspace ainda."}
          </p>
        )}

      </div>
    </div>
  );
}

function ProjectCard({
  project,
  tally,
  active,
  editing,
  delay,
  onOpen,
  onRename,
  onRenameDone,
}: {
  project: Project;
  tally: Tally;
  active: boolean;
  editing: boolean;
  delay: number;
  onOpen: () => void;
  onRename: () => void;
  onRenameDone: () => void;
}) {
  const brief = project.instructions.trim();

  return (
    <div
      className={cn(
        "group/card t3-card stagger-in pressable flex items-start gap-3 p-3 transition-[border-color,background-color] duration-150 ease-out",
        active ? "!border-border-strong !bg-bg-active" : "hover:border-border-strong",
      )}
      style={{ animationDelay: `${delay}ms` }}
    >
      <span
        aria-hidden
        className="t3-project-tile !h-10 !w-10 !rounded-[10px] !text-[12px]"
        style={projectTileStyle(project.name)}
      >
        {projectTileText(project.name)}
      </span>

      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          {editing ? (
            <ProjectNameInput
              projectId={project.id}
              name={project.name}
              onDone={onRenameDone}
              className="h-[26px] text-[13px] font-medium tracking-[-0.008em]"
            />
          ) : (
            <>
              <button
                type="button"
                onClick={onOpen}
                onDoubleClick={onRename}
                className="pressable min-w-0 flex-1 truncate text-left text-[13px] font-medium tracking-[-0.008em] text-fg"
              >
                {project.name}
              </button>
              {active && (
                <Icon
                  icon={Tick02Icon}
                  size={12}
                  strokeWidth={2.25}
                  className="shrink-0 text-fg-dim"
                />
              )}
              <ProjectMenu
                projectId={project.id}
                onRename={onRename}
                visible={false}
                className="group-hover/card:opacity-100"
              />
            </>
          )}
        </div>

        <button
          type="button"
          onClick={onOpen}
          className="block w-full text-left"
        >
          {project.description && (
            <span className="mt-0.5 line-clamp-2 block text-[12px] leading-relaxed text-fg-dim">
              {project.description}
            </span>
          )}

          {brief ? (
            <span className="mt-2 block truncate rounded-md border border-border bg-bg-surface px-2 py-1 text-[11px] text-fg-faint">
              <span className="tabular-nums">
                {formatTokens(estimateTokens(brief))}
              </span>{" "}
              tokens de contexto base · {brief.split("\n")[0]}
            </span>
          ) : (
            <span className="mt-2 block text-[11px] text-fg-faint">
              Sem contexto base ainda
            </span>
          )}

          <span className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px] tabular-nums text-fg-faint">
            <span>
              {tally.chats} {tally.chats === 1 ? "chat" : "chats"}
            </span>
          </span>
        </button>
      </div>
    </div>
  );
}
