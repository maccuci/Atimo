import { useEffect, useRef, useState } from "react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import {
  Cancel01Icon,
  DownloadCircle01Icon,
} from "@hugeicons/core-free-icons";
import { Icon } from "@/components/ui/Icon";
import {
  checkForUpdate,
  restart,
  type AvailableUpdate,
} from "@/lib/updater";

/*
 * "There is a newer build" — as quietly as that can be said.
 *
 * Deliberately not a modal. A tester interrupted mid-sentence by a dialog about
 * plumbing learns to dismiss it without reading, and the one time it matters —
 * the build that fixes the thing they reported — it gets dismissed too. This
 * waits in the corner instead, and the app stays entirely usable around it.
 *
 * State lives here rather than in the store: nothing else in the app reads it,
 * and putting a background poller in the store would put it in the persistence
 * diff's path for no reason.
 */

/** Long enough for the window to finish opening and the catalog to land. */
const FIRST_CHECK_MS = 4_000;

/** Testers leave the app open for days. Re-asking costs one request. */
const RECHECK_MS = 6 * 60 * 60 * 1_000;

type Phase =
  | { kind: "idle" }
  | { kind: "available" }
  | { kind: "downloading"; fraction: number | null }
  | { kind: "ready" }
  | { kind: "failed"; message: string };

export function UpdateBanner() {
  const [update, setUpdate] = useState<AvailableUpdate | null>(null);
  const [phase, setPhase] = useState<Phase>({ kind: "idle" });
  const [dismissed, setDismissed] = useState(false);
  const reduceMotion = useReducedMotion();

  // Held in a ref so the poll below can read it without re-running the effect
  // every time an install advances the phase.
  const busy = useRef(false);
  busy.current = phase.kind === "downloading" || phase.kind === "ready";

  useEffect(() => {
    let cancelled = false;

    const look = async () => {
      // Never interrupt an install in flight to ask about the same version.
      if (cancelled || busy.current) return;
      const found = await checkForUpdate();
      if (cancelled || !found) return;
      setUpdate(found);
      setPhase({ kind: "available" });
      // A newer version than the one they dismissed is a new question.
      setDismissed(false);
    };

    const first = setTimeout(() => void look(), FIRST_CHECK_MS);
    const repeat = setInterval(() => void look(), RECHECK_MS);
    return () => {
      cancelled = true;
      clearTimeout(first);
      clearInterval(repeat);
    };
  }, []);

  const install = async () => {
    if (!update) return;
    setPhase({ kind: "downloading", fraction: null });
    try {
      await update.install((fraction) =>
        setPhase({ kind: "downloading", fraction }),
      );
      setPhase({ kind: "ready" });
    } catch (e) {
      // The old build is still installed and still works, which is the sentence
      // the user needs — not the stack.
      setPhase({
        kind: "failed",
        message: e instanceof Error ? e.message : "the download did not finish",
      });
    }
  };

  const visible = phase.kind !== "idle" && !dismissed;

  return (
    <AnimatePresence>
      {visible ? (
        <motion.div
          initial={reduceMotion ? { opacity: 0 } : { opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          exit={reduceMotion ? { opacity: 0 } : { opacity: 0, y: 10 }}
          transition={{
            duration: reduceMotion ? 0.12 : 0.26,
            ease: [0.23, 1, 0.32, 1],
          }}
          role="status"
          className="fixed right-4 z-40 w-[300px] overflow-hidden rounded-[12px] border border-border bg-bg-raised shadow-[var(--shadow-panel)]"
          style={{ bottom: "calc(var(--statusbar-h) + 14px + var(--safe-bottom))" }}
        >
          <div className="flex items-start gap-2.5 px-3.5 py-3">
            <Icon
              icon={DownloadCircle01Icon}
              size={14}
              strokeWidth={1.75}
              className="mt-px text-cyan"
            />

            <div className="min-w-0 flex-1">
              <Body phase={phase} version={update?.version ?? ""} />
              <Actions
                phase={phase}
                onInstall={() => void install()}
                onRestart={() => void restart()}
              />
            </div>

            {/* No dismiss mid-download: there would be nothing to cancel, and a
                banner that vanishes while the bar is moving reads as a crash. */}
            {phase.kind === "downloading" ? null : (
              <button
                type="button"
                aria-label="Fechar"
                onClick={() => setDismissed(true)}
                className="pressable -mr-1 -mt-0.5 inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-lg text-fg-faint transition-colors hover:bg-bg-hover hover:text-fg"
              >
                <Icon icon={Cancel01Icon} size={12} strokeWidth={1.75} />
              </button>
            )}
          </div>

          {phase.kind === "downloading" ? (
            <Progress fraction={phase.fraction} />
          ) : null}
        </motion.div>
      ) : null}
    </AnimatePresence>
  );
}

function Body({ phase, version }: { phase: Phase; version: string }) {
  const text = (() => {
    switch (phase.kind) {
      case "available":
        return `Atimo ${version} está disponível.`;
      case "downloading":
        return `Baixando ${version}…`;
      case "ready":
        return `Atimo ${version} foi instalado.`;
      case "failed":
        return `Não foi possível atualizar — ${phase.message}. Você continua na versão atual.`;
      default:
        return "";
    }
  })();

  return (
    <p
      className={
        phase.kind === "failed"
          ? "text-[12.5px] leading-relaxed tracking-[-0.01em] text-red"
          : "text-[12.5px] leading-relaxed tracking-[-0.01em] text-fg"
      }
    >
      {text}
    </p>
  );
}

function Actions({
  phase,
  onInstall,
  onRestart,
}: {
  phase: Phase;
  onInstall: () => void;
  onRestart: () => void;
}) {
  if (phase.kind === "downloading") return null;

  const label =
    phase.kind === "ready"
      ? "Reiniciar agora"
      : phase.kind === "failed"
        ? "Tentar de novo"
        : "Instalar e reiniciar";

  return (
    <button
      type="button"
      onClick={phase.kind === "ready" ? onRestart : onInstall}
      className="pressable mt-2 inline-flex h-7 items-center rounded-lg border border-cyan/40 bg-cyan/10 px-2.5 text-[12px] tracking-[-0.01em] text-cyan transition-[background-color] duration-150 ease-out hover:bg-cyan/20"
    >
      {label}
    </button>
  );
}

/**
 * The bar, or a sweep when the server sent no content length.
 *
 * A bar with an invented denominator is worse than no bar: it either sticks at
 * a number or finishes early, and both teach the user not to trust it.
 */
function Progress({ fraction }: { fraction: number | null }) {
  return (
    <div className="h-[2px] w-full bg-bg-active">
      {fraction === null ? (
        <div className="h-full w-1/3 animate-pulse bg-cyan/60" />
      ) : (
        <div
          className="h-full bg-cyan transition-[width] duration-200 ease-out"
          style={{ width: `${Math.round(fraction * 100)}%` }}
        />
      )}
    </div>
  );
}
