import { useRef } from "react";
import { Alert02Icon, Tick02Icon } from "@hugeicons/core-free-icons";
import { Icon } from "@/components/ui/Icon";
import { IMPORT_ACCEPT, count } from "@/lib/import";
import { useImport } from "@/lib/use-import";
import { cn } from "@/lib/utils";

/*
 * The other half of the export, in the menu that offers it.
 *
 * Same arrangement as `ExportPanel`, and for the same reason: a menu action
 * whose outcome appears somewhere else makes the user look away from the thing
 * they just clicked to find out whether it worked, and this app has no toast
 * layer. What it adds is the step in between — an export is a file you are
 * writing and can inspect afterwards, an import is a file you may not have
 * opened in months, so what it holds is shown before it is applied.
 *
 * The counts do the work there. "Import?" cannot distinguish the right backup
 * from last month's, and "4 projects, 2 of which replace ones already here" is
 * exactly the sentence that sends someone back to the folder for a better file.
 */

export function ImportPanel({ onClose }: { onClose?: () => void }) {
  const input = useRef<HTMLInputElement>(null);
  const { phase, choose, confirm } = useImport();

  const pick = () => input.current?.click();

  return (
    <div className="px-3 py-1.5">
      <p className="text-[12.5px] font-medium tracking-[-0.01em] text-fg">
        Restaurar de um backup
      </p>

      <input
        ref={input}
        type="file"
        accept={IMPORT_ACCEPT}
        className="hidden"
        onChange={(e) => {
          choose(e.target.files?.[0]);
          // Cleared so picking the same file twice still fires a change — the
          // second attempt after an error is usually the same file.
          e.target.value = "";
        }}
      />

      {phase.state === "ready" || phase.state === "running" ? (
        <div className="mt-1 text-[11px] leading-relaxed text-fg-dim">
          <p>
            <span className="text-fg">{phase.plan.label}</span>
            {phase.plan.exportedAt
              ? `, exportado em ${phase.plan.exportedAt.slice(0, 10)}`
              : ""}{" "}
            pelo Atimo {phase.plan.app}.
          </p>
          <p className="mt-1">
            {[
              count(phase.plan.totals.projects, "projects"),
              count(phase.plan.totals.chats, "chats"),
              count(phase.plan.totals.messages, "messages"),
              count(phase.plan.totals.documents, "documents"),
            ].join(", ")}
            .
          </p>
          <p className="mt-1">
            {phase.plan.replacing > 0 ? (
              <>
                <span className="text-fg">
                  {count(phase.plan.replacing, "projects")}
                </span>{" "}
                já existe{phase.plan.replacing === 1 ? "" : "m"} aqui, e a cópia do arquivo
                substitui. Nada mais é alterado — restaurar só adiciona.
              </>
            ) : (
              <>Nada que já está neste workspace é alterado ou removido.</>
            )}
          </p>
        </div>
      ) : phase.state === "done" ? (
        <p className="mt-1 flex items-start gap-1.5 text-[11px] leading-relaxed text-fg-dim">
          <Icon
            icon={Tick02Icon}
            size={12}
            strokeWidth={2}
            className="mt-[3px] shrink-0 text-green"
          />
          <span>
            Restored <span className="text-fg">{phase.plan.label}</span> —{" "}
            {count(phase.plan.totals.projects, "projects")},{" "}
            {count(phase.plan.totals.messages, "messages")}.
            {phase.outcome.documentsWithoutText > 0 ? (
              <span className="text-red">
                {" "}
                The text of{" "}
                {count(phase.outcome.documentsWithoutText, "documents")} could
                not be written, so {phase.outcome.documentsWithoutText === 1
                  ? "it is listed but empty"
                  : "they are listed but empty"}
                .
              </span>
            ) : null}
            {phase.outcome.attachmentsWithoutBytes > 0 ? (
              <span className="text-red">
                {" "}
                {count(phase.outcome.attachmentsWithoutBytes, "attachments")}{" "}
                could not be written, so the{" "}
                {phase.outcome.attachmentsWithoutBytes === 1
                  ? "message that carried it names it"
                  : "messages that carried them name them"}{" "}
                but cannot show{" "}
                {phase.outcome.attachmentsWithoutBytes === 1 ? "it" : "them"}.
              </span>
            ) : null}
          </span>
        </p>
      ) : phase.state === "error" ? (
        <p className="mt-1 flex items-start gap-1.5 text-[11px] leading-relaxed text-red">
          <Icon
            icon={Alert02Icon}
            size={12}
            strokeWidth={1.75}
            className="mt-[3px] shrink-0"
          />
          <span>{phase.message}</span>
        </p>
      ) : (
        <p className="mt-1 text-[11px] leading-relaxed text-fg-dim">
          O arquivo JSON de uma exportação do Atimo. Projetos, conversas e
          arquivos voltam com o histórico. A restauração só adiciona a este
          workspace; nada daqui é apagado.
        </p>
      )}

      {/* Nothing to offer once it has landed — the only thing left is to close
          the menu, and an empty row above that button reads as a missing one. */}
      {phase.state === "done" ? null : (
        <div className="mt-2.5 flex items-center gap-1.5">
          {phase.state === "ready" || phase.state === "running" ? (
            <>
              <Action
                label={phase.state === "running" ? "Restaurando…" : "Restaurar"}
                tone="primary"
                busy={phase.state === "running"}
                onSelect={() => void confirm()}
              />
              <Action
                label="Outro arquivo"
                busy={phase.state === "running"}
                onSelect={pick}
              />
            </>
          ) : (
            <Action
              label={
                phase.state === "reading"
                  ? "Lendo…"
                  : phase.state === "error"
                    ? "Escolher outro arquivo"
                    : "Escolher um arquivo"
              }
              tone="primary"
              busy={phase.state === "reading"}
              onSelect={pick}
            />
          )}
        </div>
      )}

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

function Action({
  label,
  tone,
  busy,
  onSelect,
}: {
  label: string;
  tone?: "primary";
  busy: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      disabled={busy}
      className={cn(
        "pressable h-6 flex-1 rounded-md border text-[11.5px] font-medium transition-[background-color,border-color,color,opacity] duration-150 ease-out",
        tone === "primary"
          ? "border-cyan/40 bg-cyan/10 text-cyan hover:bg-cyan/20"
          : "border-border text-fg-dim hover:border-border-strong hover:text-fg",
        "disabled:pointer-events-none disabled:opacity-40",
      )}
    >
      {label}
    </button>
  );
}
