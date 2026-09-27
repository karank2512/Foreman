/**
 * The summary stored with a deliverable is the opening of the report, flattened and clipped with an ellipsis
 * ("…averaging $36.8M per funding round; the…"). Above the article that reads as a rendering bug and repeats the
 * first paragraph, so a report that already opens with it gets no lede. Pure — shared by the page and its test.
 */

/** Markdown to comparable plain text: markers, links and emphasis gone, whitespace collapsed, lower-cased. */
export function plainText(markdown: string): string {
  return markdown
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, " ")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/^\s{0,3}(?:#{1,6}|>|[-*+]|\d+[.)])\s+/gm, "")
    .replace(/[*_`~]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

/** Long enough that a match is the same passage, short enough to sit inside its first paragraph. */
const HEAD_CHARS = 80;
const MIN_HEAD_CHARS = 24;

/** The lede to show above a report, or null when the report's own opening already says it. */
export function ledeFor(summary: string | null, content: string, format: string): string | null {
  const text = summary?.trim();
  if (!text) return null;
  if (format !== "MARKDOWN") return text;
  const head = plainText(text.replace(/(?:…|\.\.\.)$/, "")).slice(0, HEAD_CHARS);
  if (head.length < MIN_HEAD_CHARS) return text;
  return plainText(content).includes(head) ? null : text;
}
