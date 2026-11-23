import { describe, expect, test } from "bun:test";
import { AGENT_LOGIN, isAgentKey } from "../lib/adapter/types";
import type { AgentKey, ProviderKey } from "../lib/adapter/types";

/*
 * `isAgentKey` is the fork in every transport: one side reaches for a stored
 * key, the other spawns a process. Getting it wrong in either direction is not
 * a cosmetic bug — a gateway misread as an agent tries to run a binary that
 * does not exist, and an agent misread as a gateway looks for a credential
 * this app deliberately never stores.
 */
describe("isAgentKey", () => {
  test("separates the local CLIs from the keyed gateways", () => {
    expect(isAgentKey("claude-cli")).toBe(true);
    expect(isAgentKey("codex-cli")).toBe(true);
    for (const provider of ["cursor-cli", "gemini-cli", "grok-cli", "kimi-cli", "devin-cli"] as const) {
      expect(isAgentKey(provider)).toBe(true);
      expect(AGENT_LOGIN[provider]).toBeTruthy();
    }
    expect(isAgentKey("openrouter")).toBe(false);
    expect(isAgentKey("zai")).toBe(false);
  });

  test("narrows the type, so a gateway-only call cannot take an agent", () => {
    const provider = "claude-cli" as ProviderKey;
    if (isAgentKey(provider)) {
      // Inside the guard this is an AgentKey; assigning a gateway name here
      // would fail the type check rather than fail at runtime.
      const agent: AgentKey = provider;
      expect(agent).toBe("claude-cli");
    } else {
      throw new Error("claude-cli should have been recognised as an agent");
    }
  });
});
