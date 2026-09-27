import type { MockTextResponse } from "@/server/models/types";
import type { MockAgentTurnInput } from "@/server/simulation/types";
import { hashSeed, seededPick } from "../rng";
import { formatUsdShort, joinList, plural, pluralNoun } from "../text";
import { computeMetrics, groupLabelHint, type GroupMetric, type Metrics, type NumericMetric } from "./analyst-metrics";
import { fixFirst } from "./analyst-priorities";
import { readHints } from "./hints";
import { parseAgentInput, readStructuredInputs } from "./input";

/**
 * The analyst: a markdown agent with no tools that turns the records/stats in its input into insights with
 * concrete numbers. Phrasing varies by a seed (component id + spec title + record count) so different jobs
 * read differently, while the same input always produces the same text.
 */

const pct = (share: number) => `${Math.round(share * 100)}%`;

function num(n: number, money: boolean): string {
  if (money) return formatUsdShort(n);
  const rounded = Number.isInteger(n) ? n : Math.round(n * 10) / 10;
  const [whole, fraction] = String(rounded).split(".");
  return whole.replace(/\B(?=(\d{3})+(?!\d))/g, ",") + (fraction ? `.${fraction}` : "");
}

/** What to call one record in prose — by job family first, then by the words in the field names. */
function noun(spec: MockAgentTurnInput["spec"]): string {
  const words = new Set(spec.deliverable.fields.flatMap((f) => f.name.toLowerCase().split(/[^a-z]+/)));
  const has = (...w: string[]) => w.some((x) => words.has(x));
  if (spec.jobFamily === "support_triage" || has("ticket")) return "ticket";
  if (spec.jobFamily === "feedback_analysis" || has("sentiment", "feedback")) return "feedback item";
  if (spec.jobFamily === "lead_research" || has("contact", "email")) return "lead";
  if (spec.jobFamily === "finance_ops" || has("transaction", "invoice", "expense")) return "line item";
  if (has("plan", "price", "pricing")) return "pricing record";
  if (has("stage", "round", "investor", "amount")) return "funding round";
  if (has("company", "vendor", "competitor")) return "company";
  return "record";
}

/**
 * Categories that are never "a quiet corner": one outage or security ticket is an incident, not an
 * under-reported niche. Checked against the group value with separators normalised to spaces.
 */
const CRITICAL_GROUP_RE = /\b(outages?|incidents?|downtime|urgent|critical|security|breach(es)?|vulnerab\w*|fraud|emergency|escalations?|p0|p1|sev ?[01]|data loss)\b/;
/** In a severity / priority split the top level is critical by definition. */
const SEVERITY_FIELD_RE = /(severity|priority|urgency|impact)/;
/** Most severe first: the secondary insight talks about the worst level present, not the most common bad one. */
const SEVERE_LEVELS = [/^critical$/i, /^urgent$/i, /^high$/i, /^negative$/i];

export function isCriticalGroup(field: string, value: string): boolean {
  const text = value.toLowerCase().replace(/[_\-/]+/g, " ");
  return CRITICAL_GROUP_RE.test(text) || (SEVERITY_FIELD_RE.test(field.toLowerCase()) && text.trim() === "high");
}

function severest(s: GroupMetric): GroupMetric["entries"][number] | undefined {
  for (const level of SEVERE_LEVELS) {
    const hit = s.entries.find((e) => level.test(e.key));
    if (hit) return hit;
  }
  return undefined;
}

/** "tightest SLA hours" / "highest priority" — the urgent end of a lower-is-urgent number. */
function urgentEnd(n: NumericMetric): string {
  return /(priority|urgency|rank)/.test(n.field.toLowerCase()) ? `highest ${n.label}` : `tightest ${n.label}`;
}

/** The groups sharing the top count ("onboarding, performance and reporting are tied at 6"). */
function leaders(g: GroupMetric): GroupMetric["entries"] {
  return g.entries.filter((e) => e.count === g.entries[0].count);
}

function headline(m: Metrics, one: string, things: string): string[] {
  const lines: string[] = [];
  const g = m.group;
  if (g && g.entries.length > 0) {
    const top = g.entries[0];
    const tied = leaders(g);
    lines.push(
      tied.length > 1
        ? `- **${m.total} ${things}** across **${g.entries.length} ${g.label} values**; the largest are ${joinList(tied.map((e) => `**${e.key}**`))} with ${top.count} each (${pct(top.share)}).`
        : `- **${m.total} ${things}** across **${g.entries.length} ${g.label} values**; the largest is **${top.key}** with ${top.count} (${pct(top.share)}).`,
    );
  } else {
    lines.push(`- **${m.total} ${things}** in this run.`);
  }
  const n = m.numeric;
  if (n?.lowerIsUrgent) {
    const leader = n.top[0];
    lines.push(
      `- ${n.label[0].toUpperCase()}${n.label.slice(1)}: averaging ${num(n.mean, n.money)} per ${one}, from ${num(n.min, n.money)} to ${num(n.max, n.money)}` +
        (leader ? `; the most urgent is ${leader.name} at ${num(leader.value, n.money)}.` : "."),
    );
  } else if (n) {
    const leader = n.top[0];
    lines.push(
      `- Total ${n.label}: **${num(n.sum, n.money)}**, averaging ${num(n.mean, n.money)} per ${one}` +
        (leader ? `; the largest is ${leader.name} at ${num(leader.value, n.money)}.` : `; the range runs from ${num(n.min, n.money)} to ${num(n.max, n.money)}.`),
    );
  }
  const s = m.secondary;
  if (s && s.entries.length > 0) {
    const parts = s.entries.slice(0, 3).map((e) => `${e.count} ${e.key}`);
    lines.push(`- By ${s.label}: ${joinList(parts)}${s.entries.length > 3 ? " and others" : ""}.`);
  }
  if (m.recency) {
    lines.push(`- ${m.recency.last14} of ${m.total} are dated within the last two weeks (${m.recency.last30} within 30 days).`);
  }
  if (m.quality.missing > 0 || m.quality.duplicates > 0) {
    const issues: string[] = [];
    if (m.quality.missing > 0) issues.push(`${plural(m.quality.missing, "record")} with a missing field`);
    if (m.quality.duplicates > 0) issues.push(`${plural(m.quality.duplicates, "likely duplicate")}`);
    lines.push(`- Data quality: ${joinList(issues)}.`);
  }
  return lines;
}

function concentrationInsight(g: GroupMetric, total: number, things: string, seed: number): string {
  const [top, second] = g.entries;
  const tied = leaders(g);
  let lead: string;
  if (!second) lead = `Every one of the ${total} ${things} sits under **${top.key}**.`;
  else if (tied.length > 1) lead = `${joinList(tied.map((e) => `**${e.key}**`))} are tied at ${top.count} of ${total} ${things} (${pct(top.share)}) each.`;
  else {
    lead = seededPick(
      [
        `**${top.key}** leads with ${top.count} of ${total} ${things} (${pct(top.share)}), ahead of ${second.key} at ${second.count}.`,
        `${pct(top.share)} of ${things} fall under **${top.key}** (${top.count}); ${second.key} is next with ${second.count}.`,
      ],
      seed,
    );
  }
  const rest = g.entries.slice(Math.max(2, tied.length));
  const restCount = rest.reduce((s, e) => s + e.count, 0);
  const tail =
    rest.length > 1
      ? ` The remaining ${plural(rest.length, `${g.label} value`)} account for ${restCount} between them.`
      : rest.length === 1
        ? ` ${rest[0].key} accounts for the other ${restCount}.`
        : "";
  return lead + tail;
}

/**
 * For SLA / deadline / priority-rank numbers the story is the urgent END (the smallest values), never the largest
 * value as an "outlier": a 72-hour SLA is the least urgent ticket in the queue, not the one to look at.
 */
function urgentInsight(n: NumericMetric, total: number, things: string): string {
  const leader = n.top[0];
  const end = urgentEnd(n);
  if (!leader) {
    return `${n.label[0].toUpperCase()}${n.label.slice(1)} runs from ${num(n.min, n.money)} to ${num(n.max, n.money)} across ${total} ${things} (average ${num(n.mean, n.money)}); the lowest values are the most urgent.`;
  }
  const count = Math.max(n.atMin, 1);
  if (count === 1) {
    const next = n.top[1];
    return `${leader.name} has the ${end} (${num(leader.value, n.money)}) and should be handled first${next ? `; next is ${next.name} at ${num(next.value, n.money)}` : ""}.`;
  }
  const shown = n.top.filter((x) => x.value === leader.value).slice(0, 3).map((x) => x.name);
  const names = count > shown.length ? `${shown.join(", ")} and ${count - shown.length} more` : joinList(shown);
  return `${count} of ${total} ${things} share the ${end} (${num(leader.value, n.money)}) — ${names}; these go to the front of the queue.`;
}

function numericInsight(n: NumericMetric, total: number, things: string, seed: number): string {
  if (n.lowerIsUrgent) return urgentInsight(n, total, things);
  const leader = n.top[0];
  const topThree = n.top.slice(0, 3);
  const topShare = n.sum > 0 ? topThree.reduce((s, x) => s + x.value, 0) / n.sum : 0;
  if (leader && topThree.length >= 2 && n.sum > 0) {
    return seededPick(
      [
        `The top ${topThree.length} by ${n.label} — ${joinList(topThree.map((x) => `${x.name} (${num(x.value, n.money)})`))} — make up ${pct(topShare)} of the ${num(n.sum, n.money)} total.`,
        `${leader.name} is the outlier at ${num(leader.value, n.money)}; the top ${topThree.length} together represent ${pct(topShare)} of all ${n.label} across ${total} ${things}.`,
      ],
      seed,
    );
  }
  return `${n.label[0].toUpperCase()}${n.label.slice(1)} totals ${num(n.sum, n.money)} across ${total} ${things}, with an average of ${num(n.mean, n.money)}.`;
}

function secondaryInsight(s: GroupMetric, g: GroupMetric | null, records: Array<Record<string, unknown>>, things: string): string | null {
  const negativeLike = severest(s);
  if (!negativeLike) return null;
  let where = "";
  if (g && records.length > 0) {
    const counts = new Map<string, number>();
    for (const r of records) {
      if (String(r[s.field] ?? "").trim() !== negativeLike.key) continue;
      const key = String(r[g.field] ?? "").trim();
      if (key) counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    const [topKey, topCount] = [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0] ?? [];
    // "Concentrated" only when one group really holds a large share; otherwise it is merely the most common.
    if (topKey && topCount) where = topCount / negativeLike.count >= 0.4 ? `, concentrated in **${topKey}** (${topCount} of them)` : `, most common in **${topKey}** (${topCount} of them)`;
  }
  return `${negativeLike.count} of ${records.length || "the"} ${things} are **${negativeLike.key}** ${s.label} (${pct(negativeLike.share)})${where}.`;
}

function watchList(m: Metrics, one: string, things: string): string[] {
  const items: string[] = [];
  const g = m.group;
  if (g && g.entries.length > 0) items.push(`**${g.entries[0].key}** — whether its ${pct(g.entries[0].share)} share of ${things} keeps growing next run.`);
  const leader = m.numeric?.top[0];
  if (m.numeric && leader) {
    items.push(
      m.numeric.lowerIsUrgent
        ? `**${leader.name}** — the ${urgentEnd(m.numeric)} this period (${num(leader.value, m.numeric.money)}); make sure it is picked up first.`
        : `**${leader.name}** — the largest ${m.numeric.label} this period (${num(leader.value, m.numeric.money)}); worth a closer look.`,
    );
  }
  const neg = m.secondary ? severest(m.secondary) : undefined;
  if (m.secondary && neg) items.push(`**${neg.key} ${m.secondary.label}** items (${neg.count}) — these need an owner before the next review.`);
  if (g && g.entries.length > 2) {
    const smallest = g.entries[g.entries.length - 1];
    items.push(
      isCriticalGroup(g.field, smallest.key)
        ? `**${smallest.key}** — only ${plural(smallest.count, one)}, but low volume is no comfort here; confirm each one has an owner and a resolution time.`
        : `**${smallest.key}** — only ${plural(smallest.count, one)} so far; a quiet corner that may be under-reported.`,
    );
  }
  if (m.quality.missing > 0 || m.quality.duplicates > 0) {
    const issues: string[] = [];
    if (m.quality.missing > 0) issues.push(`${m.quality.missing} incomplete`);
    if (m.quality.duplicates > 0) issues.push(`${m.quality.duplicates} duplicate`);
    items.push(`**Data hygiene** — ${joinList(issues)} ${things} should be cleaned before this is shared widely.`);
  }
  if (m.recency && m.recency.last14 < m.total) items.push(`**Freshness** — ${m.total - m.recency.last14} ${things} are older than two weeks; confirm they are still relevant.`);
  return items.slice(0, 4);
}

export function renderInsights(args: { input: MockAgentTurnInput; records: Array<Record<string, unknown>>; metrics: Metrics }): string {
  const { input, records, metrics: m } = args;
  const one = noun(input.spec);
  const things = pluralNoun(one);
  const seed = hashSeed(`${input.component.id}|${input.spec.title}|${m.total}`);
  const intro = seededPick(
    [
      `This run covered **${m.total} ${things}** for ${input.spec.deliverable.title}. The numbers below come straight from the collected records.`,
      `${m.total} ${things} were reviewed for ${input.spec.deliverable.title}; here is what stands out.`,
    ],
    seed,
  );

  const insights: string[] = [];
  if (m.group && m.group.entries.length > 0) insights.push(concentrationInsight(m.group, m.total, things, seed + 1));
  if (m.numeric) insights.push(numericInsight(m.numeric, m.total, things, seed + 2));
  if (m.secondary) {
    const s = secondaryInsight(m.secondary, m.group, records, things);
    if (s) insights.push(s);
  }
  if (m.recency) {
    insights.push(
      m.recency.last14 >= m.total * 0.5
        ? `Activity is recent: ${m.recency.last14} of ${m.total} ${things} are from the last 14 days, so this reflects the current picture rather than a backlog.`
        : `Only ${m.recency.last14} of ${m.total} ${things} are from the last 14 days; most of what was collected is older, which is worth keeping in mind when acting on it.`,
    );
  }
  if (m.quality.missing > 0 || m.quality.duplicates > 0) {
    const issues: string[] = [];
    if (m.quality.missing > 0) issues.push(`${m.quality.missing} ${things} are missing at least one field`);
    if (m.quality.duplicates > 0) issues.push(`${m.quality.duplicates} look like duplicates`);
    insights.push(`${joinList(issues)} — the totals above should be read as approximate until they are cleaned up.`);
  }
  if (insights.length < 3 && m.group && m.group.entries.length > 2) {
    const [top, second, third] = m.group.entries;
    const tied = leaders(m.group);
    // Only the groups after ALL of the leaders are "behind" them; a group level with the leaders is one of them.
    const chasers = m.group.entries.slice(tied.length);
    const next = chasers[0];
    const level = next ? chasers.filter((e) => e.count === next.count) : [];
    if (second.count < top.count) {
      insights.push(`${second.key} is the clear number two ${m.group.label} with ${plural(second.count, one)} (${pct(second.share)}), followed by ${third.key} at ${third.count}.`);
    } else if (next && level.length === 1) {
      insights.push(`${next.key} is the first ${m.group.label} behind the leaders, with ${plural(next.count, one)} (${pct(next.share)}).`);
    } else if (next) {
      insights.push(`${joinList(level.map((e) => e.key))} follow the leaders with ${plural(next.count, one)} each (${pct(next.share)}).`);
    }
  }
  if (insights.length < 3 && m.numeric) {
    insights.push(`The spread in ${m.numeric.label} is wide: from ${num(m.numeric.min, m.numeric.money)} up to ${num(m.numeric.max, m.numeric.money)}.`);
  }
  if (insights.length < 3) insights.push(`Coverage this run: ${m.total} ${things} against a target of ${input.spec.deliverable.targetCount ?? "no fixed number"}.`);

  const lines = [intro, "", "### Headline numbers", ...headline(m, one, things), "", "### Insights", ...insights.slice(0, 5).map((s, i) => `${i + 1}. ${s}`)];
  const priorities = fixFirst(records, m.group, one);
  if (priorities.length > 0) lines.push("", ...priorities);
  const watch = watchList(m, one, things);
  if (watch.length > 0) lines.push("", "### What to watch", ...watch.map((w) => `- ${w}`));
  return lines.join("\n");
}

/** Null when the input carries no records/stats at all — the generic brain handles that. */
export function analystTurn(input: MockAgentTurnInput, now: Date): MockTextResponse | null {
  const parsed = parseAgentInput(input.messages, input.component.inputKeys);
  const { records, stats } = readStructuredInputs(parsed);
  if ((!records || records.length === 0) && !stats) return null;
  const metrics = computeMetrics({
    records,
    stats,
    now,
    groupLabel: groupLabelHint(input.spec.deliverable.fields.map((f) => f.name)),
    specFields: input.spec.deliverable.fields,
    keyFields: readHints(input).keyFields,
  });
  return { text: renderInsights({ input, records: records ?? [], metrics }) };
}
