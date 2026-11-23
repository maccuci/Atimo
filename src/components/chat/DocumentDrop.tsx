import { useCallback, useEffect, useRef, useState } from "react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import {
  Add01Icon,
  Attachment01Icon,
  Cancel01Icon,
  CheckmarkCircle02Icon,
  File01Icon,
} from "@hugeicons/core-free-icons";
import { Icon } from "@/components/ui/Icon";
import { ACCEPT_ATTRIBUTE, isReadable } from "@/lib/documents";
import { ATTACH_ACCEPT, isAttachable } from "@/lib/attachments";
import { useStore } from "@/lib/store";
import { cn, formatTokens } from "@/lib/utils";
import type { Document } from "@/lib/types";

/*
 * Getting a file into a chat.
 *
 * Three ways in, because people reach for different ones and none of them is
 * discoverable from the other two: drag it onto the window, paste it, or click
 * the clip. The clip is the one that teaches the other two exist.
 *
 * Where a file lands is decided by what it *is*, never by which gesture brought
 * it — see `addFiles` in the store. Text becomes searchable project knowledge;
 * a screenshot or a PDF rides with the next prompt. That split is invisible at
 * the drop target on purpose, because it is invisible to the person dropping.
 *
 * Tauri intercepts window drops by default and hands them to Rust, which would
 * mean the webview never sees a `drop` event at all — `dragDropEnabled: false`
 * in `tauri.conf.json` is what turns that off. Without it this component works
 * perfectly in `bun run dev` and silently not at all in the desktop build,
 * which is the sort of difference that gets found late.
 */

/**
 * Drop target for the whole chat surface, not just the composer.
 *
 * People aim at the conversation, not at the input — a drop zone the size of a
 * text field is one people miss and then conclude the feature is broken.
 */
export function DocumentDrop({ children }: { children: React.ReactNode }) {
  const addFiles = useStore((s) => s.addFiles);
  const projectId = useStore((s) => s.projectId);
  const [over, setOver] = useState(false);
  const [busy, setBusy] = useState(false);
  const reduceMotion = useReducedMotion();

  /*
   * Dragenter and dragleave fire for every element the pointer crosses, so a
   * boolean set by them flickers as the cursor moves over the transcript. A
   * counter is the standard fix: only the leave that balances the first enter
   * clears the state.
   */
  const depth = useRef(0);

  const take = useCallback(
    async (files: File[]) => {
      if (!files.length) return;
      setBusy(true);
      const result = await addFiles(files);
      setBusy(false);
      announce(result);
    },
    [addFiles],
  );

  return (
    <div
      className="relative flex min-h-0 min-w-0 flex-1 flex-col"
      onDragEnter={(e) => {
        // Only file drags. Dragging selected text around the app is not an
        // upload, and lighting the whole window up for it is alarming.
        if (!e.dataTransfer.types.includes("Files")) return;
        depth.current += 1;
        setOver(true);
      }}
      onDragOver={(e) => {
        if (!e.dataTransfer.types.includes("Files")) return;
        // Without this the browser navigates to the file and the app is gone.
        e.preventDefault();
        e.dataTransfer.dropEffect = "copy";
      }}
      onDragLeave={() => {
        depth.current = Math.max(0, depth.current - 1);
        if (depth.current === 0) setOver(false);
      }}
      onDrop={(e) => {
        if (!e.dataTransfer.types.includes("Files")) return;
        e.preventDefault();
        depth.current = 0;
        setOver(false);
        void take([...e.dataTransfer.files]);
      }}
    >
      {children}

      <AnimatePresence>
        {over && projectId ? (
          <motion.div
            initial={reduceMotion ? { opacity: 0 } : { opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: reduceMotion ? 0.08 : 0.15 }}
            className="pointer-events-none absolute inset-3 z-30 flex items-center justify-center rounded-[16px] border-2 border-dashed border-cyan/50 bg-bg/80 backdrop-blur-[2px]"
          >
            <div className="text-center">
              <Icon
                icon={File01Icon}
                size={20}
                strokeWidth={1.5}
                className="mx-auto text-cyan"
              />
              <p className="mt-2 text-[13px] tracking-[-0.01em] text-fg">
                Solte os arquivos aqui
              </p>
              {/* Two sentences because two things happen, and which one you get
                  is not a choice the user makes at the drop target. */}
              <p className="mt-1 text-[11.5px] text-fg-faint">
                Texto, código e dados entram no conhecimento do projeto
              </p>
              <p className="text-[11.5px] text-fg-faint">
                Imagens, PDFs e áudio vão com a próxima mensagem
              </p>
            </div>
          </motion.div>
        ) : null}
      </AnimatePresence>

      <AnimatePresence>
        {busy ? (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: reduceMotion ? 0.08 : 0.15 }}
            className="pointer-events-none absolute inset-x-0 top-0 z-30 flex flex-col"
          >
            <div className="h-[2px] overflow-hidden bg-cyan/10">
              <motion.div
                className="h-full w-1/3 bg-cyan/70"
                initial={{ x: "-100%" }}
                animate={{ x: "400%" }}
                transition={{
                  duration: reduceMotion ? 0 : 1.1,
                  ease: "easeInOut",
                  repeat: Infinity,
                }}
              />
            </div>
            <div className="mx-auto mt-2 rounded-full border border-cyan/25 bg-bg-surface/90 px-2.5 py-1 text-[11px] tracking-[-0.01em] text-cyan shadow-[0_1px_8px_rgb(0_0_0/0.12)] backdrop-blur-sm">
              Adding to project knowledge…
            </div>
          </motion.div>
        ) : null}
      </AnimatePresence>
    </div>
  );
}

/**
 * The clip, for the composer's toolbar.
 *
 * Also owns paste, because the two are the same gesture from the user's side —
 * "this file, here" — and pasting a file into a text field otherwise does
 * nothing at all, which reads as the app dropping it.
 */
export function AttachButton({
  variant = "label",
}: {
  /** `circle` matches the composer action row (+); `label` is the text chip. */
  variant?: "label" | "circle";
}) {
  const addFiles = useStore((s) => s.addFiles);
  const view = useStore((s) => s.view);
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);

  const take = useCallback(
    async (files: File[]) => {
      if (!files.length) return;
      setBusy(true);
      setDone(false);
      const result = await addFiles(files);
      setBusy(false);
      announce(result);
      // Only for documents. An attachment confirms itself — its chip is right
      // above the composer — so flashing a tick as well would be the app saying
      // the same thing twice.
      if (result.added.length > 0) {
        setDone(true);
      }
    },
    [addFiles],
  );

  useEffect(() => {
    if (!done) return;
    const timer = setTimeout(() => setDone(false), 1_800);
    return () => clearTimeout(timer);
  }, [done]);

  useEffect(() => {
    // ChatView stays mounted under other views; only steal paste while the
    // conversation is actually on screen.
    if (view !== "chat") return;
    const onPaste = (e: ClipboardEvent) => {
      const files = [...(e.clipboardData?.files ?? [])];
      // Only files this app can actually do something with. A copied screenshot
      // now qualifies — it becomes an attachment — but pasting styled text also
      // puts a `File` on the clipboard in some apps, and swallowing that paste
      // would break pasting text.
      const usable = files.filter(
        (file) => isAttachable(file) || isReadable(file.name),
      );
      if (!usable.length) return;
      e.preventDefault();
      void take(usable);
    };
    document.addEventListener("paste", onPaste);
    return () => document.removeEventListener("paste", onPaste);
  }, [take, view]);

  return (
    <>
      <input
        ref={input}
        type="file"
        multiple
        accept={`${ATTACH_ACCEPT},${ACCEPT_ATTRIBUTE}`}
        className="hidden"
        onChange={(e) => {
          void take([...(e.target.files ?? [])]);
          // Cleared, or picking the same file twice fires no change event.
          e.target.value = "";
        }}
      />
      <button
        type="button"
        disabled={busy}
        title="Anexar arquivo — texto entra no projeto, imagens e PDFs vão com a mensagem"
        aria-label="Anexar arquivo"
        onClick={() => input.current?.click()}
        className={cn(
          "pressable transition-[background-color,border-color,color,transform] duration-150 ease-out",
          "active:scale-[0.97] disabled:opacity-40",
          variant === "circle"
            ? cn(
                "inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-full border",
                done
                  ? "border-cyan/40 bg-cyan/10 text-cyan"
                  : "border-border-strong bg-bg-surface text-fg-dim hover:border-border-strong hover:bg-bg-hover hover:text-fg",
              )
            : cn(
                "inline-flex h-7 items-center gap-1 rounded-lg px-1.5 text-[11px]",
                done
                  ? "bg-cyan/15 text-cyan"
                  : "text-fg-faint hover:bg-bg-hover hover:text-fg",
              ),
        )}
      >
        <Icon
          icon={
            done
              ? CheckmarkCircle02Icon
              : variant === "circle"
                ? Add01Icon
                : Attachment01Icon
          }
          size={variant === "circle" ? 15 : 12}
          strokeWidth={variant === "circle" ? 2 : 1.75}
        />
        {variant === "label"
          ? busy
            ? "Lendo…"
            : done
              ? "Adicionado"
              : "Anexar"
          : null}
      </button>
    </>
  );
}

/**
 * Publish the receipt for this batch.
 *
 * There is no toast system here, and inventing one for this is more surface
 * than the case deserves — but a drop that silently ignores three of five files
 * is worse than one that refuses all five loudly, and a drop that lands with
 * no confirmation is almost as bad as one that failed.
 *
 * Attachments are deliberately not announced. They arrive as chips in the
 * composer, an inch from where the user is looking and with a remove button on
 * each — a banner as well would be the app confirming something already on
 * screen. Documents need one because they land somewhere the user is not
 * looking, in a panel that may be closed.
 */
function announce(result: { added: Document[]; rejected: string[] }) {
  if (result.added.length === 0 && result.rejected.length === 0) return;
  useStore.getState().setDocumentNotice({
    added: result.added.map((doc) => ({ id: doc.id, name: doc.name })),
    rejected: result.rejected,
  });
}

/** The banner those receipts land in. Rendered above the composer. */
export function DocumentNotice() {
  const notice = useStore((s) => s.documentNotice);
  const setNotice = useStore((s) => s.setDocumentNotice);
  const queueDocumentMention = useStore((s) => s.queueDocumentMention);
  const documents = useStore((s) => s.documents);
  const reduceMotion = useReducedMotion();

  useEffect(() => {
    if (!notice) return;
    // Errors hang longer — they need reading. Success is confirmation, not a
    // homework assignment: dismiss once the chip row has been seen.
    const ms = notice.rejected.length > 0 ? 8_000 : 6_000;
    const timer = setTimeout(() => setNotice(null), ms);
    return () => clearTimeout(timer);
  }, [notice, setNotice]);

  const hasAdded = (notice?.added.length ?? 0) > 0;
  const hasRejected = (notice?.rejected.length ?? 0) > 0;

  return (
    <AnimatePresence mode="wait">
      {notice ? (
        <motion.div
          key={`${notice.added.map((d) => d.id).join(",")}-${notice.rejected.join("|")}`}
          initial={
            reduceMotion ? { opacity: 0 } : { opacity: 0, y: 6, scale: 0.98 }
          }
          animate={{ opacity: 1, y: 0, scale: 1 }}
          exit={
            reduceMotion ? { opacity: 0 } : { opacity: 0, y: 4, scale: 0.98 }
          }
          transition={{
            duration: reduceMotion ? 0.1 : 0.2,
            ease: [0.23, 1, 0.32, 1],
          }}
          className={cn(
            "mx-auto mb-2 w-full max-w-[760px] overflow-hidden rounded-[12px] border",
            hasRejected && !hasAdded
              ? "border-red/25 bg-red/5"
              : "border-cyan/25 bg-cyan/5",
          )}
        >
          <div className="flex items-start gap-2.5 px-3 py-2.5">
            <Icon
              icon={
                hasRejected && !hasAdded ? File01Icon : CheckmarkCircle02Icon
              }
              size={14}
              strokeWidth={1.75}
              className={cn(
                "mt-0.5 shrink-0",
                hasRejected && !hasAdded ? "text-red" : "text-cyan",
              )}
            />

            <div className="min-w-0 flex-1">
              {hasAdded ? (
                <>
                  <p className="text-[12.5px] font-medium tracking-[-0.01em] text-fg">
                    {notice.added.length === 1
                      ? "Adicionado ao conhecimento do projeto"
                      : `${notice.added.length} arquivos adicionados ao conhecimento do projeto`}
                  </p>
                  <p className="mt-0.5 text-[11.5px] leading-relaxed text-fg-dim">
                    Clique em um arquivo para usá-lo nesta mensagem, ou deixe —
                    a busca encontra quando for relevante.
                  </p>

                  <div className="mt-2 flex flex-wrap gap-1.5">
                    {notice.added.map((doc) => {
                      const full = documents.find((d) => d.id === doc.id);
                      return (
                        <button
                          key={doc.id}
                          type="button"
                          title={`Inserir @document("${doc.name}")`}
                          onClick={() => {
                            queueDocumentMention(doc.name);
                          }}
                          className="pressable inline-flex max-w-full items-center gap-1.5 rounded-[8px] border border-cyan/30 bg-bg-surface/80 px-2 py-1 text-left transition-[background-color,border-color,transform] duration-150 ease-out hover:border-cyan/50 hover:bg-cyan/10 active:scale-[0.97]"
                        >
                          <Icon
                            icon={File01Icon}
                            size={12}
                            strokeWidth={1.75}
                            className="shrink-0 text-cyan"
                          />
                          <span className="min-w-0 truncate text-[11.5px] font-medium tracking-[-0.01em] text-fg">
                            {doc.name}
                          </span>
                          {full?.tokens ? (
                            <span className="shrink-0 tabular-nums text-[10.5px] text-fg-faint">
                              {formatTokens(full.tokens)}
                            </span>
                          ) : null}
                        </button>
                      );
                    })}
                  </div>
                </>
              ) : null}

              {hasRejected ? (
                <p
                  className={cn(
                    "whitespace-pre-line text-[11.5px] leading-relaxed text-fg-dim",
                    hasAdded && "mt-2 border-t border-red/15 pt-2 text-red/90",
                  )}
                >
                  {notice.rejected.join("\n")}
                </p>
              ) : null}
            </div>

            <button
              type="button"
              aria-label="Fechar"
              onClick={() => setNotice(null)}
              className="pressable -mr-0.5 -mt-0.5 inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-lg text-fg-faint transition-colors duration-150 ease-out hover:bg-bg-hover hover:text-fg"
            >
              <Icon icon={Cancel01Icon} size={12} strokeWidth={2} />
            </button>
          </div>
        </motion.div>
      ) : null}
    </AnimatePresence>
  );
}
