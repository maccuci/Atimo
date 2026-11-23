import { afterEach, expect, test } from "bun:test";
import { captureRequest, startCapture, stopCapture } from "../lib/eval-capture";
import { parseCapture } from "../../evals/oracle/capture";
import type { ChatRequest } from "../lib/adapter";

afterEach(stopCapture);

const request = (): ChatRequest => ({ model: "deepseek-flash", effort: "high", maxTokens: 8192, messages: [
  { role: "system", content: "Project instructions, active skill and retrieved evidence" },
  { role: "user", content: [{ type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } }, { type: "text", text: "Question" }] },
] });

test("capture is opt-in and stops recording", () => {
  captureRequest("not-recorded", "deepseek", request(), "general");
  expect(stopCapture().requests).toEqual([]);
  startCapture();
  captureRequest("one", "deepseek", request(), "general");
  const data = stopCapture();
  captureRequest("two", "deepseek", request(), "general");
  expect(stopCapture()).toEqual(data);
});

test("capture freezes the exact messages and settings without credentials", () => {
  startCapture();
  const sent = { ...request(), apiKey: "must-not-be-captured" };
  captureRequest("one", "zai", sent, "coding");
  sent.messages[0]!.content = "mutated later";
  const json = JSON.stringify(stopCapture());
  expect(json).not.toContain("must-not-be-captured");
  expect(json).not.toContain("mutated later");
  expect(parseCapture(json).requests[0]).toMatchObject({ provider: "zai-coding", request: request() });
});

test("capture ignores CLI sessions whose final requests are built outside the app", () => {
  startCapture();
  captureRequest("cli", "claude-cli", request(), "general");
  expect(stopCapture().requests).toEqual([]);
});

test("replay rejects empty or malformed captures before calling a provider", () => {
  expect(() => parseCapture('{"format":"atimo.eval","version":1,"requests":[]}')).toThrow("vazia");
  startCapture();
  captureRequest("one", "deepseek", request(), "general");
  const data = stopCapture();
  data.requests[0]!.request.messages = [{ role: "user", content: [{ type: "text", text: 42 }] }] as unknown as ChatRequest["messages"];
  expect(() => parseCapture(JSON.stringify(data))).toThrow("Mensagens inválidas");
});
