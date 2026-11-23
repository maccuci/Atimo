import { expect, test } from "bun:test";
import { completionError } from "../lib/completion";

test("reasoning-only responses at the token limit are errors", () => {
  expect(completionError("   ", "length")).toContain("sem produzir uma resposta final");
});

test("partial responses at the token limit are incomplete", () => {
  expect(completionError("SELECT person_id FROM", "length")).toContain("Resposta incompleta");
  expect(completionError("Partial", "max_tokens")).toContain("preservado");
});

test("a normal stop still needs an answer", () => {
  expect(completionError("", "stop")).not.toBeNull();
  expect(completionError("Complete answer", "stop")).toBeNull();
  expect(completionError("Complete answer", null)).toBeNull();
});
