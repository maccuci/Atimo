import { useEffect, useRef, useState } from "react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { Cancel01Icon, Folder01Icon } from "@hugeicons/core-free-icons";
import { Icon } from "@/components/ui/Icon";
import { Button } from "@/components/ui/primitives";
import { useStore } from "@/lib/store";

/**
 * Create a workspace without creating a project or an implicit chat — or,
 * opened with a workspace id, rename that one.
 */
export function WorkspaceSheet() {
  const open = useStore((s) => s.workspaceSheet);
  const setOpen = useStore((s) => s.setWorkspaceSheet);

  return (
    <AnimatePresence>
      {open ? (
        <Sheet
          renaming={typeof open === "string" ? open : null}
          onClose={() => setOpen(false)}
        />
      ) : null}
    </AnimatePresence>
  );
}

function Sheet({ renaming, onClose }: { renaming: string | null; onClose: () => void }) {
  const createWorkspace = useStore((s) => s.createWorkspace);
  const renameWorkspace = useStore((s) => s.renameWorkspace);
  const current = useStore((s) => s.workspaces.find((w) => w.id === renaming));
  const reduceMotion = useReducedMotion();
  const nameRef = useRef<HTMLInputElement>(null);
  const [name, setName] = useState(current?.name ?? "");

  useEffect(() => {
    nameRef.current?.focus();
    nameRef.current?.select();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.stopPropagation();
        onClose();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  const submit = () => {
    if (!name.trim()) return;
    if (renaming) renameWorkspace(renaming, name);
    else createWorkspace(name);
    onClose();
  };

  return (
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
        aria-label={renaming ? "Renomear workspace" : "Novo workspace"}
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
        className="relative flex w-full max-w-[460px] flex-col overflow-hidden rounded-t-[16px] border border-border-strong bg-bg-raised sm:rounded-[16px]"
      >
        <div
          aria-hidden
          className="mx-auto mt-2 h-1 w-10 shrink-0 rounded-full bg-border-strong sm:hidden"
        />

        <header className="flex items-center gap-2.5 border-b border-border px-4 py-3.5">
          <Icon icon={Folder01Icon} size={16} strokeWidth={1.5} className="text-fg-dim" />
          <div className="min-w-0 flex-1">
            <h2 className="text-[13px] font-medium tracking-[-0.01em] text-fg">
              {renaming ? "Renomear workspace" : "Novo workspace"}
            </h2>
            <p className="text-[11px] text-fg-faint">
              Agrupa projetos relacionados
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Fechar"
            className="pressable inline-flex h-10 w-10 items-center justify-center rounded-lg text-fg-faint hover:bg-bg-hover hover:text-fg sm:h-8 sm:w-8"
          >
            <Icon icon={Cancel01Icon} size={14} strokeWidth={2} />
          </button>
        </header>

        <div className="px-4 py-4">
          <label className="block">
            <span className="mb-1.5 block text-[11px] font-medium tracking-[0.02em] text-fg-faint">
              Nome
            </span>
            <input
              ref={nameRef}
              value={name}
              maxLength={80}
              autoComplete="off"
              spellCheck={false}
              placeholder="Meu workspace"
              onChange={(event) => setName(event.target.value)}
              onKeyDown={(event) => {
                event.stopPropagation();
                if (event.key === "Enter") {
                  event.preventDefault();
                  submit();
                }
              }}
              className="h-9 w-full rounded-[10px] border border-border bg-bg-inset px-3 text-[13px] text-fg outline-none transition-[border-color] duration-150 ease-out placeholder:text-fg-faint focus:border-cyan/50"
            />
          </label>
          {renaming ? null : (
            <p className="mt-2 text-[11.5px] leading-relaxed text-fg-faint">
              Os próximos projetos que você criar podem ficar aqui. O workspace começa vazio.
            </p>
          )}
        </div>

        <footer className="flex items-center gap-2 border-t border-border px-4 py-3">
          <p className="min-w-0 flex-1 text-[11px] leading-relaxed text-fg-faint">
            {renaming ? "Os projetos e chats continuam os mesmos." : "Nada é criado até você confirmar."}
          </p>
          <Button variant="accent" onClick={submit} disabled={!name.trim()}>
            {renaming ? "Salvar" : "Criar workspace"}
          </Button>
        </footer>
      </motion.div>
    </div>
  );
}
