import type { MockTextResponse } from "@/server/models/types";
import type { MockAgentTurnInput } from "@/server/simulation/types";
import type { SampleDataset } from "@/server/tools/schemas";
import { ROUNDUP_SIZE } from "../catalog";
import { EntityIndex } from "../entities";
import { canonicalField } from "../fields";
import { clip } from "../text";
import { entityRecords, fallbackPool, fetchedPages, gatherCandidates, prioritize, recordsOf, resultsOf, searchResults } from "./candidates";
import { Conversation, isPlainRecord, toolTurn } from "./conversation";
import { genericRecords } from "./generic-records";
import { buildJobContext, type JobContext } from "./job";
import { degradeForTier } from "./quality";

/**
 * The collector: a json-output agent that gathers records. Its plan uses only granted tools, one step per turn:
 *
 *   read_dataset (when granted)            → final answer
 *   web_search (1–2 queries, one turn)     → fetch_url (top 3–4 results, one turn) → extract_data → final answer
 *
 * A company job whose first read leaves it short of its target keeps going before it extracts: one more search for
 * the newsroom's full list of rounds, then as many parts of it as the shortfall needs (see fullListStep).
 *
 * Every step is optional: a tool that is not granted, already tried, or errored is skipped and the brain
 * carries on with what it has. The final answer is a top-level JSON array of flat records keyed exactly by the
 * spec's field names, sized by the quality model in quality.ts.
 */

const SEARCH_RESULTS = 8;
/** web_search's own maximum (tools/schemas.ts). */
const SEARCH_RESULTS_MAX = 10;
const FETCH_TOP = 4;
const MAX_EXTRACT_CHARS = 24_000;
const MAX_NAMED_ROWS = 60;

const DATASET_LABELS: Record<SampleDataset, string> = {
  customer_feedback: "customer feedback",
  funding_rounds: "funding rounds",
  support_tickets: "support tickets",
};

export function collectorTurn(input: MockAgentTurnInput, now: Date): MockTextResponse {
  const ctx = buildJobContext(input);
  const convo = new Conversation(input.messages, input.tools, input.component.maxTurns);
  // The final answer needs a turn of its own, so no tool step may start when only one turn is left.
  if (convo.remainingTurns >= 2) {
    const next = nextToolStep(convo, ctx, now);
    if (next) return next;
  }
  return finalAnswer(ctx, convo, now);
}

function nextToolStep(convo: Conversation, ctx: JobContext, now: Date): MockTextResponse | null {
  // A generic job with web access prefers the web; every other job with a dataset grant starts there.
  const preferDataset = ctx.dataset !== null && convo.has("read_dataset") && (ctx.kind !== "generic" || !convo.has("web_search"));
  if (preferDataset && ctx.dataset) {
    if (convo.canTry("read_dataset")) {
      return toolTurn(convo, `I'll start with the ${DATASET_LABELS[ctx.dataset]} dataset.`, [{ name: "read_dataset", input: { dataset: ctx.dataset } }]);
    }
    if (convo.succeeded("read_dataset").some((ex) => recordsOf(ex.output).length > 0)) return null;
  }

  if (convo.canTry("web_search")) {
    const calls = ctx.queries.map((query) => ({ name: "web_search" as const, input: { query, maxResults: SEARCH_RESULTS } }));
    const turn = toolTurn(convo, `Searching the web for ${ctx.queries.map((q) => `"${q}"`).join(" and ")}.`, calls);
    if (turn) return turn;
  }

  if (convo.canTry("fetch_url")) {
    const urls = urlsToRead(convo, ctx.namedVendors.length > 0);
    const turn = toolTurn(
      convo,
      `Opening the ${urls.length === 1 ? "most relevant source" : `${urls.length} most relevant sources`}.`,
      urls.map((url) => ({ name: "fetch_url" as const, input: { url } })),
    );
    if (turn) return turn;
  }

  const deeper = fullListStep(convo, ctx, now);
  if (deeper) return deeper;

  if (convo.canTry("extract_data")) {
    const text = sourceText(convo);
    if (text.length > 0) {
      const maxRecords = Math.min(100, Math.max(ctx.count * 2, 24));
      return toolTurn(convo, "Extracting structured records from what I read.", [
        { name: "extract_data", input: { text, fields: ctx.fields, maxRecords } },
      ]);
    }
  }
  return null;
}

/** "of" never survives buildQueries' stopword filter, so no query a job's own words produce can ask for this. */
const FULL_LIST_SUFFIX = "full list of rounds";
const isFullListSearch = (input: unknown) => isPlainRecord(input) && typeof input.query === "string" && input.query.endsWith(FULL_LIST_SUFFIX);

/** Records the final answer would hold after the first `upTo` exchanges: the same pool, brief and priority rules as collectRecords. */
function recordsSoFar(ctx: JobContext, convo: Conversation, now: Date, upTo?: number): number {
  const index = new EntityIndex(now);
  return prioritize(gatherCandidates(convo, "company", index, upTo), ctx, "company", index).length;
}

/**
 * The method's "keep going until you have covered the target volume": a funding/company job (not a pricing job,
 * whose rows come from vendors' own pages) that read its first sources and is still short of `ctx.count` searches
 * for the full list of rounds, then reads one part more than the shortfall needs, since some rounds will fall
 * outside the brief. A worker whose first read already covers its target never gets here, so its run is unchanged.
 */
function fullListStep(convo: Conversation, ctx: JobContext, now: Date): MockTextResponse | null {
  if (ctx.kind !== "company" || ctx.namedVendors.length > 0 || ctx.fields.some((f) => canonicalField("company", f) === "plan")) return null;
  if (!convo.has("web_search") || !convo.has("fetch_url") || !convo.attempted("fetch_url")) return null;
  const turnsAfter = convo.canTry("extract_data") ? 2 : 1; // extraction (if still to come) and the final answer
  const at = convo.state.exchanges.findIndex((e) => e.name === "web_search" && isFullListSearch(e.input));
  if (at < 0) {
    if (convo.remainingTurns < 2 + turnsAfter) return null;
    const have = recordsSoFar(ctx, convo, now);
    if (have >= ctx.count || ctx.queries.length === 0) return null;
    return toolTurn(convo, `I have ${have} of the ${ctx.count} records this job asks for, so I'm looking for the full list of rounds.`, [
      { name: "web_search", input: { query: `${ctx.queries[0]} ${FULL_LIST_SUFFIX}`, maxResults: SEARCH_RESULTS_MAX } },
    ]);
  }
  const search = convo.state.exchanges[at];
  if (!search.answered || search.isError || convo.state.exchanges.slice(at + 1).some((e) => e.name === "fetch_url")) return null;
  if (convo.remainingTurns < 1 + turnsAfter) return null;
  // Sized from what the first read found: the list's search snippets name a few of the rounds each part holds.
  const shortfall = ctx.count - recordsSoFar(ctx, convo, now, at);
  const parts = resultsOf(search.output).slice(0, Math.ceil(shortfall / ROUNDUP_SIZE) + 1);
  return toolTurn(
    convo,
    `Reading ${parts.length === 1 ? "the first part" : `${parts.length} parts`} of the full list.`,
    parts.map((r) => ({ name: "fetch_url" as const, input: { url: r.url } })),
  );
}

/**
 * Round-robin across the search queries so a second, focused query contributes at least one source — except when
 * the first query is the customer's own vendor list: those pricing pages are read first.
 */
function urlsToRead(convo: Conversation, namedFirst: boolean): string[] {
  const perQuery = convo.succeeded("web_search").map((ex) => resultsOf(ex.output).map((r) => r.url));
  if (namedFirst && perQuery.length > 0) return [...new Set(perQuery.flat())].slice(0, FETCH_TOP);
  const picked: string[] = [];
  const longest = Math.max(0, ...perQuery.map((list) => list.length));
  for (let i = 0; i < longest && picked.length < FETCH_TOP; i++) {
    for (const list of perQuery) {
      const url = list[i];
      if (url && !picked.includes(url)) picked.push(url);
      if (picked.length >= FETCH_TOP) break;
    }
  }
  return picked;
}

/** Fetched page bodies (title first) when any were read, otherwise the search snippets. */
function sourceText(convo: Conversation): string {
  const pages = fetchedPages(convo);
  const text =
    pages.length > 0
      ? pages.map((p) => `${p.title}\n\n${p.text}`).join("\n\n---\n\n")
      : searchResults(convo)
          .map((r) => `${r.title} — ${r.snippet} (${r.url})`)
          .join("\n\n");
  return clip(text, MAX_EXTRACT_CHARS);
}

function finalAnswer(ctx: JobContext, convo: Conversation, now: Date): MockTextResponse {
  const records = degradeForTier(collectRecords(ctx, convo, now), {
    tier: ctx.tier,
    requiredFields: ctx.requiredFields,
    seed: ctx.seed,
  });
  return { text: JSON.stringify(records, null, 2) };
}

function collectRecords(ctx: JobContext, convo: Conversation, now: Date): Array<Record<string, unknown>> {
  if (ctx.kind === "generic") return genericRecords(convo, ctx, now).slice(0, ctx.count);
  const index = new EntityIndex(now, { vendorNames: ctx.namedVendors });
  const found = gatherCandidates(convo, ctx.kind, index);
  const pool = found.length > 0 ? found : fallbackPool(ctx, ctx.kind, index);
  const refs = prioritize(pool, ctx, ctx.kind, index);
  const records = entityRecords(refs, ctx, ctx.kind, index);
  // Every vendor the customer named makes the cut (all of its plans), unless the run asked for a count or the
  // quality model is trimming a vague worker's output.
  const namedKeys = new Set(index.namedRefs().map((r) => r.key));
  const namedRows = ctx.directives.count || ctx.vague ? 0 : entityRecords(refs.filter((r) => namedKeys.has(r.key)), ctx, ctx.kind, index).length;
  return records.slice(0, Math.max(ctx.count, Math.min(namedRows, MAX_NAMED_ROWS)));
}
