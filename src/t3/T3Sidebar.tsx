import { useEffect, useMemo, useState } from "react";
import {
  Add01Icon,
  Folder01Icon,
  GridViewIcon,
  Home01Icon,
  PuzzleIcon,
  SearchIcon,
  SidebarLeft01Icon,
  Cancel01Icon,
} from "@hugeicons/core-free-icons";
import type { IconSvgElement } from "@hugeicons/react";
import { Icon } from "@/components/ui/Icon";
import { useStore, type View } from "@/lib/store";
import { WorkspaceSwitcher } from "@/components/workspaces/WorkspaceSwitcher";
import { cn } from "@/lib/utils";
import { AccountFooter } from "./AccountFooter";
import { isDesktopShell } from "@/lib/use-media-query";
import { ChatMenu, ChatTitleInput } from "@/components/chat/ChatActions";
import { ProjectMenu, ProjectNameInput } from "@/components/projects/ProjectActions";
import { Kbd } from "@/components/ui/primitives";

type NavItem = { id: View; label: string; icon: IconSvgElement };

// Fixed above the chat list, so it never scrolls away under a long history.
const WORKSPACE_NAV: NavItem[] = [
  { id: "home", label: "Início", icon: Home01Icon },
  { id: "projects", label: "Projetos", icon: Folder01Icon },
  { id: "apps", label: "Modelos", icon: GridViewIcon },
  { id: "skills", label: "Skills", icon: PuzzleIcon },
];

// Hover intent shared by the title-bar toggle and the floating sidebar, so
// moving the pointer from one to the other doesn't close the peek.
// Opening waits for the pointer to rest, so brushing past the toggle doesn't
// flash the sidebar; once open, re-entering keeps it open immediately.
let peekTimer: ReturnType<typeof setTimeout> | undefined;
export function peekSidebar(on: boolean) {
  clearTimeout(peekTimer);
  const { sidebarPeek, setSidebarPeek } = useStore.getState();
  if (on === sidebarPeek) return;
  peekTimer = setTimeout(() => setSidebarPeek(on), on ? 350 : 200);
}

/**
 * The T3 thread rail: working threads on top, settled below, views below that.
 * Collapsed, it shrinks to a 44px strip that still gets you back in one click.
 */
export function T3Sidebar({
  variant = "rail",
  onNavigate,
}: {
  variant?: "rail" | "drawer" | "peek";
  onNavigate?: () => void;
}) {
  const expanded = useStore((s) => s.sidebarExpanded);
  const toggleSidebar = useStore((s) => s.toggleSidebar);
  const view = useStore((s) => s.view);
  const setView = useStore((s) => s.setView);
  const chatId = useStore((s) => s.chatId);
  const allChats = useStore((s) => s.chats);
  const messages = useStore((s) => s.messages);
  const workspaceId = useStore((s) => s.workspaceId);
  const allProjects = useStore((s) => s.projects);
  const projects = useMemo(
    () => allProjects.filter((p) => p.workspaceId === workspaceId),
    [allProjects, workspaceId],
  );
  const selectChat = useStore((s) => s.selectChat);
  const newChat = useStore((s) => s.newChat);
  const setPaletteOpen = useStore((s) => s.setPaletteOpen);
  const desktopShell = isDesktopShell();

  // Projects expanded past the per-project limit. Each project expands on
  // its own, so one long history never hides the other projects.
  const [expandedProjects, setExpandedProjects] = useState<ReadonlySet<string>>(new Set());
  const toggleProject = (projectId: string) =>
    setExpandedProjects((prev) => {
      const next = new Set(prev);
      if (!next.delete(projectId)) next.add(projectId);
      return next;
    });

  const isDrawer = variant === "drawer";
  const isPeek = variant === "peek";
  const open = isDrawer || isPeek || expanded;

  useEffect(() => {
    // Returning to the rail always starts from the full list, not wherever a
    // previous expand was left.
    if (!open) setExpandedProjects(new Set());
  }, [open]);

  // Recents follow the workspace at the top: chats of other workspaces stay there.
  // A chat nobody wrote in yet is listed only while it is open.
  const chats = useMemo(() => {
    const ids = new Set(projects.map((p) => p.id));
    const used = new Set(messages.map((m) => m.chatId));
    return allChats.filter(
      (c) => ids.has(c.projectId) && (used.has(c.id) || c.id === chatId),
    );
  }, [allChats, projects, messages, chatId]);

  const projectById = useMemo(
    () => new Map(projects.map((p) => [p.id, p])),
    [projects],
  );

  const pendingChatIds = useMemo(
    () =>
      new Set(
        messages.filter((m) => m.role === "assistant" && m.pending).map((m) => m.chatId),
      ),
    [messages],
  );

  // t3code groups threads under their project. Sorted newest-first, so a
  // Map keeps projects in order of their latest activity. The limit applies
  // per project; working and open threads are never cut by it.
  const groups = useMemo(() => {
    const sorted = [...chats].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    const byProject = new Map<string, typeof chats>();
    for (const chat of sorted) {
      const list = byProject.get(chat.projectId) ?? [];
      list.push(chat);
      byProject.set(chat.projectId, list);
    }
    return [...byProject].map(([projectId, list]) => {
      const all = expandedProjects.has(projectId);
      const visible = all
        ? list
        : list.filter(
            (c, i) => i < CHATS_PER_PROJECT || pendingChatIds.has(c.id) || c.id === chatId,
          );
      return { projectId, visible, total: list.length, all };
    });
  }, [chats, pendingChatIds, expandedProjects, chatId]);

  const go = (fn: () => void) => () => {
    fn();
    onNavigate?.();
  };

  if (!open) return null;

  // The toggle sits right after the traffic lights, in the exact spot the
  // collapsed title bar puts it — opening/closing never moves it.
  const toggleBtn = (
    <button
      type="button"
      onClick={
        isDrawer
          ? onNavigate
          : () => {
              peekSidebar(false);
              toggleSidebar();
            }
      }
      className="t3-window-btn t3-tip shrink-0"
      data-tip={isDrawer ? undefined : isPeek ? "Manter aberta  ⌘B · ⌘S" : "Ocultar barra lateral  ⌘B · ⌘S"}
      aria-label={isDrawer ? "Fechar menu" : isPeek ? "Manter barra lateral aberta" : "Ocultar barra lateral"}
    >
      <Icon icon={isDrawer ? Cancel01Icon : SidebarLeft01Icon} size={16} strokeWidth={1.75} />
    </button>
  );

  return (
    <aside
      className={cn(
        "t3-rail flex h-full w-[260px] shrink-0 flex-col border-r bg-bg-sidebar",
        isDrawer && "w-full border-r-0",
        isPeek && "t3-rail-peek rounded-r-xl border shadow-2xl",
      )}
      aria-label="Workspace"
      onMouseEnter={isPeek ? () => peekSidebar(true) : undefined}
      onMouseLeave={isPeek ? () => peekSidebar(false) : undefined}
    >
      <div
        className={cn(
          "flex shrink-0 items-center pr-2",
          desktopShell && !isDrawer ? "pl-[78px]" : "pl-2",
        )}
        style={{ height: "var(--titlebar-h)" }}
        data-tauri-drag-region
      >
        {toggleBtn}
      </div>

      {/* Actions + views, fixed above the history */}
      <div className="flex shrink-0 flex-col gap-px px-2 pb-3">
        {/* Workspace on top: it scopes everything listed below it. */}
        <WorkspaceSwitcher expanded onNavigate={onNavigate} className="mb-1.5" />
        <SideAction icon={Add01Icon} label="Novo chat" kbd="⌘N" onClick={go(() => newChat())} />
        <SideAction
          icon={SearchIcon}
          label="Buscar"
          kbd="⌘K"
          onClick={go(() => setPaletteOpen(true))}
        />
        {WORKSPACE_NAV.map((item) => (
          <SideAction
            key={item.id}
            icon={item.icon}
            label={item.label}
            active={view === item.id}
            onClick={go(() => setView(item.id))}
          />
        ))}
      </div>

      {/* History, grouped under its project */}
      <nav className="scroll-thin min-h-0 flex-1 overflow-y-auto px-2 pb-2" aria-label="Chats">
        <div className="t3-side-label">Recentes</div>
        {groups.map(({ projectId, visible: list, total, all }) => {
          const name = projectById.get(projectId)?.name ?? "Sem projeto";
          return (
            <section key={projectId} className="mb-1" aria-label={name}>
              <ProjectHeader projectId={projectId} name={name} />
              <div className="ml-[17px] flex flex-col gap-px border-l border-border/70 pl-1.5">
                {list.map((chat) => (
                  <ThreadRow
                    key={chat.id}
                    chatId={chat.id}
                    active={view === "chat" && chatId === chat.id}
                    working={pendingChatIds.has(chat.id)}
                    title={chat.title}
                    onOpen={go(() => selectChat(chat.id))}
                  />
                ))}
                {total > CHATS_PER_PROJECT ? (
                  <button
                    type="button"
                    onClick={() => toggleProject(projectId)}
                    className="t3-nav-row pressable text-fg-faint"
                  >
                    <span className="pl-2">{all ? "Mostrar menos" : `Ver todos (${total})`}</span>
                  </button>
                ) : null}
              </div>
            </section>
          );
        })}
        {chats.length === 0 ? (
          <p className="px-2.5 pt-2 text-[12.5px] leading-relaxed text-fg-faint">
            Nenhum chat ainda. <Kbd>⌘N</Kbd> começa um.
          </p>
        ) : null}

      </nav>

      {/* Footer: who is answering (menu with settings), and the plan's limits. */}
      <div className="shrink-0 border-t border-border/70 px-2 py-2">
        <AccountFooter active={view === "settings"} onNavigate={onNavigate} />
      </div>
    </aside>
  );
}

const CHATS_PER_PROJECT = 5;

function SideAction({
  icon,
  label,
  kbd,
  active,
  onClick,
}: {
  icon: IconSvgElement;
  label: string;
  kbd?: string;
  active?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      data-active={active || undefined}
      onClick={onClick}
      className="t3-nav-row pressable group/action"
    >
      <Icon icon={icon} size={16} strokeWidth={1.75} className="shrink-0 text-fg-dim" />
      <span className="min-w-0 flex-1 truncate text-left">{label}</span>
      {kbd ? (
        <span className="text-[11px] text-fg-faint opacity-0 transition-opacity duration-150 group-hover/action:opacity-100">
          {kbd}
        </span>
      ) : null}
    </button>
  );
}

function ThreadRow({
  chatId,
  active,
  working,
  title,
  onOpen,
}: {
  chatId: string;
  active: boolean;
  working: boolean;
  title: string;
  onOpen: () => void;
}) {
  const [editing, setEditing] = useState(false);

  // A div, not a button: the row holds two controls (open, actions) and a
  // button cannot contain another. The time and the "…" trigger share one
  // slot, t3code-style — hover, focus or an open menu swaps time for actions.
  return (
    <div
      data-active={active || undefined}
      className="t3-thread-row t3-side-row group/row relative"
    >
      {working ? (
        <span className="h-1.5 w-1.5 shrink-0 animate-pulse rounded-full bg-accent" aria-hidden />
      ) : null}
      {editing ? (
        <ChatTitleInput
          chatId={chatId}
          title={title}
          onDone={() => setEditing(false)}
          className="h-6 text-[13px] tracking-[-0.008em]"
        />
      ) : (
        <>
          <button
            type="button"
            onClick={onOpen}
            onDoubleClick={() => setEditing(true)}
            title={title}
            // Stretched over the row so the whole row stays the click target.
            className="t3-thread-title pressable min-w-0 flex-1 text-left after:absolute after:inset-0 after:rounded-[inherit] after:content-['']"
          >
            {title}
          </button>
          <span className="relative flex h-6 w-6 shrink-0 items-center justify-end">
            <ChatMenu
              chatId={chatId}
              onRename={() => setEditing(true)}
              visible={false}
              className="absolute right-0 z-10 group-hover/row:opacity-100 group-focus-within/row:opacity-100"
            />
          </span>
        </>
      )}
    </div>
  );
}

function ProjectHeader({ projectId, name }: { projectId: string; name: string }) {
  const [editing, setEditing] = useState(false);
  const exists = useStore((s) => s.projects.some((p) => p.id === projectId));
  return (
    <div className="group/project flex h-8 items-center gap-2.5 pr-1 pl-2.5">
      <Icon icon={Folder01Icon} size={16} strokeWidth={1.75} className="shrink-0 text-fg-dim" />
      {editing ? (
        <ProjectNameInput
          projectId={projectId}
          name={name}
          onDone={() => setEditing(false)}
          className="h-6 text-[13px]"
        />
      ) : (
        <>
          <span
            onDoubleClick={exists ? () => setEditing(true) : undefined}
            className="min-w-0 flex-1 truncate text-[13.5px] text-fg"
          >
            {name}
          </span>
          {/* Chats whose project was deleted group under "No project" — nothing to rename. */}
          {exists ? (
            <ProjectMenu
              projectId={projectId}
              onRename={() => setEditing(true)}
              visible={false}
              className="group-hover/project:opacity-100 group-focus-within/project:opacity-100"
            />
          ) : null}
        </>
      )}
    </div>
  );
}
