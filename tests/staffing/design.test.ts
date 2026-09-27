import { describe, expect, it } from "vitest";
import { WorkerBlueprintSchema, parseBlueprint, type AgentComponent, type BlueprintDraft, type DeliverableFormatSlug, type WorkerBlueprint } from "@/server/domain";
import { isAppError } from "@/server/errors";
import { designBlueprint, draftFromTemplate, reportTableColumns } from "@/server/staffing";
import { NOTABLE_KEY } from "@/server/staffing/notable-feedback";
import { tools } from "@/server/tools";
import { FAMILIES, KAI, PRICING_MONITOR, scoped, specFor } from "./helpers";

const FORMATS: readonly DeliverableFormatSlug[] = ["markdown", "csv", "json"];

function agentById(bp: WorkerBlueprint, id: string): AgentComponent | undefined {
  const c = bp.components.find((x) => x.id === id);
  return c && c.type === "agent" ? c : undefined;
}
const ids = (bp: WorkerBlueprint) => bp.components.map((c) => c.id);

describe("staffing: designBlueprint over every family template", () => {
  for (const family of FAMILIES) {
    for (const format of FORMATS) {
      it(`${family} × ${format} → valid, correctly wired blueprint`, () => {
        const spec = specFor(family, { deliverable: { ...specFor(family).deliverable, format, sections: format === "markdown" ? specFor(family).deliverable.sections : [] } });
        const draft = draftFromTemplate(spec);
        const bp = designBlueprint(spec, draft);

        // Round-trip through JSON (what Job.pendingProposal / WorkerVersion.blueprint store) and re-validate.
        expect(() => parseBlueprint(JSON.parse(JSON.stringify(bp)))).not.toThrow();
        expect(WorkerBlueprintSchema.safeParse(bp).success).toBe(true);

        const fieldNames = new Set(spec.deliverable.fields.map((f) => f.name));
        const collector = agentById(bp, "collector");
        expect(collector).toBeDefined();
        expect(collector).toMatchObject({ outputFormat: "json", outputKey: "records", inputKeys: ["job_brief", "instructions"], maxTurns: 8 });
        expect(collector!.tools.length).toBeGreaterThan(0);
        expect(collector!.tools.every((t) => tools.has(t))).toBe(true);
        expect(collector!.tools).not.toContain("send_notification");
        expect(collector!.instructions.length).toBeGreaterThan(300);
        expect(collector!.outputSchemaHint).toContain(spec.deliverable.fields[0].name);

        // In-place record steps read and write `records`, in the contracted order, with spec-only field names.
        const order = ["validate_records", "dedupe", "rank", "compute_stats"];
        const present = ids(bp).filter((id) => order.includes(id));
        expect(present).toEqual(order.filter((id) => present.includes(id)));
        // Only a feedback report builds a side shortlist; every other pipeline leaves the table on `records`.
        const shortlisted = family === "feedback_analysis" && format === "markdown";
        expect(ids(bp).filter((id) => id.startsWith("notable_"))).toEqual(shortlisted ? ["notable_shortlist", "notable_rank"] : []);
        for (const c of bp.components) {
          if (c.type !== "deterministic") continue;
          if (c.id.startsWith("notable_")) {
            expect(c.outputKey).toBe(NOTABLE_KEY);
            expect(fieldNames.has(c.operation === "filter" ? c.config.field : c.operation === "rank" ? c.config.by : "")).toBe(true);
            continue;
          }
          if (c.operation === "validate_records") {
            expect(c.outputKey).toBe("records");
            expect(c.config.requiredFields).toEqual(spec.deliverable.fields.filter((f) => f.required).map((f) => f.name));
            expect(c.config.dropInvalid).toBe(true);
          }
          if (c.operation === "dedupe") {
            expect(c.outputKey).toBe("records");
            expect(c.config.keyFields.every((k) => fieldNames.has(k))).toBe(true);
          }
          if (c.operation === "rank") {
            expect(c.outputKey).toBe("records");
            expect(fieldNames.has(c.config.by)).toBe(true);
            expect(c.config.limit).toBe(Math.round(spec.deliverable.targetCount! * 1.5));
          }
          if (c.operation === "compute_stats") {
            expect(c.outputKey).toBe("stats");
            expect(fieldNames.has(c.config.groupBy!)).toBe(true);
          }
        }
        expect(ids(bp)).toContain("validate_records");
        expect(ids(bp)).toContain("dedupe");

        const analyst = agentById(bp, "analyst");
        const hasStats = ids(bp).includes("compute_stats");
        if (format === "markdown") {
          expect(analyst).toMatchObject({ outputFormat: "markdown", outputKey: "insights", tools: [], maxTurns: 2 });
          expect(analyst!.inputKeys).toEqual(["job_brief", "records", ...(hasStats ? ["stats"] : [])]);
          const report = bp.components.find((c) => c.id === "compile_report");
          expect(report).toBeDefined();
          if (report?.type === "deterministic" && report.operation === "compile_report") {
            expect(report.outputKey).toBe("report");
            expect(report.config.title).toBe(spec.deliverable.title);
            const sources = report.config.sections.map((s) => s.sourceKey);
            expect(sources).toContain("insights");
            expect(sources).toContain(shortlisted ? NOTABLE_KEY : "records");
            expect(sources.includes("stats")).toBe(hasStats);
            // Every heading the customer named is rendered by code or handed to the analyst.
            const rendered = new Set(report.config.sections.map((s) => s.heading));
            for (const heading of spec.deliverable.sections) {
              expect(rendered.has(heading) || analyst!.instructions.includes(heading)).toBe(true);
            }
          }
          expect(bp.deliverable).toMatchObject({ format: "markdown", contentKey: "report", dataKey: "records" });
          expect(ids(bp)).not.toContain("to_csv");
        } else if (format === "csv") {
          expect(analyst).toBeUndefined();
          const csv = bp.components.find((c) => c.id === "to_csv");
          expect(csv).toMatchObject({ type: "deterministic", operation: "to_csv", outputKey: "csv", inputKeys: ["records"] });
          expect(bp.deliverable).toMatchObject({ format: "csv", contentKey: "csv", dataKey: "records" });
          expect(ids(bp)).not.toContain("compile_report");
        } else {
          expect(analyst).toBeUndefined();
          expect(bp.deliverable).toMatchObject({ format: "json", contentKey: "records", dataKey: "records" });
          expect(ids(bp)).not.toContain("to_csv");
          expect(ids(bp)).not.toContain("compile_report");
        }

        // tools[] is exactly the union of agent tools, with registry defaults for approval.
        const agentTools = new Set(bp.components.flatMap((c) => (c.type === "agent" ? c.tools : [])));
        expect(new Set(bp.tools.map((t) => t.toolName))).toEqual(agentTools);
        for (const t of bp.tools) {
          expect(t.reason.length).toBeGreaterThan(10);
          expect(t.requiresApproval).toBe(tools.get(t.toolName)!.defaultRequiresApproval);
        }

        expect(bp.jobFamily).toBe(family);
        expect(bp.schedule).toEqual(spec.cadence);
        expect(bp.limits).toMatchObject({ maxToolCallsPerRun: 40, maxRunDurationSec: 900 });
        expect(bp.deliverable.titleTemplate).toContain("{{date}}");
        expect(bp.costEstimate.perRunUsd).toBeGreaterThan(0);
        expect(bp.kpis.length).toBeGreaterThanOrEqual(4);
        expect(bp.evaluation.rubric.length).toBeGreaterThanOrEqual(3);
        expect(bp.persona.name.length).toBeGreaterThan(1);
        expect(bp.persona.title.length).toBeGreaterThan(3);
        expect(draft.rationale.length).toBeGreaterThanOrEqual(3);
      });
    }
  }
});

describe("staffing: designBlueprint wiring rules", () => {
  it("filters keyFields / rankBy / groupBy to spec fields and falls back to the first required field", () => {
    const spec = specFor("market_research");
    const draft: BlueprintDraft = { ...draftFromTemplate(spec), keyFields: ["nope", "company"], rankBy: "not_a_field", groupBy: "also_missing" };
    const bp = designBlueprint(spec, draft);
    const dedupe = bp.components.find((c) => c.id === "dedupe");
    expect(dedupe?.type === "deterministic" && dedupe.operation === "dedupe" ? dedupe.config.keyFields : null).toEqual(["company"]);
    expect(ids(bp)).not.toContain("rank");
    expect(ids(bp)).not.toContain("compute_stats");

    const noKeys = designBlueprint(spec, { ...draft, keyFields: ["nope"] });
    const fallback = noKeys.components.find((c) => c.id === "dedupe");
    expect(fallback?.type === "deterministic" && fallback.operation === "dedupe" ? fallback.config.keyFields : null).toEqual(["company"]);
    const dupCheck = noKeys.evaluation.deterministicChecks.find((c) => c.type === "no_duplicates");
    expect(dupCheck?.config).toEqual({ keyFields: ["company"] });
  });

  it("skips validate/dedupe when the spec has no required fields and no usable key", () => {
    const base = specFor("general");
    const spec = { ...base, deliverable: { ...base.deliverable, fields: base.deliverable.fields.map((f) => ({ ...f, required: false })) } };
    const bp = designBlueprint(spec, { ...draftFromTemplate(spec), keyFields: ["missing"] });
    expect(ids(bp)).not.toContain("validate_records");
    expect(ids(bp)).not.toContain("dedupe");
    expect(bp.evaluation.deterministicChecks.map((c) => c.type)).not.toContain("required_fields");
  });

  it("appends an approval-gated notifier when steps.notify is set (and drops send_notification from the collector)", () => {
    const spec = specFor("market_research");
    const draft = draftFromTemplate(spec);
    const off = designBlueprint(spec, { ...draft, steps: { ...draft.steps, notify: false } });
    expect(ids(off)).not.toContain("notifier");
    expect(off.tools.map((t) => t.toolName)).not.toContain("send_notification");

    const on = designBlueprint(spec, { ...draft, steps: { ...draft.steps, notify: true }, collector: { ...draft.collector, tools: [...draft.collector.tools, "send_notification"] } });
    const notifier = agentById(on, "notifier");
    expect(on.components[on.components.length - 1].id).toBe("notifier");
    expect(notifier).toMatchObject({ modelTier: "fast", maxTurns: 3, tools: ["send_notification"], outputKey: "notification_status", outputFormat: "markdown", inputKeys: ["report"] });
    expect(agentById(on, "collector")!.tools).not.toContain("send_notification");
    expect(on.tools.find((t) => t.toolName === "send_notification")).toMatchObject({ requiresApproval: true });
  });

  it("also notifies when the spec's toolsLikelyNeeded includes send_notification, wired to the deliverable key", () => {
    const base = specFor("lead_research");
    const spec = { ...base, toolsLikelyNeeded: [...base.toolsLikelyNeeded, "send_notification"] };
    const draft = draftFromTemplate(spec);
    const bp = designBlueprint(spec, { ...draft, steps: { ...draft.steps, notify: false } });
    expect(agentById(bp, "notifier")?.inputKeys).toEqual(["csv"]);
  });

  it("filters unknown tools, uses draft tool reasons, and takes the persona name from the draft unless it is in use", () => {
    const spec = specFor("market_research");
    const draft = draftFromTemplate(spec);
    const custom: BlueprintDraft = {
      ...draft,
      persona: { ...draft.persona, name: "Quinn" },
      collector: { ...draft.collector, tools: ["web_search", "not_a_tool", "fetch_url"] },
      toolReasons: [{ toolName: "web_search", reason: "Because the customer said so." }],
    };
    const bp = designBlueprint(spec, custom);
    expect(agentById(bp, "collector")!.tools).toEqual(["web_search", "fetch_url"]);
    expect(bp.tools.find((t) => t.toolName === "web_search")?.reason).toBe("Because the customer said so.");
    expect(bp.tools.find((t) => t.toolName === "fetch_url")?.reason).toBe(tools.get("fetch_url")!.humanDescription);
    expect(bp.persona.name).toBe("Quinn");

    const taken = designBlueprint(spec, custom, { usedNames: ["quinn"] });
    expect(taken.persona.name).not.toBe("Quinn");
    expect(designBlueprint(spec, custom, { usedNames: ["quinn"] }).persona.name).toBe(taken.persona.name);
  });

  it("uses the spec budget for limits and the cost KPI", () => {
    const spec = specFor("market_research", { budget: { maxCostPerRunUsd: 0.75 } });
    const bp = designBlueprint(spec, draftFromTemplate(spec));
    expect(bp.limits.maxCostPerRunUsd).toBe(0.75);
    expect(bp.kpis.find((k) => k.metric === "cost_per_run_usd")?.target).toBe(0.75);
    expect(bp.evaluation.deterministicChecks.find((c) => c.type === "max_cost_usd")?.config).toEqual({ max: 0.75 });
  });

  it("throws AppError(VALIDATION) with issues when the draft cannot be wired", () => {
    const spec = specFor("market_research");
    const draft = draftFromTemplate(spec);
    try {
      designBlueprint(spec, { ...draft, collector: { ...draft.collector, instructions: "" } });
      expect.unreachable("expected a validation error");
    } catch (e) {
      expect(isAppError(e) && e.code).toBe("VALIDATION");
      expect(isAppError(e) && Array.isArray((e.details as { issues?: unknown }).issues)).toBe(true);
    }
  });

  it("is deterministic: the same inputs produce the same blueprint", () => {
    const spec = specFor("feedback_analysis");
    const a = designBlueprint(spec, draftFromTemplate(spec));
    const b = designBlueprint(spec, draftFromTemplate(spec));
    expect(a).toEqual(b);
  });
});

describe("staffing: report tables and ranking read the way the customer needs", () => {
  const tableOf = (bp: WorkerBlueprint) => {
    const report = bp.components.find((c) => c.type === "deterministic" && c.operation === "compile_report");
    if (report?.type !== "deterministic" || report.operation !== "compile_report") throw new Error("no report");
    return report.config.sections.find((sec) => sec.as === "table")!;
  };

  it("keeps required fields and the source link when the table has to drop columns", () => {
    const spec = specFor("market_research"); // 8 fields + rank > 8 columns
    const table = tableOf(designBlueprint(spec, draftFromTemplate(spec)));
    expect(table.columns).toEqual(["rank", "company", "category", "stage", "amount_usd", "announced_on", "lead_investor", "source_url"]);
    expect(table.columns).not.toContain("hq");

    const many = [...Array.from({ length: 9 }, (_, i) => ({ name: `detail_${i}`, required: false })), { name: "company", required: true }, { name: "source_url", required: false }];
    expect(reportTableColumns(many, true)).toEqual(["rank", "detail_0", "detail_1", "detail_2", "detail_3", "detail_4", "company", "source_url"]);
    expect(reportTableColumns([], true)).toBeUndefined();
  });

  it("ranks triage by time left, most urgent first", () => {
    const spec = specFor("support_triage", { deliverable: { ...specFor("support_triage").deliverable, format: "markdown", sections: ["Summary", "Volume by team", "Urgent tickets"] } });
    const bp = designBlueprint(spec, draftFromTemplate(spec));
    const rank = bp.components.find((c) => c.id === "rank");
    expect(rank?.type === "deterministic" && rank.operation === "rank" ? rank.config : null).toMatchObject({ by: "sla_hours", direction: "asc" });
    expect(rank?.description).toMatch(/^Lowest SLA hours first/);
  });

  it("does not rank a lead list by an arbitrary number, and keys plan-level pricing rows on competitor + plan", () => {
    const leads = scoped(KAI); // company, website, funding_stage, headcount, fit_reason, source_url
    const leadBp = designBlueprint(leads, draftFromTemplate(leads));
    expect(ids(leadBp)).not.toContain("rank");
    expect(ids(leadBp)).toEqual(["collector", "validate_records", "dedupe", "to_csv"]);
    const csv = leadBp.components.find((c) => c.id === "to_csv");
    expect(csv?.type === "deterministic" && csv.operation === "to_csv" ? csv.config.columns : null).toEqual(["company", "website", "funding_stage", "headcount", "fit_reason", "source_url"]);

    const pricing = scoped(PRICING_MONITOR);
    const bp = designBlueprint(pricing, draftFromTemplate(pricing));
    const dedupe = bp.components.find((c) => c.id === "dedupe");
    expect(dedupe?.type === "deterministic" && dedupe.operation === "dedupe" ? dedupe.config.keyFields : null).toEqual(["competitor", "plan_name"]);
    const rank = bp.components.find((c) => c.id === "rank");
    expect(rank?.type === "deterministic" && rank.operation === "rank" ? rank.config : null).toMatchObject({ by: "monthly_price_usd", direction: "asc" });
    expect(ids(bp)).toContain("compute_stats"); // by pricing model, for the "Pricing model breakdown" section
  });
});

describe("staffing: family templates follow the contract", () => {
  it("research families use a standard collector with validate + dedupe + rank", () => {
    for (const family of ["market_research", "market_analysis", "lead_research"] as const) {
      const spec = specFor(family);
      const draft = draftFromTemplate(spec);
      expect(draft.collector.modelTier).toBe("standard");
      expect(draft.steps).toMatchObject({ validate: true, dedupe: true, rank: true });
      expect(draft.collector.tools).toEqual(expect.arrayContaining(["web_search", "fetch_url", "extract_data"]));
      expect(draft.collector.instructions.length).toBeGreaterThan(600);
      expect(draft.analyst.instructions.length).toBeGreaterThan(300);
    }
  });

  it("feedback_analysis reads the dataset, computes stats by category, and notifies only when asked", () => {
    const quiet = specFor("feedback_analysis");
    const draft = draftFromTemplate(quiet);
    expect(draft.collector.name).toBe("Categorizer");
    expect(draft.collector.tools).toEqual(["read_dataset"]);
    expect(draft.steps.computeStats).toBe(true);
    expect(draft.groupBy).toBe("category");
    expect(draft.steps.notify).toBe(false);

    const sharing = specFor("feedback_analysis", {}, { recipients: "Email the report to product@acme.example every week" });
    expect(sharing.toolsLikelyNeeded).toContain("send_notification");
    expect(draftFromTemplate(sharing).steps.notify).toBe(true);
    const bp = designBlueprint(sharing, draftFromTemplate(sharing));
    expect(agentById(bp, "notifier")?.instructions).toContain("product@acme.example");
  });

  it("lead_research delivers CSV by default", () => {
    const spec = specFor("lead_research");
    expect(spec.deliverable.format).toBe("csv");
    expect(ids(designBlueprint(spec, draftFromTemplate(spec)))).toContain("to_csv");
  });

  it("market_analysis puts the analyst on the reasoning tier", () => {
    expect(draftFromTemplate(specFor("market_analysis")).analyst.modelTier).toBe("reasoning");
  });
});
