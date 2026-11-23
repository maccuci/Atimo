import { useMemo, useState } from "react";
import {
  Add01Icon,
  GitForkIcon,
  SearchIcon,
  SparklesIcon,
  Tick02Icon,
} from "@hugeicons/core-free-icons";
import type { IconSvgElement } from "@hugeicons/react";
import { Icon } from "@/components/ui/Icon";
import { isOpenWeights, providerLabel } from "@/lib/models";
import { providerUi } from "@/lib/provider-ui";
import { useStore } from "@/lib/store";
import { useSelectableModels } from "@/lib/use-models";
import { cn, formatPrice, formatTokens } from "@/lib/utils";
import { T3Section } from "@/t3/primitives";

type CatalogItem = {
  id: string;
  name: string;
  description: string;
  icon: IconSvgElement;
  color?: string;
  kind: "model" | "capability";
  connected?: boolean;
  /** Same model under another route — "(batch)", "(free)". Models only. */
  variants?: { id: string; tag: string }[];
  open?: boolean;
};

/** "Gemini 4 Hydrogen (batch)" → ["Gemini 4 Hydrogen", "batch"]. */
const VARIANT = /\s*\((free|batch)\)$/i;
const VARIANT_LABEL: Record<string, string> = { free: "grátis", batch: "batch" };

/*
 * Models surface. Same marketplace layout as the reference, Atimo content:
 * providers you plug in, plus the knowledge capabilities that make every model
 * start from the same project memory (PRD: models are interchangeable,
 * knowledge is permanent).
 */

const MODEL_BLURB: Partial<Record<string, string>> = {
  "claude-fable-5": "Topo de linha classe Mythos sobre toda a memória do projeto",
  "claude-opus-5": "Raciocínio profundo sobre toda a memória do projeto",
  "claude-sonnet-5": "Respostas rápidas com o mesmo contexto compartilhado",
  "claude-haiku-4.5": "Alto volume sem perder a memória",
  "gpt-5.6-sol": "Topo de linha Sol — troque no meio do projeto sem reexplicar",
  "gpt-5.6-terra": "Trabalho do dia a dia sobre o conhecimento do projeto",
  "gpt-5.6-luna": "Rápido e barato, com a mesma camada de contexto",
  "gpt-5.5": "Topo de linha anterior da OpenAI, com a mesma memória",
  "gemini-3.1-pro": "Pro de contexto longo sobre a camada de conhecimento",
  "gemini-3.6-flash": "Flash estável com a mesma memória do projeto",
  "gemini-3.5-flash-lite": "Volume ultrabarato sem perder contexto",
  "grok-4.5": "Topo de linha da xAI com a mesma memória",
  "grok-4.3": "Grok de contexto longo com entrada multimodal",
  "grok-4.1-fast": "Grok de contexto longo mais barato, para alto volume",
  "deepseek-v4-pro": "Raciocínio com pesos abertos, herdando o conhecimento do projeto",
  "deepseek-v4-flash": "Modelo de fronteira mais barato, com memória compartilhada",
  "mistral-medium-3.5": "Modelo europeu de pesos abertos com o mesmo contexto",
  "muse-spark-1.1": "Raciocínio multimodal da Meta Superintelligence Labs",
  "qwen3.7-max": "Topo de linha da Alibaba com 1M de contexto",
  "qwen3.7-plus": "Qwen multimodal com a mesma memória do projeto",
};

/** Cards, not a catalog dump — search reaches the rest. */
const MODEL_CARDS = 24;

const CAPABILITIES: CatalogItem[] = [
  {
    id: "fork",
    name: "Forks de chat",
    description: "Continue uma conversa em outro modelo",
    icon: GitForkIcon,
    kind: "capability",
    connected: true,
  },
  {
    id: "refs",
    name: "Referências com @",
    description: "Traga chats e documentos para a mensagem",
    icon: SparklesIcon,
    kind: "capability",
    connected: true,
  },
];

export function AppsView() {
  const [query, setQuery] = useState("");
  const [openOnly, setOpenOnly] = useState(false);

  const catalogModels = useSelectableModels();
  const providerConnected = useStore((s) => s.connection.status === "connected");
  const setConnectOpen = useStore((s) => s.setConnectOpen);
  const setChatModel = useStore((s) => s.setChatModel);
  const chatId = useStore((s) => s.chatId);
  const setView = useStore((s) => s.setView);
  const activeModelId = useStore(
    (s) => s.chats.find((c) => c.id === s.chatId)?.modelId,
  );

  // One card per model, with its routes as chips: a list where every model
  // appears two or three times reads as three times the choice it is.
  const modelItems: CatalogItem[] = useMemo(() => {
    const groups = new Map<string, typeof catalogModels>();
    for (const model of catalogModels) {
      const base = model.label.replace(VARIANT, "");
      groups.set(base, [...(groups.get(base) ?? []), model]);
    }
    return [...groups.entries()].map(([name, members]) => {
        const model = members.find((m) => !VARIANT.test(m.label)) ?? members[0]!;
        const ui = providerUi(model.provider);
        return {
          id: model.id,
          name,
          variants: members
            .filter((m) => m !== model)
            .map((m) => ({
              id: m.id,
              tag: VARIANT_LABEL[m.label.match(VARIANT)?.[1]?.toLowerCase() ?? ""] ?? m.label,
            })),
          open: isOpenWeights(model),
          // A hand-written blurb where we have one; otherwise the two facts
          // that actually decide a model — how much it holds, what it costs.
          description:
            MODEL_BLURB[model.id] ??
            `${providerLabel(model.provider)} · ${formatTokens(model.contextWindow)} tokens de contexto · ${formatPrice(model.costIn)}/${formatPrice(model.costOut)} por 1M`,
          icon: ui.icon,
          color: ui.color,
          kind: "model" as const,
        };
      });
  }, [catalogModels]);

  const items = useMemo(() => {
    const all = [...modelItems.filter((m) => !openOnly || m.open), ...CAPABILITIES];
    const q = query.trim().toLowerCase();
    if (!q) return all;
    return all.filter(
      (a) =>
        a.name.toLowerCase().includes(q) ||
        a.description.toLowerCase().includes(q),
    );
  }, [modelItems, query, openOnly]);

  const models = items.filter((i) => i.kind === "model").slice(0, MODEL_CARDS);
  const capabilities = items.filter((i) => i.kind === "capability");

  // Connection is a property of the provider, not of each model — one key
  // unlocks the whole catalog. So the card's job is to pick a model, and it
  // only diverts to the connect sheet when there is no key at all.
  const connected = useMemo(() => {
    const on = new Set(CAPABILITIES.filter((c) => c.connected).map((c) => c.id));
    if (providerConnected && activeModelId) on.add(activeModelId);
    return on;
  }, [providerConnected, activeModelId]);

  const activate = (id: string) => {
    if (CAPABILITIES.some((c) => c.id === id)) return;
    if (!providerConnected) {
      setConnectOpen(true);
      return;
    }
    if (chatId) setChatModel(chatId, id);
    setView("chat");
  };

  return (
    <div className="scroll-thin flex min-h-0 min-w-0 flex-1 flex-col overflow-y-auto bg-bg">
      <div className="mx-auto w-full max-w-[46rem] px-6 pt-8 pb-16">
        <header className="mb-5 border-b border-border pb-5">
          <div className="flex items-start justify-between gap-4">
            <div className="min-w-0">
              <h1 className="text-[22px] leading-tight font-semibold tracking-[-0.03em] text-fg">
                Modelos
              </h1>
              <p className="mt-1 max-w-[46ch] text-[12.5px] leading-relaxed text-fg-dim">
                Os modelos mudam, o conhecimento fica — conecte uma vez e todo
                chat começa do mesmo contexto do projeto.
              </p>
            </div>
            <button
              type="button"
              onClick={() => setConnectOpen(true)}
              title={providerConnected ? "Configurações do provedor" : undefined}
              className={cn(
                "pressable inline-flex h-7 shrink-0 items-center gap-1.5 rounded-full border px-2.5 text-[11.5px] transition-[border-color,color,opacity] duration-150 ease-out",
                providerConnected
                  ? "border-border bg-bg-surface text-fg-dim hover:border-border-strong hover:text-fg"
                  : "border-transparent bg-accent font-medium text-white hover:opacity-90",
              )}
            >
              {providerConnected ? (
                <span className="h-1.5 w-1.5 rounded-full bg-green" />
              ) : null}
              {providerConnected ? "Conectado" : "Conectar provedor"}
            </button>
          </div>

          <label className="relative mt-4 block w-full max-w-[340px]">
            <span className="pointer-events-none absolute top-1/2 left-2.5 -translate-y-1/2 text-fg-faint">
              <Icon icon={SearchIcon} size={13} strokeWidth={1.75} />
            </span>
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Buscar modelos e recursos…"
              aria-label="Buscar modelos e recursos"
              className="h-8 w-full rounded-lg border border-border bg-bg-surface pr-3 pl-8 text-[12px] tracking-[-0.008em] text-fg outline-none transition-[border-color] duration-150 ease-out placeholder:text-fg-faint focus:border-border-strong"
            />
          </label>
          <div className="mt-3 flex gap-1.5" role="group" aria-label="Filtrar modelos">
            {([false, true] as const).map((only) => (
              <button
                key={String(only)}
                type="button"
                aria-pressed={openOnly === only}
                onClick={() => setOpenOnly(only)}
                className={cn(
                  "pressable h-7 rounded-full border px-3 text-[11.5px] transition-[border-color,color,background-color] duration-150 ease-out",
                  openOnly === only
                    ? "border-border-strong bg-bg-active text-fg"
                    : "border-border text-fg-dim hover:border-border-strong hover:text-fg",
                )}
              >
                {only ? "Pesos abertos" : "Todos"}
              </button>
            ))}
          </div>
        </header>

        <T3Section
          title="Modelos"
          className="px-0 pb-0"
          right={
            <span className="text-[11px] tabular-nums text-fg-faint">
              {models.length}
            </span>
          }
        >
          <div className="grid grid-cols-1 gap-1.5 sm:grid-cols-2">
            {models.map((item, i) => {
              const inUse =
                [item.id, ...(item.variants ?? []).map((v) => v.id)].find((id) => connected.has(id));
              const isOn = Boolean(inUse);
              return (
                <div
                  key={item.id}
                  data-active={isOn || undefined}
                  className={cn(
                    "t3-card stagger-in group flex w-full items-center gap-2.5 p-3 text-left",
                    "transition-[background-color,border-color] duration-150 ease-out",
                    !isOn && "hover:border-border-strong",
                  )}
                  style={{
                    animationDelay: `${120 + i * 30}ms`,
                    ...(isOn
                      ? {
                          background: "var(--accent-dim)",
                          borderColor:
                            "color-mix(in srgb, var(--accent) 35%, transparent)",
                        }
                      : undefined),
                  }}
                >
                  <button
                    type="button"
                    onClick={() => activate(item.id)}
                    title={providerConnected ? `Usar ${item.name} no chat atual` : "Conecte um provedor para usar este modelo"}
                    className="pressable flex min-w-0 flex-1 items-center gap-2.5 text-left"
                  >
                    <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-border bg-bg-surface">
                      <Icon
                        icon={item.icon}
                        size={16}
                        color={item.color}
                        strokeWidth={1.5}
                      />
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="flex items-center gap-1.5">
                        <span className="truncate text-[12.5px] font-medium tracking-[-0.01em] text-fg">
                          {item.name}
                        </span>
                        {item.open ? (
                          <span className="shrink-0 rounded-full border border-border px-1.5 text-[9.5px] leading-4 text-fg-dim">
                            pesos abertos
                          </span>
                        ) : null}
                      </span>
                      <span className="mt-0.5 block truncate text-[11px] tracking-[-0.005em] text-fg-faint">
                        {item.description}
                      </span>
                    </span>
                  </button>
                  {item.variants?.map((v) => (
                    <button
                      key={v.id}
                      type="button"
                      onClick={() => activate(v.id)}
                      title={`Usar a versão ${v.tag}`}
                      aria-pressed={inUse === v.id}
                      className={cn(
                        "pressable h-6 shrink-0 rounded-full border px-2 text-[10.5px] transition-[border-color,color,background-color] duration-150 ease-out",
                        inUse === v.id
                          ? "border-accent/40 bg-accent-dim text-accent"
                          : "border-border text-fg-dim hover:border-border-strong hover:text-fg",
                      )}
                    >
                      {v.tag}
                    </button>
                  ))}
                  {isOn ? (
                    <span className="inline-flex h-6 shrink-0 items-center gap-1 rounded-full bg-accent-dim px-2 text-[10.5px] font-medium text-accent">
                      <Icon icon={Tick02Icon} size={11} strokeWidth={2} />
                      Em uso
                    </span>
                  ) : (
                    <span className="shrink-0 text-[10.5px] text-fg-dim opacity-0 transition-opacity duration-150 ease-out group-hover:opacity-100">
                      {providerConnected ? "Usar" : "Conectar"}
                    </span>
                  )}
                </div>
              );
            })}
          </div>
        </T3Section>

        {capabilities.length > 0 && (
          <T3Section title="Camada de conhecimento" className="mt-5 px-0 pb-0">
            <div className="t3-card overflow-hidden">
              <ul className="divide-y divide-border">
                {capabilities.map((item) => {
                  const isOn = connected.has(item.id);
                  return (
                    <li key={item.id}>
                      <button
                        type="button"
                        onClick={() => activate(item.id)}
                        data-active={isOn || undefined}
                        className="group flex min-h-[40px] w-full items-center gap-2.5 px-3 py-1.5 text-left transition-colors duration-150 ease-out hover:bg-bg-hover"
                      >
                        <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md border border-border bg-bg-surface text-fg-dim">
                          <Icon icon={item.icon} size={13} strokeWidth={1.75} />
                        </span>
                        <span className="w-28 shrink-0 truncate text-[12.5px] font-medium tracking-[-0.01em] text-fg">
                          {item.name}
                        </span>
                        <span className="min-w-0 flex-1 truncate text-[11px] tracking-[-0.005em] text-fg-faint">
                          {item.description}
                        </span>
                        <span
                          className={cn(
                            "inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-full transition-[background-color,color] duration-150 ease-out",
                            isOn
                              ? "bg-accent-dim text-accent"
                              : "text-fg-faint group-hover:bg-bg-hover group-hover:text-fg",
                          )}
                          aria-label={isOn ? "Conectado" : "Conectar"}
                        >
                          <Icon
                            icon={isOn ? Tick02Icon : Add01Icon}
                            size={12}
                            strokeWidth={2}
                          />
                        </span>
                      </button>
                    </li>
                  );
                })}
              </ul>
            </div>
          </T3Section>
        )}

        {items.length === 0 && (
          <div className="mt-10 flex flex-col items-center px-6 text-center">
            <span className="flex h-10 w-10 items-center justify-center rounded-[10px] border border-border bg-bg-raised text-fg-faint">
              <Icon icon={SearchIcon} size={17} strokeWidth={1.5} />
            </span>
            <p className="mt-3 text-[13px] font-medium tracking-[-0.008em] text-fg">
              Nada encontrado para “{query}”
            </p>
            <p className="mt-1 max-w-[38ch] text-[11.5px] leading-snug text-fg-faint">
              Tente o nome de um modelo, um recurso ou um provedor.
            </p>
            <button
              type="button"
              onClick={() => setQuery("")}
              className="pressable mt-3 inline-flex h-7 items-center rounded-lg border border-border bg-bg-surface px-2.5 text-[12px] tracking-[-0.01em] text-fg-dim transition-[border-color,color] duration-150 ease-out hover:border-border-strong hover:text-fg"
            >
              Limpar busca
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
