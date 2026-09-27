import { describe, expect, it } from "vitest";
import { MAX_MARKDOWN_CHARS, inlineToText, isTableDelimiterRow, parseMarkdown } from "@/lib/markdown";
import { markdownToPlainText, plainExcerpt } from "@/server/tools";

/**
 * Deliverables, chat replies and (in live mode) fetched web pages are parsed during SSR on the shared event
 * loop, so a pathological line must not stall every tenant's requests (INF-17). Each case below took over a
 * second before the fix.
 */

const BUDGET_MS = 250;

function timed(fn: () => unknown): number {
  const started = performance.now();
  fn();
  return performance.now() - started;
}

const spaces = (n: number) => " ".repeat(n);

describe("markdown parsing: pathological input", () => {
  const cases: Array<[string, string]> = [
    ["heading with a huge whitespace run", `# a${spaces(60_000)}x`],
    ["table delimiter with a huge whitespace run", `|${spaces(60_000)}x`],
    ["table delimiter with dashes then whitespace", `| ---${spaces(60_000)}x`],
    ["horizontal-rule candidate", `-${spaces(60_000)}x`],
    ["fence candidate", `\`\`\`${spaces(60_000)}x`],
    ["list-item candidate", `${spaces(60_000)}- x`],
    ["blockquote candidate", `>${spaces(60_000)}x`],
    ["many medium-length hostile lines", Array.from({ length: 200 }, () => `# a${spaces(1_500)}x`).join("\n")],
    ["only whitespace", spaces(100_000)],
    ["closing-hash sequence", `## title${spaces(50_000)}###`],
    // Inline scanning used to slice the remaining string at every one of these characters.
    ["long backtick run", "`".repeat(60_000)],
    ["long asterisk run", "*".repeat(60_000)],
    ["long underscore run", `_${"a_".repeat(30_000)}`],
    ["many angle brackets", "<".repeat(60_000)],
    ["many bare-URL starts", "h".repeat(60_000)],
    ["long escape run", "\\".repeat(60_000)],
    ["long link-ish run", "[".repeat(20_000)],
    // At the real document cap. Each failed `[` scans a full 2,000-character window and consumes only itself,
    // so before the per-document scan budget every one of these took ~0.8 s.
    ["nothing but link openers, at the cap", "[".repeat(MAX_MARKDOWN_CHARS)],
    ["nothing but image openers, at the cap", "![".repeat(MAX_MARKDOWN_CHARS / 2)],
    ["link openers with filler, at the cap", "[a".repeat(MAX_MARKDOWN_CHARS / 2)],
    ["unclosed link targets, at the cap", "[x](".repeat(MAX_MARKDOWN_CHARS / 4)],
    ["mixed openers, at the cap", "[*_".repeat(Math.floor(MAX_MARKDOWN_CHARS / 3))],
    // The budget is per document, not per paragraph, cell or list item.
    ["link openers split across paragraphs, at the cap", Array.from({ length: 100 }, () => "[".repeat(1_999)).join("\n\n")],
    ["link openers split across list items, at the cap", Array.from({ length: 100 }, () => `- ${"[".repeat(1_990)}`).join("\n")],
    [
      "link openers split across table cells, at the cap",
      ["| a | b |", "| --- | --- |", ...Array.from({ length: 100 }, () => `| ${"[".repeat(900)} | ${"[".repeat(900)} |`)].join("\n"),
    ],
  ];

  for (const [name, source] of cases) {
    it(`parses ${name} well under ${BUDGET_MS} ms`, () => {
      expect(timed(() => parseMarkdown(source))).toBeLessThan(BUDGET_MS);
    });
  }

  it("keeps the plain-text previewer fast too", () => {
    expect(timed(() => plainExcerpt(`|${spaces(60_000)}x`, 280))).toBeLessThan(BUDGET_MS);
    expect(timed(() => markdownToPlainText(`## h${spaces(60_000)}##`))).toBeLessThan(BUDGET_MS);
  });
});

describe("markdown parsing: behaviour is unchanged", () => {
  it("still parses headings, including closing sequences", () => {
    expect(parseMarkdown("# Title")).toEqual([{ type: "heading", level: 1, children: [{ type: "text", value: "Title" }] }]);
    expect(parseMarkdown("## Title ##")).toEqual([{ type: "heading", level: 2, children: [{ type: "text", value: "Title" }] }]);
    expect(parseMarkdown("### ###")).toEqual([{ type: "heading", level: 3, children: [] }]);
    expect(parseMarkdown("###### Six  ")).toEqual([{ type: "heading", level: 6, children: [{ type: "text", value: "Six" }] }]);
    // Not headings.
    expect(parseMarkdown("#Title")[0].type).toBe("paragraph");
    expect(parseMarkdown("####### Seven")[0].type).toBe("paragraph");
    expect(parseMarkdown("## Title #more")).toEqual([
      { type: "heading", level: 2, children: [{ type: "text", value: "Title #more" }] },
    ]);
  });

  it("still parses tables and their alignment", () => {
    const table = parseMarkdown(["| Company | Round |", "| :--- | ---: |", "| Acme | $12M |"].join("\n"))[0];
    expect(table.type).toBe("table");
    if (table.type !== "table") throw new Error("expected a table");
    expect(table.align).toEqual(["left", "right"]);
    expect(table.header.map(inlineToText)).toEqual(["Company", "Round"]);
    expect(table.rows[0].map(inlineToText)).toEqual(["Acme", "$12M"]);
  });

  it("recognises the delimiter rows GFM allows, and no others", () => {
    for (const row of ["---", "| --- |", "|:---|---:|", " :-: ", "--- | ---", "|-|"]) {
      expect(isTableDelimiterRow(row), row).toBe(true);
    }
    for (const row of ["", "|", "| |", "abc", "| a |", "|--||--|", "-- x --"]) {
      expect(isTableDelimiterRow(row), row).toBe(false);
    }
    // The plain-text previewer asks for at least two dashes.
    expect(isTableDelimiterRow("|-|", 2)).toBe(false);
    expect(isTableDelimiterRow("|--|", 2)).toBe(true);
  });

  it("treats one absurdly long line as paragraph text instead of scanning it as a block", () => {
    const blocks = parseMarkdown(`# ${"word ".repeat(1_000)}`);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].type).toBe("paragraph");
  });
});

describe("markdown parsing: inline scan budget", () => {
  it("never touches a document at the cap that is nothing but real links", () => {
    const link = "[Acme](https://acme.example/pricing) ";
    const count = Math.floor(MAX_MARKDOWN_CHARS / link.length);
    const blocks = parseMarkdown(link.repeat(count));
    expect(blocks).toHaveLength(1);
    const paragraph = blocks[0];
    if (paragraph.type !== "paragraph") throw new Error("expected a paragraph");
    expect(paragraph.children.filter((n) => n.type === "link")).toHaveLength(count);
  });

  it("degrades to plain text, without throwing, once a document has spent the budget", () => {
    // A same-site target: an absolute URL would be autolinked as bare text whatever the budget says.
    const tail = "[ok](/runs/r1)";
    const control = parseMarkdown(tail)[0];
    if (control.type !== "paragraph") throw new Error("expected a paragraph");
    expect(control.children.some((n) => n.type === "link")).toBe(true);

    const source = `${"[".repeat(MAX_MARKDOWN_CHARS - tail.length)}${tail}`;
    const blocks = parseMarkdown(source);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].type).toBe("paragraph");
    if (blocks[0].type !== "paragraph") throw new Error("expected a paragraph");
    expect(blocks[0].children.some((n) => n.type === "link")).toBe(false);
    expect(inlineToText(blocks[0].children)).toBe(source);
  });

  it("parses inline markup in every table column, however wide the table", () => {
    const columns = 30;
    const header = `| ${Array.from({ length: columns }, (_, i) => `h${i}`).join(" | ")} |`;
    const delimiter = `| ${Array.from({ length: columns }, () => "---").join(" | ")} |`;
    const row = `| ${Array.from({ length: columns }, (_, i) => (i === columns - 1 ? "**bold**" : "x")).join(" | ")} |`;
    const table = parseMarkdown([header, delimiter, row].join("\n"))[0];
    if (table.type !== "table") throw new Error("expected a table");
    expect(table.rows[0][columns - 1]).toEqual([{ type: "strong", children: [{ type: "text", value: "bold" }] }]);
  });
});

describe("markdown parsing: input cap", () => {
  it("truncates a document beyond the cap and says so", () => {
    const huge = `${"filler paragraph\n\n".repeat(20_000)}THE END`;
    expect(huge.length).toBeGreaterThan(MAX_MARKDOWN_CHARS);

    const blocks = parseMarkdown(huge);
    const text = blocks.map((b) => (b.type === "paragraph" ? inlineToText(b.children) : "")).join("\n");
    expect(text).not.toContain("THE END");
    expect(text).toContain("too long to display in full");
  });

  it("leaves documents under the cap completely alone", () => {
    const fine = "## Summary\n\nTwelve rounds, three over $50M.";
    expect(parseMarkdown(fine)).toHaveLength(2);
    expect(parseMarkdown(fine).some((b) => b.type === "paragraph" && inlineToText(b.children).includes("too long"))).toBe(false);
  });
});
