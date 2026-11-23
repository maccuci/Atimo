import { memo } from "react";
import {
  Alert02Icon,
  Cancel01Icon,
  File01Icon,
  MusicNote01Icon,
  PdfIcon,
} from "@hugeicons/core-free-icons";
import { Icon } from "@/components/ui/Icon";
import { KIND_LABEL, type PendingAttachment } from "@/lib/attachments";
import { cn, formatTokens } from "@/lib/utils";
import type { Attachment, AttachmentKind } from "@/lib/types";

/*
 * Attached files, shown twice: staged above the composer, and sent inside the
 * transcript.
 *
 * One component for both, because they are the same object at two moments and
 * the failure of drawing them separately is specific — a picture that looked one
 * way while you were deciding to send it and another way afterwards reads as two
 * different files. What actually differs is small enough to be two props: the
 * staged one can be removed, and the sent one may be waiting for its bytes.
 */

const KIND_ICON: Record<AttachmentKind, typeof File01Icon> = {
  image: File01Icon,
  document: PdfIcon,
  audio: MusicNote01Icon,
};

export function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${bytes} B`;
}

/** What the tile says under the name — enough to tell two screenshots apart. */
function describe(attachment: Attachment | PendingAttachment): string {
  const size = formatBytes(attachment.bytes);
  if (attachment.kind === "image" && attachment.width && attachment.height) {
    return `${attachment.width}×${attachment.height} · ${size}`;
  }
  return `${KIND_LABEL[attachment.kind]} · ${size}`;
}

export const AttachmentTile = memo(function AttachmentTile({
  attachment,
  dataUrl,
  onRemove,
  compact = false,
}: {
  attachment: Attachment | PendingAttachment;
  /** The bytes, when they are in memory. Absent while a chat's are loading. */
  dataUrl: string | undefined;
  /** Omitted once the file has been sent — a message cannot be un-attached. */
  onRemove?: () => void;
  /** Denser, for a transcript that should not be dominated by its evidence. */
  compact?: boolean;
}) {
  const isImage = attachment.kind === "image";
  const preview = isImage ? dataUrl : undefined;
  const side = compact ? "h-[72px]" : "h-[88px]";

  const title = `${attachment.name} — ${describe(attachment)}${
    attachment.tokens ? ` · ~${formatTokens(attachment.tokens)} tokens` : ""
  }`;

  return (
    <div className="group/att relative">
      {preview ? (
        <img
          src={preview}
          alt={attachment.name}
          title={title}
          className={cn(
            side,
            "w-auto max-w-[180px] rounded-[12px] border border-border object-cover",
          )}
        />
      ) : (
        <div
          title={title}
          className={cn(
            side,
            "flex w-[180px] items-center gap-2.5 rounded-[12px] border border-border bg-bg-surface px-2.5",
          )}
        >
          <span
            className={cn(
              "flex h-9 w-9 shrink-0 items-center justify-center rounded-[10px] text-white",
              // A frame that is still loading is not the same thing as a file
              // that is a PDF, and the colour is what says so at a glance.
              dataUrl === undefined && isImage
                ? "bg-bg-active text-fg-faint"
                : "bg-amber",
            )}
          >
            <Icon
              icon={KIND_ICON[attachment.kind]}
              size={16}
              strokeWidth={1.75}
            />
          </span>
          <span className="min-w-0 flex-1">
            <span className="block truncate text-[12.5px] font-medium tracking-[-0.01em] text-fg">
              {attachment.name}
            </span>
            <span className="block truncate text-[11px] tracking-[-0.01em] text-fg-faint">
              {dataUrl === undefined && isImage
                ? "loading…"
                : describe(attachment)}
            </span>
          </span>
        </div>
      )}

      {onRemove ? (
        <button
          type="button"
          onClick={onRemove}
          aria-label={`Remover ${attachment.name}`}
          className="pressable absolute -top-1.5 -right-1.5 flex h-5 w-5 items-center justify-center rounded-full border border-border bg-bg-raised text-fg-dim transition-colors duration-150 ease-out hover:text-fg"
        >
          <Icon icon={Cancel01Icon} size={10} strokeWidth={2.25} />
        </button>
      ) : null}
    </div>
  );
});

/**
 * The staged row, above the composer.
 *
 * The refusal sits inside it rather than beside the send button, because the
 * thing the sentence is about is the row: it names a model that cannot read
 * these files, and the two fixes — change the model, remove the file — are both
 * one click from here.
 */
export function AttachmentTray({
  attachments,
  blobs,
  onRemove,
  refusal,
}: {
  attachments: PendingAttachment[];
  blobs: Record<string, string>;
  onRemove: (id: string) => void;
  /** Why this turn cannot leave with these files, or null. */
  refusal: string | null;
}) {
  if (!attachments.length) return null;

  const tokens = attachments.reduce((sum, a) => sum + a.tokens, 0);

  return (
    <div className="px-4 pt-4">
      <div className="flex flex-wrap gap-2">
        {attachments.map((attachment) => (
          <AttachmentTile
            key={attachment.id}
            attachment={attachment}
            dataUrl={blobs[attachment.id] ?? attachment.dataUrl}
            onRemove={() => onRemove(attachment.id)}
          />
        ))}
      </div>

      {refusal ? (
        <p className="mt-2 flex items-start gap-1.5 text-[11.5px] leading-relaxed text-red">
          <Icon
            icon={Alert02Icon}
            size={12}
            strokeWidth={1.75}
            className="mt-0.5 shrink-0"
          />
          {refusal}
        </p>
      ) : tokens > 0 ? (
        <p className="mt-2 text-[11px] text-fg-faint">
          {/* Stated as an estimate every time it is shown. An image is priced by
              area and a PDF by pages nobody has counted, so this is a different
              kind of number from the token counts beside it. */}
          Roughly {formatTokens(tokens)} extra tokens on this turn
        </p>
      ) : null}
    </div>
  );
}

/**
 * The sent row, inside a user message.
 *
 * Drawn from the metadata on the message, so a transcript has the right number
 * of frames the instant it renders and fills them as the bytes arrive — rather
 * than growing by an inch a moment after the user has started reading.
 */
export function SentAttachments({
  attachments,
  blobs,
}: {
  attachments: Attachment[];
  blobs: Record<string, string>;
}) {
  if (!attachments.length) return null;

  return (
    <div className="mb-2.5 flex flex-wrap gap-2">
      {attachments.map((attachment) => (
        <AttachmentTile
          key={attachment.id}
          attachment={attachment}
          dataUrl={blobs[attachment.id]}
          compact
        />
      ))}
    </div>
  );
}
