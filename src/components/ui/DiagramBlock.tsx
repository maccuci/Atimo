import { memo, useEffect, useMemo, useRef, useState } from "react";
import { useStore } from "@/lib/store";
import { saveExport } from "@/lib/export-file";
import { diagramParts, sanitizeDiagram, themeDiagram } from "@/lib/diagram-svg";

export default memo(function DiagramBlock({ source, complete, pending }: { source: string; complete: boolean; pending: boolean }) {
  const host = useRef<HTMLElement>(null);
  const [visible, setVisible] = useState(false);
  const [result, setResult] = useState<{ source: string; svg?: string; error?: string } | null>(null);
  const [themed, setImage] = useState<{ original: string; svg: string; url: string; width: number } | null>(null);
  const [zoom, setZoom] = useState(0); // 0 = fit to width, never upscaled
  const drag = useRef<{ x: number; y: number; left: number; top: number; moved: boolean } | null>(null);
  const send = useStore((s) => s.send);
  const sending = useStore((s) => s.sending);
  const lastAsk = useRef(0);
  const ask = (prompt: string) => {
    if (drag.current?.moved || Date.now() - lastAsk.current < 1500) return; // a double click must not send twice
    lastAsk.current = Date.now();
    void send(prompt);
  };
  const [showSource, setShowSource] = useState(false);
  const [notice, setNotice] = useState("");
  const current = result?.source === source ? result : null;
  const svg = current?.svg;
  const image = themed?.original === svg ? themed : null;
  const parts = useMemo(() => (svg ? diagramParts(svg) : []), [svg]);
  const error = current?.error ?? (!complete && !pending ? "O bloco Mermaid está incompleto. Peça para completar o diagrama e fechar o bloco de código." : undefined);

  useEffect(() => {
    if (!host.current) return;
    const observer = new IntersectionObserver(([entry]) => {
      if (entry?.isIntersecting) {
        setVisible(true);
        observer.disconnect();
      }
    }, { rootMargin: "200px" });
    observer.observe(host.current);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (!complete || !visible) return;
    let worker: Worker;
    try {
      worker = new Worker(new URL("../../lib/diagram.worker.ts", import.meta.url), { type: "module" });
    } catch {
      setResult({ source, error: "Não foi possível carregar o diagrama. O código está disponível abaixo." });
      return;
    }
    const fail = (error: string) => {
      setResult({ source, error });
      clearTimeout(timeout);
      worker.terminate();
    };
    const timeout = setTimeout(() => fail("O diagrama demorou demais. Peça para dividir o fluxo em partes menores."), 12_000);
    worker.onmessage = ({ data }: MessageEvent<{ svg?: string; error?: string }>) => {
      try {
        setResult({ source, ...(data.svg ? { svg: sanitizeDiagram(data.svg) } : { error: data.error }) });
      } catch {
        fail("Não foi possível exibir o diagrama com segurança. O código está disponível abaixo.");
      }
      clearTimeout(timeout);
      worker.terminate();
    };
    worker.onerror = () => fail("Não foi possível carregar o diagrama. O código está disponível abaixo.");
    worker.postMessage(source);
    return () => { clearTimeout(timeout); worker.terminate(); };
  }, [source, complete, visible]);

  useEffect(() => {
    if (!svg) { setImage(null); return; }
    const update = () => {
      const next = themeDiagram(svg);
      setImage({ ...next, original: svg, url: `data:image/svg+xml;charset=utf-8,${encodeURIComponent(next.svg)}` });
    };
    update();
    const observer = new MutationObserver(update);
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme", "style"] });
    return () => observer.disconnect();
  }, [svg]);

  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(""), 2500);
    return () => clearTimeout(timer);
  }, [notice]);

  const copy = async () => {
    try { await navigator.clipboard.writeText(source); setNotice("Código copiado."); }
    catch { setNotice("Não foi possível copiar. Selecione o código abaixo."); setShowSource(true); }
  };

  const save = async () => {
    if (!image || !svg) return;
    try {
      const saved = await saveExport("atimo-diagrama", "svg", image.svg);
      setNotice(saved.revealed ? `Salvo: ${saved.name}` : `Salvo nos downloads: ${saved.name}`);
    } catch { setNotice("Não foi possível salvar o SVG. Tente novamente."); }
  };

  return (
    <figure ref={host} className="group relative overflow-hidden rounded-lg border border-border bg-bg-inset">
      <figcaption className={`flex flex-wrap items-center gap-3 px-3 pt-2 text-[11px] text-fg-dim transition-opacity duration-150 ${image && !notice ? "opacity-0 group-hover:opacity-100 focus-within:opacity-100 [@media(hover:none)]:opacity-100" : ""}`}>
        <span role="status" className="mr-auto">{notice}</span>
        {svg && image ? (
          <span className="flex items-center gap-2" aria-label="Zoom do diagrama">
            <button type="button" disabled={zoom > 0 && zoom <= 0.5} onClick={() => setZoom((value) => Math.max(0.5, (value || 1) - 0.25))} aria-label="Diminuir diagrama">−</button>
            <button type="button" onClick={() => setZoom((value) => (value ? 0 : 1))} aria-label={zoom ? "Ajustar diagrama à largura" : "Ver em tamanho real"}>{zoom ? `${Math.round(zoom * 100)}%` : "Ajustado"}</button>
            <button type="button" disabled={zoom >= 3} onClick={() => setZoom((value) => Math.min(3, (value || 1) + 0.25))} aria-label="Ampliar diagrama">+</button>
          </span>
        ) : null}
        <button type="button" disabled={Boolean(error)} onClick={() => setShowSource((value) => !value)} aria-expanded={showSource || Boolean(error)}>{error ? "Código" : showSource ? "Ocultar código" : "Ver código"}</button>
        <button type="button" onClick={() => void copy()}>Copiar código</button>
        {svg && image ? <button type="button" onClick={() => void save()}>Salvar SVG</button> : null}
      </figcaption>

      {svg && image ? (
        <div
          tabIndex={0}
          role="region"
          aria-label="Diagrama; clique duas vezes para ampliar, arraste para mover e use Ver código para ler o texto"
          className={`p-3 ${zoom ? "max-h-[70vh] cursor-grab overflow-auto [scrollbar-width:none] active:cursor-grabbing [&::-webkit-scrollbar]:hidden" : "overflow-hidden"}`}
          onDoubleClick={() => setZoom((value) => (value ? 0 : 1))}
          onPointerDown={(event) => {
            if (!zoom || event.button !== 0) return;
            const el = event.currentTarget;
            drag.current = { x: event.clientX, y: event.clientY, left: el.scrollLeft, top: el.scrollTop, moved: false };
          }}
          onPointerMove={(event) => {
            if (!drag.current) return;
            if (!drag.current.moved && Math.abs(event.clientX - drag.current.x) + Math.abs(event.clientY - drag.current.y) > 4) {
              drag.current.moved = true;
              event.currentTarget.setPointerCapture(event.pointerId); // only once dragging, so a plain click still reaches the part
            }
            event.currentTarget.scrollLeft = drag.current.left - (event.clientX - drag.current.x);
            event.currentTarget.scrollTop = drag.current.top - (event.clientY - drag.current.y);
          }}
          onPointerUp={() => { setTimeout(() => { drag.current = null; }); }}
          onPointerCancel={() => { drag.current = null; }}
        >
          <div className="relative mx-auto" style={zoom ? { width: image.width * zoom } : { width: "100%", maxWidth: image.width }}>
            <img src={image.url} draggable={false} alt="Diagrama da resposta. Os passos e rótulos estão disponíveis em Ver código." className="block w-full select-none" />
            {parts.map((part, index) => (
              <button
                key={index}
                type="button"
                disabled={sending}
                title={`Perguntar sobre “${part.label}”`}
                aria-label={`Perguntar sobre ${part.label}`}
                className="absolute rounded-[3px] outline-none focus-visible:ring-2 focus-visible:ring-fg-faint disabled:cursor-default"
                style={{ left: `${part.x}%`, top: `${part.y}%`, width: `${part.w}%`, height: `${part.h}%`, cursor: sending ? undefined : "pointer" }}
                onDoubleClick={(event) => event.stopPropagation()}
                onClick={() => ask(part.prompt)}
              />
            ))}
          </div>
        </div>
      ) : (
        <p role="status" className="px-3 py-4 text-[12px] text-fg-dim">{error ?? (complete ? "Preparando diagrama…" : "Aguardando o código completo do diagrama…")}</p>
      )}

      {showSource || error ? <pre className="scroll-thin overflow-x-auto border-t border-border p-3 text-[12px] leading-relaxed text-fg"><code>{source}</code></pre> : null}
    </figure>
  );
});
