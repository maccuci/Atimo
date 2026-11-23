import { useEffect, useRef, useState } from "react";
import { LinkSquare02Icon, Plug01Icon, RefreshIcon, Settings02Icon } from "@hugeicons/core-free-icons";
import { Icon } from "@/components/ui/Icon";
import { Menu, MenuItem, MenuSeparator } from "@/components/ui/Menu";
import { PROVIDER_META, type ProviderKey } from "@/lib/adapter";
import { openExternal } from "@/lib/open-external";
import { connectionUi } from "@/lib/provider-ui";
import { useStore } from "@/lib/store";
import {
  MANAGE_USAGE,
  currentLeft,
  refreshUsage,
  resetLabel,
  supportsUsage,
  tightestLeft,
  usageKey,
  useUsage,
  type UsageRow,
  type UsageSnapshot,
} from "@/lib/usage-limits";
import { cn } from "@/lib/utils";
import { relativeTime } from "./primitives";

/**
 * The rail's footer, after ChatGPT's: who is answering (and the way into
 * settings) on the left, the plan's limits as a ring on the right.
 */
export function AccountFooter({ active, onNavigate }: { active: boolean; onNavigate?: () => void }) {
  const status = useStore((s) => s.connection.status);
  const provider = useStore((s) => s.connection.provider);
  const zaiPlan = useStore((s) => s.connection.zaiPlan);
  return (
    <div className="flex items-center gap-1">
      <AccountMenu active={active} onNavigate={onNavigate} />
      {status === "connected" && supportsUsage(provider, zaiPlan) ? <UsageButton /> : null}
    </div>
  );
}

/* ---- account ------------------------------------------------------------ */

function AccountMenu({ active, onNavigate }: { active: boolean; onNavigate?: () => void }) {
  const connection = useStore((s) => s.connection);
  const setView = useStore((s) => s.setView);
  const setConnectOpen = useStore((s) => s.setConnectOpen);
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);

  const connected = connection.status === "connected";
  const title = PROVIDER_META[connection.provider].title;
  const detail = connected
    ? (connection.account?.label ?? "Conectado")
    : connection.status === "connecting"
      ? "Conectando…"
      : connection.status === "error"
        ? "Precisa de atenção"
        : "Nenhum provedor conectado";
  const go = (fn: () => void) => {
    setOpen(false);
    fn();
    onNavigate?.();
  };

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-current={active ? "page" : undefined}
        title="Conta e configurações"
        onClick={() => setOpen((v) => !v)}
        className={cn(
          "pressable flex min-w-0 flex-1 items-center gap-2.5 rounded-[10px] px-2 py-1.5 text-left",
          "transition-[background-color,color] duration-150 ease-out hover:duration-0",
          active || open ? "bg-bg-active text-fg" : "text-fg-dim hover:bg-bg-hover hover:text-fg",
        )}
      >
        <ProviderAvatar provider={connection.provider} connected={connected} status={connection.status} />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[13px] tracking-[-0.008em]">{connected ? title : "Configurações"}</span>
          <span className="block truncate text-[11px] text-fg-faint">{detail}</span>
        </span>
      </button>

      <Menu open={open} anchor={triggerRef} onClose={() => setOpen(false)} label="Conta" width={244}>
        <div className="flex items-center gap-2.5 px-3 pt-1 pb-2">
          <ProviderAvatar provider={connection.provider} connected={connected} />
          <div className="min-w-0">
            <p className="truncate text-[13px] tracking-[-0.008em] text-fg">{title}</p>
            <p className="truncate text-[11.5px] text-fg-faint">{detail}</p>
          </div>
        </div>
        <MenuSeparator />
        <MenuItem icon={Settings02Icon} label="Configurações" detail="⌘," onSelect={() => go(() => setView("settings"))} />
        <MenuItem
          icon={Plug01Icon}
          label={connected ? "Trocar provedor" : "Conectar provedor"}
          onSelect={() => go(() => setConnectOpen(true))}
        />
      </Menu>
    </>
  );
}

function ProviderAvatar({
  provider,
  connected,
  status,
}: {
  provider: ProviderKey;
  connected: boolean;
  /** Draws the status dot; left out inside the menu, which already says it. */
  status?: string;
}) {
  const ui = connectionUi(provider);
  return (
    <span className="relative flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-bg-active">
      {connected ? (
        <Icon icon={ui.icon} size={15} strokeWidth={1.6} color={ui.color} />
      ) : (
        <Icon icon={Settings02Icon} size={15} strokeWidth={1.6} />
      )}
      {status ? (
        <span
          aria-hidden
          className={cn(
            "absolute -right-px -bottom-px h-2 w-2 rounded-full ring-2 ring-bg-sidebar",
            status === "connected" ? "bg-green" : status === "error" ? "bg-amber" : "bg-fg-faint",
          )}
        />
      ) : null}
    </span>
  );
}

/* ---- usage -------------------------------------------------------------- */

const tone = (left: number | null) => (left === null ? "" : left < 10 ? "text-red" : left < 25 ? "text-amber" : "");

function UsageButton() {
  const provider = useStore((s) => s.connection.provider);
  const zaiPlan = useStore((s) => s.connection.zaiPlan);
  const snapshot = useUsage((s) => s.snapshots[usageKey(provider, zaiPlan)]);
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);

  // On connect, so the ring has a value before anyone opens it; again on open.
  useEffect(() => {
    void refreshUsage(provider, zaiPlan);
  }, [provider, zaiPlan]);

  const left = tightestLeft(snapshot);
  const label = left === null ? "Uso e limites" : `Uso e limites: ${Math.round(left)}% restante`;

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={label}
        title={label}
        onClick={() => {
          if (!open) void refreshUsage(provider, zaiPlan);
          setOpen((v) => !v);
        }}
        className={cn(
          "pressable inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-[10px]",
          "transition-[background-color,color] duration-150 ease-out hover:duration-0",
          open ? "bg-bg-active text-fg" : "text-fg-dim hover:bg-bg-hover hover:text-fg",
        )}
      >
        <UsageRing left={left} />
      </button>

      <Menu
        open={open}
        anchor={triggerRef}
        onClose={() => setOpen(false)}
        label="Uso e limites"
        role="dialog"
        width={272}
        className="p-1.5"
      >
        <UsagePanel provider={provider} snapshot={snapshot} />
      </Menu>
    </>
  );
}

const RING_R = 7.25;
const RING_C = 2 * Math.PI * RING_R;

/** What is left of the tightest window. Dashed while nothing has been read. */
function UsageRing({ left }: { left: number | null }) {
  return (
    <svg width="18" height="18" viewBox="0 0 18 18" aria-hidden className={cn("-rotate-90", tone(left))}>
      <circle
        cx="9"
        cy="9"
        r={RING_R}
        fill="none"
        stroke="currentColor"
        strokeOpacity={left === null ? 0.5 : 0.2}
        strokeWidth="2"
        strokeDasharray={left === null ? "1.5 2.6" : undefined}
      />
      {left !== null ? (
        <circle
          cx="9"
          cy="9"
          r={RING_R}
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeDasharray={`${(left / 100) * RING_C} ${RING_C}`}
          // A new reading is news, so it eases in; reduced motion just swaps.
          className="transition-[stroke-dasharray] duration-[400ms] ease-[var(--ease-out)] motion-reduce:transition-none"
        />
      ) : null}
    </svg>
  );
}

function UsagePanel({ provider, snapshot }: { provider: ProviderKey; snapshot: UsageSnapshot | undefined }) {
  const loading = useUsage((s) => s.loading);
  const error = useUsage((s) => s.error);
  const now = Date.now();
  const claude = provider === "claude-cli";
  const manage = MANAGE_USAGE[provider];
  const ago = snapshot ? relativeTime(new Date(snapshot.at).toISOString()) : "";
  const when = ago === "agora" ? "agora" : `há ${ago}`;

  return (
    <div>
      <div className="flex items-center gap-2 px-3 pt-1 pb-2">
        <p className="min-w-0 flex-1 truncate text-[12px] text-fg-faint">
          Fonte de uso: {snapshot?.source ?? PROVIDER_META[provider].title}
        </p>
        {loading ? (
          <Icon icon={RefreshIcon} size={12} strokeWidth={1.75} className="shrink-0 animate-spin text-fg-faint motion-reduce:animate-none" />
        ) : null}
      </div>
      <MenuSeparator />

      {snapshot?.rows.length ? (
        <div className="py-0.5">
          {snapshot.rows.map((row) => (
            <UsageLine key={row.label} row={row} now={now} />
          ))}
        </div>
      ) : (
        <p className="px-3 py-2 text-[12px] leading-relaxed text-fg-dim">
          {claude
            ? "Os limites aparecem depois da próxima resposta do Claude."
            : loading
              ? "Lendo os limites…"
              : error
                ? `Não deu para ler os limites agora. ${error}`
                : "Este plano não informa limites."}
        </p>
      )}

      {/* Claude's numbers are only as fresh as the last answer; say so. */}
      {snapshot && (claude || error) ? (
        <p className="px-3 pt-0.5 pb-1.5 text-[11px] text-fg-faint">
          {claude ? `Lido na última resposta, ${when}` : `Não atualizou; última leitura ${when}`}
        </p>
      ) : null}

      {manage ? (
        <>
          <MenuSeparator />
          <button
            type="button"
            onClick={() => void openExternal(manage)}
            className={cn(
              "pressable flex w-full items-center justify-between gap-2 rounded-[6px] px-3 py-1.5 text-left text-[12.5px] tracking-[-0.01em] text-fg-dim outline-none",
              "transition-[background-color,color] duration-150 ease-out hover:bg-bg-hover hover:text-fg hover:duration-0 focus-visible:bg-bg-hover focus-visible:text-fg focus-visible:duration-0",
            )}
          >
            Gerenciar uso
            <Icon icon={LinkSquare02Icon} size={13} strokeWidth={1.75} className="text-fg-faint" />
          </button>
        </>
      ) : null}
    </div>
  );
}

function UsageLine({ row, now }: { row: UsageRow; now: number }) {
  const left = currentLeft(row, now);
  // A window that reset since the reading is shown fresh, not as last seen.
  const value = left !== null && left !== row.left ? `${Math.round(left)}% restante` : row.value;
  return (
    <div className="px-3 py-1.5">
      <div className="flex items-baseline justify-between gap-3">
        <span className="min-w-0 truncate text-[13px] tracking-[-0.008em] text-fg">{row.label}</span>
        <span className={cn("shrink-0 text-[12.5px] tabular-nums text-fg-dim", tone(left))}>{value}</span>
      </div>
      {row.resetsAt !== null ? (
        <p className="mt-0.5 text-[11px] text-fg-faint tabular-nums">{resetLabel(row.resetsAt, now)}</p>
      ) : null}
    </div>
  );
}
