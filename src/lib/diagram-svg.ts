import DOMPurify from "dompurify";

/** Keep SVG inert both in the chat's image and when opened as an exported file. */
export function sanitizeDiagram(svg: string): string {
  const clean = DOMPurify.sanitize(svg, {
    USE_PROFILES: { svg: true, svgFilters: true },
    FORBID_TAGS: ["foreignObject", "a", "image", "use", "feImage"],
    FORBID_ATTR: ["href", "xlink:href"],
    RETURN_DOM_FRAGMENT: true,
  });
  for (const style of clean.querySelectorAll("style")) {
    // Fonts are local. A diagram cannot import CSS or load external resources.
    style.textContent = style.textContent?.replace(/@import\s+(?:url\([^)]*\)|["'][^"']*["'])\s*;|url\([^)]*\)/gi, "") ?? "";
  }
  for (const element of clean.querySelectorAll("*")) {
    for (const attr of [...element.attributes]) {
      const targets = [...attr.value.matchAll(/url\(\s*(['"]?)(.*?)\1\s*\)/gi)];
      if (targets.some((match) => !match[2]!.trim().startsWith("#"))) {
        element.removeAttribute(attr.name);
      }
    }
  }
  const root = clean.querySelector("svg");
  if (!root) throw new Error("SVG inválido.");
  return new XMLSerializer().serializeToString(root);
}

/** Apply resolved app colors so a standalone SVG keeps the same appearance. */
export function themeDiagram(svg: string): { svg: string; width: number } {
  const root = new DOMParser().parseFromString(svg, "image/svg+xml").querySelector("svg");
  if (!root) throw new Error("SVG inválido.");
  const styles = getComputedStyle(document.documentElement);
  for (const [key, token] of Object.entries({ bg: "--bg-inset", fg: "--fg", accent: "--accent", muted: "--fg-dim", line: "--fg-faint", border: "--fg-faint" })) {
    root.style.setProperty(`--${key}`, styles.getPropertyValue(token).trim());
  }
  colorize(root);
  return { svg: new XMLSerializer().serializeToString(root), width: Number(root.getAttribute("width")) };
}

export type PartKind = "decision" | "error" | "terminal" | "call" | "data" | "step" | "group" | "actor" | "message" | "link";
export type DiagramPart = { kind: PartKind; label: string; prompt: string; x: number; y: number; w: number; h: number };

const HUES: Partial<Record<PartKind, string>> = {
  decision: "#d97706", error: "#dc2626", terminal: "#16a34a", call: "#2563eb", data: "#0d9488", group: "#7c3aed",
};
const ACTOR_HUES = ["#2563eb", "#7c3aed", "#0d9488", "#d97706", "#16a34a", "#db2777"];

const clean = (text: string | null) => (text ?? "").replace(/<br\s*\/?>/gi, " ").replace(/\s+/g, " ").trim().slice(0, 160);

function kindOf(el: Element): PartKind {
  const cls = el.getAttribute("class");
  if (cls === "actor") return "actor";
  if (cls === "message") return "message";
  if (cls === "edge-label") return "link";
  const shape = el.getAttribute("data-shape") ?? "";
  const label = clean(el.getAttribute("data-label"));
  if (shape === "diamond" || shape === "hexagon") return "decision";
  if (/\b(erro|error|falha|fault|catch|catchall|exce[cç][aã]o|exception)/i.test(label)) return "error";
  if (/^(stadium|circle|doublecircle|state-start|state-end)$/.test(shape) || /^(in[ií]cio|start|fim|end|stop)\b|\bSTOP\b/i.test(label)) return "terminal";
  if (cls === "subgraph") return "group";
  if (/\b(POST|GET|PUT|PATCH|DELETE|SOAP|REST|API|HTTPS?|invoke|endpoint)\b/.test(label) || /(^|\s)\/[\w-]+\//.test(label)) return "call";
  if (shape === "cylinder") return "data";
  return "step";
}

function promptFor(kind: PartKind, label: string, el: Element, root: Element): string {
  const name = (id: string | null) => clean(root.querySelector(`[data-id="${CSS.escape(id ?? "")}"]`)?.getAttribute("data-label") ?? id);
  const from = name(el.getAttribute("data-from"));
  const to = name(el.getAttribute("data-to"));
  const routes = [...root.querySelectorAll(`.edge[data-from="${CSS.escape(el.getAttribute("data-id") ?? "")}"]`)]
    .map((edge) => `${clean(edge.getAttribute("data-label")) || "sem rótulo"} → ${name(edge.getAttribute("data-to"))}`);
  switch (kind) {
    case "decision": return `No diagrama, o que a decisão "${label}" avalia e o que acontece em cada caminho${routes.length ? ` (${routes.join("; ")})` : ""}?`;
    case "error": return `No diagrama, o que é "${label}", quando ele é acionado e como esse erro é tratado ou deveria ser tratado?`;
    case "terminal": return `No diagrama, o que acontece em "${label}" e por que o fluxo começa ou termina aí?`;
    case "call": return `No diagrama, o que a etapa "${label}" chama, o que envia e recebe, e o que acontece se ela falhar?`;
    case "data": return `No diagrama, que dados "${label}" guarda e quem lê ou grava neles?`;
    case "group": return `No diagrama, o que o bloco "${label}" agrupa e como as etapas dentro dele funcionam juntas?`;
    case "actor": return `No diagrama de sequência, qual é o papel de "${label}" e com quem ele interage?`;
    case "message": return `No diagrama de sequência, o que é a chamada "${label}" de ${from} para ${to}, como ela funciona e o que volta?`;
    case "link": return `No diagrama, o que significa o caminho "${label}" de ${from} para ${to} e quando o fluxo segue por ele?`;
    default: return `No diagrama, o que é a etapa "${label}" e como ela funciona?`;
  }
}

/** Union box of a part's shapes, in SVG units. Subgraphs only take their header so inner nodes stay clickable. */
function boxOf(el: Element): { x: number; y: number; w: number; h: number } | null {
  const shapes = el.getAttribute("class") === "subgraph" ? [el.querySelectorAll("rect")[1] ?? el.querySelector("rect")] : [...el.querySelectorAll("rect, circle, ellipse, polygon, polyline, line")];
  const xs: number[] = [];
  const ys: number[] = [];
  const n = (shape: Element, attr: string) => Number(shape.getAttribute(attr) ?? 0);
  for (const shape of shapes) {
    if (!shape) continue;
    if (shape.tagName === "rect") { xs.push(n(shape, "x"), n(shape, "x") + n(shape, "width")); ys.push(n(shape, "y"), n(shape, "y") + n(shape, "height")); }
    else if (shape.tagName === "circle" || shape.tagName === "ellipse") {
      const rx = n(shape, "r") || n(shape, "rx"), ry = n(shape, "r") || n(shape, "ry");
      xs.push(n(shape, "cx") - rx, n(shape, "cx") + rx); ys.push(n(shape, "cy") - ry, n(shape, "cy") + ry);
    } else if (shape.tagName === "line") { xs.push(n(shape, "x1"), n(shape, "x2")); ys.push(n(shape, "y1"), n(shape, "y2")); }
    else for (const [px, py] of (shape.getAttribute("points") ?? "").trim().split(/\s+/).map((p) => p.split(",").map(Number))) { xs.push(px!); ys.push(py!); }
  }
  if (!xs.length || xs.some(Number.isNaN) || ys.some(Number.isNaN)) return null;
  let y = Math.min(...ys), h = Math.max(...ys) - y;
  if (el.getAttribute("class") === "message") { y -= 20; h += 26; } // label sits above the arrow
  return { x: Math.min(...xs), y, w: Math.max(...xs) - Math.min(...xs), h: Math.max(h, 12) };
}

/** Clickable parts as percentages of the viewBox, so they track the image at any zoom. */
export function diagramParts(svg: string): DiagramPart[] {
  const root = new DOMParser().parseFromString(svg, "image/svg+xml").querySelector("svg");
  const view = root?.getAttribute("viewBox")?.split(/[\s,]+/).map(Number);
  if (!root || !view || view.length !== 4) return [];
  const [vx, vy, vw, vh] = view as [number, number, number, number];
  return [...root.querySelectorAll("g.subgraph, g.node, g.edge-label, g.actor, g.message")].flatMap((el) => {
    const label = clean(el.getAttribute("data-label") ?? el.getAttribute("data-id"));
    const box = boxOf(el);
    if (!label || !box) return [];
    const kind = kindOf(el);
    return [{ kind, label, prompt: promptFor(kind, label, el, root), x: ((box.x - vx) / vw) * 100, y: ((box.y - vy) / vh) * 100, w: (box.w / vw) * 100, h: (box.h / vh) * 100 }];
  });
}

/** Tint parts by meaning; parts the author styled themselves keep their own colors. */
function colorize(root: Element) {
  const tint = (shape: Element, hue: string) => {
    if (!/var\(--_(node-fill|group-hdr|group-fill)\)/.test(shape.getAttribute("fill") ?? "")) return;
    shape.setAttribute("fill", `color-mix(in srgb, ${hue} 16%, var(--bg))`);
    shape.setAttribute("stroke", `color-mix(in srgb, ${hue} 65%, var(--bg))`);
  };
  for (const el of root.querySelectorAll("g.node, g.subgraph")) {
    const hue = HUES[kindOf(el)];
    if (!hue) continue;
    const shapes = [...el.querySelectorAll("rect, circle, ellipse, polygon")];
    for (const shape of el.getAttribute("class") === "subgraph" ? shapes.slice(1) : shapes) tint(shape, hue);
    if (el.getAttribute("class") === "subgraph") shapes[0]?.setAttribute("stroke", `color-mix(in srgb, ${hue} 45%, var(--bg))`);
  }
  const actors = new Map<string, string>();
  for (const el of root.querySelectorAll("g.actor")) {
    const id = el.getAttribute("data-id") ?? "";
    if (!actors.has(id)) actors.set(id, ACTOR_HUES[actors.size % ACTOR_HUES.length]!); // same actor, same color at top and bottom
    for (const shape of el.querySelectorAll("rect")) tint(shape, actors.get(id)!);
  }
}
