import { useMemo, useState } from "react";
import { Menu01Icon, SearchIcon, SidebarLeft01Icon } from "@hugeicons/core-free-icons";
import { Icon } from "@/components/ui/Icon";
import { useStore } from "@/lib/store";
import { useIsMobile, isDesktopShell } from "@/lib/use-media-query";
import { cn } from "@/lib/utils";
import { ChatMenu, ChatTitleInput } from "@/components/chat/ChatActions";
import { projectTileStyle, projectTileText } from "./primitives";
import { peekSidebar } from "./T3Sidebar";

/**
 * The T3 top bar: breadcrumb on the left (project / chat), bare icon buttons
 * on the right (⌘K search). Everything else lives in the rail.
 */
export function T3TitleBar() {
  const view = useStore((s) => s.view);
  const chatId = useStore((s) => s.chatId);
  const chats = useStore((s) => s.chats);
  const projects = useStore((s) => s.projects);
  const setPaletteOpen = useStore((s) => s.setPaletteOpen);
  const mobileNavOpen = useStore((s) => s.mobileNavOpen);
  const setMobileNavOpen = useStore((s) => s.setMobileNavOpen);
  const sidebarExpanded = useStore((s) => s.sidebarExpanded);
  const toggleSidebar = useStore((s) => s.toggleSidebar);
  const isMobile = useIsMobile();
  // The sidebar owns the macOS traffic lights; collapsed, the header clears
  // them and carries the toggle (hover peeks the sidebar, click pins it).
  const collapsed = !isMobile && !sidebarExpanded;
  const clearTrafficLights = isDesktopShell() && collapsed;

  const [renaming, setRenaming] = useState(false);
  const chat = useMemo(() => chats.find((c) => c.id === chatId), [chats, chatId]);
  const project = useMemo(
    () => (chat ? projects.find((p) => p.id === chat.projectId) : undefined),
    [chat, projects],
  );

  const middle =
    view === "chat" && chat ? (
      <>
        {project ? (
          <>
            <span className="t3-project-tile" style={projectTileStyle(project.name)}>
              {projectTileText(project.name)}
            </span>
            <span className="hidden max-w-[140px] truncate text-fg-dim sm:inline">
              {project.name}
            </span>
            <span className="hidden text-fg-faint sm:inline">/</span>
          </>
        ) : null}
        {renaming ? (
          <ChatTitleInput
            key={chat.id}
            chatId={chat.id}
            title={chat.title}
            onDone={() => setRenaming(false)}
            className="h-7 w-[min(46vw,320px)] text-[13px] font-medium"
          />
        ) : (
          <>
            <span
              onDoubleClick={() => setRenaming(true)}
              className="max-w-[46vw] truncate font-medium text-fg sm:max-w-[32vw]"
            >
              {chat.title}
            </span>
            <ChatMenu chatId={chat.id} onRename={() => setRenaming(true)} />
          </>
        )}
      </>
    ) : null; // every other view names itself in its own header

  return (
    <header
      data-tauri-drag-region
      className={cn(
        "flex h-12 shrink-0 items-center gap-2 bg-bg",
        clearTrafficLights ? "pl-[78px]" : "pl-2 md:pl-4",
        "pr-2 md:pr-3",
      )}
      style={{
        paddingRight: "max(0.5rem, var(--safe-right))",
        height: "var(--titlebar-h)",
      }}
    >
      {isMobile ? (
        <button
          type="button"
          onClick={() => setMobileNavOpen(!mobileNavOpen)}
          className="t3-window-btn"
          title="Menu"
          aria-label="Abrir menu"
          aria-expanded={mobileNavOpen}
        >
          <Icon icon={Menu01Icon} size={17} strokeWidth={1.75} />
        </button>
      ) : null}

      {collapsed ? (
        <button
          type="button"
          onClick={() => {
            peekSidebar(false); // drop a pending open
            toggleSidebar();
          }}
          onMouseEnter={() => peekSidebar(true)}
          onMouseLeave={() => peekSidebar(false)}
          className="t3-window-btn shrink-0"
          aria-label="Mostrar barra lateral"
        >
          <Icon icon={SidebarLeft01Icon} size={16} strokeWidth={1.75} />
        </button>
      ) : null}

      <div className="flex min-w-0 items-center gap-1.5 text-[13px] tracking-[-0.008em] text-fg-faint">
        {middle}
      </div>

      <div className="min-w-0 flex-1" data-tauri-drag-region />

      <button
        type="button"
        onClick={() => setPaletteOpen(true)}
        className="t3-window-btn"
        title="Buscar (⌘K)"
        aria-label="Buscar"
      >
        <Icon icon={SearchIcon} size={16} strokeWidth={1.75} />
      </button>
    </header>
  );
}
