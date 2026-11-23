import { useState } from "react";
import { Tick02Icon } from "@hugeicons/core-free-icons";
import { Icon } from "@/components/ui/Icon";
import { useStore } from "@/lib/store";
import type { ExportFormat } from "@/lib/export-file";
import { cn } from "@/lib/utils";

/*
 * The second step of an export, inside the menu that started it.
 *
 * Same arrangement as the project delete confirmation, and for the same reason:
 * a menu action whose outcome appears somewhere else — a toast, a status bar —
 * makes the user look away from the thing they just clicked to find out whether
 * it worked. This app has no toast layer, and an export is precisely the
 * operation where "did that work?" must not be a guess.
 *
 * It also has to answer *where*, which is the whole point of the feature. The
 * desktop build opens the file manager on the file, so the confirmation only
 * has to name it; a browser download goes wherever that browser puts downloads
 * and nothing here can find out where, so it says the honest, vaguer thing.
 */

type Phase =
  | { state: "idle" }
  | { state: "running"; format: ExportFormat }
  | { state: "done"; name: string; revealed: boolean }
  | { state: "error"; message: string };

export function ExportPanel({
  projectId,
  label,
  onClose,
}: {
  /** Omitted for the whole workspace. */
  projectId?: string;
  /** What is being exported, named. */
  label: string;
  /** Omitted when the panel sits on a page rather than in a menu. */
  onClose?: () => void;
}) {
  const exportWorkspace = useStore((s) => s.exportWorkspace);
  const [phase, setPhase] = useState<Phase>({ state: "idle" });

  const run = async (format: ExportFormat) => {
    setPhase({ state: "running", format });
    try {
      const saved = await exportWorkspace({ projectId, format });
      setPhase({ state: "done", ...saved });
    } catch (error) {
      setPhase({
        state: "error",
        message: error instanceof Error ? error.message : String(error),
      });
    }
  };

  const busy = phase.state === "running";

  return (
    <div className="px-3 py-1.5">
      <p className="text-[12.5px] font-medium tracking-[-0.01em] text-fg">
        Exportar {label}
      </p>

      {phase.state === "done" ? (
        <p className="mt-1 flex items-start gap-1.5 text-[11px] leading-relaxed text-fg-dim">
          <Icon
            icon={Tick02Icon}
            size={12}
            strokeWidth={2}
            className="mt-[3px] shrink-0 text-green"
          />
          <span>
            <span className="text-fg">{phase.name}</span> salvo
            {phase.revealed
              ? ", e a pasta foi aberta."
              : " na pasta de downloads."}
          </span>
        </p>
      ) : phase.state === "error" ? (
        <p className="mt-1 text-[11px] leading-relaxed text-red">
          {phase.message}
        </p>
      ) : (
        <p className="mt-1 text-[11px] leading-relaxed text-fg-dim">
          Tudo o que ele guarda: conversas e o texto de cada documento
          enviado. Sem chaves de API — elas ficam no Keychain do sistema,
          não no workspace.
        </p>
      )}

      <div className="mt-2.5 flex items-center gap-1.5">
        <FormatButton
          format="json"
          title="Completo e restaurável"
          busy={busy}
          running={phase.state === "running" && phase.format === "json"}
          onSelect={() => void run("json")}
        />
        <FormatButton
          format="md"
          title="Legível, sem os diagnósticos"
          busy={busy}
          running={phase.state === "running" && phase.format === "md"}
          onSelect={() => void run("md")}
        />
      </div>

      {onClose ? (
      <button
        type="button"
        onClick={onClose}
        className="pressable mt-1.5 h-6 w-full rounded-md border border-border text-[11.5px] text-fg-dim transition-[background-color,border-color,color] duration-150 ease-out hover:border-border-strong hover:text-fg"
      >
        {phase.state === "done" ? "Concluir" : "Cancelar"}
      </button>
      ) : null}
    </div>
  );
}

const FORMAT_LABEL: Record<ExportFormat, string> = {
  json: "JSON",
  md: "Markdown",
};

function FormatButton({
  format,
  title,
  busy,
  running,
  onSelect,
}: {
  format: ExportFormat;
  title: string;
  busy: boolean;
  running: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      title={title}
      onClick={onSelect}
      disabled={busy}
      className={cn(
        "pressable h-6 flex-1 rounded-md border text-[11.5px] font-medium transition-[background-color,border-color,color,opacity] duration-150 ease-out",
        "border-cyan/40 bg-cyan/10 text-cyan hover:bg-cyan/20",
        "disabled:pointer-events-none",
        // Only the button that is working dims; the other stays legible so the
        // row does not read as the whole panel having been disabled.
        busy && !running && "opacity-40",
      )}
    >
      {running ? "Gravando…" : FORMAT_LABEL[format]}
    </button>
  );
}
