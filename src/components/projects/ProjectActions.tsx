import { useEffect, useRef, useState } from "react";
import {
  ChatAdd01Icon,
  Delete02Icon,
  FileExportIcon,
  MoreHorizontalIcon,
  PencilEdit02Icon,
  Settings02Icon,
} from "@hugeicons/core-free-icons";
import { Menu, MenuItem, MenuSeparator } from "@/components/ui/Menu";
import { ExportPanel } from "@/components/export/ExportPanel";
import { Icon } from "@/components/ui/Icon";
import { useStore } from "@/lib/store";
import { cn } from "@/lib/utils";

/*
 * Renaming, editing and deleting a project.
 *
 * The same arrangement `ChatActions` uses, and for the same reason: the rail and
 * the projects grid show these actions on the same entity, and a delete that
 * confirmed differently depending on which surface it was clicked from is the
 * kind of inconsistency that makes an app feel unfinished.
 *
 * The difference is what a project delete costs. A chat takes its transcript;
 * a project takes every chat, every transcript, and the whole knowledge layer
 * built on top of them — so the confirmation counts all four and asks the user
 * to type the name.
 */

export function ProjectMenu({
  projectId,
  onRename,
  className,
  visible = true,
}: {
  projectId: string;
  /** Hands editing back to the caller, which owns the name's layout. */
  onRename: () => void;
  className?: string;
  /**
   * False keeps the trigger in the layout but invisible, so a row does not
   * reflow on hover. It still appears on keyboard focus.
   */
  visible?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [exporting, setExporting] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);

  const setProjectSheet = useStore((s) => s.setProjectSheet);
  const selectProject = useStore((s) => s.selectProject);
  const newChat = useStore((s) => s.newChat);
  const projectName = useStore(
    (s) => s.projects.find((p) => p.id === projectId)?.name,
  );

  const close = () => {
    setOpen(false);
    setConfirming(false);
    setExporting(false);
  };

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label="Ações do projeto"
        title="Ações do projeto"
        onClick={(e) => {
          // The row underneath opens the project; opening its menu should not.
          e.stopPropagation();
          e.preventDefault();
          setOpen((v) => !v);
          setConfirming(false);
        }}
        className={cn(
          "pressable inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md md:h-6 md:w-6",
          "text-fg-faint transition-[background-color,color,opacity] duration-150 ease-out",
          "hover:bg-bg-active hover:text-fg focus-visible:opacity-100",
          open
            ? "bg-bg-active text-fg opacity-100"
            : !visible && "opacity-0 touch-visible",
          className,
        )}
      >
        <Icon icon={MoreHorizontalIcon} size={15} strokeWidth={2} />
      </button>

      <Menu
        open={open}
        anchor={triggerRef}
        onClose={close}
        label="Ações do projeto"
        width={confirming || exporting ? 268 : 210}
      >
        {confirming ? (
          <DeleteConfirmation
            projectId={projectId}
            onCancel={() => setConfirming(false)}
            onConfirm={close}
          />
        ) : exporting ? (
          <ExportPanel
            projectId={projectId}
            label={projectName ?? "este projeto"}
            onClose={close}
          />
        ) : (
          <>
            <MenuItem
              icon={ChatAdd01Icon}
              label="Novo chat"
              onSelect={() => {
                close();
                // Select first: `newChat` puts the chat in whichever project is
                // open, so acting on this row means making it the open one.
                selectProject(projectId);
                newChat();
              }}
            />
            <MenuSeparator />
            <MenuItem
              icon={Settings02Icon}
              label="Contexto base"
              onSelect={() => {
                close();
                setProjectSheet(projectId);
              }}
            />
            <MenuItem
              icon={PencilEdit02Icon}
              label="Renomear"
              onSelect={() => {
                close();
                onRename();
              }}
            />
            {/* Directly above the delete, on purpose: the moment someone is
                looking at the button that destroys a project is the moment the
                one that saves a copy of it is worth seeing. */}
            <MenuItem
              icon={FileExportIcon}
              label="Exportar"
              onSelect={() => setExporting(true)}
            />
            <MenuSeparator />
            <MenuItem
              icon={Delete02Icon}
              label="Excluir projeto"
              tone="danger"
              onSelect={() => setConfirming(true)}
            />
          </>
        )}
      </Menu>
    </>
  );
}

/**
 * The second step of a project delete.
 *
 * Typing the name, which a chat delete deliberately does not ask for. The
 * difference is the size of the mistake: a chat is one conversation, and a
 * project is every conversation plus the memory and decisions distilled out of
 * them — the thing the whole app exists to accumulate. That is worth one moment
 * of friction, and the friction has to be *reading*, which is why the counts sit
 * directly above the field.
 */
function DeleteConfirmation({
  projectId,
  onCancel,
  onConfirm,
}: {
  projectId: string;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const deleteProject = useStore((s) => s.deleteProject);
  const project = useStore((s) => s.projects.find((p) => p.id === projectId));

  /*
   * Counts, not the arrays. This menu can be open while a turn streams into the
   * project, and subscribing to `messages` would re-render it on every frame.
   * One pass each, and each returns a number that only changes when the count
   * genuinely does.
   */
  const chatCount = useStore((s) =>
    s.chats.reduce((n, c) => (c.projectId === projectId ? n + 1 : n), 0),
  );
  const messageCount = useStore((s) => {
    const chatIds = new Set(
      s.chats.filter((c) => c.projectId === projectId).map((c) => c.id),
    );
    return s.messages.reduce((n, m) => (chatIds.has(m.chatId) ? n + 1 : n), 0);
  });

  if (!project) return null;

  return (
    <ConfirmByName
      name={project.name}
      summary={
        chatCount === 0
          ? "Ele está vazio, nada se perde."
          : `${chatCount} ${chatCount === 1 ? "chat" : "chats"} · ${messageCount} ${
              messageCount === 1 ? "mensagem" : "mensagens"
            }. Não dá para desfazer.`
      }
      onCancel={onCancel}
      onConfirm={() => {
        onConfirm();
        deleteProject(projectId);
      }}
    />
  );
}

/**
 * "Type the name to delete" — the gate for anything that takes conversations
 * with it. Shared by project and workspace deletes so both read the same.
 */
export function ConfirmByName({
  name,
  summary,
  onCancel,
  onConfirm,
}: {
  name: string;
  summary: string;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const [typed, setTyped] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  // Case-insensitive and trimmed: the gate is there to make the user read the
  // name, not to test their typing.
  const armed = typed.trim().toLowerCase() === name.toLowerCase();

  const submit = () => {
    if (armed) onConfirm();
  };

  return (
    <div className="px-3 py-1.5">
      <p className="text-[12.5px] font-medium tracking-[-0.01em] text-fg">
        Excluir {name}?
      </p>
      <p className="mt-1 text-[11px] leading-relaxed text-fg-dim">{summary}</p>

      <input
        ref={inputRef}
        value={typed}
        spellCheck={false}
        autoComplete="off"
        aria-label={`Digite ${name} para confirmar`}
        placeholder={name}
        onChange={(e) => setTyped(e.target.value)}
        onKeyDown={(e) => {
          // Contained, or Escape reaches the window handler and Enter the
          // composer underneath.
          e.stopPropagation();
          if (e.key === "Enter") {
            e.preventDefault();
            submit();
          } else if (e.key === "Escape") {
            e.preventDefault();
            onCancel();
          }
        }}
        className="mt-2.5 h-7 w-full rounded-md border border-border-strong bg-bg-inset px-2 text-[12px] text-fg outline-none transition-[border-color] duration-150 ease-out placeholder:text-fg-faint focus:border-cyan/50"
      />

      <div className="mt-2 flex items-center gap-1.5">
        <button
          type="button"
          onClick={onCancel}
          className="pressable h-6 flex-1 rounded-md border border-border text-[11.5px] text-fg-dim transition-[background-color,border-color,color] duration-150 ease-out hover:border-border-strong hover:text-fg"
        >
          Cancelar
        </button>
        <button
          type="button"
          onClick={submit}
          disabled={!armed}
          className="pressable h-6 flex-1 rounded-md border border-red/40 bg-red/10 text-[11.5px] font-medium text-red transition-[background-color,opacity] duration-150 ease-out hover:bg-red/20 disabled:pointer-events-none disabled:opacity-40"
        >
          Excluir
        </button>
      </div>
    </div>
  );
}

/* ---------------------------------------------------------------------- */
/* Inline rename                                                           */
/* ---------------------------------------------------------------------- */

/**
 * The name, as an editable field in place. Same contract as `ChatTitleInput`:
 * `⏎` commits, `⎋` cancels, blur commits, blank reverts.
 */
export function ProjectNameInput({
  projectId,
  name,
  onDone,
  className,
}: {
  projectId: string;
  name: string;
  onDone: () => void;
  className?: string;
}) {
  const renameProject = useStore((s) => s.renameProject);
  const inputRef = useRef<HTMLInputElement>(null);
  // Guards against the blur that follows Enter committing a second time.
  const settled = useRef(false);

  useEffect(() => {
    const input = inputRef.current;
    if (!input) return;
    input.focus();
    input.select();
  }, []);

  const commit = () => {
    if (settled.current) return;
    settled.current = true;
    const next = inputRef.current?.value.trim() ?? "";
    if (next && next !== name) renameProject(projectId, next);
    onDone();
  };

  const cancel = () => {
    if (settled.current) return;
    settled.current = true;
    onDone();
  };

  return (
    <input
      ref={inputRef}
      defaultValue={name}
      aria-label="Nome do projeto"
      spellCheck={false}
      onClick={(e) => e.stopPropagation()}
      onPointerDown={(e) => e.stopPropagation()}
      onBlur={commit}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === "Enter") {
          e.preventDefault();
          commit();
        } else if (e.key === "Escape") {
          e.preventDefault();
          cancel();
        }
      }}
      className={cn(
        "min-w-0 flex-1 rounded-md border border-cyan/50 bg-bg-inset px-1.5 text-fg outline-none",
        className,
      )}
    />
  );
}
