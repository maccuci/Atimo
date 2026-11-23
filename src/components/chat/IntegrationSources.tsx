import type { ComposedContext } from "@/lib/types";

const dependencyStatus = {
  included: "arquivo disponível",
  missing: "arquivo não fornecido neste documento/pacote",
  external: "externa ou não resolvida; não consultada",
  skipped: "arquivo não indexado",
};

/** Persisted with the turn, so later uploads cannot change its coverage. */
export function IntegrationSources({ context }: { context: ComposedContext }) {
  const reviews = context.chunks.flatMap((chunk) => chunk.included && chunk.review ? [chunk.review] : []);
  if (!reviews.length) return null;
  return <div className="mt-3 space-y-2 border-t border-border pt-2 text-[11px] text-fg-dim">
    {reviews.map((review, index) => <details key={`${review.document}-${index}`}>
      <summary className="cursor-pointer break-words text-fg-faint hover:text-fg-dim">
        Arquivos e cobertura · {review.document} · {review.coverage.filter((file) => file.sentParts > 0).length}/{review.coverage.length} arquivos no contexto
        {review.findings.length ? ` · ${review.findings.length} alertas estáticos` : ""}
      </summary>
      <div className="mt-2 space-y-2">
        <p>Cobertura do texto enviado ao modelo. A execução no Oracle não foi verificada.</p>
        <ul className="max-h-64 space-y-1 overflow-auto">
          {review.coverage.map((file) => <li key={file.path} className="break-words">
            <span className="font-mono">{file.path}</span>{" · "}
            {file.reason ? `não indexado: ${file.reason}` : file.sentParts === 0 && file.sameAs ? `idêntico a ${file.sameAs}`
              : file.sentParts === 0 ? "fora do contexto"
              : `${file.sentParts}/${file.parts} trechos · ${file.sentParts === file.parts ? "texto completo" : "texto parcial"}`}
            {file.ranges.length ? <span className="text-fg-faint"> · {file.ranges.map((range) => `${range.startLine}:${range.startColumn}–${range.endLine}:${range.endColumn}`).join(", ")}</span> : null}
          </li>)}
        </ul>
        {review.findings.length ? <div>
          <p className="font-medium">Verificações estáticas de XML e dependências</p>
          <ul className="max-h-48 space-y-1 overflow-auto text-amber-400">
            {review.findings.map((finding, i) => <li key={i} className="break-words">
              <span className="font-mono">{finding.path}:{finding.line}</span> · {finding.message}
            </li>)}
          </ul>
        </div> : null}
        {review.dependencies.length ? <details>
          <summary className="cursor-pointer">Dependências declaradas ({review.dependencies.length})</summary>
          <ul className="mt-1 max-h-48 space-y-1 overflow-auto">
            {review.dependencies.map((dependency, i) => <li key={i} className="break-words">
              <span className="font-mono">{dependency.path}:{dependency.line}</span> → {dependency.target} · {dependencyStatus[dependency.status]}
            </li>)}
          </ul>
        </details> : null}
      </div>
    </details>)}
  </div>;
}
