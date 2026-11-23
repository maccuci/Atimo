import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("replay sends identical captured messages and never approves empty or truncated replies", async () => {
  const dir = await mkdtemp(join(tmpdir(), "atimo-replay-"));
  let resultPath: string | undefined;
  try {
    const messages = [
      { role: "system", content: "Instructions, skills and retrieved evidence assembled by the app" },
      { role: "assistant", content: "Previous answer" },
      { role: "user", content: "Compare the supplied evidence" },
    ];
    await writeFile(join(dir, "capture.json"), JSON.stringify({ format: "atimo.eval", version: 1, requests: [
      { id: "same-case", at: "2026-11-15T00:00:00Z", provider: "deepseek", request: { model: "original", messages, maxTokens: 8192, temperature: 1 } },
    ] }));
    await writeFile(join(dir, "provider.ts"), `
      import { appendFileSync } from "node:fs";
      globalThis.fetch = async (url, init) => {
        if (String(url) !== "https://api.deepseek.com/chat/completions") throw new Error("Unexpected network request: " + url);
        const body = JSON.parse(init.body);
        appendFileSync(process.env.ATIMO_TEST_REQUESTS, JSON.stringify(body) + "\\n");
        const text = body.reasoning_effort === "low" ? "" : body.reasoning_effort === "high" ? "Partial reply" : "Complete reply";
        return Response.json({ choices: [{ message: { content: text, reasoning_content: "Thinking" }, finish_reason: body.reasoning_effort === "max" ? "stop" : "length" }], usage: { prompt_tokens: 100, completion_tokens: 20 } });
      };
    `);
    const child = Bun.spawn([process.execPath, "--preload", join(dir, "provider.ts"), "evals/oracle/run.ts", "deepseek:deepseek-flash", `--capture=${join(dir, "capture.json")}`, "--effort=low,high,max"], {
      env: { ...process.env, DEEPSEEK_API_KEY: "test-only", ATIMO_TEST_REQUESTS: join(dir, "sent.jsonl") }, stdout: "pipe", stderr: "pipe",
    });
    const [output, errors, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    resultPath = output.match(/→ (.+\.json)/)?.[1];
    expect({ code, errors }).toEqual({ code: 0, errors: "" });
    const sent = (await readFile(join(dir, "sent.jsonl"), "utf8")).trim().split("\n").map((line) => JSON.parse(line));
    expect(sent).toHaveLength(3);
    for (const request of sent) {
      expect(request.messages).toEqual(messages);
      expect(request.max_tokens).toBe(8192);
      expect(request.temperature).toBe(1);
    }
    const results = JSON.parse(await readFile(resultPath!, "utf8"));
    expect(results.map((r: { terminouNormalmente: boolean }) => r.terminouNormalmente)).toEqual([false, false, true]);
    expect(results.map((r: { respostaCompleta: boolean | null }) => r.respostaCompleta)).toEqual([false, false, null]);
    expect(results.every((r: { solucaoCorreta: boolean | null }) => r.solucaoCorreta === null)).toBe(true);
  } finally {
    if (resultPath) await rm(resultPath, { force: true });
    await rm(dir, { recursive: true, force: true });
  }
});
