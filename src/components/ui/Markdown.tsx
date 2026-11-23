import { sqlTokens } from "@/lib/sql-highlight";
import { sourceUrl } from "@/lib/research-provider";
import { lazy, Suspense, useState, Fragment, type ReactNode } from "react";
import { openExternal } from "@/lib/open-external";
import { cn } from "@/lib/utils";

const DiagramBlock = lazy(() => import("./DiagramBlock"));

/*
 * Minimal markdown renderer.
 *
 * Model output is markdown and the PRD lists "Markdown support" in the MVP.
 * A full parser is not warranted for what models actually emit in chat, and
 * pulling one in would drag a sanitizer along with it, so this handles the
 * subset that shows up in practice: headings, fenced code, lists, blockquotes,
 * and inline bold/italic/code/links. Anything unrecognized renders as text,
 * which is the safe failure mode.
 */

type Align = "left" | "center" | "right";

type Block =
  | { type: "heading"; level: number; text: string }
  | { type: "paragraph"; text: string }
  | { type: "code"; lang: string; lines: string[]; complete: boolean }
  | { type: "list"; ordered: boolean; items: string[] }
  | { type: "quote"; lines: string[] }
  | { type: "table"; header: string[]; align: Align[]; rows: string[][] }
  | { type: "rule" };

/*
 * Tables.
 *
 * Worth the ~40 lines: comparison is what this app asks models to do — which
 * library, which database, this model against that one — and a comparison comes
 * back as a table almost every time. Without a parser for them those rows fell
 * through to the paragraph branch, which joins lines with a space, so the most
 * structured answer a model can give arrived as the least readable thing on the
 * screen: one run-on line of pipes and dashes.
 */

/** `| --- | :-: |` — the row that makes the line above it a header. */
const DELIMITER_ROW = /^\s*\|?\s*:?-+:?\s*(?:\|\s*:?-+:?\s*)*\|?\s*$/;

/**
 * A table is only a table if the second line says so, which is why this looks
 * ahead rather than deciding on the current line. Any prose line can contain a
 * pipe; almost none is followed by `| --- |`.
 */
function startsTable(lines: string[], i: number): boolean {
  return (
    lines[i]!.includes("|") &&
    i + 1 < lines.length &&
    DELIMITER_ROW.test(lines[i + 1]!)
  );
}

/**
 * Split one row into cells on unescaped pipes.
 *
 * Hand-scanned rather than `split(/(?<!\\)\|/)`: lookbehind is not in every
 * WebKit this app ships against, and a regex that throws at parse time takes the
 * whole renderer with it.
 */
function splitRow(line: string): string[] {
  const cells: string[] = [];
  let cell = "";

  for (let k = 0; k < line.length; k += 1) {
    const ch = line[k]!;
    if (ch === "\\" && line[k + 1] === "|") {
      cell += "|";
      k += 1;
    } else if (ch === "|") {
      cells.push(cell);
      cell = "";
    } else {
      cell += ch;
    }
  }
  cells.push(cell);

  // `| a | b |` produces an empty cell at each end and `a | b` produces none.
  // Trimming only the empty edges accepts both without dropping a genuinely
  // empty first or last column.
  if (cells.length > 1 && !cells[0]!.trim()) cells.shift();
  if (cells.length > 1 && !cells[cells.length - 1]!.trim()) cells.pop();

  return cells.map((c) => c.trim());
}

function alignOf(spec: string): Align {
  const s = spec.trim();
  const left = s.startsWith(":");
  const right = s.endsWith(":");
  if (left && right) return "center";
  return right ? "right" : "left";
}

/** Exported for `markdown.test.ts`; nothing outside this file renders blocks. */
export function parse(source: string): Block[] {
  const lines = source.replace(/\r\n/g, "\n").split("\n");
  const blocks: Block[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i]!;

    if (!line.trim()) {
      i += 1;
      continue;
    }

    // Fenced code
    const fence = /^ {0,3}(`{3,}|~{3,})(\w*)[^\n]*$/.exec(line);
    if (fence) {
      const marker = fence[1]!;
      const close = new RegExp(`^ {0,3}${marker[0]}{${marker.length},}\\s*$`);
      const lang = fence[2] ?? "";
      const body: string[] = [];
      i += 1;
      while (i < lines.length && !close.test(lines[i]!)) {
        body.push(lines[i]!);
        i += 1;
      }
      const complete = i < lines.length;
      if (complete) i += 1;
      blocks.push({ type: "code", lang, lines: body, complete });
      continue;
    }

    if (/^(-{3,}|\*{3,}|_{3,})$/.test(line.trim())) {
      blocks.push({ type: "rule" });
      i += 1;
      continue;
    }

    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      blocks.push({
        type: "heading",
        level: heading[1]!.length,
        text: heading[2]!,
      });
      i += 1;
      continue;
    }

    if (/^>\s?/.test(line)) {
      const body: string[] = [];
      while (i < lines.length && /^>\s?/.test(lines[i]!)) {
        body.push(lines[i]!.replace(/^>\s?/, ""));
        i += 1;
      }
      blocks.push({ type: "quote", lines: body });
      continue;
    }

    if (startsTable(lines, i)) {
      const header = splitRow(line);
      const align = splitRow(lines[i + 1]!).map(alignOf);
      i += 2;
      const rows: string[][] = [];
      // A blank line ends the table; so does a line that has stopped being one,
      // which is how a model that forgets the trailing pipe halfway down still
      // gets a table plus a paragraph rather than a table that eats the rest.
      while (i < lines.length && lines[i]!.trim() && lines[i]!.includes("|")) {
        rows.push(splitRow(lines[i]!));
        i += 1;
      }
      blocks.push({ type: "table", header, align, rows });
      continue;
    }

    const bullet = /^\s*[-*+]\s+/;
    const numbered = /^\s*\d+[.)]\s+/;
    if (bullet.test(line) || numbered.test(line)) {
      const ordered = numbered.test(line);
      const marker = ordered ? numbered : bullet;
      const items: string[] = [];
      while (i < lines.length && marker.test(lines[i]!)) {
        let item = lines[i]!.replace(marker, "");
        i += 1;
        // Continuation lines are indented under the item.
        while (i < lines.length && /^\s{2,}\S/.test(lines[i]!) && !marker.test(lines[i]!)) {
          item += ` ${lines[i]!.trim()}`;
          i += 1;
        }
        items.push(item);
      }
      blocks.push({ type: "list", ordered, items });
      continue;
    }

    const body: string[] = [];
    while (
      i < lines.length &&
      lines[i]!.trim() &&
      !/^ {0,3}(?:`{3,}|~{3,})/.test(lines[i]!) &&
      !/^#{1,6}\s/.test(lines[i]!) &&
      !/^>\s?/.test(lines[i]!) &&
      !bullet.test(lines[i]!) &&
      !numbered.test(lines[i]!) &&
      // A table introduced without a blank line above it is otherwise swallowed
      // by the paragraph that precedes it — which is exactly how models write
      // one: a sentence, then the table on the next line.
      !startsTable(lines, i)
    ) {
      body.push(lines[i]!);
      i += 1;
    }
    blocks.push({ type: "paragraph", text: body.join(" ") });
  }

  return blocks;
}

/**
 * Link schemes this app is willing to hand to the OS.
 *
 * The href comes out of model output, so it is untrusted text on the way to
 * `openExternal` — which on the desktop asks the operating system to open it,
 * and an OS will open a great deal more than a browser will. An allowlist is the
 * only version of this check that stays correct as schemes are invented;
 * blocking `javascript:` and calling it done leaves `data:`, `file:` and every
 * app's custom scheme.
 */
const SAFE_SCHEME = /^(?:https?|mailto):/i;

/** Inline spans: `code`, **bold**, *italic*, [text](url). */
export function inline(text: string, keyPrefix = "", allowedUrls?: ReadonlySet<string>): ReactNode[] {
  const pattern = /(`[^`]+`)|(\*\*[^*]+\*\*)|(\*[^*]+\*|_[^_]+_)|(\[[^\]]+\]\([^)]+\))/g;
  const out: ReactNode[] = [];
  let last = 0;
  let match: RegExpExecArray | null;
  let n = 0;

  while ((match = pattern.exec(text)) !== null) {
    if (match.index > last) out.push(text.slice(last, match.index));
    const token = match[0];
    const key = `${keyPrefix}-${n++}`;

    if (token.startsWith("`")) {
      out.push(
        <code
          key={key}
          className="rounded-[3px] border border-border bg-bg-inset px-1 py-px text-[0.92em] text-fg"
        >
          {token.slice(1, -1)}
        </code>,
      );
    } else if (token.startsWith("**")) {
      out.push(
        <strong key={key} className="font-semibold text-fg">
          {token.slice(2, -2)}
        </strong>,
      );
    } else if (token.startsWith("[")) {
      const link = /\[([^\]]+)\]\(([^)]+)\)/.exec(token)!;
      const label = link[1]!;
      const href = link[2]!.trim();
      out.push(
        SAFE_SCHEME.test(href) && (!allowedUrls || allowedUrls.has(sourceUrl(href) ?? "")) ? (
          <a
            key={key}
            href={href}
            title={href}
            onClick={(e) => {
              e.preventDefault();
              void openExternal(href);
            }}
            className="text-cyan underline decoration-cyan/40 underline-offset-2"
          >
            {label}
          </a>
        ) : (
          // Not a link this app will follow. The label still reads — dropping it
          // would silently delete a sentence's worth of the answer — but it does
          // not look clickable, because it is not.
          <span key={key} title={href} className="text-fg-dim underline decoration-border">
            {label}
          </span>
        ),
      );
    } else {
      out.push(
        <em key={key} className="italic">
          {token.slice(1, -1)}
        </em>,
      );
    }
    last = match.index + token.length;
  }

  if (last < text.length) out.push(text.slice(last));
  return out;
}

export function Markdown({
  source,
  className,
  allowedUrls,
  streaming = false,
}: {
  allowedUrls?: ReadonlySet<string>;
  source: string;
  className?: string;
  streaming?: boolean;
}) {
  const blocks = parse(source);
  const renderInline = (text: string, key: string) => inline(text, key, allowedUrls);

  return (
    <div className={cn("selectable space-y-3 leading-[1.65]", className)}>
      {blocks.map((block, index) => {
        const key = `b-${index}`;

        switch (block.type) {
          case "heading": {
            const size =
              block.level <= 2 ? "text-[15px]" : block.level === 3 ? "text-[14px]" : "text-[13px]";
            return (
              <div key={key} className={cn("pt-1 font-semibold text-fg", size)}>
                {renderInline(block.text, key)}
              </div>
            );
          }

          case "paragraph":
            return (
              <p key={key} className="text-fg-dim">
                {renderInline(block.text, key)}
              </p>
            );

          case "code":
            if (block.lang.toLowerCase() === "mermaid") {
              return <Suspense key={key} fallback={<p role="status" className="text-fg-faint">Carregando diagrama…</p>}>
                <DiagramBlock source={block.lines.join("\n")} complete={block.complete} pending={streaming && !block.complete} />
              </Suspense>;
            }
            return <CodeBlock key={key} lang={block.lang} source={block.lines.join("\n")} />;

          case "list":
            return (
              <ul key={key} className="space-y-1.5">
                {block.items.map((item, j) => (
                  <li key={`${key}-${j}`} className="flex gap-2 text-fg-dim">
                    <span className="shrink-0 select-none text-fg-faint">
                      {block.ordered ? `${j + 1}.` : "·"}
                    </span>
                    <span>{renderInline(item, `${key}-${j}`)}</span>
                  </li>
                ))}
              </ul>
            );

          case "table": {
            const align = (col: number) =>
              block.align[col] === "right"
                ? "text-right"
                : block.align[col] === "center"
                  ? "text-center"
                  : "text-left";

            return (
              // The transcript column is narrower than a table usually wants, so
              // the table scrolls inside its own bounds rather than widening the
              // message and pushing the whole conversation sideways.
              <div
                key={key}
                className="scroll-thin overflow-x-auto rounded border border-border"
              >
                <table className="w-full border-collapse text-[12px]">
                  <thead>
                    <tr className="border-b border-border bg-bg-inset">
                      {block.header.map((cell, c) => (
                        <th
                          key={`${key}-h-${c}`}
                          className={cn(
                            "whitespace-nowrap px-3 py-1.5 font-semibold text-fg",
                            align(c),
                          )}
                        >
                          {renderInline(cell, `${key}-h-${c}`)}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {block.rows.map((row, r) => (
                      <tr
                        key={`${key}-r-${r}`}
                        className="border-b border-border last:border-b-0"
                      >
                        {/* Indexed off the header, not off the row: a short row
                            would otherwise shift every cell after it under the
                            wrong column, which is a table that lies rather than
                            one that looks untidy. */}
                        {block.header.map((_, c) => (
                          <td
                            key={`${key}-r-${r}-${c}`}
                            className={cn("px-3 py-1.5 align-top text-fg-dim", align(c))}
                          >
                            {renderInline(row[c] ?? "", `${key}-r-${r}-${c}`)}
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            );
          }

          case "quote":
            return (
              <blockquote
                key={key}
                className="border-l-2 border-border-strong pl-3 text-fg-faint italic"
              >
                {block.lines.map((l, j) => (
                  <Fragment key={`${key}-${j}`}>{renderInline(l, `${key}-${j}`)} </Fragment>
                ))}
              </blockquote>
            );

          case "rule":
            return <div key={key} className="h-px bg-border" />;
        }
      })}
    </div>
  );
}

function CodeBlock({ lang, source }: { lang: string; source: string }) {
  const [copied, setCopied] = useState(false);
  const colors = { comment: "text-fg-faint", string: "text-green", keyword: "text-cyan", number: "text-magenta" };
  return <div className="overflow-hidden rounded border border-border bg-bg-inset">
    <div className="flex items-center justify-between px-3 pt-2 text-[10px] text-fg-faint">
      <span>{lang || "code"}</span>
      <button type="button" className="text-cyan" onClick={() => { void navigator.clipboard.writeText(source).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1200); }).catch(() => setCopied(false)); }} aria-label="Copiar código">{copied ? "Copiado" : "Copiar"}</button>
    </div>
    <pre className="scroll-thin overflow-x-auto p-3 text-[12px] leading-relaxed"><code className="text-fg">
      {/^(sql|plsql|oracle)$/i.test(lang) ? sqlTokens(source).map((token, i) => <span key={i} className={token.kind ? colors[token.kind] : undefined}>{token.text}</span>) : source}
    </code></pre>
  </div>;
}
