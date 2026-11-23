import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  ArrowUp01Icon,
  Cancel01Icon,
  File01Icon,
  StopIcon,
} from "@hugeicons/core-free-icons";
import { ResearchControls } from "@/components/chat/ResearchControls";
import { AttachButton } from "@/components/chat/DocumentDrop";
import { AttachmentTray } from "@/components/chat/AttachmentTray";
import { useStore } from "@/lib/store";
import { attachmentGuard } from "@/lib/attachments";
import { extensionOf } from "@/lib/documents";
import {
  formatReference,
  parsePartial,
  parseReferences,
  suggest,
} from "@/lib/references";
import {
  costOf,
  referenceCost,
  resolveReference,
  type ResolvedReference,
} from "@/lib/reference-resolver";
import { compose } from "@/lib/context-composer";
import { primeQuery, subscribeEmbeddings } from "@/lib/embeddings";
import { SmartSearchNotice } from "./SmartSearch";
import { activeSkills } from "@/lib/skills";
import { getModel } from "@/lib/models";
import { providerUi } from "@/lib/provider-ui";
import {
  cn,
  describeReferenceCost,
  formatShare,
  formatTokens,
} from "@/lib/utils";
import { Icon } from "@/components/ui/Icon";
import { ContextUsageTrigger } from "@/components/chat/ContextUsagePanel";
import { ModelPicker } from "@/components/chat/ModelPicker";
import { PanelPicker } from "@/components/chat/PanelPicker";
import { KIND_OPTIONS, ReferencePopup } from "@/components/chat/ReferencePopup";
import { EditorContent, useEditor, type Editor } from "@tiptap/react";
import Document from "@tiptap/extension-document";
import Paragraph from "@tiptap/extension-paragraph";
import Text from "@tiptap/extension-text";
import HardBreak from "@tiptap/extension-hard-break";
import { Placeholder, UndoRedo } from "@tiptap/extensions";
import {
  ELEVATED_KIND,
  Mention,
  bindTypedReferences,
  canonicalOffset,
  fromCanonical,
  joinPrompt,
  partialRange,
  serialize,
} from "@/components/chat/composer-editor";
import type { DocumentKind, ReferenceKind, Referenceable } from "@/lib/types";

const DOC_KIND_LABEL: Record<DocumentKind, string> = {
  markdown: "Markdown",
  text: "Documento de texto",
  code: "Code",
  data: "Data",
  pdf: "PDF",
};

const EXT_KIND: Record<string, DocumentKind> = {
  md: "markdown",
  markdown: "markdown",
  mdx: "markdown",
  txt: "text",
  text: "text",
  rst: "text",
  log: "text",
  csv: "data",
  tsv: "data",
  json: "data",
  jsonl: "data",
  yaml: "data",
  yml: "data",
  toml: "data",
  ini: "data",
  env: "data",
  pdf: "pdf",
};

function documentKindLabel(name: string): string {
  const ext = extensionOf(name);
  const kind = EXT_KIND[ext] ?? (ext ? "code" : "text");
  return DOC_KIND_LABEL[kind];
}

/*
 * The composer.
 *
 * A ProseMirror (TipTap) field where bound mentions are atomic inline chips,
 * so selection, undo, deletion and wrapping behave like prose. The canonical
 * `@kind("…")` string is derived for send, compose, and @-autocomplete — see
 * `composer-editor.tsx`.
 */

/**
 * In-progress drafts keyed by chat.
 *
 * Module scope on purpose: the composer remounts when ChatView does, and a
 * ref would forget what was being typed in the chat you just left. Not
 * persisted — a draft is a thought in progress, not project knowledge.
 */
const draftsByChat = new Map<string, string>();

function loadDraft(chatId: string) {
  return fromCanonical(draftsByChat.get(chatId) ?? "");
}

const PLACEHOLDER =
  "Pergunte qualquer coisa — @ para citar conhecimento, ⌘K para comandos";

function rememberDraft(chatId: string, canonical: string) {
  if (canonical.trim()) draftsByChat.set(chatId, canonical);
  else draftsByChat.delete(chatId);
}

export function T3Composer() {
  const chats = useStore((s) => s.chats);
  const chatId = useStore((s) => s.chatId);
  const projectId = useStore((s) => s.projectId);
  const sending = useStore((s) => s.sending);
  const send = useStore((s) => s.send);
  const skillModes = useStore((s) => s.skills);
  const connected = useStore((s) => s.connection.status === "connected");
  const setConnectOpen = useStore((s) => s.setConnectOpen);
  const stopStreaming = useStore((s) => s.stopStreaming);
  const setComposerDraft = useStore((s) => s.setComposerDraft);
  const documentMentionQueue = useStore((s) => s.documentMentionQueue);
  const clearDocumentMentionQueue = useStore(
    (s) => s.clearDocumentMentionQueue,
  );
  const staged = useStore((s) => s.composerAttachments);
  const attachmentBlobs = useStore((s) => s.attachmentBlobs);
  const removeAttachment = useStore((s) => s.removeAttachment);
  const provider = useStore((s) => s.connection.provider);

  const messages = useStore((s) => s.messages);

  const chat = chats.find((c) => c.id === chatId);
  // The model every cost on this screen is priced against — kept primitive so
  // the memos below don't re-run when an unrelated field of the chat changes.
  const modelId = chat?.modelId;

  const [initial] = useState(() => loadDraft(chatId));
  /** Canonical text of the editor alone; `value` adds the document cards. */
  const [text, setText] = useState("");
  /** Canonical caret inside `text`. */
  const [globalCaret, setCaret] = useState(0);
  const [docs, setDocs] = useState<string[]>(initial.docs);
  const [active, setActive] = useState(0);
  const [dismissed, setDismissed] = useState(false);

  const value = useMemo(() => joinPrompt(text, docs), [text, docs]);

  const addDocs = useCallback((names: string[]) => {
    // Naming the same file twice should not stack duplicate cards.
    setDocs((prev) => [...prev, ...names.filter((n, i) => !prev.includes(n) && names.indexOf(n) === i)]);
  }, []);

  /* -- the editor -------------------------------------------------------- */

  // Handlers change every render; the editor is built once, so it reads them
  // through refs.
  const keyRef = useRef<(e: KeyboardEvent) => boolean>(() => false);
  const describeRef = useRef<(kind: ReferenceKind, label: string) => string>(
    (kind, label) => formatReference(kind, label),
  );

  const editor = useEditor({
    extensions: [
      Document,
      Paragraph,
      Text,
      HardBreak,
      UndoRedo,
      Placeholder.configure({ placeholder: PLACEHOLDER }),
      Mention.configure({ describe: (k, l) => describeRef.current(k, l) }),
    ],
    content: initial.content,
    autofocus: "end",
    shouldRerenderOnTransaction: false,
    editorProps: {
      attributes: {
        class:
          "composer-editor min-h-[21px] w-full whitespace-pre-wrap wrap-anywhere text-[15px] leading-[1.55] tracking-[-0.011em] text-fg outline-none",
        "aria-label": "Mensagem",
      },
      handleKeyDown: (_view, event) => keyRef.current(event),
    },
    onCreate: ({ editor }) => sync(editor),
    onUpdate: ({ editor }) => {
      const lifted = bindTypedReferences(editor);
      if (lifted.length) addDocs(lifted);
      sync(editor);
      setDismissed(false);
    },
    onSelectionUpdate: ({ editor }) => {
      sync(editor);
      setDismissed(false);
    },
  });

  function sync(ed: Editor) {
    const { doc, selection } = ed.state;
    setText(serialize(doc));
    setCaret(canonicalOffset(doc, selection.from));
  }

  const chatIdRef = useRef(chatId);
  const valueRef = useRef(value);
  valueRef.current = value;

  // Swap the draft when the open chat changes — each conversation keeps its
  // own in-progress text instead of leaking the previous chat's prompt into a
  // brand-new Untitled.
  useEffect(() => {
    const prev = chatIdRef.current;
    if (prev === chatId) return;
    rememberDraft(prev, valueRef.current);
    const next = loadDraft(chatId);
    setDocs(next.docs);
    editor?.chain().setContent(next.content).focus("end").run();
    setDismissed(false);
    chatIdRef.current = chatId;
  }, [chatId, editor]);

  // Persist the open draft on unmount so Projects → back does not forget it.
  useEffect(() => {
    return () => {
      rememberDraft(chatIdRef.current, valueRef.current);
      setComposerDraft("");
    };
  }, [setComposerDraft]);

  useEffect(() => {
    setComposerDraft(value);
  }, [value, setComposerDraft]);

  /* -- pull just-attached files into the draft as @document chips --------- */

  useEffect(() => {
    if (documentMentionQueue.length === 0) return;
    const names = [...documentMentionQueue];
    clearDocumentMentionQueue();
    addDocs(names);
    setDismissed(false);
  }, [documentMentionQueue, clearDocumentMentionQueue, addDocs]);

  /* -- reference state -------------------------------------------------- */

  const refs = useMemo(() => parseReferences(value), [value]);
  const partial = useMemo(
    () => (dismissed ? null : parsePartial(text, globalCaret)),
    [text, globalCaret, dismissed],
  );

  const suggestions: Referenceable[] = useMemo(
    () => (partial?.open && partial.kind ? suggest(partial, projectId) : []),
    [partial, projectId],
  );

  /*
   * What each candidate would cost this chat's model, priced with the same
   * resolver the Context Composer runs on send. Shown in the popup because the
   * decision to pull a chat in is made before the chip exists — and because a
   * reference is exempt from the retrieval budget, so an expensive one silently
   * evicts project knowledge instead of being trimmed itself.
   */
  const suggestionCosts = useMemo(
    () =>
      modelId
        ? suggestions.map((item) =>
            referenceCost(item.kind, item.label, projectId, modelId),
          )
        : [],
    [suggestions, projectId, modelId],
  );

  const kindOptions = useMemo(() => {
    if (!partial || partial.open) return [];
    const q = (partial.kind ?? partial.query).toLowerCase();
    return KIND_OPTIONS.filter((o) => o.kind.startsWith(q));
  }, [partial]);

  const mode: "kind" | "target" | null = !partial
    ? null
    : partial.open && partial.kind
      ? "target"
      : kindOptions.length > 0
        ? "kind"
        : null;

  const optionCount = mode === "kind" ? kindOptions.length : suggestions.length;

  useEffect(() => setActive(0), [mode, partial?.query, partial?.kind]);

  /* -- context preview --------------------------------------------------- */

  const [preview, setPreview] = useState<{
    chunks: number;
    tokens: number;
    skills: string[];
  } | null>(null);

  const skills = useMemo(() => activeSkills(skillModes), [skillModes]);

  /** Bumped when a query vector lands, so the preview recomputes with it. */
  const [embedded, setEmbedded] = useState(0);
  useEffect(() => subscribeEmbeddings(() => setEmbedded((n) => n + 1)), []);

  // Composed against this chat's transcript, not the draft alone: mentions made
  // earlier in the conversation come back through the pipeline, and the preview
  // has to count what will actually be sent.
  const history = useMemo(
    () => messages.filter((m) => m.chatId === chatId),
    [messages, chatId],
  );

  useEffect(() => {
    if (!modelId || !value.trim()) {
      setPreview(null);
      return;
    }
    const timer = setTimeout(() => {
      // Warmed on the debounce this preview already has. `compose` reads the
      // vector synchronously, so the first pass is lexical-only by construction
      // and `embedded` below brings it back once the vector lands — without
      // that, the chunk count under the composer would describe a composition
      // the send path is not going to make.
      primeQuery(value);

      const result = compose(value, projectId, modelId, skills, history);
      const included = result.chunks.filter((c) => c.included);
      setPreview({
        chunks: included.length,
        tokens: result.finalTokens,
        skills: included
          .filter((c) => c.kind === "skill" && c.id !== "skill-catalog")
          .map((c) => c.label),
      });
    }, 180);
    return () => clearTimeout(timer);
  }, [value, projectId, modelId, skills, history, embedded]);

  /* -- what the mentions already in the draft cost ----------------------- */

  /**
   * The bound mentions, summed. Deduped by resolved entity so naming the same
   * chat twice is counted once, matching what the pipeline actually injects.
   * Undebounced: resolution is a memoized lookup, and the number has to move
   * with the chip the user just inserted.
   */
  const mentioned = useMemo(() => {
    if (!modelId) return null;

    const byEntity = new Map<string, ResolvedReference>();
    for (const ref of refs) {
      if (!ref.entityId) continue;
      const resolved = resolveReference(ref.kind, ref.target, projectId);
      if (resolved) byEntity.set(resolved.id, resolved);
    }
    if (byEntity.size === 0) return null;

    let tokens = 0;
    let fullTokens = 0;
    for (const resolved of byEntity.values()) {
      tokens += resolved.tokens;
      fullTokens += resolved.fullTokens;
    }

    return { count: byEntity.size, cost: costOf(tokens, modelId, fullTokens) };
  }, [refs, projectId, modelId]);

  const describeMention = useCallback(
    (kind: ReferenceKind, label: string) => {
      const canonical = formatReference(kind, label);
      if (!modelId) return canonical;
      const cost = referenceCost(kind, label, projectId, modelId);
      return cost
        ? `${canonical} — ${describeReferenceCost(cost)}`
        : canonical;
    },
    [projectId, modelId],
  );
  describeRef.current = describeMention;

  /* -- completion -------------------------------------------------------- */

  const applyCompletion = useCallback(
    (index: number) => {
      if (!partial || !editor) return;
      const range = partialRange(editor, partial.start, globalCaret);
      setDismissed(false);

      if (mode === "kind") {
        const option = kindOptions[index];
        if (!option) return;
        editor
          .chain()
          .focus()
          .insertContentAt(range, { type: "text", text: `@${option.kind}("` })
          .run();
        return;
      }

      const item = suggestions[index];
      if (!item) return;
      if (item.kind === ELEVATED_KIND) {
        editor.chain().focus().deleteRange(range).run();
        addDocs([item.label]);
        return;
      }
      // Trailing space so the next `@` can open autocomplete (`@` glued to a
      // chip is rejected by parsePartial) and chips stay visually separated.
      const { doc } = editor.state;
      const next = doc.textBetween(range.to, Math.min(range.to + 1, doc.content.size), "\n", "\uFFFC");
      editor
        .chain()
        .focus()
        .insertContentAt(range, [
          { type: "mention", attrs: { kind: item.kind, label: item.label } },
          ...(/^\s/.test(next) ? [] : [{ type: "text", text: " " }]),
        ])
        .run();
    },
    [partial, editor, globalCaret, mode, kindOptions, suggestions, addDocs],
  );

  /*
   * Whether these files can go to the models that will answer.
   *
   * Every model of the turn, not just the primary — a panel sends one prompt to
   * all of them, and a member that cannot see the image would answer about a
   * picture it was never shown, next to answers that did see it.
   *
   * Checked here rather than only at send so the refusal is legible while there
   * is still something to do about it: the model picker and the remove buttons
   * are both in view, and both are a fix.
   */
  const refusal = useMemo(() => {
    // Silent until a key is connected. Before that the catalog is the seed
    // lineup, which carries no modality flags at all — so every model would
    // read as unable to see an image, and the button whose job is to open the
    // connect sheet would be the one this disabled.
    if (!chat || !staged.length || !connected) return null;
    const answering = [chat.modelId, ...(chat.panel ?? [])].map(getModel);
    return attachmentGuard(staged, provider, answering);
  }, [staged, provider, chat, connected]);

  const submit = useCallback(() => {
    const prompt = value.trim();
    if (!prompt || sending || refusal) return;
    if (!connected) {
      setConnectOpen(true);
      return;
    }
    draftsByChat.delete(chatId);
    editor?.commands.clearContent(true);
    setDocs([]);
    setDismissed(false);
    void send(prompt);
  }, [value, sending, refusal, connected, setConnectOpen, send, chatId, editor]);

  keyRef.current = (e) => {
    if (e.isComposing) return false;
    if (mode && optionCount > 0) {
      if (e.key === "ArrowDown") {
        setActive((i) => (i + 1) % optionCount);
        return true;
      }
      if (e.key === "ArrowUp") {
        setActive((i) => (i - 1 + optionCount) % optionCount);
        return true;
      }
      if (e.key === "Tab" || (e.key === "Enter" && !e.shiftKey)) {
        applyCompletion(active);
        return true;
      }
      if (e.key === "Escape") {
        setDismissed(true);
        return true;
      }
    }
    if (e.key === "Enter" && !e.shiftKey) {
      submit();
      return true;
    }
    return false;
  };

  if (!chat) return null;

  const unresolved = refs.filter((r) => !r.entityId).length;
  const model = getModel(chat.modelId);
  const modelUi = providerUi(model.provider);
  const canSend = Boolean(value.trim()) && !sending && !refusal;

  return (
    <div className="shrink-0 px-3 pb-[max(0.75rem,var(--safe-bottom))] md:px-6 md:pb-5">
      <SmartSearchNotice />
      <div className="t3-composer-shell relative mx-auto max-w-[760px]">
        {mode && (
          <ReferencePopup
            mode={mode}
            kinds={kindOptions}
            items={suggestions}
            costs={suggestionCosts}
            active={active}
            onPick={applyCompletion}
            onHover={setActive}
          />
        )}

        {/* Files riding with this prompt, above the project documents it names.
            Two different things that both look like "a file on this turn": one
            is bytes the model will read, the other is a pointer into knowledge
            the project already holds. */}
        <AttachmentTray
          attachments={staged}
          blobs={attachmentBlobs}
          onRemove={removeAttachment}
          refusal={refusal}
        />

        {docs.length > 0 ? (
          <div
            className={cn(
              "flex flex-wrap gap-2 px-4",
              staged.length > 0 ? "pt-3" : "pt-4",
            )}
          >
            {docs.map((name) => (
              <AttachmentCard
                key={name}
                name={name}
                title={describeMention(ELEVATED_KIND, name)}
                onRemove={() => setDocs((prev) => prev.filter((d) => d !== name))}
              />
            ))}
          </div>
        ) : null}

        <div
          className={cn(
            "scroll-thin max-h-[40vh] cursor-text overflow-y-auto px-4 pb-1",
            docs.length > 0 || staged.length > 0 ? "pt-3" : "pt-4",
          )}
          onMouseDown={(e) => {
            // Padding around the text still means "type here".
            if (e.target !== e.currentTarget) return;
            e.preventDefault();
            editor?.commands.focus("end");
          }}
        >
          <EditorContent editor={editor} />
        </div>

        <div className="flex items-end gap-1.5 px-3 pt-2 pb-3">
          {/* Controls may wrap; send stays pinned bottom-right. */}
          <div className="flex min-w-0 flex-1 flex-wrap items-center gap-1.5">
          <AttachButton variant="circle" />

          <ResearchControls />

          <PanelPicker
            chatId={chat.id}
            modelId={chat.modelId}
            panel={chat.panel}
          />

          {preview && preview.skills.length > 0 ? (
            <span
              className="hidden h-7 max-w-[140px] truncate rounded-full border border-magenta/25 bg-magenta/10 px-2.5 text-[11px] font-medium tracking-[-0.01em] text-magenta sm:inline-flex sm:items-center"
              title={`Ativas neste turno: ${preview.skills.join(", ")}`}
            >
              {preview.skills.length === 1
                ? preview.skills[0]
                : `${preview.skills.length} skills`}
            </span>
          ) : null}

          {/* The count is already visible as chips in the field; only a miss needs saying. */}
          {unresolved > 0 ? (
            <span className="hidden h-7 items-center rounded-full border border-border px-2.5 text-[11px] tracking-[-0.01em] text-fg-dim sm:inline-flex">
              {unresolved} não encontrada{unresolved === 1 ? "" : "s"}
            </span>
          ) : null}

          {mentioned ? (
            <span
              title={`${mentioned.count} ${
                mentioned.count === 1 ? "referência" : "referências"
              } · ${describeReferenceCost(mentioned.cost)}`}
              className={cn(
                "hidden h-7 items-center rounded-full border border-border px-2.5 text-[11px] tabular-nums tracking-[-0.01em] sm:inline-flex",
                mentioned.cost.budgetShare >= 1 ? "text-red" : "text-fg-dim",
              )}
            >
              +{formatTokens(mentioned.cost.tokens)}
              <span className="text-fg-faint">
                {" "}
                · {formatShare(mentioned.cost.share)}
              </span>
            </span>
          ) : null}

          <ContextUsageTrigger className="hidden sm:inline-flex" />

          <ModelPicker
            chatId={chat.id}
            modelId={chat.modelId}
            triggerClassName="h-8 rounded-full border border-border bg-transparent px-2.5 text-[12px] font-medium text-fg-dim hover:border-border-strong hover:text-fg"
            trigger={
              <span className="flex items-center gap-1.5">
                <Icon
                  icon={modelUi.icon}
                  size={14}
                  color={modelUi.color}
                  strokeWidth={1.5}
                />
                <span className="max-w-[160px] truncate">{model.label}</span>
              </span>
            }
          />

          </div>

          {sending ? (
            <button
              type="button"
              onClick={stopStreaming}
              className="pressable flex h-8 w-8 items-center justify-center rounded-full bg-bg-active text-fg-dim transition-[background-color,color] duration-150 ease-out hover:text-fg"
              aria-label="Parar"
            >
              <Icon icon={StopIcon} size={13} strokeWidth={2.25} />
            </button>
          ) : (
            <button
              type="button"
              onClick={submit}
              disabled={!value.trim() || Boolean(refusal)}
              // The tray already says why in a sentence; this is for the pointer
              // that lands on a dead button without having read it.
              title={refusal ?? undefined}
              aria-label={connected ? "Enviar" : "Conectar"}
              className={cn(
                "pressable flex h-8 w-8 shrink-0 items-center justify-center rounded-full transition-[background-color,color,transform] duration-150 ease-out",
                canSend
                  ? connected
                    ? "bg-fg text-bg hover:opacity-90"
                    : "bg-cyan text-white hover:opacity-90"
                  : "bg-bg-active text-fg-faint",
              )}
            >
              <Icon icon={ArrowUp01Icon} size={16} strokeWidth={2.25} />
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

function AttachmentCard({
  name,
  title,
  onRemove,
}: {
  name: string;
  title?: string;
  onRemove: () => void;
}) {
  return (
    <div
      title={title}
      className="relative flex max-w-[240px] items-center gap-2.5 rounded-[14px] border border-border bg-bg-surface py-2 pr-2.5 pl-2"
    >
      <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-[10px] bg-cyan text-white">
        <Icon icon={File01Icon} size={16} strokeWidth={1.75} />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[13px] font-medium tracking-[-0.01em] text-fg">
          {name}
        </span>
        <span className="block truncate text-[11px] tracking-[-0.01em] text-fg-faint">
          {documentKindLabel(name)}
        </span>
      </span>
      <button
        type="button"
        onClick={onRemove}
        aria-label={`Remover ${name}`}
        className="pressable absolute -top-1.5 -right-1.5 flex h-5 w-5 items-center justify-center rounded-full border border-border bg-bg-raised text-fg-dim transition-colors duration-150 ease-out hover:text-fg"
      >
        <Icon icon={Cancel01Icon} size={10} strokeWidth={2.25} />
      </button>
    </div>
  );
}
