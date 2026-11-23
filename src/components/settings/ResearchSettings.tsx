import { useStore } from "@/lib/store";
import { useEffect, useState } from "react";
import { adapter, KEY_STORAGE } from "@/lib/adapter";
import { monthlyUsage, useResearchSettings } from "@/lib/research-settings";
import { cn, formatCost } from "@/lib/utils";
import { Button } from "@/components/ui/primitives";
import { Switch } from "@/components/ui/switch";
import type { ResearchProvider } from "@/lib/research-provider";

// Same shell as the connect sheet's key field, so both halves read as one screen.
const field =
  "mt-1.5 w-full rounded-[10px] border border-border-strong bg-bg-inset px-3 py-2 text-[12px] text-fg focus:border-cyan/50 focus:outline-none";
const label = "block text-[11.5px] text-fg-faint";

export function ResearchSettings() {
  const settings = useResearchSettings();
  const [key, setKey] = useState("");
  const [hint, setHint] = useState<string | null>(null);
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const { configure, provider } = settings;
  const usage = monthlyUsage(settings.calls);
  useEffect(() => {
    let live = true;
    setKey(""); setNotice(""); setHint(null);
    void adapter.credentialStatus(provider).then((status) => { if (live) setHint(status.hint); })
      .catch((error) => { if (live) setNotice(String(error)); });
    return () => { live = false; };
  }, [provider]);
  const saveKey = async (remove = false) => {
    setBusy(true); setNotice("");
    try {
      const connection = useStore.getState();
      if (provider === "openrouter" && connection.connection.provider === "openrouter") {
        if (remove) await connection.disconnect();
        else {
          await connection.connect(key, "openrouter");
          const error = useStore.getState().connection.error;
          if (error) throw new Error(error);
        }
      } else if (remove) await adapter.credentialClear(provider);
      else await adapter.credentialSet(provider, key);
      const status = await adapter.credentialStatus(provider);
      setHint(status.hint); setKey("");
      setNotice(remove ? "Chave removida." : "Chave salva. O acesso ao grounding será validado na primeira pesquisa.");
    } catch (error) { setNotice(String(error)); }
    finally { setBusy(false); }
  };
  const groups = new Map<string, { calls: number; input: number; output: number; searches: number; cost: number; unknown: number }>();
  for (const call of usage.calls) {
    const name = `${call.provider} · ${call.model}`;
    const row = groups.get(name) ?? { calls: 0, input: 0, output: 0, searches: 0, cost: 0, unknown: 0 };
    row.calls++; row.input += call.inputTokens ?? 0; row.output += call.outputTokens ?? 0;
    row.searches += call.searches ?? 0; row.cost += call.costUsd ?? 0; row.unknown += Number(call.costUsd === null);
    groups.set(name, row);
  }
  const keyName = provider === "gemini" ? "Google Gemini" : "OpenRouter";
  return (
    <section className="space-y-4 text-[12px] text-fg-dim" aria-label="Pesquisa Oracle Fusion e consumo">
      <p className="text-[12.5px] leading-relaxed">
        Busca na web antes de responder perguntas de Oracle Fusion. Usa um provedor próprio,
        independente do modelo do chat.
      </p>

      <label className="flex cursor-pointer items-start justify-between gap-3 rounded-[10px] border border-border bg-bg-inset px-3 py-2.5">
        <span className="min-w-0">
          <span className="block text-[12.5px] font-medium tracking-[-0.01em] text-fg">Permitir pesquisa externa</span>
          <span className="mt-0.5 block text-[11px] leading-relaxed text-fg-faint">
            Envia a pergunta e as perguntas recentes desta conversa ao provedor. Documentos e
            anexos nunca vão. Remova dados de clientes e de produção antes.
          </span>
        </span>
        <Switch
          checked={settings.externalConsent}
          aria-label="Permitir pesquisa externa"
          onCheckedChange={(checked) => configure({ externalConsent: checked })}
          className="mt-0.5 shrink-0"
        />
      </label>

      <div className="grid grid-cols-2 gap-3">
        <label className={label}>Provedor
          <select className={field} value={provider} disabled={busy} onChange={(e) => configure({ provider: e.target.value as ResearchProvider })}>
            <option value="gemini">Google Gemini</option>
            <option value="openrouter">OpenRouter (Exa)</option>
          </select>
        </label>
        <label className={label}>Modelo
          <input className={cn(field, "font-mono")} value={provider === "gemini" ? settings.geminiModel : settings.openrouterModel}
            spellCheck={false} onChange={(e) => configure(provider === "gemini" ? { geminiModel: e.target.value } : { openrouterModel: e.target.value })} />
        </label>
      </div>

      <div>
        <span className={label}>
          Chave {keyName}{" "}
          {hint
            ? <span className="font-mono text-green">···{hint}</span>
            : <span>· não configurada</span>}
        </span>
        <div className="mt-1.5 flex items-center gap-2">
          <input className={cn(field, "mt-0 flex-1 font-mono")} type="password" autoComplete="off" spellCheck={false} value={key}
            placeholder={hint ? "Colar outra chave" : "Cole a chave"} aria-label={`Chave ${keyName}`}
            onChange={(e) => setKey(e.target.value)} onKeyDown={(e) => e.key === "Enter" && key.trim() && void saveKey()} />
          <Button variant="accent" className="h-[34px]" disabled={busy || !key.trim()} onClick={() => void saveKey()}>Salvar</Button>
        </div>
        <div className="mt-1.5 flex items-center justify-between gap-2 text-[11px] text-fg-faint">
          <span>
            {KEY_STORAGE[adapter.kind]}
            {provider === "openrouter" ? " · mesma chave do provedor de modelos" : ""}
          </span>
          {hint ? <button className="pressable hover:text-red disabled:opacity-40" disabled={busy} onClick={() => void saveKey(true)}>Remover</button> : null}
        </div>
        {notice ? <p role="status" className="mt-1.5 text-[11.5px]">{notice}</p> : null}
      </div>

      <div className="rounded-[10px] border border-border px-3 py-2.5">
        <div className="flex items-baseline justify-between gap-3">
          <span className="text-[11.5px] text-fg-faint">Este mês</span>
          <span className="text-[12.5px] tabular-nums text-fg">
            {formatCost(usage.spent)}
            {settings.monthlyBudget !== null ? <span className="text-fg-faint"> / {formatCost(settings.monthlyBudget)}</span> : null}
          </span>
        </div>
        <p className="mt-0.5 text-[11px] tabular-nums text-fg-faint">
          {usage.calls.length} chamadas{usage.unknown ? ` · ${usage.unknown} com custo desconhecido` : ""}
        </p>
        <label className={cn(label, "mt-3")}>Orçamento mensal em USD
          <input className={cn(field, "tabular-nums")} type="number" min="0" step="0.01" placeholder="Sem limite" value={settings.monthlyBudget ?? ""}
            onChange={(e) => { const value = e.target.value === "" ? null : Number(e.target.value); if (value === null || (Number.isFinite(value) && value >= 0)) configure({ monthlyBudget: value }); }} />
        </label>
        <div className="mt-2"><BudgetNotice /></div>
      </div>

      {groups.size ? (
        <div className="scroll-thin overflow-x-auto">
          <table className="w-full text-left text-[11px] tabular-nums">
            <thead className="text-fg-faint">
              <tr><th className="pb-1.5 font-normal">Provedor / modelo</th><th className="pb-1.5 text-right font-normal">Chamadas</th><th className="pb-1.5 text-right font-normal">In / out</th><th className="pb-1.5 text-right font-normal">Buscas*</th><th className="pb-1.5 text-right font-normal">USD</th></tr>
            </thead>
            <tbody>{[...groups].map(([name, row]) => (
              <tr key={name} className="border-t border-border">
                <td className="max-w-36 break-words py-1.5 pr-2 text-fg">{name}</td>
                <td className="text-right">{row.calls}</td>
                <td className="text-right">{row.input} / {row.output}</td>
                <td className="text-right">{row.searches}</td>
                <td className="text-right">{formatCost(row.cost)}{row.unknown ? " + ?" : ""}</td>
              </tr>
            ))}</tbody>
          </table>
        </div>
      ) : null}

      <details className="group text-[11px] leading-relaxed text-fg-faint">
        <summary className="cursor-pointer list-none hover:text-fg-dim">
          <span className="inline-block transition-transform duration-150 ease-out group-open:rotate-90">›</span> Como o custo é calculado
        </summary>
        <div className="mt-1.5 space-y-1.5 pl-3">
          <p>Os valores incluem estimativas e reservas de chamadas em andamento ou interrompidas, calculados por mês UTC. Chamadas com erro ou canceladas continuam no registro.</p>
          <p>Coding Plan e CLIs usam assinatura: custo incremental zero, mas as cotas continuam valendo. Buscas internas, modelos sem preço e anexos podem não ter custo conhecido antes da chamada.</p>
          <p>O bloqueio usa o gasto registrado e reserva o teto de tokens quando dá para calcular. Não substitui o limite na conta do provedor. Não há chamadas ao Web Search MCP da Z.ai.</p>
          {groups.size ? <p>* Buscas: quantidade informada pelo Gemini; o OpenRouter não informa.</p> : null}
        </div>
      </details>
    </section>
  );
}

export function BudgetNotice() {
  const budget = useResearchSettings((s) => s.monthlyBudget);
  const calls = useResearchSettings((s) => s.calls);
  const { spent } = monthlyUsage(calls);
  if (budget === null || (budget > 0 && spent < budget * 0.8)) return null;
  return <p role="alert" className="text-[11px] text-red">{spent >= budget ? "Limite mensal atingido. Novas chamadas pagas estão bloqueadas." : "Atenção: 80% do orçamento mensal atingido."}</p>;
}
