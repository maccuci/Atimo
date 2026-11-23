import { describe, expect, test } from "bun:test";
import { EFFORTS, EFFORT_HINT, EFFORT_LABEL, effortCaveat } from "../lib/effort";
import { fastCaveat } from "../lib/fast";
import {
  fastProviderField,
  filePluginField,
  reasoningField,
} from "../lib/adapter/web";
import type { ChatRequest } from "../lib/adapter";

/*
 * The browser transport builds its own request body, so it carries a second
 * copy of the effort table that Rust owns in `src-tauri/src/effort.rs`. These
 * tests pin that copy: a divergence would be a setting that behaves one way in
 * the desktop app and another in `bun run dev`, which is exactly the kind of
 * difference nobody notices until it matters.
 */

describe("reasoningField", () => {
  test("sends nothing at all on auto", () => {
    // The default. An install that never touches the control must keep making
    // the same request it made before the control existed.
    expect(reasoningField("openrouter", "auto")).toBeNull();
    expect(reasoningField("zai", "auto")).toBeNull();
    expect(reasoningField("openrouter", undefined)).toBeNull();
  });

  test("uses OpenRouter's ceiling, which is xhigh and not max", () => {
    // `max` is a valid Codex level and a 400 on OpenRouter.
    expect(reasoningField("openrouter", "max")).toEqual({
      reasoning: { effort: "xhigh" },
    });
    expect(reasoningField("openrouter", "high")).toEqual({
      reasoning: { effort: "high" },
    });
  });

  test("turns reasoning off with the flag each gateway actually has", () => {
    // OpenRouter has no zero-effort level; Z.AI has no levels at all.
    expect(reasoningField("openrouter", "off")).toEqual({
      reasoning: { enabled: false },
    });
    expect(reasoningField("zai", "off")).toEqual({
      thinking: { type: "disabled" },
    });
  });

  test("collapses every on-level to one switch for Z.AI", () => {
    const on = { thinking: { type: "enabled" } };
    for (const level of ["low", "medium", "high", "max"] as const) {
      expect(reasoningField("zai", level)).toEqual(on);
    }
  });

  test("keeps GLM-5.3's balanced desktop effort in the browser", () => {
    for (const model of ["glm-5.3", "glm-5.3-flash", "glm-5.3-flashx"]) {
      for (const effort of [undefined, "auto", "medium"] as const) {
        expect(reasoningField("zai", effort, model)).toEqual({
          thinking: { type: "enabled" },
          reasoning_effort: "medium",
        });
      }
    }
  });
});

describe("effortCaveat", () => {
  test("names the levels that mean less than they say", () => {
    // The control keeps the same shape on every provider, so the places where
    // a level is a no-op have to be stated rather than silently different.
    expect(effortCaveat("zai", "high")).toContain("GLM-5.3+ sempre raciocina");
    expect(effortCaveat("zai", "off")).toContain("não desliga");
    expect(effortCaveat("claude-cli", "off")).toContain("não desliga o raciocínio");
  });

  test("stays quiet when the setting does what it says", () => {
    expect(effortCaveat("openrouter", "high")).toBeNull();
    expect(effortCaveat("codex-cli", "off")).toBeNull();
    expect(effortCaveat("zai", "auto")).toBeNull();
  });
});

describe("the effort scale", () => {
  test("puts auto first and labels every level", () => {
    // Auto leads because it is the default and the inert one.
    expect(EFFORTS[0]).toBe("auto");
    for (const level of EFFORTS) {
      expect(EFFORT_LABEL[level]).toBeTruthy();
      expect(EFFORT_HINT[level]).toBeTruthy();
    }
  });
});

describe("fastProviderField", () => {
  test("sends OpenRouter throughput routing only when Fast is on", () => {
    expect(fastProviderField("openrouter", true)).toEqual({
      provider: { sort: "throughput" },
    });
    expect(fastProviderField("openrouter", false)).toBeNull();
    expect(fastProviderField("openrouter", undefined)).toBeNull();
  });

  test("stays off every other gateway — they have no equivalent knob", () => {
    expect(fastProviderField("zai", true)).toBeNull();
  });
});

describe("fastCaveat", () => {
  test("is quiet on OpenRouter and names the no-op elsewhere", () => {
    expect(fastCaveat("openrouter")).toBeNull();
    expect(fastCaveat("zai")).toContain("OpenRouter");
    expect(fastCaveat("claude-cli")).toContain("OpenRouter");
  });
});

describe("filePluginField", () => {
  const request = (content: ChatRequest["messages"][number]["content"]) => ({
    model: "anthropic/claude-sonnet-4",
    messages: [{ role: "user" as const, content }],
    pdfEngine: "pdf-text" as const,
  });

  test("declares the parser only when a document is actually attached", () => {
    /*
     * Not a tidiness point. The plugin enables a paid extraction path, and
     * declaring it on every request would arm that path for turns with nothing
     * to extract. Mirrors the same condition in `openrouter.rs`.
     */
    expect(
      filePluginField(
        "openrouter",
        request([
          {
            type: "file",
            file: { filename: "a.pdf", file_data: "data:application/pdf;base64,AA" },
          },
        ]),
      ),
    ).toEqual({
      plugins: [{ id: "file-parser", pdf: { engine: "pdf-text" } }],
    });

    expect(filePluginField("openrouter", request("just a question"))).toBeNull();
    expect(
      filePluginField(
        "openrouter",
        request([{ type: "image_url", image_url: { url: "data:image/png;base64,AA" } }]),
      ),
    ).toBeNull();
  });

  test("stays off a gateway with no such plugin", () => {
    expect(
      filePluginField(
        "zai",
        request([
          {
            type: "file",
            file: { filename: "a.pdf", file_data: "data:application/pdf;base64,AA" },
          },
        ]),
      ),
    ).toBeNull();
  });
});
