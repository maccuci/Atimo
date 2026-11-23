import { Cancel01Icon, Chatting01Icon } from "@hugeicons/core-free-icons";
import { isAgentKey } from "@/lib/adapter";
import { getModel } from "@/lib/models";
import { MAX_PANEL_MODELS, normalisePanel } from "@/lib/panel";
import { useStore } from "@/lib/store";
import { cn } from "@/lib/utils";
import { Icon } from "@/components/ui/Icon";
import { ProviderSigil } from "@/components/ui/primitives";
import { ModelPicker } from "./ModelPicker";

/*
 * Who else answers this turn.
 *
 * Sits beside the model picker rather than behind a settings toggle, because
 * the panel is a per-turn decision with a per-turn bill: it multiplies the
 * input side of every send, and the input side is where a project that prepends
 * its own knowledge to every prompt spends most of its money. A control that
 * expensive belongs where the cost is incurred, showing exactly who is on it.
 */

export function PanelPicker({
  chatId,
  modelId,
  panel,
}: {
  chatId: string;
  /** The chat's primary model — the answer that becomes the conversation. */
  modelId: string;
  panel: string[] | undefined;
}) {
  const provider = useStore((s) => s.connection.provider);
  const setChatPanel = useStore((s) => s.setChatPanel);

  /*
   * A local CLI answers as whatever the installed tool is configured to be, so
   * a panel over one would spawn several child processes to receive several
   * copies of one answer. Hidden rather than disabled: there is no setting the
   * user could change here to make it work, so a greyed-out control would only
   * pose a question with no answer.
   */
  if (isAgentKey(provider)) return null;

  const extras = normalisePanel(modelId, panel);
  const full = extras.length >= MAX_PANEL_MODELS - 1;

  return (
    <>
      {extras.map((id) => (
        <button
          key={id}
          type="button"
          onClick={() => setChatPanel(chatId, extras.filter((m) => m !== id))}
          title={`${getModel(id).label} também responde toda mensagem — clique para remover`}
          className="pressable group/chip flex h-7 shrink-0 items-center gap-1.5 rounded-full border border-border bg-bg-surface pr-2 pl-1.5 text-[11px] font-medium tracking-[-0.01em] text-fg-dim transition-[background-color,border-color,color] duration-150 ease-out hover:border-border-strong hover:bg-bg-hover hover:text-fg"
        >
          <ProviderSigil
            modelId={id}
            className="h-4 w-4 border-0 bg-transparent"
            size={11}
          />
          <span className="max-w-[110px] truncate">{getModel(id).short}</span>
          <Icon
            icon={Cancel01Icon}
            size={9}
            strokeWidth={2}
            className="opacity-0 transition-opacity duration-150 ease-out group-hover/chip:opacity-60"
          />
        </button>
      ))}

      {full ? null : (
        <ModelPicker
          modelId={modelId}
          onSelect={(id) => setChatPanel(chatId, [...extras, id])}
          triggerClassName={cn(
            "h-7 w-7 justify-center rounded-full border border-border bg-bg-surface px-0 text-[11px] font-medium",
            "hover:border-border-strong",
          )}
          trigger={
            <span
              title={
                extras.length
                  ? `Adicionar outro modelo — cada modelo do painel responde, e é cobrado, por inteiro`
                  : "Responder também com um segundo modelo — mesmo contexto, lado a lado"
              }
              className="flex items-center gap-1"
            >
              <Icon icon={Chatting01Icon} size={12} strokeWidth={1.75} />
            </span>
          }
        />
      )}
    </>
  );
}
