import { sentenceCase } from "@/lib/format";

/**
 * Field names in the words a manager reads. The proposal, the pipeline and the review checks name the spec's
 * fields in prose; they use the same label the spec and the deliverable table show (`source_url` → "Source URL"),
 * lower-cased mid-sentence and with money units spelled out — never the snake_case key. PURE.
 */

/** `amount_usd` → "amount (USD)", `source_url` → "source URL", `hq` → "HQ", `plan_name` → "plan name". */
export function fieldPhrase(name: string): string {
  const label = sentenceCase(name);
  const first = label.split(" ")[0] ?? "";
  // An acronym ("HQ", "SLA hours", "ID") keeps its capitals at the start of a phrase.
  const keepsCase = first.length > 1 && first === first.toUpperCase();
  const phrase = keepsCase ? label : `${label.charAt(0).toLowerCase()}${label.slice(1)}`;
  return phrase.replace(/ USD$/, " (USD)");
}

/** ["company", "stage", "source_url"] → "company, stage or source URL" (or "and"). */
export function fieldList(names: readonly string[], conjunction: "and" | "or" = "and"): string {
  const phrases = names.map(fieldPhrase);
  if (phrases.length <= 1) return phrases[0] ?? "";
  return `${phrases.slice(0, -1).join(", ")} ${conjunction} ${phrases[phrases.length - 1]}`;
}
