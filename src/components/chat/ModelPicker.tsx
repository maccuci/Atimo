import {
  memo,
  useCallback,
  useDeferredValue,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import {
  AiBrain01Icon,
  ArrowDown01Icon,
  Cancel01Icon,
  EyeIcon,
  PdfIcon,
  Search01Icon,
  Tick02Icon,
  Wrench01Icon,
} from "@hugeicons/core-free-icons";
import { getModel, providerLabel } from "@/lib/models";
import { providerUi } from "@/lib/provider-ui";
import { useStore } from "@/lib/store";
import { useOrderedModels, useSelectableModels } from "@/lib/use-models";
import type { Model } from "@/lib/types";
import { Icon } from "@/components/ui/Icon";
import { ScrollArea } from "@/components/ui/scroll-area";
import { cn, formatPrice, formatTokens } from "@/lib/utils";
import { ModelOptionsEdit, summariseOptions } from "./ModelOptions";

/*
 * Model switcher.
 *
 * Switching mid-chat is deliberate and lossless — knowledge lives in the
 * project, so the next turn recomposes for whatever model you pick.
 *
 * Effort and Fast are global prefs owned by `ModelOptions` in the panel
 * chrome — not by a catalog row — so picking a model stays a single hit
 * target and Edit stays visible whether or not the current id is in view.
 *
 * The live catalog runs to several hundred models, which changes what this
 * component has to be: not a menu but a search. Two consequences shape it —
 * only a bounded slice is ever in the DOM, and the row stays a single line
 * with the details of whichever row is highlighted shown once, in the footer,
 * instead of repeated three hundred times.
 */

/** Rendering the entire catalog costs more than it tells anyone. */
const MAX_ROWS = 60;

const PANEL_W = 448;
const PANEL_H = 400;

export function ModelPicker({
  chatId,
  modelId,
  onSelect,
  placement: preferred = "up",
  trigger,
  triggerClassName,
}: {
  chatId?: string;
  modelId: string;
  /** When set, selection is controlled by the parent (e.g. Compare before a chat exists). */
  onSelect?: (modelId: string) => void;
  placement?: "up" | "down";
  /** Replaces the default "current model" button — e.g. Compare's "Add model". */
  trigger?: ReactNode;
  /** Extra classes on the trigger button (e.g. composer pill chrome). */
  triggerClassName?: string;
}) {
  const setChatModel = useStore((s) => s.setChatModel);
  const catalogStatus = useStore((s) => s.catalogStatus);
  const setConnectOpen = useStore((s) => s.setConnectOpen);
  const effort = useStore((s) => s.effort);
  const fast = useStore((s) => s.fast);

  const all = useSelectableModels();
  const ordered = useOrderedModels(all);

  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState(false);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);

  const ref = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const reduceMotion = useReducedMotion();
  // Measured on open so the panel never leaves the window: flip toward the
  // roomier side, cap height to that room, slide left off the right edge.
  const [fit, setFit] = useState({ placement: preferred, height: PANEL_H, shift: 0 });
  const placement = fit.placement;
  const measure = () => {
    const r = ref.current?.getBoundingClientRect();
    if (!r) return;
    const gap = 12;
    const above = r.top - gap;
    const below = window.innerHeight - r.bottom - gap;
    const side =
      preferred === "up"
        ? above >= Math.min(PANEL_H, below) ? "up" : "down"
        : below >= Math.min(PANEL_H, above) ? "down" : "up";
    const room = side === "up" ? above : below;
    const width = Math.min(PANEL_W, window.innerWidth - 24);
    const overflow = r.left + width - (window.innerWidth - gap);
    setFit({
      placement: side,
      height: Math.max(160, Math.min(PANEL_H, room)),
      shift: Math.min(Math.max(0, overflow), Math.max(0, r.left - gap)),
    });
  };

  // Typing must stay at pointer speed; re-filtering several hundred models is
  // the slow part, so it runs at whatever priority is left over.
  const deferredQuery = useDeferredValue(query);

  const { rows, total } = useMemo(
    () => filterModels(ordered, deferredQuery),
    [ordered, deferredQuery],
  );

  // Group headers are derived from the flat list rather than nesting it, so
  // keyboard navigation is a single index into a single array.
  const headerBefore = useMemo(() => {
    const map = new Map<string, boolean>();
    let previous: string | null = null;
    for (const model of rows) {
      map.set(model.id, model.provider !== previous);
      previous = model.provider;
    }
    return map;
  }, [rows]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      const target = e.target as Element;
      // Its options flyout is portaled to <body>: a click in there is still
      // inside the picker.
      if (target.closest?.("[data-anchored-layer]")) return;
      if (!ref.current?.contains(target)) {
        setOpen(false);
        setEditing(false);
      }
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  // A changed filter invalidates the old index; land on the first result.
  useEffect(() => setActive(0), [deferredQuery]);

  useEffect(() => {
    if (!open) return;
    listRef.current
      ?.querySelector('[data-active="true"]')
      ?.scrollIntoView({ block: "nearest" });
  }, [active, open]);

  useEffect(() => {
    if (!open) setEditing(false);
  }, [open]);

  const commit = useCallback(
    (model: Model | undefined) => {
      if (!model) return;
      if (onSelect) onSelect(model.id);
      else if (chatId) setChatModel(chatId, model.id);
      setOpen(false);
      setEditing(false);
      setQuery("");
    },
    [onSelect, chatId, setChatModel],
  );

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") {
      e.preventDefault();
      if (editing) {
        setEditing(false);
        return;
      }
      setOpen(false);
      return;
    }
    if (editing) return;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActive((i) => (rows.length ? (i + 1) % rows.length : 0));
      return;
    }
    if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((i) => (rows.length ? (i - 1 + rows.length) % rows.length : 0));
      return;
    }
    if (e.key === "Enter") {
      e.preventDefault();
      commit(rows[active]);
    }
  };

  const current = getModel(modelId);
  const currentUi = providerUi(current.provider);
  const highlighted = rows[active];
  const optionSummary = summariseOptions(effort, fast);

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => {
          if (!open) measure();
          setOpen((v) => !v);
          setQuery("");
          setEditing(false);
        }}
        className={cn(
          "pressable flex items-center gap-1.5 rounded-lg px-2 py-1 text-[12px] tracking-[-0.01em] transition-[background-color,border-color,color] duration-150 ease-out",
          open ? "bg-bg-active text-fg" : "text-fg-dim hover:bg-bg-hover hover:text-fg",
          triggerClassName,
        )}
      >
        {trigger ?? (
          <>
            <Icon
              icon={currentUi.icon}
              size={13}
              color={currentUi.color}
              strokeWidth={1.5}
            />
            <span className="max-w-[190px] truncate">{current.label}</span>
            {optionSummary ? (
              <span className="max-w-[90px] truncate text-fg-faint">
                {optionSummary}
              </span>
            ) : null}
            <Icon icon={ArrowDown01Icon} size={11} strokeWidth={2} />
          </>
        )}
      </button>

      <AnimatePresence>
        {open ? (
          <motion.div
            // Anchored to the trigger: the panel grows out of the button that
            // opened it rather than materialising somewhere near it.
            initial={reduceMotion ? { opacity: 0 } : { opacity: 0, scale: 0.96, y: placement === "up" ? 6 : -6 }}
            animate={reduceMotion ? { opacity: 1 } : { opacity: 1, scale: 1, y: 0 }}
            exit={reduceMotion ? { opacity: 0 } : { opacity: 0, scale: 0.97, y: placement === "up" ? 4 : -4 }}
            transition={
              reduceMotion
                ? { duration: 0.12 }
                : // Critically damped: a menu did not arrive with any momentum,
                  // so it should not bounce as if it had.
                  { type: "spring", bounce: 0, duration: 0.32 }
            }
            style={{
              width: `min(${PANEL_W}px, calc(100vw - 1.5rem))`,
              height: fit.height,
              left: -fit.shift,
              maxWidth: "calc(100vw - 1.5rem)",
              transformOrigin: placement === "up" ? "bottom left" : "top left",
              boxShadow: "var(--shadow-panel)",
            }}
            className={cn(
              "absolute left-0 z-30 flex flex-col overflow-hidden rounded-[12px] border border-border-strong bg-bg-raised",
              "right-auto",
              placement === "up" ? "bottom-full mb-1.5" : "top-full mt-1.5",
            )}
          >
            <div className="flex items-center gap-2 border-b border-border px-3 py-2.5">
              <Icon icon={Search01Icon} size={13} strokeWidth={1.75} className="text-fg-faint" />
              <input
                autoFocus
                value={query}
                spellCheck={false}
                onChange={(e) => setQuery(e.target.value)}
                onKeyDown={onKeyDown}
                placeholder={`Buscar entre ${total} modelo${total === 1 ? "" : "s"}…`}
                className="min-w-0 flex-1 text-[13px] tracking-[-0.01em] text-fg"
              />
              {query ? (
                <button
                  type="button"
                  onClick={() => setQuery("")}
                  className="pressable text-fg-faint hover:text-fg"
                >
                  <Icon icon={Cancel01Icon} size={12} strokeWidth={2} />
                </button>
              ) : null}
              <ModelOptionsEdit open={editing} onOpenChange={setEditing} />
            </div>

            <ScrollArea className="min-h-0 flex-1">
              <div ref={listRef} className="py-1.5">
                {rows.length === 0 ? (
                  <p className="px-3 py-6 text-center text-[12px] text-fg-dim">
                    Nothing matches “{query}”.
                  </p>
                ) : (
                  rows.map((model, index) => (
                    <ModelRow
                      key={model.id}
                      model={model}
                      index={index}
                      selected={model.id === modelId}
                      active={index === active}
                      showHeader={headerBefore.get(model.id) === true}
                      onHover={setActive}
                      onPick={commit}
                    />
                  ))
                )}

                {rows.length < total && query ? (
                  <p className="px-3 py-2 text-[11px] text-fg-faint">
                    Showing {rows.length} of {total} matches — keep typing to narrow.
                  </p>
                ) : null}
              </div>
            </ScrollArea>

            <ModelDetails
              model={highlighted}
              catalogStatus={catalogStatus}
              onConnect={() => {
                setOpen(false);
                setEditing(false);
                setConnectOpen(true);
              }}
            />
          </motion.div>
        ) : null}
      </AnimatePresence>
    </div>
  );
}

/* ---------------------------------------------------------------------- */

/**
 * Rank matches so the obvious answer is first: typing "sonnet" should not
 * surface a model that merely mentions it in a vendor name.
 */
function filterModels(models: Model[], query: string): { rows: Model[]; total: number } {
  const q = query.trim().toLowerCase();
  if (!q) return { rows: models.slice(0, MAX_ROWS), total: models.length };

  const terms = q.split(/\s+/);
  const scored: { model: Model; score: number }[] = [];

  for (const model of models) {
    const haystack = `${model.label} ${model.id} ${providerLabel(model.provider)}`.toLowerCase();
    // Every term has to appear somewhere — that is what makes "claude fast"
    // behave the way the user means it.
    if (!terms.every((t) => haystack.includes(t))) continue;

    const label = model.label.toLowerCase();
    const score = label.startsWith(q) ? 3 : label.includes(q) ? 2 : 1;
    scored.push({ model, score });
  }

  scored.sort((a, b) => b.score - a.score);
  return { rows: scored.slice(0, MAX_ROWS).map((s) => s.model), total: scored.length };
}

interface RowProps {
  model: Model;
  index: number;
  selected: boolean;
  active: boolean;
  showHeader: boolean;
  onHover: (index: number) => void;
  onPick: (model: Model) => void;
}

/**
 * Memoised because the highlight moves on every arrow key and every pointer
 * move across the list — without this, one keystroke re-renders sixty rows.
 */
const ModelRow = memo(function ModelRow({
  model,
  index,
  selected,
  active,
  showHeader,
  onHover,
  onPick,
}: RowProps) {
  const ui = providerUi(model.provider);

  return (
    <>
      {showHeader ? (
        <div className="flex items-center gap-1.5 px-3 pt-2 pb-1 text-[10px] font-medium tracking-[0.04em] text-fg-faint uppercase">
          <Icon icon={ui.icon} size={11} color={ui.color} strokeWidth={1.5} />
          {providerLabel(model.provider)}
        </div>
      ) : null}

      <button
        type="button"
        data-active={active}
        onMouseMove={() => onHover(index)}
        onClick={() => onPick(model)}
        className={cn(
          "flex w-full items-center gap-2 px-3 py-1.5 text-left text-[12.5px] transition-colors duration-100 ease-out",
          active ? "bg-bg-hover text-fg" : "text-fg-dim",
        )}
      >
        <Icon
          icon={Tick02Icon}
          size={12}
          strokeWidth={2}
          className={cn("shrink-0 text-cyan", selected ? "opacity-100" : "opacity-0")}
        />
        <span className="min-w-0 flex-1 truncate">{model.label}</span>

        {/* Price belongs on the row, not only in the footer. Scanning three
            hundred models for a cheap one should not require arrowing through
            them one at a time to read the details pane. */}
        <span
          className="w-[90px] shrink-0 text-right font-mono text-[10.5px] tabular-nums text-fg-faint"
          title={`$${model.costIn} entrada / $${model.costOut} saída por 1M de tokens`}
        >
          {model.costIn === 0 && model.costOut === 0 ? (
            <span className="text-green">grátis</span>
          ) : (
            <>
              {formatPrice(model.costIn)}
              <span className="text-fg-faint/50">/</span>
              {formatPrice(model.costOut)}
            </>
          )}
        </span>

        <span className="w-[38px] shrink-0 text-right font-mono text-[10.5px] tabular-nums text-fg-faint">
          {formatTokens(model.contextWindow)}
        </span>
      </button>
    </>
  );
});

/**
 * The details of exactly one model — whichever the user is looking at. Pushing
 * price and capabilities down here is what lets the rows stay scannable, and
 * it gives the panel a stable place to answer "what am I about to pick?".
 */
function ModelDetails({
  model,
  catalogStatus,
  onConnect,
}: {
  model: Model | undefined;
  catalogStatus: "idle" | "loading" | "ready" | "error";
  onConnect: () => void;
}) {
  if (!model) {
    return (
      <div className="h-[74px] border-t border-border bg-bg-surface px-3 py-2.5 text-[11px] text-fg-faint">
        {catalogStatus === "loading" ? "Carregando o catálogo…" : "Nenhum modelo selecionado."}
      </div>
    );
  }

  return (
    <div className="h-[74px] shrink-0 border-t border-border bg-bg-surface px-3 py-2.5">
      <div className="flex items-baseline gap-2">
        <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-fg-dim">
          {model.id}
        </span>
        {model.live ? null : (
          <button
            type="button"
            onClick={onConnect}
            className="pressable shrink-0 rounded-md px-1.5 py-px text-[10px] text-cyan hover:bg-cyan/10"
          >
            não conectado
          </button>
        )}
      </div>

      <div className="mt-1.5 flex items-center gap-2.5 text-[11px] text-fg-faint">
        <span title="Janela de contexto">{formatTokens(model.contextWindow)} tokens de contexto</span>
        <span className="text-fg-faint/40">·</span>
        <span title="USD por 1M de tokens de entrada / saída">
          {formatPrice(model.costIn)}
          <span className="text-fg-faint/50"> / </span>
          {formatPrice(model.costOut)}
          <span className="text-fg-faint"> por 1M</span>
        </span>

        {/* Every turn in a project re-sends the same composed knowledge, so
            for this app the cached rate is frequently the input price that
            actually applies. Worth a line of its own. */}
        {model.costCacheRead ? (
          <>
            <span className="text-fg-faint/40">·</span>
            <span
              className="text-green"
              title={`Entrada em cache: ${formatPrice(model.costCacheRead)} por 1M — ${Math.round(
                model.costIn / model.costCacheRead,
              )}x abaixo do preço normal de entrada`}
            >
              cache {formatPrice(model.costCacheRead)}
            </span>
          </>
        ) : null}

        <div className="flex-1" />

        <Capability
          on={model.supportsVision}
          icon={EyeIcon}
          label="Lê imagens anexadas"
        />
        <Capability
          on={model.supportsFiles}
          icon={PdfIcon}
          label="Lê PDFs anexados"
        />
        <Capability on={model.supportsTools} icon={Wrench01Icon} label="Uso de ferramentas" />
        <Capability on={model.supportsReasoning} icon={AiBrain01Icon} label="Raciocínio" />
      </div>
    </div>
  );
}

function Capability({
  on,
  icon,
  label,
}: {
  on: boolean | undefined;
  icon: Parameters<typeof Icon>[0]["icon"];
  label: string;
}) {
  if (!on) return null;
  return (
    <span title={label} className="text-fg-dim">
      <Icon icon={icon} size={12} strokeWidth={1.75} />
    </span>
  );
}
