import { cn } from "@/lib/utils";
import { Fragment } from "react";
import { Icon } from "@/components/ui/Icon";
import { KIND_ICON } from "@/components/ui/primitives";
import { parseReferences } from "@/lib/references";
import type { Reference, ReferenceKind } from "@/lib/types";

/** Codex-style mention: kind icon + label, no chip chrome. */
export function MentionChip({
  kind,
  label,
  title,
  selected,
}: {
  kind: ReferenceKind;
  label: string;
  title?: string;
  selected?: boolean;
}) {
  return (
    <span
      title={title}
      className={cn(
        "inline-flex max-w-full min-w-0 items-center gap-1 text-cyan",
        selected && "rounded-[3px] bg-cyan/15",
      )}
    >
      <Icon
        icon={KIND_ICON[kind]}
        size={13}
        strokeWidth={1.75}
        className="shrink-0"
      />
      <span className="min-w-0 truncate font-medium tracking-[-0.01em]">
        {label}
      </span>
    </span>
  );
}

/**
 * Renders `@kind("target")` references as Codex chips (icon + label).
 * Used in sent messages — the composer hosts chips as editor nodes (composer-editor.tsx).
 */
export function ReferenceText({ value }: { value: string }) {
  const refs = parseReferences(value);
  if (refs.length === 0) return <>{value}</>;

  const parts: React.ReactNode[] = [];
  let cursor = 0;

  refs.forEach((reference, i) => {
    if (reference.start > cursor) {
      parts.push(value.slice(cursor, reference.start));
    }
    const text = value.slice(reference.start, reference.end);
    parts.push(
      <RefToken key={i} reference={reference} text={text} />,
    );
    cursor = reference.end;
  });

  if (cursor < value.length) parts.push(value.slice(cursor));

  return (
    <>
      {parts.map((part, i) => (
        <Fragment key={i}>{part}</Fragment>
      ))}
    </>
  );
}

function RefToken({
  reference,
  text,
}: {
  reference: Reference;
  text: string;
}) {
  if (reference.entityId && reference.target) {
    return (
      <MentionChip
        kind={reference.kind}
        label={reference.target}
        title={text}
      />
    );
  }

  return (
    <span className="text-fg-dim underline decoration-fg-faint decoration-dotted underline-offset-2">
      {text}
    </span>
  );
}
