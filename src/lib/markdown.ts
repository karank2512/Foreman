/**
 * Minimal, safe Markdown → AST parser for worker deliverables, reviews and chat replies.
 *
 * Supported: ATX headings, paragraphs (hard breaks), ordered / unordered / task lists (nested), GFM tables with
 * alignment, fenced code, blockquotes, horizontal rules, and inline bold / italic / strikethrough / code / links /
 * bare URLs. Raw HTML is NEVER interpreted — it stays literal text — and link targets are restricted to
 * http(s), mailto and same-site paths. The renderer (`src/components/markdown.tsx`) maps this AST to React
 * elements, so no HTML string is ever produced.
 */

export type InlineNode =
  | { type: "text"; value: string }
  | { type: "strong"; children: InlineNode[] }
  | { type: "em"; children: InlineNode[] }
  | { type: "del"; children: InlineNode[] }
  | { type: "code"; value: string }
  | { type: "link"; href: string; children: InlineNode[] }
  | { type: "br" };

export type TableAlign = "left" | "center" | "right" | null;

export interface ListItemNode {
  /** `true` / `false` for task-list items (`- [x]`), `null` otherwise. */
  checked: boolean | null;
  /** The item's first paragraph. */
  children: InlineNode[];
  /** Anything after it: nested lists, further paragraphs, code blocks. */
  blocks: BlockNode[];
}

export type BlockNode =
  | { type: "heading"; level: 1 | 2 | 3 | 4 | 5 | 6; children: InlineNode[] }
  | { type: "paragraph"; children: InlineNode[] }
  | { type: "list"; ordered: boolean; start: number; items: ListItemNode[] }
  | { type: "code"; lang: string | null; value: string }
  | { type: "table"; align: TableAlign[]; header: InlineNode[][]; rows: InlineNode[][][] }
  | { type: "blockquote"; children: BlockNode[] }
  | { type: "hr" };

// ── Links ───────────────────────────────────────────────────────────────────

const SAFE_PROTOCOL = /^(https?:|mailto:)/i;
/** Placeholder origin used only to check that a relative href cannot leave the site. */
const SAME_SITE_ORIGIN = "http://same-site.invalid";

/** Returns a safe href or `null` (javascript:, data:, vbscript:, protocol-relative and unknown schemes are dropped). */
export function sanitizeHref(raw: string): string | null {
  // Browsers ignore whitespace/control characters inside the scheme ("java\nscript:"), so strip before checking.
  const href = raw.trim().replace(/[\x00-\x1f\x7f\s]+/g, "");
  if (href === "") return null;
  // Absolute links open in a new tab without a referrer (see isExternalHref), so they may point anywhere.
  if (SAFE_PROTOCOL.test(href)) return href;
  // Anything else with a scheme is rejected.
  if (/^[a-z][a-z0-9+.-]*:/i.test(href)) return null;
  // What is left renders as a same-tab link WITH a referrer, so it must stay on this site. Browsers read "\" as
  // "/" in http(s) URLs, which makes "/\evil.example" and "\\evil.example" protocol-relative just like
  // "//evil.example"; resolving against a placeholder origin catches every such spelling.
  if (href.includes("\\")) return null;
  try {
    if (new URL(href, SAME_SITE_ORIGIN).origin !== SAME_SITE_ORIGIN) return null;
  } catch {
    return null;
  }
  // "/runs/r1", "#summary", "?tab=x" and scheme-less text like "docs/page" (a relative path).
  return href;
}

export function isExternalHref(href: string): boolean {
  return /^https?:/i.test(href);
}

// ── Inline ──────────────────────────────────────────────────────────────────

const ESCAPABLE = /[\\`*_{}[\]()#+\-.!|~<>]/;
const WORD_CHAR = /[\p{L}\p{N}]/u;

/**
 * Sticky (`y`) regexes matched AT an index instead of `exec(src.slice(i))`. Slicing inside the scan loop is
 * what made the inline parser quadratic on long runs of spaces, backticks or `*` — 60 k spaces took 1.8 s
 * (INF-17). Sticky matching allocates nothing.
 */
const HARD_BREAK_AT = / {2,}\n/y;
const AUTOLINK_AT = /<((?:https?:\/\/|mailto:)[^\s<>]+)>/iy;
const BARE_URL_AT = /https?:\/\/[^\s<>]+/iy;

/**
 * How far the inline scanner looks ahead for a closing delimiter or link bracket. Real emphasis and real
 * link labels are short; without a bound, `"_a_a_a…"` or `"[[[[…"` makes every opener scan to the end of the
 * document (quadratic). Past the window the delimiter is simply literal text.
 */
const MAX_SPAN = 2_000;
/** Nested inline structures recurse; a crafted `[[[[…]]]]` must not exhaust the stack. */
const MAX_INLINE_DEPTH = 24;

/**
 * Ceiling on the characters the inline scanner may look ahead in ONE document. `MAX_SPAN` bounds a single
 * opener, but nothing stopped a document at the cap from being 200,000 openers that each fail after a full
 * window: `"[".repeat(200_000)` cost 0.8 s of the SSR event loop. Real content spends a handful of characters
 * per delimiter — a document full of links scans roughly its own length once — so this is never reached by
 * anything a worker legitimately writes. Past it, the remaining delimiters are plain text.
 */
const MAX_INLINE_SCAN = 10_000_000;

/** Shared by every inline scan of one document (paragraphs, cells, nested labels) so the ceiling is per document. */
interface ScanBudget {
  remaining: number;
}

const newScanBudget = (): ScanBudget => ({ remaining: MAX_INLINE_SCAN });

function matchAt(re: RegExp, src: string, index: number): RegExpExecArray | null {
  re.lastIndex = index;
  return re.exec(src);
}

/** Length of the run of `ch` starting at `index`. */
function runLength(src: string, index: number, ch: string): number {
  let n = 0;
  while (src[index + n] === ch) n += 1;
  return n;
}

function pushText(out: InlineNode[], value: string): void {
  if (value === "") return;
  const last = out[out.length - 1];
  if (last && last.type === "text") last.value += value;
  else out.push({ type: "text", value });
}

/**
 * Index of the closing `delim` after `from`, skipping escapes and code spans. -1 when there is none within
 * `MAX_SPAN` characters or the document's scan budget is spent. The characters looked at are charged to the
 * budget.
 */
function findClosing(src: string, from: number, delim: string, budget: ScanBudget): number {
  const limit = Math.min(src.length, from + MAX_SPAN, from + budget.remaining);
  const close = scanClosing(src, from, limit, delim);
  budget.remaining -= (close === -1 ? limit : Math.min(close, limit)) - from;
  return close;
}

function scanClosing(src: string, from: number, limit: number, delim: string): number {
  let i = from;
  while (i < limit) {
    const ch = src[i];
    if (ch === "\\") {
      i += 2;
      continue;
    }
    if (ch === "`") {
      const run = runLength(src, i, "`") || 1;
      const close = src.indexOf("`".repeat(run), i + run);
      i = close === -1 ? i + run : close + run;
      continue;
    }
    if (src.startsWith(delim, i)) {
      // A single * / _ must not match the first char of a ** / __ run (that belongs to a nested strong).
      if (delim.length === 1 && src[i + 1] === delim) {
        const innerClose = src.indexOf(delim + delim, i + 2);
        if (innerClose !== -1) {
          i = innerClose + 2;
          continue;
        }
      }
      // "**bold and *italic***": a longer closing run donates its LAST chars to this delimiter so the inner
      // emphasis keeps its own closer.
      if (delim.length > 1) {
        let run = delim.length;
        while (src[i + run] === delim[0]) run += 1;
        return i + (run - delim.length);
      }
      return i;
    }
    i += 1;
  }
  return -1;
}

/**
 * Matches `[label](target "title")` at `start` (which points at `[`). Both scans are clamped to the document's
 * remaining budget and charged to it: a failed `[` costs up to `MAX_SPAN` characters and consumes only itself,
 * which is what made a document of nothing but `[` quadratic.
 */
function matchLink(src: string, start: number, budget: ScanBudget): { label: string; target: string; end: number } | null {
  const labelLimit = Math.min(src.length, start + MAX_SPAN, start + budget.remaining);
  let depth = 0;
  let i = start;
  for (; i < labelLimit; i++) {
    const ch = src[i];
    if (ch === "\\") {
      i += 1;
      continue;
    }
    if (ch === "[") depth += 1;
    else if (ch === "]") {
      depth -= 1;
      if (depth === 0) break;
    }
  }
  budget.remaining -= Math.min(i, labelLimit) - start;
  if (i >= labelLimit || src[i + 1] !== "(") return null;
  const targetLimit = Math.min(src.length, i + MAX_SPAN, i + budget.remaining);
  let parens = 0;
  let j = i + 1;
  for (; j < targetLimit; j++) {
    const ch = src[j];
    if (ch === "\\") {
      j += 1;
      continue;
    }
    if (ch === "\n") break;
    if (ch === "(") parens += 1;
    else if (ch === ")") {
      parens -= 1;
      if (parens === 0) break;
    }
  }
  budget.remaining -= Math.min(j, targetLimit) - i;
  if (j >= targetLimit || src[j] === "\n") return null;
  const inside = src.slice(i + 2, j).trim();
  // Drop an optional title: [x](https://a.example "Title")
  const target = inside.replace(/\s+("[^"]*"|'[^']*')\s*$/, "").replace(/^<(.*)>$/, "$1");
  return { label: src.slice(start + 1, i), target, end: j + 1 };
}

function emphasisCanOpen(src: string, i: number, delim: string): boolean {
  const next = src[i + delim.length];
  if (next === undefined || /\s/.test(next)) return false;
  // snake_case and 2*3*4 must survive: `_` never opens inside a word.
  if (delim[0] === "_" && i > 0 && WORD_CHAR.test(src[i - 1] ?? "")) return false;
  return true;
}

function emphasisCanClose(src: string, closeIdx: number, delim: string): boolean {
  const prev = src[closeIdx - 1];
  if (prev === undefined || /\s/.test(prev)) return false;
  if (delim[0] === "_" && WORD_CHAR.test(src[closeIdx + delim.length] ?? "")) return false;
  return true;
}

export function parseInline(src: string, depth = 0, budget: ScanBudget = newScanBudget()): InlineNode[] {
  const out: InlineNode[] = [];
  if (depth > MAX_INLINE_DEPTH) return src === "" ? out : [{ type: "text", value: src }];
  let i = 0;

  while (i < src.length) {
    const ch = src[i] as string;

    // Backslash escapes and backslash hard breaks
    if (ch === "\\") {
      const next = src[i + 1];
      if (next === "\n") {
        out.push({ type: "br" });
        i += 2;
        continue;
      }
      if (next !== undefined && ESCAPABLE.test(next)) {
        pushText(out, next);
        i += 2;
        continue;
      }
      pushText(out, ch);
      i += 1;
      continue;
    }

    // Hard break: two+ trailing spaces before a newline
    if (ch === " " && src[i + 1] === " ") {
      const hard = matchAt(HARD_BREAK_AT, src, i);
      if (hard) {
        out.push({ type: "br" });
        i += hard[0].length;
        continue;
      }
      // Not a break: emit the whole space run so its tail is not re-tested character by character.
      const spaces = runLength(src, i, " ");
      pushText(out, " ".repeat(spaces));
      i += spaces;
      continue;
    }

    // Code span
    if (ch === "`") {
      const run = runLength(src, i, "`") || 1;
      const close = src.indexOf("`".repeat(run), i + run);
      if (close !== -1) {
        const value = src.slice(i + run, close).replace(/\n/g, " ");
        // CommonMark: one leading + trailing space is stripped when both exist ("`` `a` ``").
        const trimmed = value.length > 2 && value.startsWith(" ") && value.endsWith(" ") ? value.slice(1, -1) : value;
        out.push({ type: "code", value: trimmed });
        i = close + run;
        continue;
      }
      pushText(out, "`".repeat(run));
      i += run;
      continue;
    }

    // Emphasis: ***x***, **x**, __x__, *x*, _x_, ~~x~~
    if (ch === "*" || ch === "_" || ch === "~") {
      const candidates = ch === "~" ? ["~~"] : [ch.repeat(3), ch.repeat(2), ch];
      let matched = false;
      for (const delim of candidates) {
        if (!src.startsWith(delim, i) || !emphasisCanOpen(src, i, delim)) continue;
        const close = findClosing(src, i + delim.length, delim, budget);
        if (close === -1 || close === i + delim.length || !emphasisCanClose(src, close, delim)) continue;
        const inner = parseInline(src.slice(i + delim.length, close), depth + 1, budget);
        if (delim === "~~") out.push({ type: "del", children: inner });
        else if (delim.length === 3) out.push({ type: "strong", children: [{ type: "em", children: inner }] });
        else if (delim.length === 2) out.push({ type: "strong", children: inner });
        else out.push({ type: "em", children: inner });
        i = close + delim.length;
        matched = true;
        break;
      }
      if (matched) continue;
      // Not emphasis: emit the whole delimiter run literally so its tail is not re-tried as an opener.
      const run = runLength(src, i, ch) || 1;
      pushText(out, ch.repeat(run));
      i += run;
      continue;
    }

    // Links (images degrade to a link on their alt text — deliverables never embed remote images)
    if (ch === "[" || (ch === "!" && src[i + 1] === "[")) {
      const start = ch === "!" ? i + 1 : i;
      const link = matchLink(src, start, budget);
      if (link) {
        const href = sanitizeHref(link.target);
        const children = parseInline(link.label, depth + 1, budget);
        if (href) out.push({ type: "link", href, children: children.length > 0 ? children : [{ type: "text", value: href }] });
        else out.push(...children);
        i = link.end;
        continue;
      }
    }

    // Autolink <https://…> — any other <…> is literal text (no raw HTML).
    if (ch === "<") {
      const auto = matchAt(AUTOLINK_AT, src, i);
      const href = auto?.[1] ? sanitizeHref(auto[1]) : null;
      if (auto && href) {
        out.push({ type: "link", href, children: [{ type: "text", value: auto[1] as string }] });
        i += auto[0].length;
        continue;
      }
    }

    // Bare URL
    if ((ch === "h" || ch === "H") && (i === 0 || !WORD_CHAR.test(src[i - 1] ?? ""))) {
      const bare = matchAt(BARE_URL_AT, src, i);
      if (bare) {
        let url = bare[0].replace(/[.,;:!?'"*_~]+$/, "");
        // A trailing ")" belongs to the sentence unless the URL itself opened a parenthesis.
        while (url.endsWith(")") && (url.match(/\(/g)?.length ?? 0) < (url.match(/\)/g)?.length ?? 0)) {
          url = url.slice(0, -1);
        }
        const href = sanitizeHref(url);
        if (href) {
          out.push({ type: "link", href, children: [{ type: "text", value: url }] });
          i += url.length;
          continue;
        }
      }
    }

    pushText(out, ch);
    i += 1;
  }

  return out;
}

/** Flatten inline nodes to plain text (used for titles, previews and tests). */
export function inlineToText(nodes: InlineNode[]): string {
  return nodes
    .map((n) => {
      switch (n.type) {
        case "text":
        case "code":
          return n.value;
        case "br":
          return "\n";
        default:
          return inlineToText(n.children);
      }
    })
    .join("");
}

// ── Blocks ──────────────────────────────────────────────────────────────────

const FENCE = /^ {0,3}(`{3,}|~{3,})\s*([^\s`]*)[^`]*$/;
/**
 * Applied to `line.trimEnd()`, with the optional closing `###` run stripped afterwards by
 * `stripClosingHashes`. The CommonMark-shaped `(?:\s+(.*?))?(?:\s+#+)?\s*$` spelling backtracks in
 * quadratic time on a long whitespace run, which is untrusted model/web text on the SSR event loop (INF-17).
 */
const HEADING = /^ {0,3}(#{1,6})(?:[ \t]+(.*))?$/;
const HR = /^ {0,3}([-*_])(?:\s*\1){2,}\s*$/;
const BLOCKQUOTE = /^ {0,3}>\s?/;
const LIST_ITEM = /^(\s*)([-*+]|\d{1,9}[.)])(\s+)(.*)$/;
const TASK = /^\[([ xX])\]\s+/;

/**
 * Block openers are only looked for on lines of a sane length. A 100 KB single line is never a heading, a
 * rule or a table delimiter, and scanning it repeatedly is exactly the stall INF-17 describes — it becomes
 * paragraph text instead.
 */
const MAX_BLOCK_LINE_CHARS = 2_000;
const tooLongForBlockScan = (line: string): boolean => line.length > MAX_BLOCK_LINE_CHARS;

/** Longest document this parser will render; the rest is dropped with a visible notice. */
export const MAX_MARKDOWN_CHARS = 200_000;
const TRUNCATION_NOTICE = "*[This document is too long to display in full. The rest was left out.]*";

const isBlank = (line: string | undefined): boolean => line === undefined || line.trim() === "";
const indentOf = (line: string): number => /^\s*/.exec(line)?.[0].length ?? 0;

/** `## Title ##` → `Title`. Hand-written: the regex form (`\s+#+\s*$`) is quadratic on whitespace runs. */
function stripClosingHashes(text: string): string {
  let end = text.length;
  while (end > 0 && text[end - 1] === "#") end -= 1;
  if (end === text.length) return text; // no trailing hashes
  if (end === 0) return ""; // the text IS the closing sequence ("## ###")
  let start = end;
  while (start > 0 && (text[start - 1] === " " || text[start - 1] === "\t")) start -= 1;
  return start === end ? text : text.slice(0, start);
}

export interface HeadingMatch {
  level: 1 | 2 | 3 | 4 | 5 | 6;
  text: string;
}

function matchHeading(line: string): HeadingMatch | null {
  if (tooLongForBlockScan(line)) return null;
  const match = HEADING.exec(line.trimEnd());
  if (!match) return null;
  return { level: (match[1] as string).length as HeadingMatch["level"], text: stripClosingHashes(match[2] ?? "").trim() };
}

/**
 * `| --- | :--: |` — a GFM table delimiter row. A hand-written scan: every regex spelling of this row has
 * adjacent `\s*` quantifiers and backtracks quadratically on whitespace (INF-17). Linear and allocation-free
 * apart from the trim.
 *
 * @param minDashes minimum `-` per cell (Markdown allows one; the plain-text previewer wants two).
 */
export function isTableDelimiterRow(line: string, minDashes = 1): boolean {
  if (tooLongForBlockScan(line)) return false;
  const s = line.trim();
  if (s === "") return false;
  let i = s[0] === "|" ? 1 : 0;
  let cells = 0;
  const skipSpaces = () => {
    while (i < s.length && (s[i] === " " || s[i] === "\t")) i += 1;
  };
  while (i < s.length) {
    skipSpaces();
    if (s[i] === ":") i += 1;
    let dashes = 0;
    while (i < s.length && s[i] === "-") {
      i += 1;
      dashes += 1;
    }
    if (dashes < minDashes) return false;
    if (s[i] === ":") i += 1;
    skipSpaces();
    cells += 1;
    if (i >= s.length) break;
    if (s[i] !== "|") return false;
    i += 1;
  }
  return cells > 0;
}

/** Split a table row on unescaped pipes; outer pipes are optional. */
export function splitTableRow(line: string): string[] {
  const cells: string[] = [];
  let current = "";
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === "\\" && line[i + 1] === "|") {
      current += "|";
      i += 1;
    } else if (ch === "|") {
      cells.push(current);
      current = "";
    } else {
      current += ch;
    }
  }
  cells.push(current);
  const trimmed = cells.map((c) => c.trim());
  if (trimmed.length > 1 && trimmed[0] === "") trimmed.shift();
  if (trimmed.length > 1 && trimmed[trimmed.length - 1] === "") trimmed.pop();
  return trimmed;
}

function isTableStart(lines: string[], i: number): boolean {
  const header = lines[i];
  const delimiter = lines[i + 1];
  if (header === undefined || delimiter === undefined) return false;
  if (tooLongForBlockScan(header)) return false;
  if (!header.includes("|") || !delimiter.includes("-") || !isTableDelimiterRow(delimiter)) return false;
  return splitTableRow(header).length === splitTableRow(delimiter).length;
}

function startsNewBlock(lines: string[], i: number): boolean {
  const line = lines[i] as string;
  if (tooLongForBlockScan(line)) return false;
  return (
    FENCE.test(line) ||
    matchHeading(line) !== null ||
    HR.test(line) ||
    BLOCKQUOTE.test(line) ||
    LIST_ITEM.test(line) ||
    isTableStart(lines, i)
  );
}

function parseList(lines: string[], start: number, budget: ScanBudget): { node: BlockNode; next: number } {
  const first = LIST_ITEM.exec(lines[start] as string) as RegExpExecArray;
  const baseIndent = (first[1] as string).length;
  const ordered = /\d/.test(first[2] as string);
  const startNumber = ordered ? parseInt(first[2] as string, 10) : 1;
  const items: ListItemNode[] = [];
  let i = start;

  while (i < lines.length) {
    const match = LIST_ITEM.exec(lines[i] as string);
    if (!match || (match[1] as string).length !== baseIndent || /\d/.test(match[2] as string) !== ordered) break;
    // A "- - -" style rule at list level ends the list rather than becoming an item.
    if (HR.test(lines[i] as string)) break;

    const contentIndent = baseIndent + (match[2] as string).length + (match[3] as string).length;
    const dedent = (l: string): string => l.slice(Math.min(indentOf(l), contentIndent));
    const head: string[] = [match[4] as string];
    const body: string[] = [];
    let inBody = false;
    i += 1;

    while (i < lines.length) {
      const line = lines[i] as string;
      if (isBlank(line)) {
        // A blank line stays inside the item only when indented content follows it.
        let k = i + 1;
        while (k < lines.length && isBlank(lines[k])) k += 1;
        if (k >= lines.length || indentOf(lines[k] as string) <= baseIndent) break;
        body.push("");
        inBody = true;
        i += 1;
        continue;
      }
      const indent = indentOf(line);
      if (indent <= baseIndent) {
        // Same-level marker = next item; any other block start ends the list; plain text is a lazy continuation.
        if (LIST_ITEM.test(line) || inBody || startsNewBlock(lines, i)) break;
        head.push(line.trim());
        i += 1;
        continue;
      }
      // Indented content: either more of the first paragraph, or the start of the item's body (nested list,
      // code fence, table …). The lookahead line is needed because a table is recognised by its second row.
      const dedented = dedent(line);
      const opensBlock = startsNewBlock([dedented, dedent(lines[i + 1] ?? "")], 0);
      if (!inBody && !opensBlock) {
        head.push(line.trim());
      } else {
        inBody = true;
        body.push(dedented);
      }
      i += 1;
    }

    let text = head.join("\n");
    let checked: boolean | null = null;
    const task = TASK.exec(text);
    if (task) {
      checked = task[1] !== " ";
      text = text.slice(task[0].length);
    }
    items.push({ checked, children: parseInline(text, 0, budget), blocks: parseBlocks(body, budget) });

    // Blank lines between sibling items are fine ("loose" lists).
    let k = i;
    while (k < lines.length && isBlank(lines[k])) k += 1;
    const upcoming = k < lines.length ? LIST_ITEM.exec(lines[k] as string) : null;
    if (k > i && upcoming && (upcoming[1] as string).length === baseIndent) i = k;
  }

  return { node: { type: "list", ordered, start: startNumber, items }, next: i };
}

function parseTable(lines: string[], start: number, budget: ScanBudget): { node: BlockNode; next: number } {
  const cell = (text: string): InlineNode[] => parseInline(text, 0, budget);
  const headerCells = splitTableRow(lines[start] as string);
  const align: TableAlign[] = splitTableRow(lines[start + 1] as string).map((cell) => {
    const left = cell.startsWith(":");
    const right = cell.endsWith(":");
    if (left && right) return "center";
    if (right) return "right";
    return left ? "left" : null;
  });
  const rows: InlineNode[][][] = [];
  let i = start + 2;
  while (i < lines.length && !isBlank(lines[i]) && (lines[i] as string).includes("|")) {
    const cells = splitTableRow(lines[i] as string);
    // Normalize ragged rows to the header width so the renderer can rely on a rectangular table.
    const normalized = headerCells.map((_, col) => cells[col] ?? "");
    rows.push(normalized.map(cell));
    i += 1;
  }
  return { node: { type: "table", align, header: headerCells.map(cell), rows }, next: i };
}

function parseBlocks(lines: string[], budget: ScanBudget): BlockNode[] {
  const blocks: BlockNode[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i] as string;
    if (isBlank(line)) {
      i += 1;
      continue;
    }

    if (tooLongForBlockScan(line)) {
      // One very long line is paragraph text, whatever it starts with.
      blocks.push({ type: "paragraph", children: parseInline(line.trimEnd(), 0, budget) });
      i += 1;
      continue;
    }

    const fence = FENCE.exec(line);
    if (fence) {
      const marker = fence[1] as string;
      const closing = new RegExp(`^ {0,3}${marker[0] === "`" ? "`" : "~"}{${marker.length},}\\s*$`);
      const body: string[] = [];
      i += 1;
      while (i < lines.length && !closing.test(lines[i] as string)) {
        body.push(lines[i] as string);
        i += 1;
      }
      i += 1; // closing fence (or EOF: an unclosed fence swallows the rest, like CommonMark)
      blocks.push({ type: "code", lang: fence[2] ? (fence[2] as string).toLowerCase() : null, value: body.join("\n") });
      continue;
    }

    if (HR.test(line)) {
      blocks.push({ type: "hr" });
      i += 1;
      continue;
    }

    const heading = matchHeading(line);
    if (heading) {
      blocks.push({ type: "heading", level: heading.level, children: parseInline(heading.text, 0, budget) });
      i += 1;
      continue;
    }

    if (BLOCKQUOTE.test(line)) {
      const quoted: string[] = [];
      while (i < lines.length && !isBlank(lines[i]) && (BLOCKQUOTE.test(lines[i] as string) || !startsNewBlock(lines, i))) {
        quoted.push((lines[i] as string).replace(BLOCKQUOTE, ""));
        i += 1;
      }
      blocks.push({ type: "blockquote", children: parseBlocks(quoted, budget) });
      continue;
    }

    if (isTableStart(lines, i)) {
      const table = parseTable(lines, i, budget);
      blocks.push(table.node);
      i = table.next;
      continue;
    }

    if (LIST_ITEM.test(line)) {
      const list = parseList(lines, i, budget);
      blocks.push(list.node);
      i = list.next;
      continue;
    }

    const paragraph: string[] = [line.trimStart()];
    i += 1;
    while (i < lines.length && !isBlank(lines[i]) && !startsNewBlock(lines, i)) {
      paragraph.push((lines[i] as string).trimStart());
      i += 1;
    }
    // Keep trailing double-spaces on inner lines (hard breaks) but not at the very end.
    blocks.push({ type: "paragraph", children: parseInline(paragraph.join("\n").trimEnd(), 0, budget) });
  }

  return blocks;
}

/**
 * Parse a Markdown document. Never throws; `null` / `undefined` / empty input yields `[]`. Input longer than
 * `MAX_MARKDOWN_CHARS` is cut at that point and a notice is appended — deliverables and chat replies are
 * model output, so "how long can this be" is not our call to leave open.
 */
export function parseMarkdown(source: string | null | undefined): BlockNode[] {
  if (!source) return [];
  const capped =
    source.length > MAX_MARKDOWN_CHARS ? `${source.slice(0, MAX_MARKDOWN_CHARS)}\n\n${TRUNCATION_NOTICE}` : source;
  const lines = capped.replace(/\r\n?/g, "\n").replace(/\t/g, "    ").split("\n");
  return parseBlocks(lines, newScanBudget());
}
