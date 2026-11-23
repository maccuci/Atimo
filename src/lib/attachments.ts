// Straight from the module that declares it, not through the `adapter` barrel:
// the barrel pulls both transports in behind one predicate, and this module is
// reached from the composer on every keystroke that stages a file.
import { isAgentKey } from "./adapter/types";
import type { ContentPart, ProviderKey } from "./adapter/types";
import { uid } from "./utils";
import type { Attachment, AttachmentKind, Model } from "./types";

/*
 * Files that travel with one prompt.
 *
 * The distinction this module exists to hold is the one between a *document* and
 * an *attachment*, which look identical at the drop target and are nothing alike
 * afterwards.
 *
 * A document is text the project keeps. It is chunked, indexed, retrieved in
 * pieces, and reaches a model only insofar as it answers the question — that is
 * `documents.ts`, and it is the product's whole thesis about context.
 *
 * An attachment is bytes one turn carries. A screenshot has no chunks and no
 * passages; there is nothing to retrieve *from* it, because the model is the
 * thing that reads it. So it is not project knowledge, it is part of a message,
 * and it goes to the provider whole or not at all.
 *
 * That "or not at all" is the other half of the module. Attachments are the
 * first thing in this app a model can simply refuse: a text prompt reaches every
 * model in the picker, an image reaches maybe half of them, and a request built
 * for the wrong one fails the turn rather than degrading. So capability is
 * checked before the send button is live, not discovered from a 400.
 */

/* ---------------------------------------------------------------------- */
/* What can be attached                                                    */
/* ---------------------------------------------------------------------- */

/**
 * Media types every gateway here accepts as an image part, unaltered.
 *
 * The allowlist is the provider's, not the browser's. A webview will happily
 * decode HEIC and BMP, and a model will reject both — so anything outside this
 * set is re-encoded to JPEG below rather than sent and refused.
 */
const PROVIDER_IMAGE_MIME = new Set([
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif",
]);

/** Extension → media type, for the files a browser hands over with none set. */
const MIME_BY_EXTENSION: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
  gif: "image/gif",
  heic: "image/heic",
  heif: "image/heif",
  bmp: "image/bmp",
  tif: "image/tiff",
  tiff: "image/tiff",
  avif: "image/avif",
  pdf: "application/pdf",
  mp3: "audio/mpeg",
  wav: "audio/wav",
};

/**
 * Audio the gateways take inline, and the `format` string each one wants.
 *
 * Two, which is the whole list OpenRouter documents for `input_audio`. Naming
 * them individually rather than accepting `audio/*` keeps the failure at the
 * drop target, where it can say what would work, instead of at the provider.
 */
const AUDIO_FORMAT: Record<string, string> = {
  "audio/mpeg": "mp3",
  "audio/mp3": "mp3",
  "audio/wav": "wav",
  "audio/x-wav": "wav",
  "audio/wave": "wav",
};

/** What the file picker offers. Same source of truth as the checks below. */
export const ATTACH_ACCEPT = [
  ...Object.keys(MIME_BY_EXTENSION).map((ext) => `.${ext}`),
  "image/*",
  "application/pdf",
  "audio/mpeg",
  "audio/wav",
].join(",");

/**
 * Ceilings, per kind, on the file as picked.
 *
 * Not about disk, and not really about the network either — it is about the
 * window. A 20MB PDF is several hundred pages, which is more tokens than most
 * models have context for, so a turn carrying one would fail on length after
 * the user waited for the upload. Refusing it up front is the same answer,
 * arrived at in a second instead of a minute.
 */
export const MAX_BYTES: Record<AttachmentKind, number> = {
  image: 20 * 1024 * 1024,
  document: 20 * 1024 * 1024,
  audio: 20 * 1024 * 1024,
};

/** Attachments one prompt may carry. Beyond this the turn is a file transfer. */
export const MAX_PER_TURN = 8;

/**
 * The longest edge an image is sent at.
 *
 * Every provider downsamples above roughly this anyway, and they charge for the
 * pixels first. Sending a 6000px phone photo therefore buys nothing at all: the
 * model sees the same image it would have seen at 1568, and the user pays four
 * times over for the upload, the tokens and the wait.
 */
const MAX_IMAGE_EDGE = 1568;

function extensionOf(name: string): string {
  const at = name.lastIndexOf(".");
  return at === -1 ? "" : name.slice(at + 1).toLowerCase();
}

/**
 * The media type to treat a file as.
 *
 * The browser's own `type` first, then the extension. Both are guesses — a
 * `File` from a drag has whatever the OS said, and one from a paste often has
 * nothing — so the decode below is what actually decides whether an image is an
 * image. This only has to be right enough to route.
 */
export function mimeOf(file: { name: string; type?: string }): string {
  const declared = (file.type ?? "").toLowerCase();
  if (declared && declared !== "application/octet-stream") return declared;
  return MIME_BY_EXTENSION[extensionOf(file.name)] ?? declared;
}

export function kindOf(mime: string): AttachmentKind | null {
  if (mime.startsWith("image/")) return "image";
  if (mime === "application/pdf") return "document";
  if (mime in AUDIO_FORMAT) return "audio";
  return null;
}

/** Whether this file belongs to a turn rather than to project knowledge. */
export function isAttachable(file: { name: string; type?: string }): boolean {
  return kindOf(mimeOf(file)) !== null;
}

/** How a kind is named to a person, singular. */
const KIND_PLURAL: Record<AttachmentKind, string> = {
  image: "imagens",
  document: "documentos",
  audio: "áudios",
};

export const KIND_LABEL: Record<AttachmentKind, string> = {
  image: "imagem",
  document: "documento",
  audio: "áudio",
};

/* ---------------------------------------------------------------------- */
/* Reading one                                                             */
/* ---------------------------------------------------------------------- */

/**
 * An attachment held by the composer, before any message owns it.
 *
 * Carries its bytes, which the persisted `Attachment` deliberately does not.
 * The id is minted here rather than at send, so a chip can be removed by
 * identity while the user is still deciding what to type.
 */
export interface PendingAttachment {
  id: string;
  name: string;
  mime: string;
  kind: AttachmentKind;
  bytes: number;
  width?: number;
  height?: number;
  tokens: number;
  /** `data:<mime>;base64,…` — what both the provider and an `<img>` want. */
  dataUrl: string;
}

/** Why a file was refused, in words the user can act on. */
export class UnattachableFile extends Error {}

function describeSize(bytes: number): string {
  return bytes >= 1024 * 1024
    ? `${(bytes / 1024 / 1024).toFixed(1)}MB`
    : `${Math.max(1, Math.round(bytes / 1024))}KB`;
}

/**
 * Roughly what an image costs in input tokens.
 *
 * `width × height / 750` is Anthropic's published rule and lands within a factor
 * of about 1.3 of what OpenAI and Google charge for the same picture, which is
 * as close as one number gets across four providers. It is shown as an estimate
 * everywhere, and it is only ever used to warn — nothing is refused on it.
 *
 * The fallback is for an image whose dimensions never decoded: a mid-sized
 * picture, so a turn is not reported as free.
 */
export function imageTokens(width?: number, height?: number): number {
  if (!width || !height) return 1_200;
  return Math.min(4_000, Math.round((width * height) / 750));
}

/**
 * Roughly what a PDF costs, from its size alone.
 *
 * There is no page count without parsing the file, and parsing a PDF in the
 * webview to improve a number that is labelled "estimate" is not a trade worth
 * making. ~2.5KB of PDF per page and ~700 tokens a page is the shape of a
 * text-heavy document, which is what people attach.
 */
export function documentTokens(bytes: number): number {
  return Math.round((bytes / 2_500) * 700);
}

/** Base64 payload of a `data:` URL, or the whole string if it is not one. */
function base64Of(dataUrl: string): string {
  const at = dataUrl.indexOf(",");
  return at === -1 ? dataUrl : dataUrl.slice(at + 1);
}

/** Bytes a base64 payload decodes to, without decoding it. */
export function decodedBytes(dataUrl: string): number {
  const payload = base64Of(dataUrl);
  const padding = payload.endsWith("==") ? 2 : payload.endsWith("=") ? 1 : 0;
  return Math.max(0, Math.floor((payload.length * 3) / 4) - padding);
}

function readAsDataUrl(file: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () =>
      typeof reader.result === "string"
        ? resolve(reader.result)
        : reject(new Error("the file did not read as a data URL"));
    reader.onerror = () => reject(reader.error ?? new Error("unreadable file"));
    reader.readAsDataURL(file);
  });
}

interface DecodedImage {
  dataUrl: string;
  mime: string;
  width: number;
  height: number;
  bytes: number;
}

/**
 * Decode an image, shrink it if it is bigger than any model will look at, and
 * re-encode it if its format is one no model accepts.
 *
 * Both jobs are the same canvas pass, which is why they are one function: a HEIC
 * from an iPhone is usually also 4000px wide, and doing the two separately would
 * mean decoding it twice.
 *
 * Returns `null` rather than throwing when the canvas route is unavailable —
 * an animated GIF, a webview with the image decoder disabled, an SVG with no
 * intrinsic size. The caller falls back to sending the original bytes when the
 * format already is one a provider takes, and refuses the file when it is not.
 * That ordering matters: silently converting an animation to a still frame is
 * worse than either.
 */
async function normaliseImage(
  file: Blob,
  mime: string,
): Promise<DecodedImage | null> {
  if (typeof document === "undefined" || typeof Image === "undefined") {
    return null;
  }

  const objectUrl = URL.createObjectURL(file);
  try {
    const image = await new Promise<HTMLImageElement>((resolve, reject) => {
      const element = new Image();
      element.onload = () => resolve(element);
      element.onerror = () => reject(new Error("could not decode the image"));
      element.src = objectUrl;
    });

    const width = image.naturalWidth;
    const height = image.naturalHeight;
    if (!width || !height) return null;

    const scale = Math.min(1, MAX_IMAGE_EDGE / Math.max(width, height));
    const supported = PROVIDER_IMAGE_MIME.has(mime);

    // Nothing to do: already small enough and already in a format that travels.
    // Re-encoding here would cost a generation of quality for no gain, and on a
    // screenshot that generation is the legibility of the text in it.
    if (scale === 1 && supported) {
      const dataUrl = await readAsDataUrl(file);
      return { dataUrl, mime, width, height, bytes: file.size };
    }

    /*
     * An animation cannot survive a canvas: it would arrive as its first frame,
     * which is a different image from the one the user attached. So a GIF is
     * sent whole even when it is larger than the edge limit — every provider
     * accepts the format, and paying for the extra pixels is the cheaper of the
     * two mistakes available here.
     */
    if (mime === "image/gif") {
      const dataUrl = await readAsDataUrl(file);
      return { dataUrl, mime, width, height, bytes: file.size };
    }

    const target = {
      width: Math.max(1, Math.round(width * scale)),
      height: Math.max(1, Math.round(height * scale)),
    };

    const canvas = document.createElement("canvas");
    canvas.width = target.width;
    canvas.height = target.height;
    const context = canvas.getContext("2d");
    if (!context) return null;
    context.drawImage(image, 0, 0, target.width, target.height);

    // PNG keeps transparency and stays lossless, which is what a screenshot or a
    // diagram needs. Everything else lands as JPEG, which is what a photograph
    // needs — and is a format every provider takes.
    const out = mime === "image/png" ? "image/png" : "image/jpeg";
    const dataUrl = canvas.toDataURL(out, 0.9);
    // A canvas that produced nothing usable — a tainted context, an out-of-memory
    // rasterisation — returns a stub `data:,` rather than throwing.
    if (!dataUrl.startsWith(`data:${out}`)) return null;

    return {
      dataUrl,
      mime: out,
      width: target.width,
      height: target.height,
      bytes: decodedBytes(dataUrl),
    };
  } catch {
    return null;
  } finally {
    URL.revokeObjectURL(objectUrl);
  }
}

/**
 * Turn a picked file into something a turn can carry, or refuse it by name.
 *
 * Size is checked before anything is read: a 200MB video should cost a sentence,
 * not a minute of base64 encoding followed by a sentence.
 */
export async function readAttachment(file: File): Promise<PendingAttachment> {
  const mime = mimeOf(file);
  const kind = kindOf(mime);

  if (!kind) {
    throw new UnattachableFile(
      `${file.name} não pode ir direto para o modelo — só imagens, PDFs e ` +
        `áudio MP3/WAV. Arquivos de texto e código vão para o projeto, ` +
        `onde ficam pesquisáveis.`,
    );
  }

  if (file.size > MAX_BYTES[kind]) {
    throw new UnattachableFile(
      `${file.name} tem ${describeSize(file.size)} — o limite para ` +
        `${KIND_PLURAL[kind]} é ${describeSize(MAX_BYTES[kind])}.`,
    );
  }

  if (file.size === 0) {
    throw new UnattachableFile(`${file.name} está vazio.`);
  }

  if (kind === "image") {
    const decoded = await normaliseImage(file, mime);
    if (!decoded) {
      if (!PROVIDER_IMAGE_MIME.has(mime)) {
        throw new UnattachableFile(
          `${file.name} não pôde ser convertido para um formato aceito — ` +
            `salve como PNG ou JPEG e tente de novo.`,
        );
      }
      // Decoding failed but the format itself travels, so the bytes are still
      // worth sending: the model's decoder is not this webview's.
      const dataUrl = await readAsDataUrl(file);
      return {
        id: uid("att"),
        name: file.name,
        mime,
        kind,
        bytes: file.size,
        tokens: imageTokens(),
        dataUrl,
      };
    }

    return {
      id: uid("att"),
      name: file.name,
      mime: decoded.mime,
      kind,
      bytes: decoded.bytes,
      width: decoded.width,
      height: decoded.height,
      tokens: imageTokens(decoded.width, decoded.height),
      dataUrl: decoded.dataUrl,
    };
  }

  const dataUrl = await readAsDataUrl(file);
  return {
    id: uid("att"),
    name: file.name,
    mime,
    kind,
    bytes: file.size,
    // Audio pricing is per second and nothing here knows the duration, so the
    // estimate is left at zero rather than invented. A clip short enough to
    // attach is a rounding error next to the project context around it.
    tokens: kind === "document" ? documentTokens(file.size) : 0,
    dataUrl,
  };
}

/** The persisted half of a pending attachment, once a message owns it. */
export function toAttachment(
  pending: PendingAttachment,
  messageId: string,
  chatId: string,
): Attachment {
  return {
    id: pending.id,
    messageId,
    chatId,
    name: pending.name,
    mime: pending.mime,
    kind: pending.kind,
    bytes: pending.bytes,
    width: pending.width,
    height: pending.height,
    tokens: pending.tokens,
  };
}

/* ---------------------------------------------------------------------- */
/* What a model will take                                                  */
/* ---------------------------------------------------------------------- */

export type ModalitySupport = Record<AttachmentKind, boolean>;

const NOTHING: ModalitySupport = { image: false, document: false, audio: false };

/**
 * What this provider and model, together, will accept.
 *
 * Together, because the two answer different halves and neither is enough on its
 * own. A gateway can add a capability the model does not have — OpenRouter
 * extracts a PDF to text for any model, so "can this model read documents"
 * decides how the extraction is done, not whether it may be attached. And a
 * gateway can withhold one the model does have: Z.AI's chat endpoint takes
 * images inline but has no document part at all, whatever GLM itself can read.
 *
 * A local CLI takes nothing. Its whole interface is one prompt string on an
 * argv, and Atimo runs it with tools switched off, so there is neither a
 * channel to send bytes down nor a way for the agent to fetch them.
 */
export function attachmentSupport(
  provider: ProviderKey,
  model: Model,
): ModalitySupport {
  if (isAgentKey(provider)) return NOTHING;

  return {
    image: model.supportsVision === true,
    document: provider === "openrouter",
    audio: model.supportsAudio === true,
  };
}

/**
 * The engine OpenRouter should extract an attached PDF with.
 *
 * Always stated, never defaulted, and that is the point of the function. Left
 * unset, OpenRouter falls back to OCR for any model without native document
 * input — at $2 per thousand pages, on a turn the user thought was priced by
 * token. `pdf-text` reads the text layer for free and is right for the documents
 * people actually attach; `native` hands the file to a model that reads it
 * itself, which is better than any extraction when it is available.
 *
 * The gap this leaves is a scanned PDF with no text layer on a model that cannot
 * read documents: `pdf-text` returns nothing from it. That is a worse answer
 * than OCR would give and a much better one than a surprise bill, and the fix is
 * a sentence in the composer rather than a charge.
 */
export function pdfEngineFor(
  provider: ProviderKey,
  model: Model,
): "native" | "pdf-text" | undefined {
  if (provider !== "openrouter") return undefined;
  return model.supportsFiles === true ? "native" : "pdf-text";
}

/**
 * Why this turn cannot leave with these attachments, or null.
 *
 * Checked against every model that will answer, not just the primary: a panel
 * sends the same prompt to all of them, and one member that cannot see the
 * image would answer a question about a picture it was never shown — confidently,
 * and next to three answers that did see it.
 *
 * Refusing outright rather than dropping the attachment for that one model is
 * the deliberate half. A panel exists to compare models on one input; a panel
 * where the input silently differed per member is not that, and nothing on
 * screen would say so.
 */
export function attachmentGuard(
  attachments: readonly { kind: AttachmentKind; name: string }[],
  provider: ProviderKey,
  models: readonly Model[],
): string | null {
  if (!attachments.length) return null;

  const kinds = new Set(attachments.map((a) => a.kind));

  for (const model of models) {
    const support = attachmentSupport(provider, model);
    const missing = [...kinds].filter((kind) => !support[kind]);
    if (!missing.length) continue;

    const list = missing.map((kind) => KIND_PLURAL[kind]).join(" ou ");
    return isAgentKey(provider)
      ? `${model.label} roda por uma CLI local, que só recebe texto — ` +
          `anexos precisam de uma chave de gateway. Conecte uma, ou ` +
          `remova ${list}.`
      : `${model.label} não aceita ${list}. Escolha um modelo que aceite, ou ` +
          `remova o anexo.`;
  }

  return null;
}

/* ---------------------------------------------------------------------- */
/* Becoming a request                                                      */
/* ---------------------------------------------------------------------- */

/**
 * One attachment as the provider wants it, or null when it cannot go.
 *
 * Null covers both reasons and does not distinguish them, because the caller
 * does the same thing either way — names the file in the prompt so the model
 * knows something is missing. The reasons are: this model does not take the
 * kind, or the bytes are not in memory, which happens to a chat reopened before
 * its blobs have finished loading.
 */
export function attachmentPart(
  attachment: Attachment,
  dataUrl: string | undefined,
  support: ModalitySupport,
): ContentPart | null {
  if (!dataUrl || !support[attachment.kind]) return null;

  switch (attachment.kind) {
    case "image":
      return { type: "image_url", image_url: { url: dataUrl } };
    case "document":
      return {
        type: "file",
        file: { filename: attachment.name, file_data: dataUrl },
      };
    case "audio": {
      const format = AUDIO_FORMAT[attachment.mime];
      if (!format) return null;
      return {
        type: "input_audio",
        input_audio: { data: base64Of(dataUrl), format },
      };
    }
    default: {
      const exhaustive: never = attachment.kind;
      return exhaustive;
    }
  }
}
