import { useEffect, useState, type ReactNode } from "react";
import {
  AiBrain01Icon,
  Archive02Icon,
  Globe02Icon,
  InformationCircleIcon,
  PaintBoardIcon,
  Plug01Icon,
  Tick02Icon,
} from "@hugeicons/core-free-icons";
import { isAgentKey, isConnectable, PROVIDER_META, PROVIDERS, type ProviderKey } from "@/lib/adapter";
import { EFFORT_HINT, EFFORT_LABEL, EFFORTS, effortCaveat, type Effort } from "@/lib/effort";
import { fastCaveat } from "@/lib/fast";
import { connectionUi } from "@/lib/provider-ui";
import { REASONING_LABEL, REASONING_VISIBILITY } from "@/lib/reasoning";
import { useStore } from "@/lib/store";
import {
  ACCENTS,
  DEFAULT_APPEARANCE,
  FONTS,
  GLASS_MAX,
  GLASS_MIN,
  isMacDesktop,
  SCALE_MAX,
  SCALE_MIN,
  THEMES,
  type ThemeId,
} from "@/lib/theme";
import { checkForUpdate, restart, type AvailableUpdate } from "@/lib/updater";
import { cn } from "@/lib/utils";
import { Icon } from "@/components/ui/Icon";
import { Button } from "@/components/ui/primitives";
import { Switch } from "@/components/ui/switch";
import { ExportPanel } from "@/components/export/ExportPanel";
import { ImportPanel } from "@/components/import/ImportPanel";
import { ResearchSettings } from "@/components/settings/ResearchSettings";
import { useSmartSearchToggle } from "../SmartSearch";

const VERSION = typeof __APP_VERSION__ === "undefined" ? "dev" : __APP_VERSION__;

const SECTIONS = [
  { id: "appearance", label: "Aparência", hint: "Tema, cor, fonte e tamanho", icon: PaintBoardIcon },
  { id: "models", label: "Respostas", hint: "Raciocínio e velocidade", icon: AiBrain01Icon },
  { id: "providers", label: "Provedores", hint: "Chaves e CLIs conectadas", icon: Plug01Icon },
  { id: "research", label: "Pesquisa Oracle", hint: "Busca na web e orçamento", icon: Globe02Icon },
  { id: "backup", label: "Backup", hint: "Exportar, restaurar e busca", icon: Archive02Icon },
  { id: "about", label: "Sobre", hint: "Versão e atalhos", icon: InformationCircleIcon },
] as const;

type SectionId = (typeof SECTIONS)[number]["id"];

/*
 * Nav on the left, content on the right. Each nav entry says what is inside,
 * so the list reads as a table of contents rather than a column of labels.
 * Switching sections is instant on purpose: it is navigation, done many times
 * in a row, and an animation there only makes the app feel slower.
 */
export function SettingsView() {
  const [section, setSection] = useState<SectionId>("appearance");

  return (
    <div className="scroll-thin flex min-h-0 min-w-0 flex-1 overflow-y-auto bg-bg">
      <div className="mx-auto flex w-full max-w-[56rem] flex-col gap-8 px-4 pt-8 pb-16 sm:flex-row sm:px-6">
        <nav
          aria-label="Seções das configurações"
          className="flex shrink-0 gap-1.5 overflow-x-auto sm:sticky sm:top-0 sm:w-56 sm:flex-col sm:self-start"
        >
          <h1 className="mb-4 hidden px-1 text-[22px] leading-tight font-semibold tracking-[-0.03em] text-fg sm:block">
            Configurações
          </h1>
          {SECTIONS.map((s) => {
            const active = section === s.id;
            return (
              <button
                key={s.id}
                type="button"
                onClick={() => setSection(s.id)}
                aria-current={active ? "page" : undefined}
                className={cn(
                  "pressable flex shrink-0 items-center gap-3 rounded-[12px] p-1.5 pr-3 text-left transition-[background-color] duration-150 ease-out",
                  active ? "bg-bg-raised shadow-[inset_0_0_0_1px_var(--border)]" : "hover:bg-bg-hover",
                )}
              >
                <span
                  className={cn(
                    "flex h-8 w-8 shrink-0 items-center justify-center rounded-[9px] transition-[background-color,color] duration-150 ease-out",
                    active ? "bg-accent text-white" : "bg-bg-inset text-fg-dim",
                  )}
                >
                  <Icon icon={s.icon} size={15} strokeWidth={1.7} />
                </span>
                <span className="min-w-0">
                  <span className={cn("block text-[13px] tracking-[-0.01em]", active ? "text-fg" : "text-fg-dim")}>
                    {s.label}
                  </span>
                  <span className="hidden truncate text-[11px] text-fg-faint sm:block">{s.hint}</span>
                </span>
              </button>
            );
          })}
        </nav>

        <div className="min-w-0 flex-1">
          {section === "appearance" && <AppearanceSection />}
          {section === "models" && <Models />}
          {section === "providers" && <Providers />}
          {section === "research" && (
            <Page title="Pesquisa Oracle" lede="Pesquisa na web antes de responder perguntas de Oracle Fusion.">
              <ResearchSettings />
            </Page>
          )}
          {section === "backup" && <Backup />}
          {section === "about" && <About />}
        </div>
      </div>
    </div>
  );
}

/* ---------------------------------------------------------------------- */

function AppearanceSection() {
  const theme = useStore((s) => s.theme);
  const setTheme = useStore((s) => s.setTheme);
  const appearance = useStore((s) => s.appearance);
  const setAppearance = useStore((s) => s.setAppearance);
  const percent = Math.round(appearance.scale * 100);
  const changed =
    appearance.accent !== DEFAULT_APPEARANCE.accent ||
    appearance.font !== DEFAULT_APPEARANCE.font ||
    appearance.scale !== DEFAULT_APPEARANCE.scale ||
    appearance.glass !== DEFAULT_APPEARANCE.glass ||
    appearance.glassIntensity !== DEFAULT_APPEARANCE.glassIntensity;

  return (
    <Page title="Aparência" lede="Fica salvo neste computador e vale para todas as janelas.">
      <Label>Tema</Label>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
        {THEMES.map((t) => (
          <ThemeCard
            key={t.id}
            id={t.id}
            label={t.label}
            inspired={t.inspired}
            selected={theme === t.id}
            onSelect={() => setTheme(t.id)}
          />
        ))}
      </div>

      <Label className="mt-8">Cor de destaque</Label>
      <div role="radiogroup" aria-label="Cor de destaque" className="flex flex-wrap gap-2">
        {ACCENTS.map((a) => {
          const selected = appearance.accent === a.id;
          return (
            <button
              key={a.id}
              type="button"
              role="radio"
              aria-checked={selected}
              aria-label={a.label}
              title={a.label}
              onClick={() => setAppearance({ accent: a.id })}
              className={cn(
                "pressable flex h-9 items-center gap-2 rounded-full border pr-3 pl-1.5 text-[12px] transition-[border-color,color] duration-150 ease-out",
                selected ? "border-fg/40 text-fg" : "border-border text-fg-dim hover:border-border-strong",
              )}
            >
              <span
                className="flex h-6 w-6 items-center justify-center rounded-full text-white"
                style={{
                  background: a.color ?? "conic-gradient(#4f46e5, #e11d48, #c2410c, #15803d, #2563eb, #4f46e5)",
                }}
              >
                {selected ? <Icon icon={Tick02Icon} size={12} strokeWidth={2.5} /> : null}
              </span>
              {a.label}
            </button>
          );
        })}
      </div>

      <Label className="mt-8">Fonte</Label>
      <div role="radiogroup" aria-label="Fonte" className="grid grid-cols-2 gap-2 sm:grid-cols-5">
        {FONTS.map((f) => {
          const selected = appearance.font === f.id;
          return (
            <button
              key={f.id}
              type="button"
              role="radio"
              aria-checked={selected}
              onClick={() => setAppearance({ font: f.id })}
              className={cn(
                "pressable flex flex-col items-start gap-1 rounded-[12px] border px-3 py-2.5 text-left transition-[border-color,background-color] duration-150 ease-out",
                selected ? "border-accent bg-accent-dim" : "border-border hover:border-border-strong",
              )}
            >
              <span
                className="text-[22px] leading-none text-fg"
                style={{ fontFamily: f.stack ?? "-apple-system, BlinkMacSystemFont, system-ui, sans-serif" }}
              >
                Aa
              </span>
              <span className="text-[11.5px] text-fg-dim">{f.label}</span>
            </button>
          );
        })}
      </div>

      <div className="mt-8 flex items-baseline justify-between">
        <Label className="mb-0">Tamanho do texto</Label>
        <span className="text-[12px] tabular-nums text-fg-dim">{percent}%</span>
      </div>
      <div className="mt-3 flex items-center gap-3">
        <span className="text-[11px] text-fg-faint">A</span>
        <input
          type="range"
          min={SCALE_MIN * 100}
          max={SCALE_MAX * 100}
          step={5}
          value={percent}
          aria-label="Tamanho do texto"
          aria-valuetext={`${percent}%`}
          // Applied on release, not on every pixel of the drag: the page
          // reflowing under the thumb makes the slider jump away from it.
          onChange={(e) => setPreviewScale(Number(e.target.value))}
          onPointerUp={(e) => setAppearance({ scale: Number(e.currentTarget.value) / 100 })}
          onKeyUp={(e) => setAppearance({ scale: Number(e.currentTarget.value) / 100 })}
          className="flex-1 accent-[var(--accent)]"
        />
        <span className="text-[17px] text-fg-faint">A</span>
      </div>

      {isMacDesktop() ? (
        <>
          <div className="mt-8 flex items-center justify-between gap-4">
            <div className="min-w-0">
              <Label className="mb-0">Vidro</Label>
              <p className="mt-1 text-[11.5px] leading-relaxed text-fg-faint">
                Deixa a área de trabalho aparecer, desfocada, atrás da janela.
              </p>
            </div>
            <Switch
              checked={appearance.glass}
              onCheckedChange={(glass) => setAppearance({ glass })}
              aria-label="Vidro"
            />
          </div>
          {appearance.glass ? (
            <div className="mt-3 flex items-center gap-3">
              <span className="text-[11px] text-fg-faint">Sutil</span>
              <input
                type="range"
                min={GLASS_MIN}
                max={GLASS_MAX}
                step={5}
                value={appearance.glassIntensity}
                aria-label="Intensidade do vidro"
                aria-valuetext={`${appearance.glassIntensity}%`}
                onChange={(e) => setAppearance({ glassIntensity: Number(e.target.value) })}
                className="flex-1 accent-[var(--accent)]"
              />
              <span className="text-[11px] text-fg-faint">Intenso</span>
            </div>
          ) : null}
        </>
      ) : null}

      {changed ? (
        <button
          type="button"
          onClick={() => setAppearance(DEFAULT_APPEARANCE)}
          className="pressable mt-6 text-[12px] text-fg-faint hover:text-fg"
        >
          Voltar aparência ao padrão
        </button>
      ) : null}
    </Page>
  );
}

/** The thumb moves at once; the zoom lands on release (see the slider). */
function setPreviewScale(percent: number) {
  useStore.setState((s) => ({ appearance: { ...s.appearance, scale: percent / 100 } }));
}

/*
 * The card wears the theme itself (`data-theme` on the preview), so what it
 * shows is the real palette. The preview is a tiny conversation, which is
 * what this app actually looks like most of the time.
 */
function ThemeCard({
  id,
  label,
  inspired,
  selected,
  onSelect,
}: {
  id: ThemeId;
  label: string;
  inspired?: string;
  selected: boolean;
  onSelect: () => void;
}) {
  const preview = (theme: string, className?: string) => (
    <div data-theme={theme} className={cn("flex h-full flex-col justify-between bg-bg p-2.5", className)}>
      <div className="ml-auto h-4 w-3/5 rounded-[8px] rounded-br-[3px] bg-accent" />
      <div className="flex items-start gap-1.5">
        <span className="mt-0.5 h-2 w-2 shrink-0 rounded-full bg-magenta" />
        <div className="flex-1 space-y-1">
          <div className="h-1.5 w-full rounded-full bg-fg/60" />
          <div className="h-1.5 w-2/3 rounded-full bg-fg-dim/40" />
        </div>
      </div>
      <div className="h-3.5 rounded-full border border-border bg-bg-raised" />
    </div>
  );

  return (
    <button
      type="button"
      onClick={onSelect}
      aria-pressed={selected}
      title={inspired ? `Paleta inspirada em ${inspired}` : undefined}
      className="pressable group text-left"
    >
      <div
        className={cn(
          "relative h-[88px] overflow-hidden rounded-[14px] transition-[box-shadow] duration-150 ease-out",
          selected
            ? "shadow-[0_0_0_2px_var(--bg),0_0_0_4px_var(--accent)]"
            : "shadow-[inset_0_0_0_1px_var(--border)] group-hover:shadow-[inset_0_0_0_1px_var(--border-strong)]",
        )}
      >
        {id === "system" ? (
          <>
            {preview("light", "absolute inset-0")}
            {preview("dark", "absolute inset-0 [clip-path:polygon(100%_0,100%_100%,0_100%)]")}
          </>
        ) : (
          preview(id)
        )}
      </div>
      <p className={cn("mt-2 px-0.5 text-[12.5px] tracking-[-0.01em]", selected ? "text-fg" : "text-fg-dim")}>
        {label}
      </p>
    </button>
  );
}

/* ---------------------------------------------------------------------- */

function Models() {
  const provider = useStore((s) => s.connection.provider);
  const effort = useStore((s) => s.effort);
  const setEffort = useStore((s) => s.setEffort);
  const fast = useStore((s) => s.fast);
  const setFast = useStore((s) => s.setFast);
  const reasoning = useStore((s) => s.reasoningVisibility);
  const setReasoning = useStore((s) => s.setReasoningVisibility);
  const effortNote = effortCaveat(provider, effort);
  const fastNote = fastCaveat(provider);

  return (
    <Page title="Respostas" lede="Como os modelos respondem, em qualquer chat. Também dá para trocar no campo de mensagem.">
      <Card>
        <Row label="Esforço de raciocínio" hint={effortNote ?? EFFORT_HINT[effort]}>
          <select
            value={effort}
            onChange={(e) => setEffort(e.target.value as Effort)}
            aria-label="Esforço de raciocínio"
            className="h-8 rounded-lg border border-border-strong bg-bg-inset px-2 text-[12px] text-fg"
          >
            {EFFORTS.map((e) => (
              <option key={e} value={e}>{EFFORT_LABEL[e]}</option>
            ))}
          </select>
        </Row>
        <Row label="Mostrar raciocínio" hint="Quanto do raciocínio do modelo aparece no chat. Não muda a resposta.">
          <Segmented
            value={reasoning}
            options={REASONING_VISIBILITY.map((v) => ({ value: v, label: REASONING_LABEL[v] }))}
            onChange={setReasoning}
            label="Mostrar raciocínio"
          />
        </Row>
        <Row label="Rápido" hint={fastNote ?? "Prefere o provedor mais rápido para o modelo escolhido."}>
          <Switch checked={fast} onCheckedChange={setFast} aria-label="Rápido" />
        </Row>
      </Card>
    </Page>
  );
}

/* ---------------------------------------------------------------------- */

function Providers() {
  const connection = useStore((s) => s.connection);
  const setProvider = useStore((s) => s.setProvider);
  const setConnectOpen = useStore((s) => s.setConnectOpen);
  const disconnect = useStore((s) => s.disconnect);
  const connected = connection.status === "connected";
  const [ready, setReady] = useState<Partial<Record<ProviderKey, boolean>>>({});

  // Keychain lookups and `--version` probes: free, and no model is called.
  useEffect(() => {
    let live = true;
    for (const id of PROVIDERS) {
      void isConnectable(id).then((ok) => {
        if (live) setReady((r) => ({ ...r, [id]: ok }));
      });
    }
    return () => {
      live = false;
    };
  }, [connection.status, connection.provider]);

  const open = (id: ProviderKey) => {
    if (id !== connection.provider) setProvider(id);
    setConnectOpen(true);
  };

  return (
    <Page title="Provedores" lede="Um provedor responde de cada vez. As chaves dos outros ficam salvas para quando você voltar a eles.">
      <Card>
        {PROVIDERS.map((id) => {
          const meta = PROVIDER_META[id];
          const ui = connectionUi(id);
          const current = id === connection.provider && connected;
          const status = current
            ? "Em uso"
            : ready[id]
              ? isAgentKey(id) ? "CLI pronta" : "Chave salva"
              : ready[id] === false
                ? "Não configurado"
                : "…";
          return (
            <div key={id} className="flex items-center gap-3 px-4 py-3">
              <Icon icon={ui.icon} size={18} strokeWidth={1.5} color={ui.color} className="shrink-0" />
              <div className="min-w-0 flex-1">
                <p className="text-[13px] tracking-[-0.008em] text-fg">{meta.title}</p>
                <p className="truncate text-[11.5px] text-fg-faint">{meta.subtitle}</p>
              </div>
              <span className={cn("shrink-0 text-[11.5px]", current ? "text-green" : "text-fg-faint")}>{status}</span>
              <Button variant={current ? "outline" : "ghost"} onClick={() => open(id)}>
                {current ? "Gerenciar" : ready[id] ? "Usar" : "Conectar"}
              </Button>
            </div>
          );
        })}
      </Card>

      {connected ? (
        <div className="mt-4 flex items-center justify-between gap-3 rounded-[12px] border border-border px-4 py-3">
          <div className="min-w-0">
            <p className="text-[13px] text-fg">Desconectar {PROVIDER_META[connection.provider].title}</p>
            <p className="text-[11.5px] text-fg-faint">
              {isAgentKey(connection.provider)
                ? "O Atimo para de usar a CLI. O login dela continua."
                : "Apaga a chave deste computador. Para voltar, cole a chave de novo."}
            </p>
          </div>
          <Button variant="outline" className="shrink-0 hover:border-red/50 hover:text-red" onClick={() => void disconnect()}>
            Desconectar
          </Button>
        </div>
      ) : null}
    </Page>
  );
}

/* ---------------------------------------------------------------------- */

function Backup() {
  const smart = useSmartSearchToggle();
  const workspaceName = useStore((s) => s.workspaces.find((w) => w.id === s.workspaceId)?.name);

  return (
    <Page
      title="Backup"
      lede="O workspace fica num banco SQLite neste computador, sem servidor e sem sincronização. Um backup em JSON é a sua cópia de segurança."
    >
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="rounded-[14px] border border-border bg-bg-raised py-2">
          <ExportPanel label={workspaceName ?? "este workspace"} />
        </div>
        <div className="rounded-[14px] border border-border bg-bg-raised py-2">
          <ImportPanel />
        </div>
      </div>
      <p className="mt-3 text-[11.5px] leading-relaxed text-fg-faint">
        JSON restaura tudo: projetos, conversas, memória e o texto dos documentos. Markdown é para ler. Nenhum
        dos dois leva suas chaves de API. Para exportar um projeto só, use o menu do projeto.
      </p>

      {smart.hidden ? null : (
        <>
          <Label className="mt-8">Busca</Label>
          <Card>
            <Row
              label="Busca inteligente"
              hint={`${smart.detail}. Encontra chats e documentos pelo sentido, não só pelas palavras. Modelo local de 1,1 GB.`}
            >
              <Switch checked={smart.on} disabled={smart.loading} onCheckedChange={smart.toggle} aria-label="Busca inteligente" />
            </Row>
          </Card>
        </>
      )}
    </Page>
  );
}

/* ---------------------------------------------------------------------- */

const SHORTCUTS: [string, string][] = [
  ["⌘K", "Busca e comandos"],
  ["⌘N", "Novo chat"],
  ["⌘B · ⌘S", "Mostrar ou esconder a barra lateral"],
  ["⌘1", "Chat"],
  ["⌘6", "Modelos"],
  ["⌘7", "Skills"],
  ["⌘,", "Configurações"],
  ["@", "Citar um chat, projeto ou documento"],
];

type UpdateState =
  | { state: "idle" }
  | { state: "checking" }
  | { state: "none" }
  | { state: "found"; update: AvailableUpdate }
  | { state: "installing" }
  | { state: "error"; message: string };

function About() {
  const [update, setUpdate] = useState<UpdateState>({ state: "idle" });

  const check = async () => {
    setUpdate({ state: "checking" });
    try {
      const found = await checkForUpdate();
      setUpdate(found ? { state: "found", update: found } : { state: "none" });
    } catch (error) {
      setUpdate({ state: "error", message: error instanceof Error ? error.message : String(error) });
    }
  };

  const install = async (found: AvailableUpdate) => {
    setUpdate({ state: "installing" });
    try {
      await found.install();
      await restart();
    } catch (error) {
      setUpdate({ state: "error", message: error instanceof Error ? error.message : String(error) });
    }
  };

  return (
    <Page title="Sobre" lede={`Atimo ${VERSION}`}>
      <Card>
        <Row
          label="Atualizações"
          hint={
            update.state === "none"
              ? "Você está na versão mais recente."
              : update.state === "found"
                ? `A versão ${update.update.version} está disponível.`
                : update.state === "error"
                  ? update.message
                  : "O app também verifica sozinho a cada seis horas."
          }
        >
          {update.state === "found" ? (
            <Button variant="accent" onClick={() => void install(update.update)}>Instalar e reiniciar</Button>
          ) : (
            <Button
              variant="outline"
              disabled={update.state === "checking" || update.state === "installing"}
              onClick={() => void check()}
            >
              {update.state === "checking" ? "Verificando…" : update.state === "installing" ? "Instalando…" : "Verificar agora"}
            </Button>
          )}
        </Row>
      </Card>

      <h3 className="mt-6 mb-2 text-[12px] font-medium text-fg-dim">Atalhos</h3>
      <Card>
        {SHORTCUTS.map(([keys, action]) => (
          <div key={keys} className="flex items-center justify-between px-4 py-2 text-[12.5px]">
            <span className="text-fg-dim">{action}</span>
            <kbd className="rounded-md border border-border bg-bg-inset px-1.5 py-0.5 font-mono text-[11px] text-fg-dim">{keys}</kbd>
          </div>
        ))}
      </Card>

      <p className="mt-6 text-[11.5px] text-fg-faint">Licença Apache-2.0.</p>
    </Page>
  );
}

/* ---------------------------------------------------------------------- */

function Page({ title, lede, children }: { title: string; lede: string; children: ReactNode }) {
  return (
    <section>
      <header className="mb-5">
        <h2 className="text-[17px] font-semibold tracking-[-0.02em] text-fg">{title}</h2>
        <p className="mt-1 text-[12.5px] leading-relaxed text-fg-dim">{lede}</p>
      </header>
      {children}
    </section>
  );
}

function Label({ children, className }: { children: ReactNode; className?: string }) {
  return <h3 className={cn("mb-3 text-[12px] font-medium tracking-[-0.005em] text-fg-dim", className)}>{children}</h3>;
}

function Card({ children }: { children: ReactNode }) {
  return (
    <div className="divide-y divide-border overflow-hidden rounded-[14px] border border-border bg-bg-raised">
      {children}
    </div>
  );
}

function Row({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-4 px-4 py-3">
      <div className="min-w-0">
        <p className="text-[13px] tracking-[-0.008em] text-fg">{label}</p>
        {hint ? <p className="mt-0.5 text-[11.5px] leading-relaxed text-fg-faint">{hint}</p> : null}
      </div>
      <div className="shrink-0">{children}</div>
    </div>
  );
}

function Segmented<T extends string>({
  value,
  options,
  onChange,
  label,
}: {
  value: T;
  options: { value: T; label: string }[];
  onChange: (value: T) => void;
  label: string;
}) {
  return (
    <div role="radiogroup" aria-label={label} className="flex gap-0.5 rounded-lg border border-border bg-bg-inset p-0.5">
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          role="radio"
          aria-checked={value === o.value}
          onClick={() => onChange(o.value)}
          className={cn(
            "pressable rounded-md px-2.5 py-1 text-[12px] transition-[background-color,color] duration-150 ease-out",
            value === o.value ? "bg-bg-raised text-fg shadow-sm" : "text-fg-faint hover:text-fg-dim",
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}
