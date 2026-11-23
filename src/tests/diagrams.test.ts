import { expect, test } from "bun:test";
import { renderDiagram, MAX_DIAGRAM_CHARS } from "../lib/diagram";

export const integrationFlow = `flowchart LR
  Source["Sistema de origem"] --> OIC["OIC: receber pedido"]
  OIC --> Valid{"Payload válido?"}
  Valid -->|Sim| Mapping["Transformar dados"]
  Mapping --> Fusion["Oracle Fusion"]
  Valid -->|Não| Fault["Registrar falha"]
  Fusion --> Reply["Retornar resultado"]`;

export const integrationSequence = `sequenceDiagram
  participant Source as Sistema de origem
  participant OIC as Oracle Integration
  participant Fusion as Oracle Fusion
  Source->>OIC: Enviar pedido
  OIC->>Fusion: Enviar dados transformados
  alt Pedido aceito
    Fusion-->>OIC: Identificador criado
    OIC-->>Source: Retornar identificador
  else Falha no destino
    Fusion-->>OIC: Erro de validação
    OIC-->>Source: Retornar falha
  end`;

test("renders a proposed integration with decisions and fault paths, without fetching fonts", () => {
  const svg = renderDiagram(integrationFlow);
  expect(svg).toContain("<svg");
  for (const label of ["Sistema de origem", "Payload válido?", "Registrar falha", "Oracle Fusion"]) expect(svg).toContain(label);
  expect(svg).not.toContain("@import");
  expect(svg).not.toContain("fonts.googleapis.com");
});

test("renders integration call order and both sequence branches", () => {
  const svg = renderDiagram(integrationSequence);
  for (const label of ["Enviar pedido", "Pedido aceito", "Falha no destino", "Retornar falha"]) expect(svg).toContain(label);
});

test("does not turn model-provided HTML labels into active SVG markup", () => {
  const svg = renderDiagram('flowchart TD\n A["<script>alert(1)</script>"] --> B["Fim"]');
  expect(svg).not.toContain("<script>");
  expect(svg).toContain("&lt;script&gt;");
});

test("unsupported syntax and oversized diagrams fail instead of blocking the conversation", () => {
  expect(() => renderDiagram("not a diagram")).toThrow();
  expect(() => renderDiagram("a".repeat(MAX_DIAGRAM_CHARS + 1))).toThrow("dividir o fluxo");
});
