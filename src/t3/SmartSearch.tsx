import { useEffect, useState } from "react";
import { SearchIcon } from "@hugeicons/core-free-icons";
import { Icon } from "@/components/ui/Icon";
import {
  declineEmbeddings,
  disableEmbeddings,
  downloadEmbeddings,
  embeddingConsent,
  embeddingStatus,
  subscribeEmbeddings,
} from "@/lib/embeddings";
import { useStore } from "@/lib/store";
import { reindexProject } from "@/lib/vectors";

/*
 * The local search model is ~1.1GB, so it is downloaded only after the user
 * says yes. Until then search matches words; nothing else changes.
 */

/** Re-render on every model state change (and on consent, which notifies too). */
function useSmartSearch() {
  const [, tick] = useState(0);
  useEffect(() => subscribeEmbeddings(() => tick((n) => n + 1)), []);
  return { status: embeddingStatus(), consent: embeddingConsent() };
}

function startDownload() {
  void downloadEmbeddings().then((status) => {
    if (status.state === "ready") void reindexProject(useStore.getState().projectId);
  });
}

/** First-run ask, above the composer. Gone once answered either way. */
export function SmartSearchNotice() {
  const { status, consent } = useSmartSearch();
  // `downloaded` is only set by the desktop app, so the browser build never asks.
  if (status.downloaded !== false) return null;

  if (status.state === "loading") {
    return (
      <Notice>
        <span className="h-1.5 w-1.5 shrink-0 animate-pulse rounded-full bg-accent" />
        <span className="min-w-0 flex-1">
          Baixando o modelo de busca (1,1 GB). Até terminar, a busca compara só palavras.
        </span>
      </Notice>
    );
  }

  if (status.state === "failed") {
    return (
      <Notice>
        <span className="min-w-0 flex-1 text-red">{status.error ?? "Não foi possível baixar o modelo de busca."}</span>
        <NoticeButton primary onClick={startDownload}>Tentar de novo</NoticeButton>
      </Notice>
    );
  }

  if (consent !== null) return null;

  return (
    <Notice>
      <Icon icon={SearchIcon} size={13} strokeWidth={1.75} className="shrink-0 text-fg-faint" />
      <span className="min-w-0 flex-1">
        A busca inteligente encontra chats e documentos pelo sentido, não só pelas palavras.
        Ela usa um modelo local (1,1 GB, baixado uma vez).
      </span>
      <NoticeButton onClick={declineEmbeddings}>Agora não</NoticeButton>
      <NoticeButton primary onClick={startDownload}>Baixar</NoticeButton>
    </Notice>
  );
}

/** State and the one action for the on/off control, shared by menu and settings. */
export function useSmartSearchToggle() {
  const { status } = useSmartSearch();
  const hidden = status.downloaded === undefined && status.state !== "ready";
  const on = status.state === "ready";
  const detail = on
    ? "Ligada"
    : status.state === "loading"
      ? "Baixando…"
      : status.state === "failed"
        ? "Falhou — tentar de novo"
        : status.downloaded
          ? "Desligada"
          : "Desligada — baixar";
  const title = on
    ? "Desligar: a busca volta a comparar só palavras"
    : status.downloaded
      ? "Ligar a busca por sentido"
      : "Baixar o modelo de busca local (1,1 GB)";
  // Loading has nothing to toggle yet; everything else flips.
  const toggle = on ? disableEmbeddings : status.state === "loading" ? () => {} : startDownload;
  return { hidden, on, loading: status.state === "loading", detail, title, toggle };
}

function Notice({ children }: { children: React.ReactNode }) {
  return (
    <div className="mx-auto mb-2 flex max-w-[760px] items-center gap-2.5 rounded-[12px] border border-border bg-bg-surface px-3 py-2 text-[12px] leading-snug text-fg-dim">
      {children}
    </div>
  );
}

function NoticeButton({
  primary,
  onClick,
  children,
}: {
  primary?: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={
        primary
          ? "pressable h-7 shrink-0 rounded-lg bg-fg px-2.5 text-[12px] font-medium text-bg transition-opacity duration-150 ease-out hover:opacity-90"
          : "pressable h-7 shrink-0 rounded-lg px-2.5 text-[12px] text-fg-dim transition-colors duration-150 ease-out hover:bg-bg-hover hover:text-fg"
      }
    >
      {children}
    </button>
  );
}
