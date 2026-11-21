import { describe, expect, it } from "vitest";
import { WorkerBlueprintSchema, parseBlueprint, type AgentComponent, type BlueprintComponent, type WorkerBlueprint } from "@/server/domain";
import { ALL_AGENT_BASELINE_DEFAULT_TIER, convertDeterministicToAgents, convertedSteps, designBlueprint, draftFromTemplate } from "@/server/staffing";
import { FUNDING_TRACKER, scoped, specFor } from "./helpers";

/**
 * The all-agent baseline (scripts/bench-cost.ts) must be the SAME worker with only the mechanical steps moved to a
 * model: same wiring, same deliverable, same evaluation — or the cost comparison measures something else.
 */

const fundingTracker = (): WorkerBlueprint => {
  const spec = scoped(FUNDING_TRACKER, { volume: "10", recipients: "Just me, in the workspace" });
  return designBlueprint(spec, draftFromTemplate(spec));
};

const agent = (c: BlueprintComponent | undefined): AgentComponent => {
  if (!c || c.type !== "agent") throw new Error(`expected an agent component, got ${c?.type ?? "nothing"}`);
  return c;
};
const byId = (bp: WorkerBlueprint, id: string) => bp.components.find((c) => c.id === id);

describe("staffing: convertDeterministicToAgents", () => {
  it("turns every deterministic step of the funding tracker into a one-turn, tool-less agent with the same wiring", () => {
    const after = fundingTracker();
    const before = convertDeterministicToAgents(after);
    const mechanical = after.components.filter((c) => c.type === "deterministic");
    // The designed funding tracker really does have mechanical steps to convert.
    expect(mechanical.map((c) => c.id)).toEqual(["validate_records", "dedupe", "rank", "compute_stats", "compile_report"]);

    expect(before.components.map((c) => c.id)).toEqual(after.components.map((c) => c.id));
    expect(before.components.every((c) => c.type === "agent")).toBe(true);
    for (const original of mechanical) {
      const converted = agent(byId(before, original.id));
      expect(converted).toMatchObject({
        name: original.name,
        inputKeys: original.inputKeys,
        outputKey: original.outputKey,
        modelTier: ALL_AGENT_BASELINE_DEFAULT_TIER,
        tools: [],
        maxTurns: 1,
        outputFormat: original.operation === "compile_report" ? "markdown" : "json",
      });
      expect(converted.instructions.length).toBeGreaterThan(200);
    }
    expect(ALL_AGENT_BASELINE_DEFAULT_TIER).toBe("fast");
  });

  it("leaves the worker's own agents and everything outside the pipeline untouched", () => {
    const after = fundingTracker();
    const before = convertDeterministicToAgents(after);
    for (const original of after.components.filter((c) => c.type === "agent")) expect(byId(before, original.id)).toEqual(original);
    const outsidePipeline = (bp: WorkerBlueprint): Partial<WorkerBlueprint> => {
      const rest: Partial<WorkerBlueprint> = { ...bp };
      delete rest.components;
      delete rest.costEstimate;
      return rest;
    };
    expect(outsidePipeline(before)).toEqual(outsidePipeline(after));
    expect(before.tools).toEqual(after.tools); // converted steps get no tools, so no new grants
  });

  it("produces a schema-valid blueprint that survives the JSON round trip storage does", () => {
    const before = convertDeterministicToAgents(fundingTracker());
    expect(WorkerBlueprintSchema.safeParse(before).success).toBe(true);
    expect(parseBlueprint(JSON.parse(JSON.stringify(before)))).toEqual(before);
  });

  it("re-estimates the cost: every converted step is now a priced model call", () => {
    const after = fundingTracker();
    const before = convertDeterministicToAgents(after);
    const priced = (bp: WorkerBlueprint, id: string) => bp.costEstimate.breakdown.find((b) => b.componentId === id)?.costUsd ?? 0;
    for (const id of ["validate_records", "dedupe", "rank", "compute_stats", "compile_report"]) {
      expect(priced(after, id)).toBe(0);
      expect(priced(before, id)).toBeGreaterThan(0);
    }
    expect(before.costEstimate.perRunUsd).toBeGreaterThan(after.costEstimate.perRunUsd);
  });

  it("writes the operation and its exact config into the instructions", () => {
    const after = fundingTracker();
    const before = convertDeterministicToAgents(after);
    for (const original of after.components) {
      if (original.type !== "deterministic") continue;
      const text = agent(byId(before, original.id)).instructions;
      switch (original.operation) {
        case "validate_records":
          for (const field of original.config.requiredFields) expect(text).toContain(`"${field}"`);
          expect(text).toContain("Remove every incomplete record");
          break;
        case "dedupe":
          for (const field of original.config.keyFields) expect(text).toContain(`"${field}"`);
          expect(text).toContain("Keep the first record");
          break;
        case "rank":
          expect(text).toContain(`rank by "${original.config.by}", highest first, keeping the top ${original.config.limit}`);
          expect(text).toContain('Add a field "rank"');
          break;
        case "compute_stats":
          expect(text).toContain(`"${original.config.groupBy}"`);
          for (const field of original.config.numericFields) expect(text).toContain(`"${field}"`);
          expect(text).toContain("ONE JSON object");
          break;
        case "compile_report":
          expect(text).toContain(`# ${original.config.title}`);
          for (const section of original.config.sections) {
            expect(text).toContain(`"${section.heading}"`);
            expect(text).toContain(`"## ${section.sourceKey}"`);
            if (section.columns) expect(text).toContain(section.columns.join(", "));
            if (section.maxRows) expect(text).toContain(`at most ${section.maxRows} rows`);
          }
          expect(text).toContain(`Pipeline: ${after.components.map((c) => c.name).join(" → ")}.`);
          break;
        default:
          throw new Error(`unexpected step ${original.operation}`);
      }
    }
  });

  it("honours the tier option for the converted steps only", () => {
    const after = fundingTracker();
    const before = convertDeterministicToAgents(after, { tier: "standard" });
    for (const original of after.components) {
      const converted = agent(byId(before, original.id));
      expect(converted.modelTier).toBe(original.type === "agent" ? original.modelTier : "standard");
    }
  });

  it("is pure: the input is not mutated and the same input gives the same output", () => {
    const after = fundingTracker();
    const snapshot = JSON.parse(JSON.stringify(after));
    const first = convertDeterministicToAgents(after);
    expect(after).toEqual(snapshot);
    expect(convertDeterministicToAgents(after)).toEqual(first);
  });

  it("handles CSV exports and filters: CSV comes back as text, filters keep their condition", () => {
    const csvSpec = specFor("lead_research", { deliverable: { ...specFor("lead_research").deliverable, format: "csv", sections: [] } });
    const csvWorker = convertDeterministicToAgents(designBlueprint(csvSpec, draftFromTemplate(csvSpec)));
    const csv = agent(byId(csvWorker, "to_csv"));
    expect(csv).toMatchObject({ outputFormat: "markdown", outputKey: "csv", maxTurns: 1 });
    expect(csv.instructions).toContain("CSV text only");

    const feedbackSpec = specFor("feedback_analysis");
    const feedback = designBlueprint(feedbackSpec, draftFromTemplate(feedbackSpec));
    const filters = feedback.components.filter((c) => c.type === "deterministic" && c.operation === "filter");
    expect(filters.length).toBeGreaterThan(0);
    const converted = convertDeterministicToAgents(feedback);
    for (const f of filters) {
      if (f.type !== "deterministic" || f.operation !== "filter") continue;
      const text = agent(byId(converted, f.id)).instructions;
      expect(text).toContain(`"${f.config.field}"`);
      if (f.config.value !== undefined) expect(text).toContain(JSON.stringify(f.config.value));
    }
    expect(WorkerBlueprintSchema.safeParse(converted).success).toBe(true);
  });

  it("returns an all-agent worker unchanged apart from a fresh estimate", () => {
    const allAgent = convertDeterministicToAgents(fundingTracker());
    const again = convertDeterministicToAgents(allAgent);
    expect(again.components).toEqual(allAgent.components);
    expect(again.costEstimate.perRunUsd).toBe(allAgent.costEstimate.perRunUsd);
  });

  it("maps every converted agent to the steps it replaces: one each per step, a chain when merged", () => {
    const after = fundingTracker();
    expect(convertedSteps(after).map((s) => [s.componentId, s.replaces.map((r) => r.id)])).toEqual([
      ["validate_records", ["validate_records"]],
      ["dedupe", ["dedupe"]],
      ["rank", ["rank"]],
      ["compute_stats", ["compute_stats"]],
      ["compile_report", ["compile_report"]],
    ]);
    expect(convertedSteps(after, { shape: "merged" }).map((s) => [s.componentId, s.replaces.map((r) => r.id)])).toEqual([
      ["validate_records_dedupe_rank", ["validate_records", "dedupe", "rank"]],
      ["compute_stats", ["compute_stats"]],
      ["compile_report", ["compile_report"]],
    ]);
  });

  it("merges the in-place record steps into ONE call that applies them in order, leaving stats and the report separate", () => {
    const after = fundingTracker();
    const merged = convertDeterministicToAgents(after, { shape: "merged" });
    expect(WorkerBlueprintSchema.safeParse(merged).success).toBe(true);
    expect(merged.components.map((c) => c.id)).toEqual(["collector", "validate_records_dedupe_rank", "compute_stats", "analyst", "compile_report"]);
    const cleaner = agent(byId(merged, "validate_records_dedupe_rank"));
    expect(cleaner).toMatchObject({ inputKeys: ["records"], outputKey: "records", outputFormat: "json", maxTurns: 1, tools: [], modelTier: ALL_AGENT_BASELINE_DEFAULT_TIER });
    expect(cleaner.name).toBe("Validate records + Remove duplicates + Rank by amount (USD)");
    const text = cleaner.instructions;
    expect(text.indexOf("Step 1 — validate records")).toBeGreaterThan(0);
    expect(text.indexOf("Step 2 — remove duplicates")).toBeGreaterThan(text.indexOf("Step 1"));
    expect(text.indexOf("Step 3 — rank by")).toBeGreaterThan(text.indexOf("Step 2"));
    expect(text).toContain('Add a field "rank"');
    expect(text).toContain("Answer with the JSON array of the records after step 3, in rank order.");
    // The report's methodology names the pipeline the baseline really runs.
    expect(agent(byId(merged, "compile_report")).instructions).toContain(`Pipeline: ${merged.components.map((c) => c.name).join(" → ")}.`);
    // Same per-step instructions for the steps that stay separate.
    const perStep = convertDeterministicToAgents(after);
    expect(agent(byId(merged, "compute_stats")).instructions).toBe(agent(byId(perStep, "compute_stats")).instructions);
    expect(merged.costEstimate.perRunUsd).toBeLessThan(perStep.costEstimate.perRunUsd);
  });
});
