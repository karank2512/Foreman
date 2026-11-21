import type { SearchResult, ToolOutputs } from "@/server/tools/schemas";
import { constraintMisses, hasConstraints } from "../constraints";
import { EntityIndex, type EntityRef, type Facts } from "../entities";
import { buildRecord, canonicalField, type EntityKind } from "../fields";
import { companyRelevance } from "../search";
import { stem, tokenize } from "../text";
import { isPlainRecord, type Conversation } from "./conversation";
import type { JobContext } from "./job";

/**
 * What the collector "learned" from its tool calls. Every successful tool output in the conversation is read
 * per `ToolOutputs` and resolved to fixture entities (companies by name/host, feedback and tickets by id), in
 * order of first appearance — the brain never reports something it did not actually see, unless it saw
 * nothing at all (no tools, or every tool failed), in which case it falls back to what it "knows".
 */

type Row = Record<string, unknown>;

export function recordsOf(output: unknown): Row[] {
  if (!isPlainRecord(output)) return [];
  const records = (output as Partial<ToolOutputs["extract_data"]>).records;
  return Array.isArray(records) ? records.filter(isPlainRecord) : [];
}

export function resultsOf(output: unknown): SearchResult[] {
  if (!isPlainRecord(output)) return [];
  const results = (output as Partial<ToolOutputs["web_search"]>).results;
  return Array.isArray(results)
    ? results.filter((r): r is SearchResult => isPlainRecord(r) && typeof r.url === "string" && typeof r.title === "string")
    : [];
}

export function pageOf(output: unknown): ToolOutputs["fetch_url"] | null {
  if (!isPlainRecord(output) || typeof output.text !== "string") return null;
  return { url: typeof output.url === "string" ? output.url : "", title: typeof output.title === "string" ? output.title : "", text: output.text };
}

/** Search results from every successful web_search, first query first, de-duplicated by URL. */
export function searchResults(convo: Conversation): SearchResult[] {
  const seen = new Set<string>();
  const out: SearchResult[] = [];
  for (const ex of convo.succeeded("web_search")) {
    for (const r of resultsOf(ex.output)) {
      if (seen.has(r.url)) continue;
      seen.add(r.url);
      out.push(r);
    }
  }
  return out;
}

export function fetchedPages(convo: Conversation): Array<ToolOutputs["fetch_url"]> {
  return convo
    .succeeded("fetch_url")
    .map((ex) => pageOf(ex.output))
    .filter((p): p is ToolOutputs["fetch_url"] => p !== null);
}

/** Rows returned by read_dataset / extract_data, in call order. */
export function structuredRows(convo: Conversation): Row[] {
  return [...convo.succeeded("read_dataset"), ...convo.succeeded("extract_data")].flatMap((ex) => recordsOf(ex.output));
}

/** `upTo` limits the reading to the first exchanges of the conversation (what the worker knew at that point). */
export function gatherCandidates(convo: Conversation, kind: EntityKind, index: EntityIndex, upTo = convo.state.exchanges.length): EntityRef[] {
  const seen = new Set<string>();
  const out: EntityRef[] = [];
  const push = (ref: EntityRef | null) => {
    if (!ref || ref.kind !== kind || seen.has(ref.key)) return;
    seen.add(ref.key);
    out.push(ref);
  };
  for (const ex of convo.state.exchanges.slice(0, upTo)) {
    if (!ex.answered || ex.isError) continue;
    if (ex.name === "read_dataset" || ex.name === "extract_data") {
      for (const row of recordsOf(ex.output)) push(index.identify(row));
    } else if (ex.name === "fetch_url") {
      const page = pageOf(ex.output);
      if (page) for (const ref of index.mentioned(`${page.title}\n${page.text}`, kind)) push(ref);
    } else if (ex.name === "web_search") {
      for (const r of resultsOf(ex.output)) for (const ref of index.mentioned(`${r.title} ${r.snippet} ${r.url}`, kind)) push(ref);
    }
  }
  return out;
}

/**
 * What a tool-less (or tool-starved) collector reports: the vendors the customer named (they told us who), then
 * the fixtures most relevant to the job, newest first.
 */
export function fallbackPool(ctx: JobContext, kind: EntityKind, index: EntityIndex): EntityRef[] {
  if (kind === "company") {
    const score = companyRelevance(ctx.relevanceQuery);
    const named = index.namedRefs();
    const namedKeys = new Set(named.map((r) => r.key));
    // The universe the brief is about, already newest-first; a stable sort keeps that order within each band.
    const ranked = index
      .companiesIn(ctx.constraints.sector ?? "ai_infrastructure")
      .map((c, i) => ({ c, i, score: score(c) }))
      .sort((a, b) => b.score - a.score || a.i - b.i)
      .map((x) => index.companyRef(x.c))
      .filter((r) => !namedKeys.has(r.key));
    return [...named, ...ranked];
  }
  return index.refs(kind);
}

// ── Prioritisation ──────────────────────────────────────────────────────────

function factsText(ref: EntityRef): string {
  return Object.values(ref.facts)
    .filter((v): v is string | number => typeof v === "string" || typeof v === "number")
    .join(" ")
    .toLowerCase();
}

/** How many one-off focus terms an entity matches (phrases literally, words by stem). */
function focusScore(ref: EntityRef, terms: readonly string[]): number {
  if (terms.length === 0) return 0;
  const text = factsText(ref);
  const bag = new Set(tokenize(text).map(stem));
  return terms.filter((t) => (t.includes(" ") ? text.includes(t) : bag.has(stem(t)))).length;
}

function specRelevance(ctx: JobContext, kind: EntityKind, index: EntityIndex): (ref: EntityRef) => number {
  if (kind === "company") {
    const score = companyRelevance(ctx.relevanceQuery);
    return (ref) => {
      const c = index.companyByKey(ref.key);
      return c ? score(c) : 0;
    };
  }
  const focus = new Set(ctx.specFocus);
  return (ref) => (typeof ref.facts.category === "string" && focus.has(ref.facts.category) ? 1 : 0);
}

/** Funding rounds are news: newer first. Feedback/tickets already arrive newest-first from their sources. */
function recency(ref: EntityRef, kind: EntityKind): number {
  if (kind !== "company") return 0;
  const t = Date.parse(String(ref.facts.announced_on ?? ""));
  return Number.isFinite(t) ? t : 0;
}

/**
 * The brief's hard constraints ("15 Series A fintech companies in Europe"): a company that breaks one is not
 * what the customer asked for, however well it fits otherwise — so it is dropped, even if that leaves fewer
 * records than the target. Finance reviews scoped to software keep only software lines.
 */
export function withinBrief(refs: readonly EntityRef[], ctx: JobContext, kind: EntityKind, index: EntityIndex): EntityRef[] {
  if (kind === "expense") {
    if (ctx.expenseScope === "software") return refs.filter((r) => r.facts.group === "software");
    if (ctx.expenseScope === "invoices") return refs.filter((r) => r.facts.kind === "invoice");
    return [...refs];
  }
  if (kind !== "company" || !hasConstraints(ctx.constraints)) return [...refs];
  return refs.filter((ref) => {
    const c = index.companyByKey(ref.key);
    return !c || constraintMisses({ stage: c.stage, location: c.hq, sector: c.sector }, ctx.constraints).length === 0;
  });
}

/** Vendors the spec names, earliest-named highest; 0 for everything else. */
function namedScore(ctx: JobContext, index: EntityIndex): (ref: EntityRef) => number {
  const order = new Map(index.namedRefs().map((r, i) => [r.key, i]));
  return (ref) => {
    const i = order.get(ref.key);
    return i === undefined ? 0 : ctx.namedVendors.length - i;
  };
}

/**
 * One-off focus first ("focus on vector databases"), then the vendors the spec names, then the spec's own topic,
 * then recency, then the order the worker encountered things. `strict` ("only Series A") drops non-matching
 * entities when any match; the brief's own constraints (withinBrief) always apply.
 */
export function prioritize(refs: readonly EntityRef[], ctx: JobContext, kind: EntityKind, index: EntityIndex): EntityRef[] {
  const relevance = specRelevance(ctx, kind, index);
  const named = namedScore(ctx, index);
  const scored = withinBrief(refs, ctx, kind, index).map((ref, i) => ({
    ref,
    i,
    focus: focusScore(ref, ctx.directives.focusTerms),
    named: named(ref),
    spec: relevance(ref),
    when: recency(ref, kind),
  }));
  const anyFocus = scored.some((s) => s.focus > 0);
  const kept = ctx.directives.strict && anyFocus ? scored.filter((s) => s.focus > 0) : scored;
  return kept.sort((a, b) => b.focus - a.focus || b.named - a.named || b.spec - a.spec || b.when - a.when || a.i - b.i).map((s) => s.ref);
}

// ── Records ─────────────────────────────────────────────────────────────────

/** Pricing specs that ask for a `plan` column get one row per company × plan instead of one per company. */
export function entityRecords(refs: readonly EntityRef[], ctx: JobContext, kind: EntityKind, index: EntityIndex): Row[] {
  const wantsPlans = kind === "company" && ctx.fields.some((f) => canonicalField("company", f) === "plan");
  const facts: Facts[] = wantsPlans ? refs.flatMap((ref) => index.planFactsFor(ref) ?? [ref.facts]) : refs.map((ref) => ref.facts);
  return facts.map((f) => buildRecord(kind, f, ctx.fields));
}
