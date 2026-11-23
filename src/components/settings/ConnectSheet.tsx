import { ResearchSettings } from "./ResearchSettings";
import { useCallback, useEffect, useRef, useState } from "react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import {
  Alert02Icon,
  Cancel01Icon,
  CheckmarkCircle02Icon,
  Copy01Icon,
  LinkSquare02Icon,
  Tick02Icon,
} from "@hugeicons/core-free-icons";
import {
  isAgentKey,
  KEY_STORAGE,
  PROVIDER_META,
  PROVIDERS,
  type AgentProbe,
  type ProviderKey,
  type ZaiPlan,
} from "@/lib/adapter";
import { openExternal } from "@/lib/open-external";
import { connectionUi } from "@/lib/provider-ui";
import { useStore } from "@/lib/store";
import { Icon } from "@/components/ui/Icon";
import { Switch } from "@/components/ui/switch";
import { Button } from "@/components/ui/primitives";
import { cn, formatCost } from "@/lib/utils";

/*
 * The one place a provider is connected.
 *
 * Two routes, and the difference matters enough that the screen states it
 * rather than blurring them into one "sign in" button:
 *
 *   A *gateway* takes an API key. This screen owes the user two things about
 *   it — where the key is kept (OS keychain on desktop; the browser build has
 *   nowhere safe and says so) and proof that it works, which is why `connect()`
 *   calls the provider rather than just writing to storage.
 *
 *   A *local CLI* takes nothing. Atimo spawns the vendor's own tool, already
 *   signed in on this machine, so there is no key field, no OAuth window, and
 *   no token for this app to hold. Connecting is a detection, and the only
 *   failure worth a sentence is "installed but signed out", which the user
 *   fixes with one command in their terminal.
 */

export function ConnectSheet() {
  const open = useStore((s) => s.connectOpen);
  const setOpen = useStore((s) => s.setConnectOpen);
  const connection = useStore((s) => s.connection);
  const connect = useStore((s) => s.connect);
  const connectAgent = useStore((s) => s.connectAgent);
  const disconnect = useStore((s) => s.disconnect);
  const setProvider = useStore((s) => s.setProvider);
  const setZaiPlan = useStore((s) => s.setZaiPlan);
  const catalogCount = useStore((s) => s.catalog.length);
  const catalogStatus = useStore((s) => s.catalogStatus);

  const [key, setKey] = useState("");
  const [section, setSection] = useState<"models" | "research">("models");
  const reduceMotion = useReducedMotion();
  const inputRef = useRef<HTMLInputElement>(null);

  const gateway = connection.provider;
  const meta = PROVIDER_META[gateway];
  const isAgent = isAgentKey(gateway);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, setOpen]);

  // A key left in a field the user thinks they closed is a key still in memory.
  useEffect(() => {
    if (!open) setKey("");
  }, [open]);

  const connected = connection.status === "connected";
  const sending = useStore((s) => s.sending);
  const busy = connection.status === "connecting" || sending;

  const submit = async () => {
    if (isAgent) return;
    if (!key.trim() || busy) return;
    await connect(key.trim(), gateway);
    setKey("");
  };

  const pickGateway = (next: ProviderKey) => {
    if (next === gateway || busy) return;
    setKey("");
    setProvider(next);
  };

  return (
    <AnimatePresence>
      {open ? (
        <div className="fixed inset-0 z-50 flex items-end justify-center p-0 sm:items-center sm:p-6">
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.18 }}
            onClick={() => setOpen(false)}
            className="absolute inset-0 bg-bg/70 backdrop-blur-[2px]"
          />

          <motion.div
            role="dialog"
            aria-modal
            aria-label="Conectar um provedor"
            initial={reduceMotion ? { opacity: 0 } : { opacity: 0, scale: 0.97, y: 8 }}
            animate={reduceMotion ? { opacity: 1 } : { opacity: 1, scale: 1, y: 0 }}
            exit={reduceMotion ? { opacity: 0 } : { opacity: 0, scale: 0.98, y: 4 }}
            transition={reduceMotion ? { duration: 0.12 } : { type: "spring", bounce: 0, duration: 0.4 }}
            style={{
              boxShadow: "var(--shadow-panel)",
              paddingBottom: "var(--safe-bottom)",
            }}
            className="relative flex max-h-[min(92dvh,720px)] w-full max-w-[440px] flex-col overflow-hidden rounded-t-[16px] border border-border-strong bg-bg-raised sm:rounded-[16px]"
          >
            <div
              aria-hidden
              className="mx-auto mt-2 h-1 w-10 shrink-0 rounded-full bg-border-strong sm:hidden"
            />
            <header className="flex shrink-0 items-center gap-3 border-b border-border px-4 py-3">
              <h2 className="text-[13px] font-medium tracking-[-0.01em] text-fg">
                Conexões
              </h2>
              <div
                role="tablist"
                aria-label="Seção"
                className="flex flex-1 gap-1 text-[12px]"
              >
                {(
                  [
                    ["models", "Modelos"],
                    ["research", "Pesquisa Oracle"],
                  ] as const
                ).map(([id, title]) => (
                  <button
                    key={id}
                    type="button"
                    role="tab"
                    aria-selected={section === id}
                    onClick={() => setSection(id)}
                    className={cn(
                      "pressable rounded-[8px] px-2.5 py-1 font-medium tracking-[-0.01em] transition-colors",
                      section === id
                        ? "bg-bg-active text-fg"
                        : "text-fg-faint hover:text-fg-dim",
                    )}
                  >
                    {title}
                  </button>
                ))}
              </div>
              <button
                type="button"
                onClick={() => setOpen(false)}
                aria-label="Fechar"
                className="pressable inline-flex h-10 w-10 items-center justify-center rounded-lg text-fg-faint hover:bg-bg-hover hover:text-fg sm:h-8 sm:w-8"
              >
                <Icon icon={Cancel01Icon} size={14} strokeWidth={2} />
              </button>
            </header>

            <div className="scroll-thin min-h-0 flex-1 overflow-y-auto px-4 py-4">
              {section === "research" ? (
                <ResearchSettings />
              ) : (
              <>
              <GatewayTabs
                active={gateway}
                disabled={busy}
                onSelect={pickGateway}
              />

              {gateway === "zai" ? (
                <CodingPlanSwitch
                  plan={connection.zaiPlan}
                  disabled={busy}
                  onChange={setZaiPlan}
                />
              ) : null}

              {connected ? (
                <ConnectedPanel
                  hint={connection.hint}
                  label={connection.account?.label ?? "Conectado"}
                  usage={connection.account?.usage ?? null}
                  limit={connection.account?.limit ?? null}
                  storage={KEY_STORAGE[connection.storage]}
                  catalogCount={catalogCount}
                  catalogStatus={catalogStatus}
                  keysUrl={meta.keysUrl}
                  showUsage={gateway === "openrouter"}
                  agent={connection.agent}
                  planLabel={
                    gateway === "zai"
                      ? connection.zaiPlan === "coding"
                        ? "Coding Plan"
                        : "API geral"
                      : null
                  }
                  onDisconnect={() => void disconnect()}
                />
              ) : isAgent ? (
                <AgentPanel
                  title={meta.title}
                  probe={connection.agent}
                  error={connection.error}
                  busy={busy}
                  docsUrl={meta.keysUrl}
                  onDetect={() => void connectAgent()}
                />
              ) : (
                <>
                  <p className="mt-3.5 text-[12.5px] leading-relaxed text-fg-dim">
                    {gateway === "openrouter" ? (
                      <>
                        O Atimo mantém os modelos intercambiáveis, então fala com um
                        só gateway em vez de uma dúzia de SDKs. Cole uma chave do
                        OpenRouter e Anthropic, OpenAI, Google, xAI e os demais ficam
                        disponíveis de uma vez.
                      </>
                    ) : gateway === "deepseek" ? (
                      <>
                        Conecte uma chave da plataforma DeepSeek para usar o DeepSeek V4
                        Pro e Flash na API oficial, pagando por uso.
                      </>
                    ) : connection.zaiPlan === "coding" ? (
                      <>
                        Use sua chave do GLM Coding Plan no endpoint de código.
                        Veja o aviso acima antes de conectar.
                      </>
                    ) : (
                      <>
                        Conecte uma chave da Z.AI para usar os modelos GLM na API
                        geral, pagando por uso.
                      </>
                    )}
                  </p>

                  <label className="mt-3.5 flex items-center gap-2 rounded-[10px] border border-border-strong bg-bg-inset px-3 py-2 focus-within:border-cyan/50">
                    <input
                      ref={inputRef}
                      type="password"
                      value={key}
                      autoFocus
                      spellCheck={false}
                      autoComplete="off"
                      placeholder={meta.placeholder}
                      onChange={(e) => setKey(e.target.value)}
                      onKeyDown={(e) => e.key === "Enter" && void submit()}
                      className="min-w-0 flex-1 font-mono text-[12px] text-fg"
                    />
                  </label>

                  {connection.error ? (
                    <p className="mt-2.5 flex items-start gap-1.5 text-[11.5px] leading-relaxed text-red">
                      <Icon icon={Alert02Icon} size={13} strokeWidth={1.75} className="mt-px" />
                      {connection.error}
                    </p>
                  ) : null}

                  <div className="mt-3.5 flex items-center gap-2">
                    <Button
                      variant="accent"
                      disabled={!key.trim() || busy}
                      onClick={() => void submit()}
                    >
                      {busy ? "Verificando…" : "Conectar"}
                    </Button>
                    <Button
                      variant="ghost"
                      onClick={() => void openExternal(meta.keysUrl)}
                    >
                      Obter uma chave
                      <Icon icon={LinkSquare02Icon} size={12} strokeWidth={1.75} />
                    </Button>
                  </div>

                  <StorageNote storage={connection.storage} />
                </>
              )}

              {connected && connection.error ? (
                <p className="mt-2.5 flex items-start gap-1.5 text-[11.5px] leading-relaxed text-red">
                  <Icon icon={Alert02Icon} size={13} strokeWidth={1.75} className="mt-px" />
                  {connection.error}
                </p>
              ) : null}
              </>
              )}
            </div>
          </motion.div>
        </div>
      ) : null}
    </AnimatePresence>
  );
}

/* ---------------------------------------------------------------------- */

/*
 * Grouped by route: keys on top, local CLIs underneath — the distinction the
 * rest of the sheet spends its words on. Each group is its own row so no
 * provider is left orphaned in a half-empty one.
 *
 * Originally: two rows of two rather than one row of four. Four labels across a 440px
 * sheet leaves "Claude Code" a hair over its column and truncating a provider
 * name is the one thing this control cannot afford to do. The grid also groups
 * the two routes visually — keys on top, local CLIs underneath — which is the
 * distinction the rest of the sheet spends its words on.
 */
function GatewayTabs({
  active,
  disabled,
  onSelect,
}: {
  active: ProviderKey;
  disabled: boolean;
  onSelect: (provider: ProviderKey) => void;
}) {
  return (
    <div role="tablist" aria-label="Provedor" className="space-y-2.5">
      {(
        [
          ["Chave de API", PROVIDERS.filter((id) => !isAgentKey(id))],
          ["Assinatura, via CLI", PROVIDERS.filter(isAgentKey)],
        ] as const
      ).map(([title, ids]) => (
        <div key={title}>
          <p className="mb-1 px-0.5 text-[11px] text-fg-faint">{title}</p>
          <div
            className="grid gap-1 rounded-[10px] border border-border bg-bg-inset p-1"
            style={{ gridTemplateColumns: `repeat(${Math.min(ids.length, 3)}, minmax(0, 1fr))` }}
          >
      {ids.map((id) => {
        const selected = id === active;
        const mark = connectionUi(id);
        return (
          <button
            key={id}
            type="button"
            role="tab"
            aria-selected={selected}
            disabled={disabled}
            onClick={() => onSelect(id)}
            className={cn(
              "pressable flex min-w-0 items-center gap-1.5 rounded-[8px] px-2.5 py-1.5 text-[12px] font-medium tracking-[-0.01em] transition-colors",
              selected
                ? "bg-bg-raised text-fg shadow-sm"
                : "text-fg-faint hover:text-fg-dim",
              disabled && "opacity-60",
            )}
          >
            <Icon
              icon={mark.icon}
              size={13}
              strokeWidth={1.5}
              color={selected ? mark.color : "currentColor"}
              className="shrink-0"
            />
            <span className="truncate">{PROVIDER_META[id].title}</span>
          </button>
        );
      })}
          </div>
        </div>
      ))}
    </div>
  );
}

/* ---------------------------------------------------------------------- */

/**
 * The local-CLI route: detect, don't authenticate.
 *
 * There is no key field here and no sign-in window, and that absence is the
 * point of the whole feature — Atimo holds no credential for these
 * providers, so there is nothing for it to leak and nothing for a vendor to
 * object to. When the CLI is installed but signed out, the fix is a command in
 * the user's own terminal, offered here as copyable text rather than run for
 * them: a login flow spawned from a GUI has no terminal to prompt into, and
 * would hang waiting for input nobody can give it.
 */
function AgentPanel({
  title,
  probe,
  error,
  busy,
  docsUrl,
  onDetect,
}: {
  title: string;
  probe: AgentProbe | null;
  error: string | null;
  busy: boolean;
  docsUrl: string;
  onDetect: () => void;
}) {
  const command = probe?.loginCommand;
  const needsLogin = Boolean(probe?.installed && !probe.loggedIn && command);

  return (
    <>
      <p className="mt-3.5 text-[12.5px] leading-relaxed text-fg-dim">
        O Atimo executa a CLI do {title} que você já tem instalada e logada,
        e lê a resposta. Nenhuma chave é guardada e nenhum token é lido — as
        mensagens usam a assinatura que essa CLI já tem.
      </p>

      {probe?.installed ? (
        <dl className="mt-3.5 grid grid-cols-2 gap-x-4 gap-y-2 text-[11.5px]">
          <Stat term="Versão" value={probe.version ?? "desconhecida"} />
          <Stat term="Logada" value={probe.loggedIn ? "sim" : "não"} />
          {probe.path ? (
            <div className="col-span-2 min-w-0">
              <dt className="text-fg-faint">Encontrada em</dt>
              <dd className="mt-px truncate font-mono text-[10.5px] text-fg-dim">
                {probe.path}
              </dd>
            </div>
          ) : null}
        </dl>
      ) : null}

      {error ? (
        <p className="mt-2.5 flex items-start gap-1.5 text-[11.5px] leading-relaxed text-red">
          <Icon icon={Alert02Icon} size={13} strokeWidth={1.75} className="mt-px" />
          {error}
        </p>
      ) : null}

      {needsLogin && command ? <CommandHint command={command} /> : null}

      <div className="mt-3.5 flex items-center gap-2">
        <Button variant="accent" disabled={busy} onClick={onDetect}>
          {busy ? "Verificando…" : "Detectar"}
        </Button>
        <Button variant="ghost" onClick={() => void openExternal(docsUrl)}>
          Guia de instalação
          <Icon icon={LinkSquare02Icon} size={12} strokeWidth={1.75} />
        </Button>
      </div>

      <p className="mt-3 text-[11px] leading-relaxed text-fg-faint">
        Nada é gravado no Keychain para este provedor. O Atimo nunca lê
        as credenciais da CLI — só inicia o programa e lê o que ele
        imprime.
      </p>
    </>
  );
}

/** The one command that fixes a signed-out CLI, ready to paste. */
function CommandHint({ command }: { command: string }) {
  const [copied, setCopied] = useState(false);

  const copy = useCallback(() => {
    void navigator.clipboard
      .writeText(command)
      .then(() => setCopied(true))
      .catch(() => {
        /* no clipboard permission — the text is on screen to type */
      });
  }, [command]);

  // Revert to the idle label rather than leaving a permanent "Copied", which
  // would still be claiming something about a click made minutes ago.
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 1600);
    return () => clearTimeout(timer);
  }, [copied]);

  return (
    <div className="mt-2.5 flex items-center gap-2 rounded-[10px] border border-border-strong bg-bg-inset px-3 py-2">
      <code className="min-w-0 flex-1 truncate font-mono text-[11.5px] text-fg">
        {command}
      </code>
      <button
        type="button"
        onClick={copy}
        aria-label={`Copiar ${command}`}
        className="pressable inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-fg-faint hover:bg-bg-hover hover:text-fg"
      >
        <Icon
          icon={copied ? Tick02Icon : Copy01Icon}
          size={13}
          strokeWidth={1.75}
          color={copied ? "var(--color-green)" : undefined}
        />
      </button>
    </div>
  );
}

function CodingPlanSwitch({
  plan,
  disabled,
  onChange,
}: {
  plan: ZaiPlan;
  disabled: boolean;
  onChange: (plan: ZaiPlan) => void;
}) {
  const on = plan === "coding";

  return (
    <div>
    <label
      className={cn(
        "mt-3 flex cursor-pointer items-center justify-between gap-3 rounded-[10px] border border-border bg-bg-inset px-3 py-2.5",
        "transition-[border-color,background-color] duration-150 ease-[var(--ease-out, ease-out)]",
        on ? "border-cyan/35 bg-cyan/5" : "hover:border-border-strong",
        disabled && "cursor-not-allowed opacity-60",
      )}
    >
      <div className="min-w-0">
        <p className="text-[12.5px] font-medium tracking-[-0.01em] text-fg">
          Coding Plan
        </p>
        <p
          className={cn(
            "font-mono text-[10.5px] leading-snug tracking-[-0.01em]",
            on ? "text-cyan" : "text-fg-faint",
          )}
        >
          {on
            ? "api.z.ai/api/coding/paas/v4"
            : "api.z.ai/api/paas/v4"}
        </p>
      </div>
      <Switch
        checked={on}
        disabled={disabled}
        aria-label="Usar o endpoint do GLM Coding Plan"
        onCheckedChange={(checked) => onChange(checked ? "coding" : "general")}
      />
    </label>
    <p
      role="note"
      className="mt-1.5 px-1 text-[11.5px] leading-snug text-amber"
    >
      A Z.AI só permite usar a cota do Coding Plan nas ferramentas que ela lista
      em docs.z.ai, e o Atimo não está entre elas. Se ativar, o risco é seu: a
      Z.AI pode limitar ou suspender a assinatura. A API geral não tem essa
      restrição.
    </p>
    </div>
  );
}

function ConnectedPanel({
  hint,
  label,
  usage,
  limit,
  storage,
  catalogCount,
  catalogStatus,
  keysUrl,
  showUsage,
  agent,
  planLabel,
  onDisconnect,
}: {
  hint: string | null;
  label: string;
  usage: number | null;
  limit: number | null;
  storage: string;
  catalogCount: number;
  catalogStatus: "idle" | "loading" | "ready" | "error";
  keysUrl: string;
  showUsage: boolean;
  /** Set when the connection is a local CLI rather than a key. */
  agent: AgentProbe | null;
  planLabel: string | null;
  onDisconnect: () => void;
}) {
  if (agent) {
    return (
      <>
        <div className="mt-3.5 flex items-center gap-2 text-[12.5px] text-green">
          <Icon icon={CheckmarkCircle02Icon} size={14} strokeWidth={1.75} />
          {label}
        </div>

        <dl className="mt-3.5 grid grid-cols-2 gap-x-4 gap-y-2 text-[11.5px]">
          <Stat
            term="Modelos disponíveis"
            value={
              catalogStatus === "loading"
                ? "carregando…"
                : catalogStatus === "error"
                  ? "indisponível"
                  : String(catalogCount)
            }
          />
          <Stat term="Login via" value={agent.method ?? "CLI"} />
          <Stat term="Versão da CLI" value={agent.version ?? "desconhecida"} />
          {/* Not "free": the user is paying a subscription. It is simply not
              billed per token, so quoting a per-turn price would be fiction. */}
          <Stat term="Cobrança" value="seu plano atual" />
        </dl>

        <div className="mt-4 flex items-center gap-2">
          <Button variant="outline" onClick={onDisconnect}>
            Desconectar
          </Button>
          <Button variant="ghost" onClick={() => void openExternal(keysUrl)}>
            Documentação da CLI
            <Icon icon={LinkSquare02Icon} size={12} strokeWidth={1.75} />
          </Button>
        </div>

        <p className="mt-3 text-[11px] leading-relaxed text-fg-faint">
          Desconectar só faz o Atimo parar de usar a CLI. Seu login{" "}
          {agent.method ?? "da CLI"} continua intacto — ele nunca foi do app.
        </p>
      </>
    );
  }

  return (
    <>
      <div className="mt-3.5 flex items-center gap-2 text-[12.5px] text-green">
        <Icon icon={CheckmarkCircle02Icon} size={14} strokeWidth={1.75} />
        <span className={cn(label.includes("...") && "font-mono text-[12px]")}>{label}</span>
        {hint && !label.includes("...") ? (
          <span className="font-mono text-[11px] text-fg-faint">···{hint}</span>
        ) : null}
      </div>

      <dl className="mt-3.5 grid grid-cols-2 gap-x-4 gap-y-2 text-[11.5px]">
        <Stat
          term="Modelos disponíveis"
          value={
            catalogStatus === "loading"
              ? "carregando…"
              : catalogStatus === "error"
                ? "indisponível"
                : String(catalogCount)
          }
        />
        {showUsage ? (
          <>
            <Stat
              term="Gasto nesta chave"
              value={usage === null ? "—" : formatCost(usage)}
            />
            <Stat
              term="Limite de crédito"
              value={limit === null ? "sem limite" : formatCost(limit)}
            />
          </>
        ) : (
          <>
            <Stat term="Endpoint" value={planLabel ?? "—"} />
            <Stat term="Uso" value="veja o painel da Z.AI" />
          </>
        )}
        <Stat term="Chave guardada em" value={storage} />
      </dl>

      <div className="mt-4 flex items-center gap-2">
        <Button variant="outline" onClick={onDisconnect}>
          Desconectar
        </Button>
        <Button variant="ghost" onClick={() => void openExternal(keysUrl)}>
          Gerenciar chaves
          <Icon icon={LinkSquare02Icon} size={12} strokeWidth={1.75} />
        </Button>
      </div>
    </>
  );
}

function Stat({ term, value }: { term: string; value: string }) {
  return (
    <div>
      <dt className="text-fg-faint">{term}</dt>
      <dd className="mt-px text-fg-dim">{value}</dd>
    </div>
  );
}

function StorageNote({ storage }: { storage: "desktop" | "web" }) {
  return (
    <p
      className={cn(
        "mt-3 text-[11px] leading-relaxed",
        storage === "web" ? "text-fg-dim" : "text-fg-faint",
      )}
    >
      {storage === "desktop" ? (
        <>
          A chave é gravada no {KEY_STORAGE.desktop} e lida só dentro da
          requisição que a usa — ela nunca chega a esta janela.
        </>
      ) : (
        <>
          Você está na versão de navegador, que não tem Keychain: a chave fica
          no {KEY_STORAGE.web} e a requisição sai desta página. Use o app
          desktop para qualquer coisa além de desenvolvimento.
        </>
      )}
    </p>
  );
}
