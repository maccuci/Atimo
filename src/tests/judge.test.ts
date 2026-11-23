import { describe, expect, test } from "bun:test";
import { JUDGE_PROMPT, parseVerdict } from "../../evals/oracle/judge";

describe("eval judge", () => {
  test("takes the last JSON object of the reply and rejects malformed verdicts", () => {
    const reply = 'Pensando... {"rascunho": 1}\n{"nota": 7.5, "reprova": false, "respostaCompleta": true, "solucaoCorreta": false, "justificativa": "Usou PRIMARY_FLAG."}';
    expect(parseVerdict(reply, "deepseek:x")).toEqual({ alvo: "deepseek:x", nota: 7.5, reprova: false, respostaCompleta: true, solucaoCorreta: false, justificativa: "Usou PRIMARY_FLAG." });
    expect(parseVerdict('{"nota": 11, "reprova": false, "respostaCompleta": true, "solucaoCorreta": true}', "x")).toBeNull();
    expect(parseVerdict('{"nota": "7", "reprova": false}', "x")).toBeNull();
    expect(parseVerdict("sem JSON", "x")).toBeNull();
    expect(JUDGE_PROMPT).toContain("caps the score at 3");
  });
});
