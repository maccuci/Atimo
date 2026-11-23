self.onmessage = async ({ data }: MessageEvent<string>) => {
  try {
    // ELK needs its local layout branch; beautiful-mermaid also assigns to the worker's read-only self getter.
    Object.defineProperties(globalThis, {
      document: { value: {}, configurable: true },
      self: { value: globalThis, writable: true, configurable: true },
    });
    const { renderDiagram } = await import("./diagram");
    self.postMessage({ svg: renderDiagram(data) });
  } catch {
    self.postMessage({ error: "Não foi possível desenhar este Mermaid. Peça para corrigir a sintaxe ou simplificar o diagrama; o código foi preservado abaixo." });
  } finally {
    Reflect.deleteProperty(globalThis, "document");
    Reflect.deleteProperty(globalThis, "self");
  }
};
