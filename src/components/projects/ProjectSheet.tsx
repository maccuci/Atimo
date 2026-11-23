import { useEffect, useMemo, useRef, useState } from "react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { Cancel01Icon, Folder01Icon } from "@hugeicons/core-free-icons";
import { useStore } from "@/lib/store";
import { getModel } from "@/lib/models";
import { contextBudget, estimateTokens } from "@/lib/tokens";
import { Icon } from "@/components/ui/Icon";
import { Button } from "@/components/ui/primitives";
import { cn, formatShare, formatTokens } from "@/lib/utils";

/*
 * The project editor — one project's name, its one-line description, and its
 * base context.
 *
 * The base context is the reason this screen exists, so it gets the room: it is
 * the text every chat in the project inherits, and the only way to know whether
 * it is worth its cost is to see that cost while writing it. Hence the live token
 * count and the share of the model's window, priced with the same estimator the
 * composer budgets with.
 *
 * Edits to an existing project commit on close rather than on every keystroke.
 * The brief is prose, and a store write per character would put a partial
 * sentence into every chat in the project for as long as the user paused typing.
 * A new project is the exception: it is created only by the button that says so.
 */

/** Above this share of the window, a standing brief is crowding out retrieval. */
const HEAVY_SHARE = 0.15;

export function ProjectSheet() {
  const target = useStore((s) => s.projectSheet);
  const setProjectSheet = useStore((s) => s.setProjectSheet);

  // Keyed so switching between projects without closing remounts the form and
  // its drafts, instead of showing the previous project's text under a new name.
  return (
    <AnimatePresence>
      {target ? (
        <Sheet
          key={target}
          target={target}
          onClose={() => setProjectSheet(null)}
        />
      ) : null}
    </AnimatePresence>
  );
}

function Sheet({
  target,
  onClose,
}: {
  /** A project id, or `"new"`. */
  target: string;
  onClose: () => void;
}) {
  const creating = target === "new";
  const project = useStore((s) =>
    creating ? undefined : s.projects.find((p) => p.id === target),
  );
  const createProject = useStore((s) => s.createProject);
  const updateProject = useStore((s) => s.updateProject);
  const selectProject = useStore((s) => s.selectProject);
  const newChat = useStore((s) => s.newChat);
  const setView = useStore((s) => s.setView);

  // The model the brief will actually be sent to, so the share is priced against
  // the window it will really occupy rather than a default.
  const modelId = useStore((s) => {
    const chat = s.chats.find((c) => c.id === s.chatId);
    return chat?.modelId ?? s.catalog[0]?.id ?? "claude-opus-5";
  });

  const reduceMotion = useReducedMotion();
  const nameRef = useRef<HTMLInputElement>(null);
  const briefRef = useRef<HTMLTextAreaElement>(null);

  const [name, setName] = useState(project?.name ?? "");
  const [description, setDescription] = useState(project?.description ?? "");
  const [instructions, setInstructions] = useState(project?.instructions ?? "");

  /*
   * Dismissing through a ref rather than from the closure.
   *
   * Escape and the backdrop both dismiss, and both run through an effect whose
   * dependencies would otherwise have to include every draft field — re-binding
   * the key listener on each keystroke. The ref keeps the listener bound once
   * while still seeing the latest text.
   *
   * Creating and editing dismiss differently, and the difference is what the
   * primary button says. On an existing project the sheet *is* the field: there
   * is nothing to confirm, so any way out saves. On a new one the button reads
   * "Create project", which means nothing else may create it — Escape on a
   * half-filled form has to leave the workspace as it was, not leave a project
   * behind that the user never agreed to.
   */
  const dismissRef = useRef(() => {});
  dismissRef.current = () => {
    if (!creating) updateProject(target, { name, description, instructions });
    onClose();
  };

  const submit = () => {
    if (creating) {
      const id = createProject({
        name,
        description,
        instructions,
      });
      if (!id) return;
      selectProject(id);
      // Land on a ready composer: an empty project has nothing to pick, and
      // its first chat is also what puts it in Recents.
      newChat();
      setView("chat");
      onClose();
      return;
    }
    dismissRef.current();
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        dismissRef.current();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);

  // A new project opens on its name; an existing one opens on its brief, which
  // is the field anyone reopening this screen came back for.
  useEffect(() => {
    if (creating) nameRef.current?.focus();
    else briefRef.current?.focus();
  }, [creating]);

  const cost = useMemo(() => {
    const text = instructions.trim();
    if (!text) return null;
    const tokens = estimateTokens(text);
    const model = getModel(modelId);
    return {
      tokens,
      model,
      share: tokens / model.contextWindow,
      budgetShare: tokens / Math.max(1, contextBudget(modelId)),
    };
  }, [instructions, modelId]);

  const heavy = cost !== null && cost.budgetShare > HEAVY_SHARE;

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center p-0 sm:items-center sm:p-6">
      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        transition={{ duration: 0.18 }}
        onClick={() => dismissRef.current()}
        className="absolute inset-0 bg-bg/70 backdrop-blur-[2px]"
      />

      <motion.div
        role="dialog"
        aria-modal
        aria-label={creating ? "Novo projeto" : `Configurações de ${project?.name}`}
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
        className="relative flex max-h-[min(92dvh,780px)] w-full max-w-140 flex-col overflow-hidden rounded-t-2xl border border-border-strong bg-bg-raised sm:rounded-2xl"
      >
        <div
          aria-hidden
          className="mx-auto mt-2 h-1 w-10 shrink-0 rounded-full bg-border-strong sm:hidden"
        />

        <header className="flex shrink-0 items-center gap-2.5 border-b border-border px-4 py-3.5">
          <Icon icon={Folder01Icon} size={16} strokeWidth={1.5} className="text-fg-dim" />
          <div className="min-w-0 flex-1">
            <h2 className="text-[13px] font-medium tracking-[-0.01em] text-fg">
              {creating ? "Novo projeto" : project?.name}
            </h2>
            <p className="text-[11px] text-fg-faint">
              Compartilhado por todos os chats deste projeto
            </p>
          </div>
          <button
            type="button"
            onClick={() => dismissRef.current()}
            aria-label="Fechar"
            className="pressable inline-flex h-10 w-10 items-center justify-center rounded-lg text-fg-faint hover:bg-bg-hover hover:text-fg sm:h-8 sm:w-8"
          >
            <Icon icon={Cancel01Icon} size={14} strokeWidth={2} />
          </button>
        </header>

        <div className="scroll-thin min-h-0 flex-1 overflow-y-auto px-4 py-4">
          <Field label="Nome">
            <input
              ref={nameRef}
              value={name}
              spellCheck={false}
              placeholder="Atimo"
              onChange={(e) => setName(e.target.value)}
              className="h-9 w-full rounded-[10px] border border-border bg-bg-inset px-3 text-[13px] text-fg outline-none transition-[border-color] duration-150 ease-out placeholder:text-fg-faint focus:border-cyan/50"
            />
          </Field>

          <Field
            label="Descrição"
            hint="Uma linha, para você — não vai para o modelo"
          >
            <input
              value={description}
              spellCheck={false}
              placeholder="Do que se trata este projeto"
              onChange={(e) => setDescription(e.target.value)}
              className="h-9 w-full rounded-[10px] border border-border bg-bg-inset px-3 text-[13px] text-fg outline-none transition-[border-color] duration-150 ease-out placeholder:text-fg-faint focus:border-cyan/50"
            />
          </Field>

          <Field
            label="Contexto base"
            hint="Todo chat daqui começa com isto, em qualquer modelo"
          >
            <textarea
              ref={briefRef}
              value={instructions}
              rows={10}
              spellCheck={false}
              placeholder={
                "O que todo modelo precisa saber antes de responder neste projeto?\n\nA stack e as restrições. Como as decisões são tomadas. O que você nunca quer que seja sugerido. Tudo que você digitaria de novo em cada chat novo."
              }
              onChange={(e) => setInstructions(e.target.value)}
              className="scroll-thin block w-full resize-y rounded-[10px] border border-border bg-bg-inset px-3 py-2.5 text-[13px] leading-relaxed text-fg outline-none transition-[border-color] duration-150 ease-out placeholder:text-fg-faint focus:border-cyan/50"
            />
          </Field>

          {cost ? (
            <div
              className={cn(
                "mt-1 rounded-[10px] border px-3 py-2.5 text-[11.5px] leading-relaxed",
                heavy
                  ? "border-red/30 bg-red/10 text-red"
                  : "border-border bg-bg-surface text-fg-dim",
              )}
            >
              <div className="flex items-baseline justify-between gap-3">
                <span>
                  ~{cost.tokens.toLocaleString("pt-BR")} tokens em toda mensagem
                </span>
                <span className="shrink-0 tabular-nums text-fg-faint">
                  {formatShare(cost.share)} de{" "}
                  {formatTokens(cost.model.contextWindow)}
                </span>
              </div>
              {heavy && (
                <p className="mt-1">
                  Isso é {formatShare(cost.budgetShare)} do que o{" "}
                  {cost.model.label} pode gastar com contexto, então sobra menos
                  espaço para chats e documentos. Material de referência longo
                  fica melhor em documentos.
                </p>
              )}
            </div>
          ) : (
            <p className="mt-1 text-[11.5px] leading-relaxed text-fg-faint">
              Sem contexto base, os chats deste projeto ainda compartilham
              chats e documentos — só começam sem um resumo.
            </p>
          )}
        </div>

        <footer className="flex shrink-0 items-center gap-2 border-t border-border px-4 py-3">
          {/* The two dismiss rules, stated rather than left to be discovered. */}
          <p className="min-w-0 flex-1 text-[11px] leading-relaxed text-fg-faint">
            {creating
              ? "Nada é criado até você confirmar."
              : "Salvo ao fechar."}
          </p>
          <Button
            variant="accent"
            onClick={submit}
            disabled={creating && !name.trim()}
          >
            {creating ? "Criar projeto" : "Concluir"}
          </Button>
        </footer>
      </motion.div>
    </div>
  );
}

function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <label className="mb-3.5 block">
      <span className="mb-1.5 flex items-baseline gap-2">
        <span className="text-[11px] font-medium tracking-[0.02em] text-fg-faint">
          {label}
        </span>
        {hint ? (
          <span className="min-w-0 flex-1 truncate text-[11px] text-fg-faint">
            {hint}
          </span>
        ) : null}
      </span>
      {children}
    </label>
  );
}
