import { useEffect, useRef, useState } from "react";
import {
  Delete02Icon,
  MoreHorizontalIcon,
  PencilEdit02Icon,
} from "@hugeicons/core-free-icons";
import { Menu, MenuItem, MenuSeparator } from "@/components/ui/Menu";
import { Icon } from "@/components/ui/Icon";
import { useStore } from "@/lib/store";
import { cn } from "@/lib/utils";

/*
 * Renaming and deleting a chat.
 *
 * Both live here rather than in the rail and the chat header separately: the two
 * surfaces show the same two actions on the same entity, and a rename that
 * trimmed differently or a delete that confirmed differently depending on where
 * it was clicked from is exactly the kind of inconsistency that makes an app
 * feel unfinished.
 */

/* ---------------------------------------------------------------------- */
/* The menu                                                                */
/* ---------------------------------------------------------------------- */

export function ChatMenu({
  chatId,
  onRename,
  className,
  visible = true,
}: {
  chatId: string;
  /** Hands editing back to the caller, which owns the title's layout. */
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
  const triggerRef = useRef<HTMLButtonElement>(null);

  const deleteChat = useStore((s) => s.deleteChat);
  const messageCount = useStore(
    // A count, not the array: subscribing to `messages` would re-render every
    // row of the rail on each frame of a streaming turn.
    (s) => s.messages.reduce((n, m) => (m.chatId === chatId ? n + 1 : n), 0),
  );

  const close = () => {
    setOpen(false);
    setConfirming(false);
  };

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label="Ações do chat"
        title="Ações do chat"
        onClick={(e) => {
          // The row underneath selects the chat; opening its menu should not.
          e.stopPropagation();
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
        label="Ações do chat"
        width={confirming ? 216 : 190}
      >
        {confirming ? (
          <DeleteConfirmation
            messageCount={messageCount}
            onCancel={() => setConfirming(false)}
            onConfirm={() => {
              close();
              deleteChat(chatId);
            }}
          />
        ) : (
          <>
            <MenuItem
              icon={PencilEdit02Icon}
              label="Renomear"
              onSelect={() => {
                close();
                onRename();
              }}
            />
            <MenuSeparator />
            <MenuItem
              icon={Delete02Icon}
              label="Excluir chat"
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
 * The second step of a delete.
 *
 * A chat carries its whole transcript out with it and there is no undo, which is
 * the one case a confirmation genuinely earns — but it does not earn a modal.
 * Staying inside the menu keeps the action anchored to the row it belongs to,
 * and naming the number of messages gives the user the fact they need to decide
 * instead of asking them to remember it.
 */
function DeleteConfirmation({
  messageCount,
  onCancel,
  onConfirm,
}: {
  messageCount: number;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const confirmRef = useRef<HTMLButtonElement>(null);

  // Focus lands on the destructive button so Enter completes the action the
  // user already asked for — and Escape, handled by the menu, still backs out.
  useEffect(() => {
    confirmRef.current?.focus();
  }, []);

  return (
    <div className="px-3 py-1.5">
      <p className="text-[12.5px] font-medium tracking-[-0.01em] text-fg">
        Excluir este chat?
      </p>
      <p className="mt-0.5 text-[11px] leading-relaxed text-fg-dim">
        {messageCount === 0
          ? "Ele está vazio, nada se perde."
          : `${messageCount === 1 ? "A mensagem vai junto" : `As ${messageCount} mensagens vão junto`}. Não dá para desfazer.`}
      </p>
      <div className="mt-2.5 flex items-center gap-1.5">
        <button
          type="button"
          onClick={onCancel}
          className="pressable h-6 flex-1 rounded-md border border-border text-[11.5px] text-fg-dim transition-[background-color,border-color,color] duration-150 ease-out hover:border-border-strong hover:text-fg"
        >
          Cancelar
        </button>
        <button
          ref={confirmRef}
          type="button"
          onClick={onConfirm}
          className="pressable h-6 flex-1 rounded-md border border-red/40 bg-red/10 text-[11.5px] font-medium text-red transition-[background-color] duration-150 ease-out hover:bg-red/20"
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
 * The title, as an editable field in place.
 *
 * In place rather than in a dialog: the user is renaming the thing they are
 * looking at, and a dialog would take the row away to ask about it. Committing
 * on blur as well as on Enter means clicking elsewhere keeps the edit, which is
 * what the gesture reads as — nobody clicks away to discard.
 */
export function ChatTitleInput({
  chatId,
  title,
  onDone,
  className,
}: {
  chatId: string;
  title: string;
  onDone: () => void;
  className?: string;
}) {
  const renameChat = useStore((s) => s.renameChat);
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
    // An empty title would leave a row with nothing to click on, so blank input
    // reverts instead of erasing — the forgiving reading of a cleared field.
    if (next && next !== title) renameChat(chatId, next);
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
      defaultValue={title}
      aria-label="Nome do chat"
      spellCheck={false}
      onClick={(e) => e.stopPropagation()}
      onPointerDown={(e) => e.stopPropagation()}
      onBlur={commit}
      onKeyDown={(e) => {
        // Contained here: Escape would otherwise reach the window handler and
        // Enter the composer.
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
