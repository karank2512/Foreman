import { describe, expect, it } from "vitest";
import { EXAMPLE_JOBS } from "@/app/(app)/hire/schema";
import type { AgentComponent } from "@/server/domain/blueprint";
import type { JobSpec } from "@/server/domain/job-spec";
import { buildRoundups } from "@/server/simulation/catalog";
import { constraintMisses, countryOfLocation, regionOfCountry } from "@/server/simulation/constraints";
import { companyEntities, COMPANY_FIXTURES } from "@/server/simulation/fixtures/companies";
import { fintechEntities, FINTECH_FIXTURES } from "@/server/simulation/fixtures/fintech";
import { LONG_TAIL_SIZE, longTailEntities } from "@/server/simulation/fixtures/long-tail";
import { designBlueprint } from "@/server/staffing/design";
import { mockJobSpec, mockScopingQuestions } from "@/server/staffing/scoping-mock";
import { draftFromTemplate } from "@/server/staffing/templates";
import { driveAgent, FIXED_NOW, parseRecords, sim, type DriveResult } from "./helpers";

/**
 * The long tail: generated rounds a collector reaches only when its first read leaves it short of the volume the job
 * asks for. Below that point nothing may change; above it, the job gets as many distinct, in-brief records as it
 * asked for, every one of them read from a page.
 */

const FUNDING_TRACKER = EXAMPLE_JOBS.find((j) => j.id === "funding-tracker")!.description;

/** A job scoped and designed the way the hire flow does it in Simulated mode, with `volume` as the customer's answer. */
function hired(description: string, volume?: string): { spec: JobSpec; collector: AgentComponent } {
  const scoped = mockScopingQuestions(description);
  const answers: Record<string, string> = Object.fromEntries(scoped.questions.map((q) => [q.id, q.suggestions[0] ?? ""]));
  if (volume !== undefined) answers.volume = volume;
  const spec = mockJobSpec({ description, title: scoped.draftTitle, jobFamily: scoped.jobFamily, intake: { questions: scoped.questions, answers } });
  const collector = designBlueprint(spec, draftFromTemplate(spec)).components.find((c) => c.id === "collector");
  if (!collector || collector.type !== "agent") throw new Error("the designed worker has no collector agent");
  return { spec, collector };
}

const callsOf = (run: DriveResult, tool: string) => run.calls.filter((c) => c.name === tool).map((c) => c.input as Record<string, unknown>);
const longTailNames = () => [...longTailEntities("ai_infrastructure", FIXED_NOW), ...longTailEntities("fintech", FIXED_NOW)].map((c) => c.company);

/** Everything the collector read: search titles/snippets and fetched pages. */
function readText(run: DriveResult): string {
  return run.messages
    .flatMap((m) => {
      if (m.role !== "tool") return [];
      const out = m.output as { results?: Array<{ title: string; snippet: string }>; title?: string; text?: string };
      if (m.toolName === "web_search") return (out.results ?? []).map((r) => `${r.title} ${r.snippet}`);
      if (m.toolName === "fetch_url") return [`${out.title ?? ""}\n${out.text ?? ""}`];
      return [];
    })
    .join("\n");
}

describe("simulated long tail of funding rounds", () => {
  it("leaves a job its first read already covers exactly as it was (funding tracker, 10 and 22 records)", () => {
    // Pinned from the simulator before the long tail existed: the 22 rounds its first read finds, in order.
    const before = [
      "Agentdock", "Latchkey AI", "Evalight", "Vectorloom", "Halcyon Compute", "Sentrymesh", "Routewise AI", "Shardline", "Synthvale", "Tunewright", "Stratacore",
      "Cosinebase", "Edgekiln", "Datamason", "Corpusworks", "Toolbridge", "Tinygrid", "Adapterly", "Checkpointly", "Nearside DB", "Policyloom", "Lumen Trace",
    ];
    for (const n of [10, 22]) {
      const { spec, collector } = hired(FUNDING_TRACKER, String(n));
      const run = driveAgent({ component: collector, spec });
      expect(run.calls.map((c) => c.name)).toEqual(["web_search", "web_search", "fetch_url", "fetch_url", "fetch_url", "fetch_url", "extract_data"]);
      expect(parseRecords(run.final).map((r) => r.company)).toEqual(before.slice(0, n));
      const text = JSON.stringify(run.messages).toLowerCase();
      expect(text).not.toContain("full list");
      for (const name of longTailNames()) expect(text).not.toContain(name.toLowerCase());
    }
  });

  it.each([25, 50, 100])("delivers %i distinct, in-brief records by reading the full list when the first read falls short", (n) => {
    const { spec, collector } = hired(FUNDING_TRACKER, String(n));
    const run = driveAgent({ component: collector, spec });
    expect(run.turns).toBeLessThanOrEqual(collector.maxTurns);

    const searches = callsOf(run, "web_search");
    expect(searches).toHaveLength(3);
    expect(String(searches[2].query)).toMatch(/full list of rounds$/);
    // The first read (4 pages) found 22 rounds; one 12-round part per 12 short, plus one.
    expect(callsOf(run, "fetch_url")).toHaveLength(4 + Math.ceil((n - 22) / 12) + 1);

    const records = parseRecords(run.final);
    expect(records).toHaveLength(n);
    expect(new Set(records.map((r) => String(r.company).toLowerCase())).size).toBe(n); // nothing for dedupe to remove
    for (const r of records) {
      expect(["Seed", "Series A", "Series B"]).toContain(r.stage); // the brief: seed to Series B
      for (const field of ["company", "category", "stage", "amount_usd", "source_url"]) expect(r[field], field).not.toBeNull();
    }
    // Never reports a round it did not read about.
    const read = readText(run).toLowerCase();
    for (const r of records) expect(read).toContain(String(r.company).toLowerCase());
    expect(records.some((r) => longTailNames().includes(String(r.company)))).toBe(true);

    expect(driveAgent({ component: collector, spec }).final).toBe(run.final);
  });

  it("keeps the brief's constraints when it reaches into the long tail", () => {
    const { spec, collector } = hired("Find 25 Series A fintech companies in Europe that recently raised and name a decision-maker at each.");
    const records = parseRecords(driveAgent({ component: collector, spec }).final);
    expect(records.length).toBeGreaterThan(18); // what the hand-written universe alone yields
    expect(records.length).toBeLessThanOrEqual(25);
    // A lead list has no stage or HQ column: check the company each record names.
    const universe = [...companyEntities(FIXED_NOW), ...fintechEntities(FIXED_NOW), ...longTailEntities("ai_infrastructure", FIXED_NOW), ...longTailEntities("fintech", FIXED_NOW)];
    for (const r of records) {
      const company = universe.find((c) => c.company === r.company);
      expect(company, String(r.company)).toBeDefined();
      expect(company!.stage).toBe("Series A");
      expect(company!.sector).toBe("fintech");
      expect(regionOfCountry(countryOfLocation(company!.hq))).toBe("Europe");
    }
  });

  it("is invisible to the standard fixture web and distinct from the hand-written universe", () => {
    for (const sector of ["ai_infrastructure", "fintech"] as const) {
      const tail = longTailEntities(sector, FIXED_NOW);
      expect(tail).toHaveLength(LONG_TAIL_SIZE);
      expect(tail.every((c) => c.sector === sector)).toBe(true);
      expect(longTailEntities(sector, FIXED_NOW)).toEqual(tail);
    }
    const names = longTailNames().map((n) => n.toLowerCase());
    expect(new Set(names).size).toBe(names.length);
    expect(sim.companies()).toHaveLength(COMPANY_FIXTURES.length);

    const handWritten = [...COMPANY_FIXTURES, ...FINTECH_FIXTURES].map((f) => `${f.company} ${f.description} ${f.lead_investor} ${f.hq}`);
    const standardWeb = [
      ...["AI infrastructure startups funding", "Series A fintech companies in Europe", "vector database series A", "compare Notion, Coda and Airtable pricing plans", "GPU cloud leads"].flatMap((q) =>
        sim.search(q, { maxResults: 10 }).map((r) => `${r.title} ${r.snippet}`),
      ),
      ...[...buildRoundups(companyEntities(FIXED_NOW)), ...buildRoundups(fintechEntities(FIXED_NOW), "fintech")].map((r) => sim.fetchPage(r.url).text),
      // genericPage: any URL outside the fixture hosts, and any string that is not a URL at all.
      ...[
        "https://blog.example.org/ai-infrastructure-funding-rounds",
        "https://example.com/fintech/series-a-europe-full-list-of-rounds",
        "https://unknown-host.test/companies/recent-raises",
        "not a url at all",
      ].map((u) => {
        const page = sim.fetchPage(u);
        return `${page.title}\n${page.text}`;
      }),
    ];
    const corpus = [...handWritten, ...standardWeb].join("\n").toLowerCase();
    for (const name of names) expect(corpus).not.toMatch(new RegExp(`\\b${name}\\b`));
  });

  it("is reached only through a full-list search, whose parts are fetchable pages", () => {
    const results = sim.search("AI infrastructure funding announcements full list of rounds", { maxResults: 10 });
    expect(results).toHaveLength(10);
    const page = sim.fetchPage(results[0].url);
    const first = longTailEntities("ai_infrastructure", FIXED_NOW)[0];
    expect(page.text).toContain(first.company);
    expect(sim.fetchPage(first.source_url).title).toContain(first.company);
    expect(constraintMisses({ stage: first.stage, location: first.hq, sector: first.sector }, { stages: [], regions: [], countries: [], sector: "ai_infrastructure", labels: [] })).toEqual([]);
    expect(sim.search("AI infrastructure funding announcements", { maxResults: 10 }).some((r) => r.url.includes("full-list"))).toBe(false);
  });
});
