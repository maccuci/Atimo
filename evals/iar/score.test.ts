import { expect, test } from "bun:test";
import { casos } from "./casos";
import { score, type IarCase } from "./score";

const caso: IarCase = {
  id: "t", arquivo: "t.iar", pergunta: "",
  achados: [
    { id: "a", descricao: "", peso: 3, evidencia: [{ near: [/csfkey/, /diverge/], within: 30 }] },
    { id: "b", descricao: "", peso: 1, evidencia: [/Integration5/] },
  ],
  erros: [{ id: "e", descricao: "", evidencia: [/mesma chave/] }],
};

test("a finding counts only when its terms are near each other, and known errors cost half a point", () => {
  expect(score("O csfkey diverge entre os arquivos.", caso)).toEqual({ nota: 7.5, acertos: ["a"], faltas: ["b"], erros: [] });
  expect(score(`csfkey${" x".repeat(40)} diverge`, caso).acertos).toEqual([]);
  expect(score("csfkey diverge; Integration5 duplicado; é a mesma chave", caso)).toMatchObject({ nota: 9.5, erros: ["e"] });
  expect(score("mesma chave", caso).nota).toBe(0);
});

test("the CADCARGO gabarito separates the right mechanism from the watermark mistake", () => {
  const cadcargo = casos.find((c) => c.id === "cadcargo")!;
  const right = "O router testa $p_integration_date, que é atribuída depois do router; os parâmetros do schedule gravam em outros message contexts.";
  const wrong = "AssignEndVars: p_integration_date = currentDateTime, a watermark que alimentará a próxima execução. Falha global vai para o e-mail.";
  expect(score(right, cadcargo).acertos).toContain("gate-variaveis");
  expect(score(wrong, cadcargo).acertos).not.toContain("gate-variaveis");
  expect(score(wrong, cadcargo).erros).toContain("watermark-persiste");
});
