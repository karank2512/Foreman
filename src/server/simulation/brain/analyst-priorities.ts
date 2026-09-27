import { FEEDBACK_ACTIONS } from "../fixtures/feedback";
import { TICKET_ROUTING } from "../fixtures/tickets";
import { clip, normalizeKey, plural } from "../text";
import type { GroupMetric } from "./analyst-metrics";
import type { InputRecord } from "./input";

/**
 * "Tell us what to fix first": the categories carrying the most pain (negative sentiment plus high severity),
 * each with the action most records suggest and one verbatim to show what it feels like to a customer. Built only
 * from the records the analyst was given; the playbook actions stand in when the records carry none.
 */

const SEVERITY_KEYS = ["severity", "priority", "urgency", "impact"];
const SENTIMENT_KEYS = ["sentiment", "tone", "polarity"];
const ACTION_KEYS = ["suggested_action", "recommended_action", "recommendation", "next_step", "action"];
const QUOTE_KEYS = ["summary", "text", "feedback", "verbatim", "comment", "subject", "body"];
const WHO_KEYS = ["customer", "customer_name", "account", "company"];
const HIGH = /^(high|urgent|critical|severe|p0|p1)$/i;
const NEGATIVE = /^(negative|very negative|angry|frustrated)$/i;

const PLAYBOOK: Record<string, string> = {
  ...Object.fromEntries(Object.entries(FEEDBACK_ACTIONS).map(([k, v]) => [k, v.action])),
  ...Object.fromEntries(Object.entries(TICKET_ROUTING).map(([k, v]) => [k, v.action])),
};

function fieldOf(records: readonly InputRecord[], names: readonly string[]): string | undefined {
  const keys = new Map<string, string>();
  for (const r of records) for (const k of Object.keys(r)) if (!keys.has(normalizeKey(k))) keys.set(normalizeKey(k), k);
  return names.map((n) => keys.get(n)).find((k): k is string => k !== undefined);
}

const str = (v: unknown) => (typeof v === "string" ? v.trim() : typeof v === "number" ? String(v) : "");

function mostCommon(values: string[]): string | undefined {
  const counts = new Map<string, number>();
  for (const v of values) if (v) counts.set(v, (counts.get(v) ?? 0) + 1);
  return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]?.[0];
}

/** `one` is the singular record noun ("company"); the count line pluralizes it properly. */
export function fixFirst(records: readonly InputRecord[], group: GroupMetric | null, one: string): string[] {
  if (!group || group.field === "group" || records.length === 0) return [];
  const severity = fieldOf(records, SEVERITY_KEYS);
  const sentiment = fieldOf(records, SENTIMENT_KEYS);
  if (!severity && !sentiment) return [];
  const action = fieldOf(records, ACTION_KEYS);
  const quote = fieldOf(records, QUOTE_KEYS);
  const who = fieldOf(records, WHO_KEYS);

  // The most painful item of a category: high AND negative first, then high, then negative.
  const painOf = (r: InputRecord) => (severity && HIGH.test(str(r[severity])) ? 2 : 0) + (sentiment && NEGATIVE.test(str(r[sentiment])) ? 1 : 0);

  const rows = group.entries.map((entry) => {
    const items = records.filter((r) => str(r[group.field]) === entry.key);
    const high = severity ? items.filter((r) => HIGH.test(str(r[severity]))) : [];
    const negative = sentiment ? items.filter((r) => NEGATIVE.test(str(r[sentiment]))) : [];
    return { entry, items, high, negative, pain: high.length + negative.length };
  });
  const top = rows.filter((r) => r.pain > 0).sort((a, b) => b.pain - a.pain || b.entry.count - a.entry.count || a.entry.key.localeCompare(b.entry.key)).slice(0, 3);
  if (top.length === 0) return [];

  const lines = top.map((row, i) => {
    const parts: string[] = [];
    if (sentiment) parts.push(`${row.negative.length} negative`);
    if (severity) parts.push(`${row.high.length} high-${severity.replace(/_/g, " ")}`);
    const fix = (action ? mostCommon(row.items.map((r) => str(r[action]))) : undefined) ?? PLAYBOOK[row.entry.key] ?? "Give it a named owner and find the root cause before the next run";
    const worst = [...row.items].sort((a, b) => painOf(b) - painOf(a))[0];
    const said = worst && quote ? clip(str(worst[quote]), 140) : "";
    const by = worst && who ? str(worst[who]) : "";
    return `${i + 1}. **${row.entry.key}** — ${parts.join(", ")} of ${plural(row.entry.count, one)}. **Fix:** ${fix.replace(/\.$/, "")}.${said ? ` “${said}”${by ? ` — ${by}` : ""}` : ""}`;
  });
  return ["### What to fix first", ...lines];
}
