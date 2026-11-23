import { describe, expect, test } from "bun:test";
import { isValidElement, type ReactElement, type ReactNode } from "react";
import { inline, parse } from "./Markdown";

/*
 * The renderer's two pieces that can be wrong without looking wrong.
 *
 * Both are pure: `parse` returns data and `inline` returns React elements,
 * which are plain objects until something renders them. So neither test needs a
 * DOM, and this file stays the same shape as everything under `lib/`.
 */

/* -- tables ------------------------------------------------------------- */

describe("diagram fences", () => {
  test("recognizes a complete diagram and keeps the prose around it", () => {
    const blocks = parse('Fluxo:\n```mermaid\nflowchart LR\n A --> B\n```\nPróximo passo.');
    expect(blocks.map((block) => block.type)).toEqual(["paragraph", "code", "paragraph"]);
    expect(blocks[1]).toMatchObject({ lang: "mermaid", complete: true, lines: ["flowchart LR", " A --> B"] });
  });

  test("does not mark a partially streamed diagram complete", () => {
    expect(parse("```mermaid\nflowchart LR\n A -->")[0]).toMatchObject({ complete: false, lang: "mermaid" });
  });

  test("accepts indented tilde fences and requires the matching closing fence", () => {
    expect(parse("  ~~~~mermaid\nflowchart LR\n A --> B\n~~~\n  ~~~~")[0]).toMatchObject({
      complete: true, lines: ["flowchart LR", " A --> B", "~~~"],
    });
  });

  test("does not close a diagram when a different fence appears inside it", () => {
    expect(parse("````mermaid\nflowchart LR\n```\n A --> B\n````")[0]).toMatchObject({
      complete: true, lines: ["flowchart LR", "```", " A --> B"],
    });
  });
});

describe("tables", () => {
  test("a pipe table becomes a table, not a paragraph of pipes", () => {
    const [block] = parse(
      ["| model | cost |", "| --- | --- |", "| opus | high |", "| haiku | low |"].join("\n"),
    );

    expect(block).toEqual({
      type: "table",
      header: ["model", "cost"],
      align: ["left", "left"],
      rows: [
        ["opus", "high"],
        ["haiku", "low"],
      ],
    });
  });

  test("the delimiter row sets column alignment", () => {
    const [block] = parse(["| a | b | c |", "| :-- | :-: | --: |", "| 1 | 2 | 3 |"].join("\n"));

    expect(block).toMatchObject({ align: ["left", "center", "right"] });
  });

  test("rows written without outer pipes are accepted", () => {
    const [block] = parse(["a | b", "--- | ---", "1 | 2"].join("\n"));

    expect(block).toMatchObject({ header: ["a", "b"], rows: [["1", "2"]] });
  });

  test("a genuinely empty edge cell survives the trim of the outer pipes", () => {
    const [block] = parse(["| a | b |", "| --- | --- |", "|  | 2 |"].join("\n"));

    expect(block).toMatchObject({ rows: [["", "2"]] });
  });

  test("an escaped pipe stays inside its cell", () => {
    const [block] = parse(["| op | means |", "| --- | --- |", String.raw`| \| | or |`].join("\n"));

    expect(block).toMatchObject({ rows: [["|", "or"]] });
  });

  /*
   * The failure this guards is the quiet one: a short row silently shifts every
   * cell after it one column left, so the table reads fine and says the wrong
   * thing. Rendering indexes off the header for the same reason.
   */
  test("a short row is padded rather than shifted", () => {
    const [block] = parse(["| a | b | c |", "| --- | --- | --- |", "| 1 | 2 |"].join("\n"));

    expect(block).toMatchObject({ header: ["a", "b", "c"], rows: [["1", "2"]] });
  });

  test("a table that follows a sentence with no blank line is still a table", () => {
    const blocks = parse(
      ["Here is the comparison:", "| a | b |", "| --- | --- |", "| 1 | 2 |"].join("\n"),
    );

    expect(blocks.map((b) => b.type)).toEqual(["paragraph", "table"]);
    expect(blocks[0]).toMatchObject({ text: "Here is the comparison:" });
  });

  test("a table ends where its rows do", () => {
    const blocks = parse(
      ["| a | b |", "| --- | --- |", "| 1 | 2 |", "", "After the table."].join("\n"),
    );

    expect(blocks.map((b) => b.type)).toEqual(["table", "paragraph"]);
    expect(blocks[1]).toMatchObject({ text: "After the table." });
  });

  test("a horizontal rule is not mistaken for a delimiter row", () => {
    expect(parse("---")).toEqual([{ type: "rule" }]);
  });

  test("prose containing a pipe stays prose", () => {
    const blocks = parse("Run `a | b` to pipe it.\nThen read the output.");

    expect(blocks.map((b) => b.type)).toEqual(["paragraph"]);
  });
});

/* -- links -------------------------------------------------------------- */

function elements(nodes: ReactNode[]): ReactElement<{ href?: string }>[] {
  return nodes.filter((n): n is ReactElement<{ href?: string }> => isValidElement(n));
}

describe("links", () => {
  test("an http link renders as an anchor", () => {
    const [link] = elements(inline("see [docs](https://example.com/a)"));

    expect(link?.type).toBe("a");
    expect(link?.props.href).toBe("https://example.com/a");
  });

  test("mailto is allowed", () => {
    expect(elements(inline("[write](mailto:a@b.co)"))[0]?.type).toBe("a");
  });

  /*
   * The href is model output on its way to `openExternal`, which asks the OS to
   * open it. Anything outside the allowlist has to stop being a link — and keep
   * its label, because deleting text from an answer is its own kind of wrong.
   */
  test.each([
    ["javascript:alert(1)"],
    ["data:text/html,<script>alert(1)</script>"],
    ["file:///etc/passwd"],
    ["./relative/path.md"],
  ])("%s does not become a clickable link", (href) => {
    const [node] = elements(inline(`[label](${href})`));

    expect(node?.type).toBe("span");
    expect(node?.props.href).toBeUndefined();
  });

  test("a refused link keeps its label", () => {
    const [node] = elements(inline("[click here](javascript:alert(1))"));

    expect((node?.props as { children?: unknown }).children).toBe("click here");
  });

  test("a scheme is matched case-insensitively", () => {
    expect(elements(inline("[a](HTTPS://example.com)"))[0]?.type).toBe("a");
    expect(elements(inline("[a](JaVaScRiPt:alert(1))"))[0]?.type).toBe("span");
  });
});
