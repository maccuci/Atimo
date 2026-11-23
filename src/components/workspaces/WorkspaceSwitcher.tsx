import { useRef, useState } from "react";
import {
  Add01Icon,
  Delete02Icon,
  Edit02Icon,
  ArrowDown01Icon,
  Folder01Icon,
  Folder02Icon,
  Tick02Icon,
} from "@hugeicons/core-free-icons";
import { Menu, MenuItem, MenuSeparator } from "@/components/ui/Menu";
import { Icon } from "@/components/ui/Icon";
import { ConfirmByName } from "@/components/projects/ProjectActions";
import { useStore } from "@/lib/store";
import { cn } from "@/lib/utils";
import { projectTileStyle, projectTileText } from "@/t3/primitives";

/**
 * The workspace boundary in the rail.
 *
 * Projects are scoped to the selected workspace, so switching it must go
 * through the store rather than filtering locally. The same menu also owns the
 * only entry point for creating a workspace, keeping the action discoverable
 * without adding another permanent button to the rail.
 */
export function WorkspaceSwitcher({
  expanded,
  onNavigate,
  className,
}: {
  expanded: boolean;
  onNavigate?: () => void;
  className?: string;
}) {
  const workspaces = useStore((s) => s.workspaces);
  const workspaceId = useStore((s) => s.workspaceId);
  const selectWorkspace = useStore((s) => s.selectWorkspace);
  const setWorkspaceSheet = useStore((s) => s.setWorkspaceSheet);
  const current = workspaces.find((workspace) => workspace.id === workspaceId);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const deleteWorkspace = useStore((s) => s.deleteWorkspace);
  // Counts, not arrays: the summary only needs numbers.
  const projectCount = useStore((s) =>
    s.projects.reduce((n, p) => (p.workspaceId === s.workspaceId ? n + 1 : n), 0),
  );
  const chatCount = useStore((s) => {
    const ids = new Set(s.projects.filter((p) => p.workspaceId === s.workspaceId).map((p) => p.id));
    return s.chats.reduce((n, c) => (ids.has(c.projectId) ? n + 1 : n), 0);
  });

  const close = () => {
    setOpen(false);
    setConfirming(false);
  };
  const choose = (id: string) => {
    selectWorkspace(id);
    close();
    onNavigate?.();
  };

  return (
    <div className={cn(className)}>
      <button
        ref={triggerRef}
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={current ? `Workspace: ${current.name}` : "Escolher workspace"}
        title={expanded ? undefined : (current?.name ?? "Escolher workspace")}
        onClick={() => setOpen((value) => !value)}
        className={cn(
          "pressable flex items-center rounded-[10px] text-left transition-[background-color,color] duration-150 ease-out",
          expanded
            ? "w-full gap-2.5 px-2 py-1.5 text-[13.5px] tracking-[-0.008em]"
            : "mx-auto h-9 w-9 justify-center",
          open
            ? "bg-bg-active text-fg"
            : "text-fg-dim hover:bg-bg-hover hover:text-fg",
        )}
      >
        {expanded && current ? (
          <span
            className="t3-project-tile"
            // Round and a size up: the workspace reads as "you", not a project.
            style={{ ...projectTileStyle(current.name), width: 24, height: 24, borderRadius: 999, fontSize: 10 }}
          >
            {projectTileText(current.name)}
          </span>
        ) : (
          <Icon icon={open ? Folder02Icon : Folder01Icon} size={15} strokeWidth={1.75} />
        )}
        {expanded ? (
          <>
            <span className="min-w-0 flex-1 truncate">
              {current?.name ?? "Escolher workspace"}
            </span>
            <Icon
              icon={ArrowDown01Icon}
              size={12}
              strokeWidth={1.75}
              className="shrink-0 text-fg-faint"
            />
          </>
        ) : null}
      </button>

      <Menu
        open={open}
        anchor={triggerRef}
        onClose={close}
        label="Workspaces"
        width={confirming ? 268 : 240}
      >
        {confirming && current ? (
          <ConfirmByName
            name={current.name}
            summary={
              projectCount === 0
                ? "Ele está vazio, nada se perde."
                : `${projectCount} ${projectCount === 1 ? "projeto" : "projetos"} · ${chatCount} ${
                    chatCount === 1 ? "chat" : "chats"
                  }, com documentos e memória. Não dá para desfazer.`
            }
            onCancel={() => setConfirming(false)}
            onConfirm={() => {
              close();
              deleteWorkspace(current.id);
            }}
          />
        ) : (
        <>
        <div className="px-3 pb-1.5 text-[11px] font-medium tracking-[0.02em] text-fg-faint">
          Workspaces
        </div>

        {workspaces.length ? (
          workspaces.map((workspace) => {
            const active = workspace.id === workspaceId;
            return (
              <MenuItem
                key={workspace.id}
                icon={Folder01Icon}
                label={workspace.name}
                active={active}
                trailing={
                  active ? (
                    <Icon
                      icon={Tick02Icon}
                      size={13}
                      strokeWidth={2}
                      className="shrink-0 text-cyan"
                    />
                  ) : null
                }
                onSelect={() => choose(workspace.id)}
              />
            );
          })
        ) : (
          <p className="px-3 py-2 text-[12px] leading-relaxed text-fg-faint">
            Nenhum workspace ainda.
          </p>
        )}

        <MenuSeparator />
        {current ? (
          <MenuItem
            icon={Edit02Icon}
            label="Renomear workspace"
            onSelect={() => {
              close();
              setWorkspaceSheet(current.id);
              onNavigate?.();
            }}
          />
        ) : null}
        <MenuItem
          icon={Add01Icon}
          label="Novo workspace"
          onSelect={() => {
            close();
            setWorkspaceSheet(true);
            onNavigate?.();
          }}
        />
        {current && workspaces.length > 1 ? (
          <>
            <MenuSeparator />
            <MenuItem
              icon={Delete02Icon}
              label="Excluir workspace"
              tone="danger"
              onSelect={() => setConfirming(true)}
            />
          </>
        ) : null}
        </>
        )}
      </Menu>
    </div>
  );
}
