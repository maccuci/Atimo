import { ChevronRight } from "lucide-react";
import type { ResearchRecord } from "@/lib/research-orchestrator";
import { sourceUrl } from "@/lib/research-provider";
import { openExternal } from "@/lib/open-external";

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

function Link({ href, children }: { href: string; children: React.ReactNode }) {
  return <a href={href} onClick={(e) => { e.preventDefault(); void openExternal(href); }} className="text-cyan hover:underline">{children}</a>;
}

/**
 * One quiet line under the answer; the detail opens on demand. Only what needs action before
 * running the SQL (columns the docs don't list) stays visible.
 */
export function ResearchSources({ research }: { research: ResearchRecord }) {
  const sources = [...new Map(research.results.flatMap((r) => r.sources).map((s) => [s.url, s])).values()].filter((s) => sourceUrl(s.url));
  const tables = research.dictionary?.tables ?? [];
  const issues = research.dictionary?.issues ?? [];
  const joins = research.dictionary?.joins ?? [];
  const rules = research.dictionary?.rules ?? [];
  // Providers often attach their own answer as every source's snippet: that says nothing about the page.
  const shared = new Set(sources.map((s) => s.snippet).filter((s, i, all) => s && all.indexOf(s) !== i));
  const providers = [...new Set(research.results.map((r) => `${r.provider} · ${r.model}`))];
  const last = research.results.at(-1)?.searchedAt;
  if (!tables.length && !sources.length && !issues.length && !joins.length && !rules.length && !research.warning) return null;

  return <div className="mt-3 border-t border-border pt-2 text-[11px] text-fg-dim">
    {issues.length ? <p role="status" className="mb-1.5 text-amber-400">
      Itens que a documentação Oracle não lista (confira antes de usar): {issues.join(", ")}
    </p> : null}
    {joins.length ? <p role="status" className="mb-1.5 text-amber-400">
      Outer join (+) incompleto em {joins.join(", ")}: um predicado sem (+) vira inner join e some com quem não tem a linha.
    </p> : null}
    {rules.map((rule) => <p key={rule} role="status" className="mb-1.5 text-amber-400">{rule}.</p>)}
    <details className="group">
      <summary className="flex cursor-pointer select-none list-none items-center gap-1 text-fg-faint transition-colors duration-150 hover:text-fg-dim [&::-webkit-details-marker]:hidden">
        <ChevronRight aria-hidden className="size-3 transition-transform duration-150 ease-out group-open:rotate-90 motion-reduce:transition-none" />
        <span>Fontes</span>
        {tables.length ? <span>· {plural(tables.length, "página Oracle", "páginas Oracle")}</span> : null}
        {sources.length ? <span>· {plural(sources.length, "link", "links")}{research.reused ? " (reutilizados)" : ""}</span> : null}
        {research.warning ? <span className="text-amber-400/80">· aviso</span> : null}
      </summary>
      <div className="mt-2 space-y-2 pl-4">
        {tables.length ? <p>
          <span className="text-fg-faint">Documentação Oracle (FA Latest): </span>
          {tables.map((t, i) => <span key={t.name}>{i ? ", " : ""}<Link href={t.url}>{t.name}</Link></span>)}
        </p> : null}
        {sources.length ? <ol className="space-y-1">
          {sources.map((s, i) => <li key={s.url}>
            <Link href={s.url}>[{i + 1}] {s.title}</Link>
            <span className="ml-1.5 text-fg-faint">
              {s.official ? "oficial" : "comunidade"}{s.version ? ` · ${s.version}` : ""} · {s.document ? "lida pelo Atimo" : s.providerRead ? "lida pelo Gemini" : s.verification === "checked" ? "não lida · link ok" : "não lida"}
            </span>
            {s.document ? <details className="mt-0.5 text-fg-faint"><summary className="cursor-pointer">Trecho{s.document.truncated ? " (parcial)" : ""}</summary>
              <pre className="mt-1 max-h-64 overflow-auto whitespace-pre-wrap font-sans">{s.document.excerpt}</pre></details> : null}
            {s.snippet && !shared.has(s.snippet) ? <p className="mt-0.5 line-clamp-2 text-fg-faint">{s.snippet}</p> : null}
          </li>)}
        </ol> : null}
        {research.warning ? <p className="text-amber-400/90">{research.warning}</p> : null}
        {providers.length ? <p className="text-fg-faint">
          {providers.join(", ")}{last ? ` · ${new Date(last).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}` : ""}
        </p> : null}
      </div>
    </details>
  </div>;
}
