import { describe, expect, test } from "bun:test";
import {
  attachmentGuard,
  attachmentPart,
  attachmentSupport,
  decodedBytes,
  documentTokens,
  imageTokens,
  isAttachable,
  kindOf,
  mimeOf,
  pdfEngineFor,
} from "../lib/attachments";
import { buildMessages, contentText, userContent } from "../lib/prompt-builder";
import type { Attachment, ComposedContext, Message, Model } from "../lib/types";

/*
 * Attachments, from "is this a file we can send" through to what the provider
 * actually receives.
 *
 * The capability half carries most of the weight here. Everything else in this
 * app reaches every model — an attachment is the first thing that does not, and
 * the failure of getting it wrong is a turn that costs money and comes back as a
 * 400 the user cannot act on.
 */

const EMPTY_CONTEXT: ComposedContext = {
  chunks: [],
  rawTokens: 0,
  finalTokens: 0,
  elapsedMs: 0,
};

function model(over: Partial<Model> = {}): Model {
  return {
    id: "anthropic/claude-sonnet-4",
    label: "Claude Sonnet 4",
    provider: "anthropic",
    short: "sonnet-4",
    contextWindow: 200_000,
    costIn: 3,
    costOut: 15,
    live: true,
    ...over,
  };
}

function attachment(over: Partial<Attachment> = {}): Attachment {
  return {
    id: "att-1",
    messageId: "m-1",
    chatId: "c-1",
    name: "screenshot.png",
    mime: "image/png",
    kind: "image",
    bytes: 40_000,
    width: 800,
    height: 600,
    tokens: 640,
    ...over,
  };
}

describe("what counts as an attachment", () => {
  test("images, PDFs and the two audio formats are attachable", () => {
    expect(isAttachable({ name: "a.png", type: "image/png" })).toBe(true);
    expect(isAttachable({ name: "spec.pdf", type: "application/pdf" })).toBe(true);
    expect(isAttachable({ name: "note.mp3", type: "audio/mpeg" })).toBe(true);
    expect(isAttachable({ name: "note.wav", type: "audio/wav" })).toBe(true);
  });

  test("text formats are not — those are project knowledge", () => {
    // The whole distinction this module exists to hold. A `.md` has passages to
    // retrieve; a screenshot of it does not.
    expect(isAttachable({ name: "README.md", type: "text/markdown" })).toBe(false);
    expect(isAttachable({ name: "main.rs", type: "" })).toBe(false);
    expect(isAttachable({ name: "data.csv", type: "text/csv" })).toBe(false);
  });

  test("a file with no declared type falls back to its extension", () => {
    // A dragged file often arrives with nothing set, and one pasted from a
    // screenshot tool arrives as octet-stream.
    expect(mimeOf({ name: "photo.HEIC", type: "" })).toBe("image/heic");
    expect(mimeOf({ name: "x.pdf", type: "application/octet-stream" })).toBe(
      "application/pdf",
    );
  });

  test("an unknown video is refused rather than guessed at", () => {
    expect(kindOf("video/mp4")).toBeNull();
    expect(isAttachable({ name: "clip.mp4", type: "video/mp4" })).toBe(false);
  });
});

describe("the cost estimate", () => {
  test("an image is priced by area", () => {
    expect(imageTokens(1000, 750)).toBe(1_000);
  });

  test("a picture with no decoded dimensions is not priced at zero", () => {
    // A turn reported as free is worse than one reported approximately.
    expect(imageTokens()).toBeGreaterThan(0);
  });

  test("an enormous image is capped rather than extrapolated", () => {
    expect(imageTokens(20_000, 20_000)).toBe(4_000);
  });

  test("a document is priced from its size", () => {
    expect(documentTokens(25_000)).toBe(7_000);
  });

  test("base64 length reads back as the byte count it encodes", () => {
    expect(decodedBytes("data:image/png;base64,AAAA")).toBe(3);
    expect(decodedBytes("data:image/png;base64,AAA=")).toBe(2);
    expect(decodedBytes("data:image/png;base64,AA==")).toBe(1);
  });
});

describe("what a provider and model will take", () => {
  test("a vision model on a gateway takes images", () => {
    const support = attachmentSupport("openrouter", model({ supportsVision: true }));
    expect(support.image).toBe(true);
  });

  test("a text-only model does not, whatever the gateway", () => {
    expect(attachmentSupport("openrouter", model()).image).toBe(false);
    expect(attachmentSupport("zai", model()).image).toBe(false);
  });

  test("OpenRouter takes a PDF for any model, because it can extract one", () => {
    // The gateway adds a capability the model does not have — which is why this
    // is not simply `model.supportsFiles`.
    expect(attachmentSupport("openrouter", model()).document).toBe(true);
  });

  test("Z.AI takes no document at all, whatever GLM itself can read", () => {
    const support = attachmentSupport("zai", model({ supportsFiles: true }));
    expect(support.document).toBe(false);
  });

  test("a local CLI takes nothing", () => {
    // One prompt string on an argv, with tools switched off: there is neither a
    // channel for the bytes nor a way for the agent to go and fetch them.
    const support = attachmentSupport(
      "claude-cli",
      model({ supportsVision: true, supportsFiles: true, supportsAudio: true }),
    );
    expect(support).toEqual({ image: false, document: false, audio: false });
  });
});

describe("the PDF engine", () => {
  test("a model that reads documents itself gets the file untouched", () => {
    expect(pdfEngineFor("openrouter", model({ supportsFiles: true }))).toBe("native");
  });

  test("one that does not gets free text extraction, never OCR by default", () => {
    // The point of stating it: OpenRouter's own default here bills per page.
    expect(pdfEngineFor("openrouter", model())).toBe("pdf-text");
  });

  test("nothing is sent to a gateway that has no such plugin", () => {
    expect(pdfEngineFor("zai", model())).toBeUndefined();
    expect(pdfEngineFor("claude-cli", model())).toBeUndefined();
  });
});

describe("refusing a turn", () => {
  const image = { kind: "image" as const, name: "screenshot.png" };

  test("nothing attached is never a refusal", () => {
    expect(attachmentGuard([], "claude-cli", [model()])).toBeNull();
  });

  test("a model that cannot see the image is named", () => {
    const why = attachmentGuard([image], "openrouter", [model()]);
    expect(why).toContain("Claude Sonnet 4");
    expect(why).toContain("imagens");
  });

  test("one blind member refuses the whole panel", () => {
    /*
     * The deliberate half. Dropping the image for that member alone would leave
     * it answering a question about a picture it was never shown, next to three
     * answers that saw it — and nothing on screen would say so.
     */
    const why = attachmentGuard([image], "openrouter", [
      model({ id: "a", label: "Sees", supportsVision: true }),
      model({ id: "b", label: "Blind" }),
    ]);
    expect(why).toContain("Blind");
  });

  test("a panel that can all see it goes through", () => {
    const why = attachmentGuard([image], "openrouter", [
      model({ id: "a", label: "One", supportsVision: true }),
      model({ id: "b", label: "Two", supportsVision: true }),
    ]);
    expect(why).toBeNull();
  });

  test("a CLI provider says what would fix it, not just that it failed", () => {
    const why = attachmentGuard([image], "claude-cli", [
      model({ supportsVision: true }),
    ]);
    expect(why).toContain("gateway");
  });
});

describe("becoming a content part", () => {
  const yes = { image: true, document: true, audio: true };

  test("an image goes as a data URL", () => {
    expect(attachmentPart(attachment(), "data:image/png;base64,AAA", yes)).toEqual({
      type: "image_url",
      image_url: { url: "data:image/png;base64,AAA" },
    });
  });

  test("a document carries its filename, which is half of what it says", () => {
    const part = attachmentPart(
      attachment({ kind: "document", name: "Q3 plan.pdf", mime: "application/pdf" }),
      "data:application/pdf;base64,AAA",
      yes,
    );
    expect(part).toEqual({
      type: "file",
      file: { filename: "Q3 plan.pdf", file_data: "data:application/pdf;base64,AAA" },
    });
  });

  test("audio goes as bare base64 with its format named", () => {
    const part = attachmentPart(
      attachment({ kind: "audio", name: "note.mp3", mime: "audio/mpeg" }),
      "data:audio/mpeg;base64,AAA",
      yes,
    );
    expect(part).toEqual({
      type: "input_audio",
      input_audio: { data: "AAA", format: "mp3" },
    });
  });

  test("bytes that are not loaded yet produce nothing rather than an empty part", () => {
    expect(attachmentPart(attachment(), undefined, yes)).toBeNull();
  });

  test("a model that cannot take the kind produces nothing", () => {
    expect(
      attachmentPart(attachment(), "data:image/png;base64,AAA", {
        ...yes,
        image: false,
      }),
    ).toBeNull();
  });
});

describe("what the request ends up looking like", () => {
  const send = (
    prompt: string,
    attachments: Attachment[],
    resolve = (a: Attachment) =>
      attachmentPart(a, "data:image/png;base64,AAA", {
        image: true,
        document: true,
        audio: true,
      }),
  ) =>
    buildMessages({
      context: EMPTY_CONTEXT,
      history: [],
      prompt,
      attachments,
      resolveAttachment: resolve,
      projectName: "Atimo",
    });

  test("a turn with nothing attached still sends a bare string", () => {
    /*
     * Load-bearing. Every model takes a string; a parts array is a shape some
     * of them only half support, and there is no reason for an ordinary
     * question to find that out.
     */
    const messages = send("hello", []);
    expect(messages.at(-1)!.content).toBe("hello");
    expect(typeof messages[0]!.content).toBe("string");
  });

  test("attachments lead and the question follows", () => {
    const content = send("what is this?", [attachment()]).at(-1)!.content;
    expect(Array.isArray(content)).toBe(true);
    const parts = content as Exclude<typeof content, string>;
    expect(parts[0]!.type).toBe("image_url");
    expect(parts.at(-1)).toEqual({ type: "text", text: "what is this?" });
  });

  test("a file that could not travel is named, not dropped", () => {
    // A model asked "why does this fail?" with the screenshot silently missing
    // will invent a screenshot. Told the file is missing, it asks.
    const content = send("why does this fail?", [attachment()], () => null)
      .at(-1)!.content;
    expect(typeof content).toBe("string");
    expect(content).toContain("screenshot.png");
    expect(content).toContain("could not be sent");
  });

  test("a picture stays in front of the model on the follow-up turn", () => {
    const history: Message[] = [
      {
        id: "m-1",
        chatId: "c-1",
        role: "user",
        content: "what is this?",
        createdAt: "2026-08-01T00:00:00.000Z",
        attachments: [attachment()],
      },
      {
        id: "m-2",
        chatId: "c-1",
        role: "assistant",
        content: "A login form.",
        createdAt: "2026-08-01T00:00:01.000Z",
      },
    ];

    const messages = buildMessages({
      context: EMPTY_CONTEXT,
      history,
      prompt: "and the top left?",
      resolveAttachment: (a) =>
        attachmentPart(a, "data:image/png;base64,AAA", {
          image: true,
          document: true,
          audio: true,
        }),
      projectName: "Atimo",
    });

    // Without this, "and the top left?" is a question about nothing.
    const earlier = messages[1]!.content;
    expect(Array.isArray(earlier)).toBe(true);
    expect((earlier as { type: string }[])[0]!.type).toBe("image_url");
  });

  test("history degrades to prose when the chat has moved to a blind model", () => {
    const history: Message[] = [
      {
        id: "m-1",
        chatId: "c-1",
        role: "user",
        content: "what is this?",
        createdAt: "2026-08-01T00:00:00.000Z",
        attachments: [attachment()],
      },
    ];

    const messages = buildMessages({
      context: EMPTY_CONTEXT,
      history,
      prompt: "summarise what we said",
      resolveAttachment: () => null,
      projectName: "Atimo",
    });

    expect(contentText(messages[1]!.content)).toContain("screenshot.png");
  });
});

describe("userContent on its own", () => {
  test("no attachments is the identity", () => {
    expect(userContent("hi", undefined, () => null)).toBe("hi");
    expect(userContent("hi", [], () => null)).toBe("hi");
  });

  test("a mixed batch sends what it can and names the rest", () => {
    const sendable = attachment({ id: "a", name: "shot.png" });
    const blocked = attachment({ id: "b", name: "audio.mp3", kind: "audio" });

    const content = userContent("look", [sendable, blocked], (a) =>
      a.id === "a" ? { type: "image_url", image_url: { url: "x" } } : null,
    );

    const parts = content as Exclude<typeof content, string>;
    expect(parts).toHaveLength(2);
    expect(parts[0]!.type).toBe("image_url");
    expect(contentText(parts)).toContain("audio.mp3");
    expect(contentText(parts)).not.toContain("shot.png");
  });
});
