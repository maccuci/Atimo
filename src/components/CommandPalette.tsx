import { useEffect, useMemo, useRef, useState } from "react";
import { SearchIcon } from "@hugeicons/core-free-icons";
import { useStore } from "@/lib/store";
import { semanticSearch } from "@/lib/search";
import { primeQuery, subscribeEmbeddings } from "@/lib/embeddings";
import { ensureVectors, ensureWorkspaceVectors } from "@/lib/vectors";
import { Icon } from "@/components/ui/Icon";
import { KindGlyph, Kbd, ScoreBar } from "@/components/ui/primitives";
import { cn } from "@/lib/utils";
import type { SearchResult } from "@/lib/types";

/*
 * ⌘K — semantic search across the workspace.
 * Scope toggle: one project (retrieval) vs everything (discovery).
 */

export function CommandPalette() {
  const open = useStore((s) => s.paletteOpen);
  const setOpen = useStore((s) => s.setPaletteOpen);
  const projectId = useStore((s) => s.projectId);
  const projects = useStore((s) => s.projects);
  const selectChat = useStore((s) => s.selectChat);
  const selectProject = useStore((s) => s.selectProject);
  const setView = useStore((s) => s.setView);
  const queueDocumentMention = useStore((s) => s.queueDocumentMention);

  const [query, setQuery] = useState("");
  const [scoped, setScoped] = useState(true);
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  /** Bumped when a query vector lands, so the results recompute with it. */
  const [embedded, setEmbedded] = useState(0);
  useEffect(() => subscribeEmbeddings(() => setEmbedded((n) => n + 1)), []);

  /*
   * The vectors for whatever the toggle is about to search.
   *
   * Unscoped means the whole workspace, and only the open project's index is
   * resident by default — so without this, "everything" would be searched by
   * meaning in one project and by words in the rest, which is a difference the
   * ranking would show and nothing on screen would explain.
   */
  useEffect(() => {
    if (!open) return;
    if (scoped) void ensureVectors(projectId);
    else void ensureWorkspaceVectors();
  }, [open, scoped, projectId]);

  const results = useMemo(() => {
    if (!query.trim()) return [];
    // Undebounced, unlike the composer preview: the palette is a search box, the
    // query is short, and the result of a miss is one frame ranked by words.
    primeQuery(query);
    const found = semanticSearch(query, {
      projectId: scoped ? projectId : undefined,
      limit: scoped ? 12 : 30,
    });
    if (scoped) return found;
    // Grouped by project, best project first. Results arrive best-first, so a
    // project's first index is also its rank, and a stable sort keeps the order
    // inside each group.
    const rank = new Map<string, number>();
    found.forEach((r, i) => {
      if (!rank.has(r.projectId)) rank.set(r.projectId, i);
    });
    return found.sort(
      (a, b) => rank.get(a.projectId)! - rank.get(b.projectId)!,
    );
  }, [query, scoped, projectId, embedded]);

  useEffect(() => setActive(0), [query, scoped]);

  useEffect(() => {
    if (open) {
      setQuery("");
      requestAnimationFrame(() => inputRef.current?.focus());
    }
  }, [open]);

  if (!open) return null;

  const go = (result: SearchResult) => {
    selectProject(result.projectId);
    if (result.kind === "chat") selectChat(result.id);
    else {
      // No file viewer exists; what a found file is for is using it. The chat
      // view is always mounted, so its composer picks the mention up.
      setView("chat");
      queueDocumentMention(result.title);
    }
    setOpen(false);
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") {
      setOpen(false);
      return;
    }
    if (e.key === "Tab") {
      e.preventDefault();
      setScoped((v) => !v);
      return;
    }
    if (results.length === 0) return;

    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActive((i) => (i + 1) % results.length);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((i) => (i - 1 + results.length) % results.length);
    } else if (e.key === "Enter") {
      e.preventDefault();
      const result = results[active];
      if (result) go(result);
    }
  };

  const project = projects.find((p) => p.id === projectId);

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-black/50 pt-[max(0.75rem,var(--safe-top),8dvh)] backdrop-blur-[2px] sm:pt-[12vh]"
      onMouseDown={() => setOpen(false)}
    >
      <div
        onMouseDown={(e) => e.stopPropagation()}
        onKeyDown={onKeyDown}
        className="fade-up w-[min(640px,calc(100vw-1.5rem))] overflow-hidden rounded-[16px] border border-border-strong bg-bg-raised"
        style={{ boxShadow: "var(--shadow-panel)" }}
      >
        <div className="flex items-center gap-2.5 border-b border-border px-4 py-3">
          <Icon
            icon={SearchIcon}
            size={16}
            strokeWidth={1.75}
            className="text-fg-faint"
          />
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            spellCheck={false}
            placeholder="Buscar chats e documentos…"
            className="min-w-0 flex-1 text-[14px] tracking-[-0.01em] outline-none"
          />
          <button
            type="button"
            onClick={() => setScoped((v) => !v)}
            className={cn(
              "pressable shrink-0 rounded-full border px-2.5 py-1 text-[11px] tracking-[-0.01em] transition-[background-color,border-color,color] duration-150 ease-out",
              scoped
                ? "border-cyan/40 bg-cyan/10 text-cyan"
                : "border-border text-fg-faint hover:text-fg-dim",
            )}
            title="Tab alterna o escopo"
          >
            {scoped ? project?.name : "Todos os projetos"}
          </button>
        </div>

        <div className="scroll-thin max-h-[52vh] overflow-y-auto">
          {!query.trim() ? (
            <div className="px-5 py-8 text-center text-[13px] leading-relaxed text-fg-dim">
              Busque por assunto em conversas e arquivos. <Kbd>⇥</Kbd> alterna o
              escopo.
            </div>
          ) : results.length === 0 ? (
            <div className="px-5 py-8 text-center text-[13px] leading-relaxed text-fg-dim">
              Nada encontrado{scoped ? ` em ${project?.name}` : ""}. Aperte{" "}
              <Kbd>⇥</Kbd> para buscar em todos os projetos.
            </div>
          ) : (
            <div className="py-1.5">
              {results.map((result, index) => {
                const owner = projects.find((p) => p.id === result.projectId);
                const startsGroup =
                  !scoped && results[index - 1]?.projectId !== result.projectId;
                return (
                  <div key={`${result.kind}-${result.id}`}>
                    {startsGroup && (
                      <div className="px-4 pb-1 pt-3 text-[11px] font-medium uppercase tracking-[0.04em] text-fg-faint first:pt-1.5">
                        {owner?.name ?? "Sem projeto"}
                      </div>
                    )}
                    <button
                      type="button"
                      title={
                        result.kind === "document"
                          ? "Usar este arquivo no chat"
                          : undefined
                      }
                      onMouseEnter={() => setActive(index)}
                      onClick={() => go(result)}
                      className={cn(
                        "flex w-full flex-col gap-0.5 px-4 py-2.5 text-left transition-colors duration-150 ease-out",
                        index === active ? "bg-bg-active" : "hover:bg-bg-hover",
                      )}
                    >
                      <div className="flex items-center gap-2">
                        <KindGlyph kind={result.kind} />
                        <span className="min-w-0 flex-1 truncate text-[13px] font-medium tracking-[-0.01em] text-fg">
                          {result.title}
                        </span>
                        <ScoreBar score={result.score} />
                      </div>
                      <div className="truncate pl-[22px] text-[12px] text-fg-faint">
                        {result.excerpt}
                      </div>
                    </button>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        <div className="flex items-center gap-3 border-t border-border bg-bg-inset/80 px-4 py-2 text-[11px] text-fg-faint">
          <span className="flex items-center gap-1.5">
            <Kbd>↑↓</Kbd> navegar
          </span>
          <span className="flex items-center gap-1.5">
            <Kbd>⏎</Kbd> abrir
          </span>
          <span className="flex items-center gap-1.5">
            <Kbd>⇥</Kbd> escopo
          </span>
          <div className="flex-1" />
          <span>
            {results.length} {results.length === 1 ? "resultado" : "resultados"}
          </span>
        </div>
      </div>
    </div>
  );
}
