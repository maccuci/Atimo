import { renderMermaidSVG } from "beautiful-mermaid";

export const MAX_DIAGRAM_CHARS = 20_000;

/** Runs in a worker: layout must not block typing or streaming the answer. */
export function renderDiagram(source: string): string {
  if (source.length > MAX_DIAGRAM_CHARS) {
    throw new Error("Diagrama muito grande. Peça para dividir o fluxo em diagramas menores.");
  }
  const svg = renderMermaidSVG(source, { font: "system-ui", interactive: false });
  // The renderer embeds Google Fonts imports; diagrams must stay local, including exported SVGs.
  return svg.replace(/@import\s+url\([^)]*\)\s*;/g, "");
}
