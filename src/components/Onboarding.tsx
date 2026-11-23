import { useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { motion, useReducedMotion } from "motion/react";
import {
  Alert02Icon,
  ArrowRight01Icon,
  FileImportIcon,
  Folder01Icon,
  SparklesIcon,
} from "@hugeicons/core-free-icons";
import type { IconSvgElement } from "@hugeicons/react";
import { Icon } from "@/components/ui/Icon";
import { IMPORT_ACCEPT, count } from "@/lib/import";
import { initializeWorkspace } from "@/lib/sync";
import { useStore } from "@/lib/store";
import { useImport } from "@/lib/use-import";
import { cn } from "@/lib/utils";

/*
 * First run, and the only screen that gets to interrupt the app.
 *
 * It exists because of what used to happen instead: an empty database was
 * silently filled with the demo fixtures, so a new user's first sight of
 * Atimo was four projects they had never created, holding transcripts with
 * assistant replies no model had ever produced. Someone testing the app could
 * not tell which half was theirs — and neither could their feedback.
 *
 * Both paths are legitimate, which is why this asks rather than picks. Example
 * data is genuinely the better demo: the timeline, the decision log and project
 * memory are all views onto history, and a workspace with no history renders
 * them as three empty panes. An empty workspace is the better start for real
 * work. The one thing that must not happen is a user getting the first without
 * knowing it.
 */

export function Onboarding() {
  const setConnectOpen = useStore((s) => s.setConnectOpen);
  const connected = useStore((s) => s.connection.status === "connected");
  const reduceMotion = useReducedMotion();

  const [name, setName] = useState("");
  const [busy, setBusy] = useState<"demo" | "clean" | null>(null);
  const [error, setError] = useState<string | null>(null);

  const backupInput = useRef<HTMLInputElement>(null);
  const restore = useImport();
  /*
   * A restore in progress owns the screen. It seeds the same workspace marker
   * the two buttons above do, so letting one start while the other is running
   * would race two `seed` calls at one database.
   */
  const restoring =
    restore.phase.state === "reading" || restore.phase.state === "running";

  /**
   * Restore, then ask for a model — the same second step the other two get.
   *
   * Chained here rather than watched for, because a restore that succeeds
   * completes onboarding and unmounts this screen in the same tick: an effect on
   * the phase would never run, and someone reinstalling would land in a restored
   * workspace with nothing connected and nothing saying so.
   */
  const restoreBackup = async () => {
    const outcome = await restore.confirm();
    if (outcome && !connected) setConnectOpen(true);
  };

  const choose = async (choice: "demo" | "clean") => {
    if (busy || restoring) return;
    setBusy(choice);
    setError(null);
    try {
      await initializeWorkspace(choice, name);
      // The next thing they need is a model, and the sheet says so better than
      // a line of text here would. Skipped when a key is already connected —
      // reinstalling should not mean re-reading the key screen.
      if (!connected) setConnectOpen(true);
    } catch (e) {
      // Setup that half-succeeded is worse than setup that failed loudly: the
      // app would run on a workspace nothing can save. Stay on this screen.
      setBusy(null);
      setError(
        e instanceof Error
          ? e.message
          : "the workspace could not be written to disk",
      );
    }
  };

  const onNameKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") {
      e.preventDefault();
      void choose("clean");
    }
  };

  return (
    <div className="fixed inset-0 z-[100] flex flex-col items-center justify-center overflow-auto bg-bg px-6 py-10">
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0"
        style={{
          background:
            "radial-gradient(ellipse 70% 50% at 50% 38%, color-mix(in srgb, var(--cyan) 8%, transparent), transparent 70%)",
        }}
      />

      {/*
        Covering the whole window also covers the title bar, which is the only
        thing the window can be dragged by — and a window that cannot be moved
        reads as a hang rather than as a question. Painted before the content
        rather than above it, so a short window that scrolls its buttons up
        here keeps them clickable.
      */}
      <div
        data-tauri-drag-region
        aria-hidden
        className="absolute inset-x-0 top-0"
        style={{ height: "calc(var(--titlebar-h) + var(--safe-top))" }}
      />

      <motion.div
        initial={reduceMotion ? { opacity: 0 } : { opacity: 0, y: 8 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: reduceMotion ? 0.12 : 0.32, ease: [0.23, 1, 0.32, 1] }}
        className="relative flex w-full max-w-[560px] flex-col items-center text-center"
      >
        <img src="/logo.png" alt="" className="mb-5 size-11 select-none rounded-[12px]" />

        <h1
          className="text-[24px] font-semibold tracking-[-0.035em] text-fg"
          style={{ lineHeight: 1.1 }}
        >
          Boas-vindas ao Atimo
        </h1>
        <p className="mt-2.5 max-w-md text-[13.5px] leading-relaxed tracking-[-0.01em] text-fg-dim">
          O conhecimento fica nos projetos; os modelos se revezam sobre ele.
          Escolha como este workspace começa — dá para criar ou excluir
          projetos a qualquer momento.
        </p>

        <div className="mt-8 flex w-full flex-col gap-3 text-left">
          {/* Own project first: it is the honest default, and putting the demo
              above it would read as the recommended path. */}
          <Option
            icon={Folder01Icon}
            title="Começar com meu próprio projeto"
            body="Um workspace vazio com um projeto. Nada no app é de outra pessoa."
          >
            <div className="mt-3 flex items-center gap-2">
              <input
                value={name}
                autoFocus
                spellCheck={false}
                maxLength={80}
                placeholder="Meu projeto"
                onChange={(e) => setName(e.target.value)}
                onKeyDown={onNameKey}
                className="min-w-0 flex-1 rounded-[10px] border border-border-strong bg-bg-inset px-3 py-2 text-[13px] tracking-[-0.01em] text-fg placeholder:text-fg-faint outline-none focus:border-cyan/50"
              />
              <button
                type="button"
                disabled={busy !== null}
                onClick={() => void choose("clean")}
                className="pressable inline-flex h-[38px] shrink-0 items-center gap-1.5 rounded-[10px] border border-cyan/40 bg-cyan/10 px-3.5 text-[12.5px] tracking-[-0.01em] text-cyan transition-[background-color] duration-150 ease-out hover:bg-cyan/20 disabled:pointer-events-none disabled:opacity-40"
              >
                {busy === "clean" ? "Criando…" : "Criar"}
                {busy === "clean" ? null : (
                  <Icon icon={ArrowRight01Icon} size={13} strokeWidth={2} />
                )}
              </button>
            </div>
          </Option>

          <Option
            icon={SparklesIcon}
            title="Explorar com dados de exemplo"
            body="Quatro projetos de exemplo com conversas e documentos já preenchidos, para ter o que explorar. É conteúdo de demonstração, não seu, e excluir um projeto apaga de vez."
          >
            <button
              type="button"
              disabled={busy !== null || restoring}
              onClick={() => void choose("demo")}
              className="pressable mt-3 inline-flex h-[34px] items-center gap-1.5 rounded-[10px] border border-border px-3.5 text-[12.5px] tracking-[-0.01em] text-fg-dim transition-[border-color,color] duration-150 ease-out hover:border-border-strong hover:text-fg disabled:pointer-events-none disabled:opacity-40"
            >
              {busy === "demo" ? "Carregando…" : "Carregar dados de exemplo"}
            </button>
          </Option>

          {/*
            Last, and the only one of the three that is not a decision about
            what to start with — it is the answer to having lost a workspace, or
            to arriving on a second machine. Reinstalling is the moment a backup
            is worth something, so it has to be reachable from the first screen
            after one: an import buried in a menu inside the app is one the user
            reaches only after setting up the workspace it was meant to replace.
          */}
          <Option
            icon={FileImportIcon}
            title="Restaurar de um backup"
            body="O arquivo JSON gerado por uma exportação do Atimo. Projetos, conversas e arquivos enviados voltam com o histórico."
          >
            <input
              ref={backupInput}
              type="file"
              accept={IMPORT_ACCEPT}
              className="hidden"
              onChange={(e) => {
                restore.choose(e.target.files?.[0]);
                e.target.value = "";
              }}
            />

            {restore.phase.state === "ready" ||
            restore.phase.state === "running" ? (
              <>
                <p className="mt-2.5 text-[12px] leading-relaxed tracking-[-0.01em] text-fg-dim">
                  <span className="text-fg">{restore.phase.plan.label}</span>
                  {restore.phase.plan.exportedAt
                    ? `, exportado em ${restore.phase.plan.exportedAt.slice(0, 10)}`
                    : ""}{" "}
                  — {count(restore.phase.plan.totals.projects, "projects")},{" "}
                  {count(restore.phase.plan.totals.chats, "chats")},{" "}
                  {count(restore.phase.plan.totals.messages, "messages")}.
                </p>
                <div className="mt-3 flex items-center gap-2">
                  <button
                    type="button"
                    disabled={restoring}
                    onClick={() => void restoreBackup()}
                    className="pressable inline-flex h-[34px] items-center gap-1.5 rounded-[10px] border border-cyan/40 bg-cyan/10 px-3.5 text-[12.5px] tracking-[-0.01em] text-cyan transition-[background-color] duration-150 ease-out hover:bg-cyan/20 disabled:pointer-events-none disabled:opacity-40"
                  >
                    {restore.phase.state === "running"
                      ? "Restaurando…"
                      : "Restaurar este workspace"}
                  </button>
                  <button
                    type="button"
                    disabled={restoring}
                    onClick={() => backupInput.current?.click()}
                    className="pressable inline-flex h-[34px] items-center rounded-[10px] border border-border px-3.5 text-[12.5px] tracking-[-0.01em] text-fg-dim transition-[border-color,color] duration-150 ease-out hover:border-border-strong hover:text-fg disabled:pointer-events-none disabled:opacity-40"
                  >
                    Outro arquivo
                  </button>
                </div>
              </>
            ) : (
              <>
                <button
                  type="button"
                  disabled={busy !== null || restoring}
                  onClick={() => backupInput.current?.click()}
                  className="pressable mt-3 inline-flex h-[34px] items-center gap-1.5 rounded-[10px] border border-border px-3.5 text-[12.5px] tracking-[-0.01em] text-fg-dim transition-[border-color,color] duration-150 ease-out hover:border-border-strong hover:text-fg disabled:pointer-events-none disabled:opacity-40"
                >
                  {restore.phase.state === "reading"
                    ? "Lendo…"
                    : "Escolher arquivo de backup"}
                </button>
                {restore.phase.state === "error" ? (
                  <p className="mt-2 flex items-start gap-1.5 text-[11.5px] leading-relaxed text-red">
                    <Icon
                      icon={Alert02Icon}
                      size={13}
                      strokeWidth={1.75}
                      className="mt-px shrink-0"
                    />
                    {restore.phase.message}
                  </p>
                ) : null}
              </>
            )}
          </Option>
        </div>

        {error ? (
          <p className="mt-4 flex items-start gap-1.5 text-left text-[11.5px] leading-relaxed text-red">
            <Icon
              icon={Alert02Icon}
              size={13}
              strokeWidth={1.75}
              className="mt-px shrink-0"
            />
            Setup could not finish — {error}. Nothing was changed; try again.
          </p>
        ) : null}

        {/*
          Three ways in, and still no "skip". What the three have in common is
          the only thing this screen actually requires: each of them ends in a
          `seed`, and writing that marker is what makes the workspace saveable
          at all. A user who got past here without choosing would type into an
          app that silently persists nothing — which is why "restore" earns a
          card and "decide later" does not.
        */}
        <p className="mt-6 text-[11.5px] leading-relaxed text-fg-faint">
          You will need a model next. Atimo takes an OpenRouter or Z.AI key,
          or runs the Claude Code or Codex CLI you are already signed in to.
        </p>
      </motion.div>
    </div>
  );
}

function Option({
  icon,
  title,
  body,
  children,
}: {
  icon: IconSvgElement;
  title: string;
  body: string;
  children: ReactNode;
}) {
  return (
    <div
      className={cn(
        "rounded-[14px] border border-border bg-bg-raised px-4 py-3.5",
        "transition-[border-color] duration-150 ease-out hover:border-border-strong",
      )}
    >
      <div className="flex items-center gap-2">
        <Icon icon={icon} size={14} strokeWidth={1.75} className="text-fg-faint" />
        <h2 className="text-[13.5px] font-medium tracking-[-0.015em] text-fg">
          {title}
        </h2>
      </div>
      <p className="mt-1.5 text-[12.5px] leading-relaxed tracking-[-0.01em] text-fg-dim">
        {body}
      </p>
      {children}
    </div>
  );
}
