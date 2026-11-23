import { afterEach, expect, test } from "bun:test";
import { compose } from "../lib/context-composer";
import { buildMessages } from "../lib/prompt-builder";
import { inputCost } from "../lib/store";
import { publishWorkspace, resetWorkspace } from "../lib/workspace";
import type { ActiveSkill, ContextChunk } from "../lib/types";

afterEach(resetWorkspace);

test("project instructions and the skill catalog remain a stable prefix across questions", () => {
  publishWorkspace({
    workspaces: [{ id: "w", name: "Test" }],
    projects: [{ id: "p", workspaceId: "w", name: "Test", description: "", instructions: "User's standing instructions", memoryTokens: 0 }],
    chats: [], messages: [], memory: [], decisions: [], documents: [],
  });
  const skills: ActiveSkill[] = [
    { mode: "auto", skill: { id: "alpha", name: "Alpha", category: "approach", summary: "Alpha", description: "Alpha guide", triggers: ["alpha", "one"], body: "Alpha instructions" } },
    { mode: "auto", skill: { id: "beta", name: "Beta", category: "approach", summary: "Beta", description: "Beta guide", triggers: ["beta", "two"], body: "Beta instructions" } },
  ];
  const system = (prompt: string, active = skills) => String(buildMessages({
    context: compose(prompt, "p", "deepseek-flash", active), history: [], prompt, projectName: "Test",
  })[0]!.content);
  const first = system("alpha one beta");
  const second = system("alpha beta two");
  const prefix = (text: string) => text.split("## Skills active on this turn")[0];
  expect(prefix(first)).toBe(prefix(second));
  expect(prefix(first)).toContain("User's standing instructions");
  expect(prefix(first)).toContain("Alpha guide");
  expect(prefix(first)).toContain("Beta guide");

  const always = skills.map((skill) => ({ ...skill, mode: "always" as const }));
  expect(system("alpha one beta", always)).toBe(system("alpha beta two", always));
});

test("retrieved context rides the latest message, so the system prefix is byte-identical between follow-ups", () => {
  publishWorkspace({
    workspaces: [{ id: "w", name: "Test" }],
    projects: [{ id: "p", workspaceId: "w", name: "Test", description: "", instructions: "", memoryTokens: 0 }],
    chats: [], messages: [], memory: [], decisions: [], documents: [],
  });
  const archive = { id: "doc-iar", stage: "resolve", kind: "document", label: "x.iar", score: 1, tokens: 10, included: true,
    excerpt: "INTEGRATION_REVIEW_DATA archive text", review: { document: "x.iar", coverage: [], findings: [], dependencies: [] } } satisfies ContextChunk;
  const chat = (text: string) => ({ id: `sem-${text}`, stage: "semantic", kind: "chat", label: text, score: 0.5, tokens: 5, included: true, excerpt: text }) satisfies ContextChunk;
  const request = (prompt: string, retrieved: string) => {
    const context = compose(prompt, "p", "deepseek-flash");
    return buildMessages({ context: { ...context, chunks: [...context.chunks, archive, chat(retrieved)] }, history: [], prompt, projectName: "Test" });
  };
  const first = request("o que faz o gate?", "chat about HDL");
  const second = request("e o s1?", "chat about REST");
  expect(first[0]!.content).toBe(second[0]!.content);
  expect(String(first[0]!.content)).toContain("archive text");
  expect(String(first[0]!.content)).not.toContain("chat about HDL");
  expect(String(first.at(-1)!.content)).toContain("chat about HDL");
  expect(String(first.at(-1)!.content).endsWith("## User message\n\no que faz o gate?")).toBe(true);
});

test("fallback cost prices cache hits at the cache-read rate", () => {
  expect(inputCost(1000, 800, { costIn: 1, costCacheRead: 0.1 })).toBeCloseTo(280);
  expect(inputCost(1000, 800, { costIn: 1 })).toBe(1000);
  expect(inputCost(1000, null, { costIn: 1, costCacheRead: 0.1 })).toBe(1000);
});

test("retrieval keeps the few chats that answer, not every chat that shares a word", () => {
  const chat = (id: string, title: string) => ({ id, projectId: "p", title, createdAt: "2026-01-01", updatedAt: "2026-01-01" });
  const message = (id: string, chatId: string, content: string) => ({ id, chatId, role: "assistant", content, createdAt: "2026-01-01" });
  const weak = Array.from({ length: 12 }, (_, i) => chat(`c-${i}`, `Assunto ${i}`));
  publishWorkspace({
    workspaces: [{ id: "w", name: "Test" }],
    projects: [{ id: "p", workspaceId: "w", name: "Test", description: "", instructions: "", memoryTokens: 0 }],
    chats: [chat("c-hit", "Gate do router CADCARGO watermark"), ...weak],
    messages: [
      message("m-hit", "c-hit", "O gate do router CADCARGO nunca abre: watermark em p_integration_date não persiste."),
      ...weak.map((c, i) => message(`m-${i}`, c.id, `Uma conversa sobre HDL ${i} que cita o router de passagem.`)),
    ],
    memory: [], decisions: [], documents: [],
  } as never);
  const chats = compose("por que o gate do router CADCARGO não abre com a watermark?", "p", "deepseek-flash")
    .chunks.filter((c) => c.kind === "chat");
  expect(chats[0]?.label).toBe("Gate do router CADCARGO watermark");
  expect(chats.length).toBeLessThanOrEqual(5);
  expect(chats.every((c) => c.score >= chats[0]!.score * 0.5)).toBe(true);
});
