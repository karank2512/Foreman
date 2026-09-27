import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { db } from "@/server/db";
import { parseBlueprint, type JobSpec, type WorkerBlueprint } from "@/server/domain";
import { enqueueRun, executeRun } from "@/server/runtime";
import { approveJobSpec, buildJobSpec, designBlueprint, draftFromTemplate, hireWorker, proposeWorker, scopeJob } from "@/server/staffing";
import { detectFamily } from "@/server/staffing/family-cues";
import { fieldList, fieldPhrase } from "@/server/staffing/labels";
import { mockScopingQuestions } from "@/server/staffing/scoping-mock";
import { createTestOrg } from "../helpers/factory";
import { DESCRIPTIONS, FAMILIES, FEEDBACK_DIGEST, FINTECH_LEADS, FUNDING_TRACKER, KAI, PRICING_MONITOR, SEED_PRICING_JOB, scoped } from "./helpers";

/**
 * Simulated mode is what every customer sees first, so the proposal has to read like a contractor's résumé:
 * fields by their labels, no template placeholders, no implementation jargon — and a brief about what
 * competitors shipped must be scoped as a digest, not as a funding tracker.
 */

/** The placeholder on the Describe step: the brief most customers try first. */
const COMPETITOR_DIGEST = "Every Monday, summarize what our three main competitors shipped last week and email it to the product team.";

/** Every string the proposal and the spec review show a manager (hire page, "Why this design", review method, cost). */
function userFacingStrings(spec: JobSpec, blueprint: WorkerBlueprint, rationale: readonly string[]): string[] {
  return [
    spec.title,
    spec.summary,
    spec.deliverable.title,
    ...spec.responsibilities,
    ...spec.assumptions,
    ...rationale,
    blueprint.persona.title,
    blueprint.persona.summary,
    ...blueprint.responsibilities,
    ...blueprint.components.flatMap((c) => [c.name, c.description]),
    ...blueprint.tools.map((t) => t.reason),
    ...blueprint.costEstimate.assumptions,
    ...blueprint.costEstimate.breakdown.map((b) => b.label),
    ...blueprint.evaluation.deterministicChecks.map((c) => c.description),
    ...blueprint.evaluation.rubric.flatMap((r) => [r.criterion, r.description]),
    ...blueprint.kpis.flatMap((k) => [k.name, k.description]),
  ];
}

function proposalFor(description: string) {
  const spec = scoped(description);
  const draft = draftFromTemplate(spec);
  return { spec, draft, blueprint: designBlueprint(spec, draft) };
}

const BRIEFS: Record<string, string> = {
  ...Object.fromEntries(FAMILIES.map((family) => [family, DESCRIPTIONS[family]])),
  kai: KAI,
  pricing_monitor: PRICING_MONITOR,
  funding_tracker: FUNDING_TRACKER,
  feedback_digest: FEEDBACK_DIGEST,
  fintech_leads: FINTECH_LEADS,
  seed_pricing: SEED_PRICING_JOB,
  competitor_digest: COMPETITOR_DIGEST,
};

describe("staffing: proposal copy reads like a résumé, not engineering output", () => {
  it.each(Object.entries(BRIEFS))("%s: no field keys, placeholders, sub-cent dollars or implementation jargon", (_, description) => {
    const { spec, draft, blueprint } = proposalFor(description);
    for (const text of userFacingStrings(spec, blueprint, draft.rationale)) {
      expect(text, text).not.toContain("{{");
      expect(text, text).not.toMatch(/\b[a-z0-9]+_[a-z0-9_]+\b/); // snake_case field keys and tool ids
      expect(text, text).not.toMatch(/\$\d+\.\d{3,}/);
      expect(text, text).not.toMatch(/\bin code\b|\bas code\b|\bdeterministic\b|\bcollector\b|\b(?:fast|standard|reasoning)[- ]tier\b/i);
    }
  });

  it("names fields by the label the spec and the table show", () => {
    expect(fieldPhrase("amount_usd")).toBe("amount (USD)");
    expect(fieldPhrase("source_url")).toBe("source URL");
    expect(fieldPhrase("hq")).toBe("HQ");
    expect(fieldPhrase("plan_name")).toBe("plan name");
    expect(fieldList(["company", "pricing_model", "starting_price_usd", "pricing_url", "source_url"], "or")).toBe(
      "company, pricing model, starting price (USD), pricing URL or source URL",
    );

    const funding = proposalFor(FUNDING_TRACKER);
    const rank = funding.blueprint.components.find((c) => c.id === "rank");
    expect(rank?.name).toBe("Rank by amount (USD)");
    expect(funding.draft.rationale.join(" ")).toContain("ranked by amount (USD)");
    const pricing = proposalFor(SEED_PRICING_JOB);
    expect(pricing.draft.rationale.join(" ")).toContain("missing company, pricing model, starting price (USD), pricing URL or source URL is set aside");
    // The spec's own assumptions name the customer's extra columns the same way.
    expect(scoped(PRICING_MONITOR).assumptions.join(" ")).toContain("Monthly price (USD), seat minimum and change since last are filled when the source states them");
  });
});

describe("staffing: a brief about what competitors shipped is scoped as a digest", () => {
  it.each([
    [COMPETITOR_DIGEST, "market_research"],
    ["Keep an eye on what Notion, Coda and Airtable ship each week and summarize it for me.", "market_research"],
    ["Analyze the product launches and new features of our competitors every Friday.", "market_research"],
    // Funding and pricing briefs keep their own designs.
    ["Track which competitors raised a funding round and what they launched with it.", "market_research"],
    [PRICING_MONITOR, "market_analysis"],
  ])("%s → %s", (description, family) => {
    expect(detectFamily(description)).toBe(family);
  });

  it("titles it for what it is and asks digest questions, not funding ones", () => {
    const q = mockScopingQuestions(COMPETITOR_DIGEST);
    expect(q).toMatchObject({ jobFamily: "market_research", draftTitle: "Weekly Competitor Digest" });
    expect(q.questions.map((x) => x.id)).toEqual(["competitors", "dimensions", "recipients"]);
    expect(JSON.stringify(q)).not.toMatch(/Series|seed|funding|stage/i);
  });

  it("drafts a spec and a worker about releases — no rounds, investors or ranking by amount", () => {
    const { spec, blueprint, draft } = proposalFor(COMPETITOR_DIGEST);
    const fields = spec.deliverable.fields.map((f) => f.name);
    expect(fields).toEqual(["competitor", "summary", "category", "announced_on", "source_url"]);
    expect(spec.deliverable).toMatchObject({ title: "Weekly Competitor Digest", sections: ["Summary", "Notable releases", "Updates by category"] });
    // "Three competitors" counts companies, not rows: about two notable updates each.
    expect(spec.deliverable.targetCount).toBe(6);
    expect(JSON.stringify(spec)).not.toMatch(/amount_usd|lead_investor|Top rounds|funding|Series B/i);

    expect(blueprint.components.map((c) => c.id)).not.toContain("rank");
    const dedupe = blueprint.components.find((c) => c.id === "dedupe");
    // Several updates per competitor survive de-duplication; the same update twice does not.
    expect(dedupe?.type === "deterministic" && dedupe.config).toEqual({ keyFields: ["competitor", "summary"] });
    expect(blueprint.persona.summary).toMatch(/competitors/);
    expect(draft.rationale.join(" ")).not.toMatch(/amount|round/i);
    const collector = blueprint.components.find((c) => c.id === "collector");
    expect(collector?.type === "agent" && collector.instructions).not.toMatch(/40000000|Series A/);
  });

  it("an object that is a clause never becomes a title", () => {
    const { draftTitle } = mockScopingQuestions("Research what our customers say about onboarding on Reddit and in app reviews every week.");
    expect(draftTitle).not.toMatch(/^What\b|\bResearch$/);
  });
});

describe("e2e: the competitor digest runs end to end in Simulated mode", () => {
  let t: Awaited<ReturnType<typeof createTestOrg>>;
  beforeAll(async () => {
    t = await createTestOrg("proposal-copy");
  });
  afterAll(async () => {
    await t.cleanup();
  });

  it("scopes, designs, hires and delivers a digest with every required column filled", async () => {
    const scopedJob = await scopeJob(t.session, COMPETITOR_DIGEST);
    expect(scopedJob.questions.draftTitle).toBe("Weekly Competitor Digest");
    const answers = Object.fromEntries(scopedJob.questions.questions.map((q) => [q.id, q.suggestions[0] ?? ""]));
    const built = await buildJobSpec(t.session, scopedJob.jobId, answers);
    expect(built.spec.deliverable.fields.map((f) => f.name)).not.toContain("amount_usd");
    expect(built.spec.constraints.join(" ")).not.toMatch(/seed to Series B/);
    await approveJobSpec(t.session, built.jobSpecId);
    const proposal = await proposeWorker(t.session, scopedJob.jobId);
    for (const text of userFacingStrings(built.spec, proposal.blueprint, proposal.rationale)) expect(text, text).not.toMatch(/\{\{|\b[a-z0-9]+_[a-z0-9_]+\b/);

    const hired = await hireWorker(t.session, scopedJob.jobId, { startFirstRun: false });
    const { runId } = await enqueueRun({ organizationId: t.organization.id, workerId: hired.workerId, trigger: "MANUAL", requestedById: t.user.id });
    // The brief asks for an email, so the run delivers and then waits for the send to be approved.
    const outcome = await executeRun(runId);
    expect(outcome.status).toBe("WAITING_FOR_APPROVAL");
    const deliverable = await db.deliverable.findFirstOrThrow({ where: { runId, organizationId: t.organization.id } });
    expect(deliverable.title).toMatch(/^Weekly Competitor Digest — \d{4}-\d{2}-\d{2}$/);
    expect(deliverable.content).not.toMatch(/Top rounds/);
    const records = deliverable.data as Array<Record<string, unknown>>;
    expect(records.length).toBeGreaterThan(0);
    for (const record of records) for (const field of ["competitor", "summary", "source_url"]) expect(record[field], field).not.toBeNull();

    const version = await db.workerVersion.findUniqueOrThrow({ where: { id: hired.versionId } });
    expect(parseBlueprint(version.blueprint).deliverable.titleTemplate).toBe("Weekly Competitor Digest — {{date}}");
  });
});
