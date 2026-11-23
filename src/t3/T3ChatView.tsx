import { useEffect, useMemo, useRef } from "react";
import { GitForkIcon } from "@hugeicons/core-free-icons";
import { useStore } from "@/lib/store";
import { groupTranscript } from "@/lib/panel";
import { Icon } from "@/components/ui/Icon";
import { Button, Empty } from "@/components/ui/primitives";
import { estimateTokens } from "@/lib/tokens";
import { useEdgeFade } from "@/lib/use-edge-fade";
import { formatTokens } from "@/lib/utils";
import { DocumentDrop, DocumentNotice } from "@/components/chat/DocumentDrop";
import { T3MessageItem } from "./T3MessageItem";
import { T3Composer } from "./T3Composer";
import { PanelTurn } from "@/components/chat/PanelTurn";
import type { Project } from "@/lib/types";

// How close to the bottom still counts as being at the bottom. Fractional
// scroll heights and browser zoom mean the three numbers rarely cancel out
// exactly, so an equality check would drop the follow after one frame.
const BOTTOM_SLACK = 32;

export function T3ChatView() {
  const chats = useStore((s) => s.chats);
  const chatId = useStore((s) => s.chatId);
  const messages = useStore((s) => s.messages);
  const selectChat = useStore((s) => s.selectChat);
  const projects = useStore((s) => s.projects);
  const projectId = useStore((s) => s.projectId);

  const scroller = useRef<HTMLDivElement>(null);
  // Whether the view is following the stream. A ref rather than state: it
  // changes on every scroll event and nothing renders from it, so re-rendering
  // the transcript on each one would only cost frames mid-generation.
  const pinned = useRef(true);
  const chat = chats.find((c) => c.id === chatId);
  const transcript = useMemo(
    () => messages.filter((m) => m.chatId === chatId),
    [messages, chatId],
  );
  // A panel turn is several rows that render as one block. Grouped here so the
  // list below stays a plain map, and memoised because it runs on every frame
  // of a stream — the rows change identity per frame, but nothing else does.
  const entries = useMemo(() => groupTranscript(transcript), [transcript]);
  const project = projects.find((p) => p.id === projectId);

  // How much text the turn at the bottom is holding. Summed across a panel's
  // answers rather than read off the last row: a panel streams several answers
  // at once, and following only the last of them would leave the view frozen
  // while the first one grows past the fold. A number, not the text, so the
  // effect compares primitives.
  const tail = entries.at(-1);
  const tailLength =
    tail?.kind === "panel"
      ? tail.answers.reduce((total, a) => total + a.content.length, 0)
      : (tail?.message.content.length ?? 0);

  // Re-read on every scroll, the user's and this component's alike. The effects
  // below land exactly at the bottom, so their own scroll event sets this back
  // to true — which is what keeps a programmatic scroll from being mistaken for
  // the reader walking away.
  const trackPinned = () => {
    const el = scroller.current;
    if (!el) return;
    pinned.current =
      el.scrollHeight - el.scrollTop - el.clientHeight <= BOTTOM_SLACK;
  };

  // Opening a chat starts at the newest turn, wherever the previous transcript
  // had been left. Separate from the effect below so that switching chats
  // re-arms the follow even if the last one was read from the top.
  useEffect(() => {
    const el = scroller.current;
    if (!el) return;
    pinned.current = true;
    el.scrollTop = el.scrollHeight;
  }, [chatId]);

  // Follow the stream only while the view is still sitting at the bottom.
  // Scrolling up during a generation used to be impossible: this ran on every
  // frame and pulled the view back down under the reader.
  useEffect(() => {
    const el = scroller.current;
    if (!el || !pinned.current) return;
    el.scrollTop = el.scrollHeight;
  }, [entries.length, tailLength]);

  /*
   * Symmetric bands, unlike the reference: their transcript scrolls *under*
   * translucent chrome, so each band has to be as deep as whatever it slides
   * beneath or text ghosts through it. Ours meets an opaque bordered header and
   * an opaque composer, and the fade is only saying "this continues" — a band
   * sized to chrome it never touches would just be a wider fade.
   */
  useEdgeFade(scroller);

  if (!chat) return <NoChat />;

  const source = chat.forkedFrom
    ? chats.find((c) => c.id === chat.forkedFrom!.chatId)
    : null;

  return (
    <DocumentDrop>
      <div className="flex min-h-0 min-w-0 flex-1 flex-col bg-bg">
      {source ? (
        <div className="shrink-0 border-b border-border bg-bg px-4 py-1.5 text-center">
          <button
            type="button"
            onClick={() => selectChat(source.id)}
            className="inline-flex items-center gap-1.5 text-[11px] text-fg-faint transition-colors duration-150 ease-out hover:text-fg-dim"
          >
            <Icon icon={GitForkIcon} size={10} strokeWidth={1.75} />
            Forked from {source.title}
          </button>
        </div>
      ) : null}

      <div
        ref={scroller}
        onScroll={trackPinned}
        className="scroll-thin edge-fade min-h-0 flex-1 overflow-y-auto"
      >
        {transcript.length === 0 ? (
          <EmptyChat project={project} />
        ) : (
          <div className="mx-auto w-full max-w-[46rem] px-4 pt-5 pb-10 md:px-6">
            {entries.map((entry, i) => {
              // Only the last turn can be run again — re-running an earlier one
              // would have to discard the turns that replied to it. The
              // transcript is already filtered to this chat here, so the check
              // is an index compare rather than a scan per message.
              const isLast = i === entries.length - 1;

              return entry.kind === "panel" ? (
                <PanelTurn
                  key={entry.key}
                  answers={entry.answers}
                  isLast={isLast}
                />
              ) : (
                <T3MessageItem
                  key={entry.key}
                  message={entry.message}
                  isLast={isLast}
                />
              );
            })}
          </div>
        )}
      </div>

        <div className="shrink-0 px-3 md:px-5">
          <DocumentNotice />
        </div>
        <T3Composer />
      </div>
    </DocumentDrop>
  );
}

/**
 * No chat selected — which since projects became creatable is usually a project
 * that has none yet, not a stale selection.
 *
 * A freshly created project lands here, so this is the first thing its author
 * sees: it confirms the brief was saved and offers the one action that makes
 * sense next, rather than telling them to pick from a Recents list that is empty.
 */
function NoChat() {
  const projects = useStore((s) => s.projects);
  const projectId = useStore((s) => s.projectId);
  const newChat = useStore((s) => s.newChat);
  const setProjectSheet = useStore((s) => s.setProjectSheet);
  const hasChats = useStore((s) =>
    s.chats.some((c) => c.projectId === s.projectId),
  );

  const project = projects.find((p) => p.id === projectId);

  if (!project) {
    return (
      <Empty>
        Nenhum projeto aberto. Crie um pela barra lateral — o projeto guarda o
        contexto de onde todo chat dele começa.
      </Empty>
    );
  }

  const brief = project.instructions.trim();

  return (
    <div className="flex h-full min-w-0 flex-1 flex-col items-center justify-center px-8 text-center">
      <div className="stagger-in max-w-md">
        <p className="text-[15px] font-medium tracking-[-0.02em] text-fg">
          {hasChats ? `Escolha um chat em ${project.name}` : `${project.name} está pronto`}
        </p>
        <p className="mt-2 text-[13px] leading-relaxed text-fg-dim">
          {brief ? (
            <>
              Todo chat aqui começa com{" "}
              <span className="text-fg">
                {formatTokens(estimateTokens(brief))} tokens de contexto base
              </span>
              , em qualquer modelo.
            </>
          ) : (
            <>
              Dê a ele um contexto base e todo chat aqui — em qualquer modelo —
              começa do mesmo ponto.
            </>
          )}
        </p>

        <div className="mt-5 flex items-center justify-center gap-2">
          <Button variant="accent" onClick={() => newChat()}>
            Novo chat
          </Button>
          <Button
            variant="outline"
            onClick={() => setProjectSheet(project.id)}
          >
            {brief ? "Editar contexto base" : "Adicionar contexto base"}
          </Button>
        </div>
      </div>
    </div>
  );
}

function EmptyChat({ project }: { project?: Project }) {
  const setProjectSheet = useStore((s) => s.setProjectSheet);
  const brief = project?.instructions.trim();

  return (
    <div className="flex h-full flex-col items-center justify-center px-6 py-10">
      <div className="stagger-in w-full max-w-[30rem]">
        <h1 className="text-center text-[22px] font-semibold tracking-[-0.03em] text-fg">
          {project?.name ?? "Novo chat"}
        </h1>

        <div className="mt-6 overflow-hidden rounded-[14px] border border-border bg-bg-surface">
          <button
            type="button"
            onClick={() => project && setProjectSheet(project.id)}
            disabled={!project}
            className="pressable flex w-full items-center gap-3 px-4 py-3 text-left transition-colors duration-150 ease-out hover:bg-bg-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent"
          >
            <span className="min-w-0 flex-1">
              <span className="block text-[13px] font-medium text-fg">
                {brief ? "Contexto base" : "Adicionar contexto base"}
              </span>
              <span className="mt-0.5 block text-[12px] leading-snug text-fg-dim">
                {brief
                  ? `${formatTokens(estimateTokens(brief))} tokens enviados com todo chat deste projeto, em qualquer modelo.`
                  : "Objetivos, stack, convenções — escritos uma vez, enviados com todo chat daqui."}
              </span>
            </span>
            <span className="shrink-0 text-[12px] text-fg-faint">{brief ? "Editar" : "Adicionar"}</span>
          </button>

          <div className="border-t border-border px-4 py-3">
            <span className="block text-[13px] font-medium text-fg">Traga trabalho anterior</span>
            <span className="mt-0.5 block text-[12px] leading-snug text-fg-dim">
              Digite <span className="text-cyan">@</span> na mensagem para anexar um chat ou arquivo
              em vez de colar o conteúdo.
            </span>
            <div className="mt-2.5 flex flex-wrap gap-1.5">
              {['@chat("Arquitetura")', '@document("schema.sql")'].map((mention) => (
                <span
                  key={mention}
                  className="inline-flex h-6 items-center rounded-full border border-cyan/30 bg-cyan/10 px-2.5 font-mono text-[11px] text-cyan"
                >
                  {mention}
                </span>
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
