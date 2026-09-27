import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { db, toJson } from "@/server/db";
import { llm } from "@/server/models";
import { getVersionComparison, listMessages, sendMessageToWorker } from "@/server/workers";
import { classifyMessageHeuristically, normalizeInstruction } from "@/server/workers/chat-mock";
import { deriveSpecChange, parseCadence, parseFormat, parseRecordTarget } from "@/server/workers/chat-spec-change";
import { createTestOrg } from "../helpers/factory";
import { createHiredWorker, makeBlueprint, makeJobSpec } from "../helpers/fixtures";
import { activityOf, createDeliverable, createJudgeEvaluation, createRun, daysAgo, records, type Hired, type TestOrg } from "./helpers";

describe("mock classifier", () => {
  it.each([
    ["What did your last run produce?", "QUESTION"],
    ["Why did the last run fail", "QUESTION"],
    ["How much have you cost this month?", "QUESTION"],
    ["When is your next run?", "QUESTION"],
    ["status", "QUESTION"],
    ["Explain how you rank the rounds.", "QUESTION"],
    ["Is the report ready?", "QUESTION"],
    ["From now on, include the lead investor for every round.", "SPEC_CHANGE"],
    ["Always cite two sources per company", "SPEC_CHANGE"],
    ["Going forward, run daily at 8am", "SPEC_CHANGE"],
    ["Every time you run, send the report as CSV", "SPEC_CHANGE"],
    ["Please change the schedule to weekly on Fridays", "SPEC_CHANGE"],
    ["Change the format to csv", "SPEC_CHANGE"],
    ["Permanently skip seed rounds", "SPEC_CHANGE"],
    ["Stop doing pricing pages", "SPEC_CHANGE"],
    ["This time, focus on Series A rounds only.", "TEMPORARY_INSTRUCTION"],
    ["For the next run, only look at European startups", "TEMPORARY_INSTRUCTION"],
    ["For now, skip anything under $5M", "TEMPORARY_INSTRUCTION"],
    ["Today please include the acquisition rumours", "TEMPORARY_INSTRUCTION"],
    ["Just once, add a section on hardware", "TEMPORARY_INSTRUCTION"],
    ["Focus on vector databases", "TEMPORARY_INSTRUCTION"],
    ["Include the source URL for each round", "TEMPORARY_INSTRUCTION"],
    ["thanks!", "QUESTION"],
    // Polite requests are requests, even with a question mark.
    ["Can you also include the CEO's LinkedIn?", "SPEC_CHANGE"],
    ["Could you please also add the lead investor?", "SPEC_CHANGE"],
    ["Would you add headcount from now on?", "SPEC_CHANGE"],
    ["Can you focus on fintech for the next run?", "TEMPORARY_INSTRUCTION"],
    ["Could you skip seed rounds?", "TEMPORARY_INSTRUCTION"],
    ["Can you include the CEO's LinkedIn this time?", "TEMPORARY_INSTRUCTION"],
    ["Please add a column for headcount", "TEMPORARY_INSTRUCTION"],
    ["Can you explain how you rank the rounds?", "QUESTION"],
    ["Could you tell me what you found?", "QUESTION"],
    ["Why did you pick these sources?", "QUESTION"],
  ])("%s → %s", (message, expected) => {
    expect(classifyMessageHeuristically(message)).toBe(expected);
  });

  it("normalizes instructions into an imperative sentence", () => {
    expect(normalizeInstruction("From now on, can you please include the lead investor?")).toBe("Include the lead investor");
    expect(normalizeInstruction("this time, focus on Series A rounds only.")).toBe("Focus on Series A rounds only");
    expect(normalizeInstruction("Please run daily at 8am going forward")).toBe("Run daily at 8am");
    expect(normalizeInstruction("Can you also include the CEO's LinkedIn?")).toBe("Include the CEO's LinkedIn");
  });
});

describe("spec-change derivation", () => {
  const spec = makeJobSpec();
  const blueprint = makeBlueprint();

  it("parses schedules, record targets and formats", () => {
    expect(parseCadence("run daily at 8am", blueprint.schedule)).toEqual({ kind: "daily", hour: 8 });
    expect(parseCadence("every friday at 5pm", blueprint.schedule)).toEqual({ kind: "weekly", hour: 17, dayOfWeek: 5 });
    expect(parseCadence("every hour", blueprint.schedule)).toEqual({ kind: "hourly" });
    expect(parseCadence("include more detail", blueprint.schedule)).toBeNull();
    expect(parseRecordTarget("find 20 records per run")).toBe(20);
    expect(parseRecordTarget("give me the top 15")).toBe(15);
    expect(parseRecordTarget("cite sources")).toBeNull();
    expect(parseFormat("send it as csv")).toBe("csv");
    expect(parseFormat("switch the output to json format")).toBe("json");
    expect(parseFormat("include the report link")).toBeNull();
  });

  it("changes the schedule and the record target structurally", () => {
    const { blueprint: next, changes } = deriveSpecChange({ blueprint, spec, instruction: "Run daily at 8am and find 20 records per run" });
    expect(next.schedule).toEqual({ kind: "daily", hour: 8 });
    const rank = next.components.find((c) => c.id === "rank");
    expect(rank?.type === "deterministic" && rank.operation === "rank" && rank.config.limit).toBe(30);
    expect(next.evaluation.deterministicChecks.find((c) => c.type === "min_records")?.config).toEqual({ min: 16 });
    expect(next.kpis.find((k) => k.metric === "records_per_run")?.target).toBe(20);
    const collector = next.components.find((c) => c.id === "collector");
    expect(collector?.type === "agent" && collector.outputSchemaHint).toContain("about 20 records per run");
    expect(next.costEstimate.runsPerMonth).toBe(30);
    expect(changes.join(" ")).toContain("schedule weekly on Monday at 9am → daily at 8am");
    expect(changes.join(" ")).toContain("20 records");
  });

  it("re-wires the pipeline for a CSV deliverable and back to markdown", () => {
    const csv = deriveSpecChange({ blueprint, spec, instruction: "Deliver the results as csv" }).blueprint;
    expect(csv.deliverable).toMatchObject({ format: "csv", contentKey: "csv", dataKey: "records" });
    expect(csv.components.map((c) => c.id)).toEqual(["collector", "validate_records", "dedupe", "rank", "to_csv"]);
    expect(csv.evaluation.deterministicChecks.some((c) => c.type === "contains_sections")).toBe(false);

    const md = deriveSpecChange({ blueprint: csv, spec, instruction: "Switch back to a markdown report" }).blueprint;
    expect(md.deliverable).toMatchObject({ format: "markdown", contentKey: "report" });
    expect(md.components.map((c) => c.id)).toEqual(["collector", "validate_records", "dedupe", "rank", "analyst", "compile_report"]);
  });

  it("never proposes an identical design: an already-satisfied wish becomes a standing instruction", () => {
    const { blueprint: next, changes } = deriveSpecChange({ blueprint, spec, instruction: "Run weekly on Monday at 9am" });
    expect(next.schedule).toEqual(blueprint.schedule);
    expect(changes).toHaveLength(1);
    expect(changes[0]).toContain("standing instruction");
    expect(next).not.toEqual(blueprint);
  });

  it("falls back to a standing instruction on every agent", () => {
    const { blueprint: next, changes } = deriveSpecChange({ blueprint, spec, instruction: "Include the lead investor for every round" });
    for (const c of next.components) {
      if (c.type === "agent") expect(c.instructions).toContain("Standing instruction from your manager: Include the lead investor for every round.");
    }
    // Says which part of the work changes, in the manager's words — not the design's internal role names.
    expect(changes[0]).toContain("a standing instruction for the research and analysis steps");
    expect(changes[0]).not.toMatch(/Researcher|Analyst/);
    expect(next.schedule).toEqual(blueprint.schedule);
  });
});

describe("sendMessageToWorker", () => {
  let t: TestOrg;
  let hired: Hired;

  beforeEach(async () => {
    t = await createTestOrg("workers-chat");
    hired = await createHiredWorker(t.organization.id, { userId: t.user.id });
  });
  afterEach(async () => {
    await t.cleanup();
  });

  it("stores a temporary instruction as active and acknowledges the next run", async () => {
    await db.worker.update({ where: { id: hired.worker.id }, data: { nextRunAt: new Date(Date.now() + 86_400_000) } });
    const result = await sendMessageToWorker(t.session, hired.worker.id, "This time, focus on Series A rounds only.");
    expect(result.classification).toBe("TEMPORARY_INSTRUCTION");
    expect(result.proposedVersionId).toBeUndefined();

    const user = await db.workerMessage.findUniqueOrThrow({ where: { id: result.userMessageId } });
    expect(user.role).toBe("USER");
    expect(user.instructionActive).toBe(true);
    expect(user.userId).toBe(t.user.id);
    expect(user.metadata).toMatchObject({ normalizedInstruction: "Focus on Series A rounds only" });

    const reply = await db.workerMessage.findUniqueOrThrow({ where: { id: result.replyMessageId } });
    expect(reply.role).toBe("WORKER");
    expect(reply.content).toContain("I'll apply this on my next run");
    expect(reply.content).toContain("Focus on Series A rounds only");
    expect(reply.content).toContain("My next run is weekly on Monday at 9am");
    expect(reply.metadata).toMatchObject({ simulated: true });

    const events = await activityOf(t.organization.id, hired.worker.id, "INSTRUCTION_RECEIVED");
    expect(events).toHaveLength(1);
    expect(events[0].detail).toBe("Focus on Series A rounds only");

    const messages = await listMessages(t.organization.id, hired.worker.id);
    expect(messages.map((m) => m.role)).toEqual(["USER", "WORKER"]);
    expect(messages[0].id).toBe(result.userMessageId);
  });

  it("turns a spec change into a PROPOSED version with a diff and a review link", async () => {
    const result = await sendMessageToWorker(t.session, hired.worker.id, "From now on, run daily at 8am and find 20 records per run.");
    expect(result.classification).toBe("SPEC_CHANGE");
    expect(result.proposedVersionId).toBeDefined();
    const versionId = result.proposedVersionId!;

    const version = await db.workerVersion.findUniqueOrThrow({ where: { id: versionId } });
    expect(version.status).toBe("PROPOSED");
    expect(version.version).toBe(2);
    expect(version.changeReason).toBe("SPEC_CHANGE");
    expect(version.changeSummary).toBe("Run daily at 8am and find 20 records per run");
    expect(version.analysis).toBeNull();

    const user = await db.workerMessage.findUniqueOrThrow({ where: { id: result.userMessageId } });
    expect(user.proposedVersionId).toBe(versionId);
    expect(user.instructionActive).toBe(false);
    const reply = await db.workerMessage.findUniqueOrThrow({ where: { id: result.replyMessageId } });
    const href = `/workers/${hired.worker.id}/replace/${versionId}`;
    expect(reply.metadata).toMatchObject({ proposedVersionId: versionId, href });
    expect(reply.content).toContain("for your approval");
    // The link travels in the metadata (the "Compare and decide" card); the prose never quotes a path or an id.
    expect(reply.content).not.toContain(href);
    expect(reply.content).not.toContain(versionId);
    expect(reply.content).not.toMatch(/\/workers\//);

    const comparison = await getVersionComparison(t.organization.id, versionId);
    expect(comparison.base?.id).toBe(hired.version.id);
    expect(comparison.canDecide).toBe(true);
    expect(comparison.analysis).toBeNull();
    const paths = comparison.diff.entries.map((e) => e.path);
    expect(paths).toContain("schedule");
    expect(paths).toContain("kpis.coverage");
    expect(comparison.diff.entries.find((e) => e.path === "schedule")).toMatchObject({ before: "Weekly on Monday at 9am", after: "Daily at 8am" });

    // The worker keeps working as before until the proposal is applied.
    expect((await db.worker.findUniqueOrThrow({ where: { id: hired.worker.id } })).currentVersionId).toBe(hired.version.id);
    expect(await activityOf(t.organization.id, hired.worker.id, "VERSION_PROPOSED")).toHaveLength(1);
  });

  it("answers a lasting change in contractor language: no path, no version id, no internal role names", async () => {
    const result = await sendMessageToWorker(t.session, hired.worker.id, "From now on, always add a column with the lead investor's website.");
    expect(result.classification).toBe("SPEC_CHANGE");
    const reply = await db.workerMessage.findUniqueOrThrow({ where: { id: result.replyMessageId } });
    expect(reply.content).toContain("I've drafted version 2 for your approval");
    expect(reply.content).toContain("a standing instruction for the research and analysis steps");
    expect(reply.content).toContain(`until then I keep working as ${hired.worker.name} v1`);
    expect(reply.content).not.toMatch(/\/workers\/|\breplace\b|Researcher|Analyst|Versions tab \(/);
    expect(reply.content).not.toContain(result.proposedVersionId!);
    expect(reply.metadata).toMatchObject({ href: `/workers/${hired.worker.id}/replace/${result.proposedVersionId}` });
  });

  it("answers a question from the worker's real record", async () => {
    const run = await createRun(hired, { status: "SUCCEEDED", createdAt: daysAgo(2), costUsd: 0.21 });
    const deliverable = await createDeliverable(hired, run.id, { title: "Weekly AI Infra Funding Report — Sep 16", data: records(9) });
    await createJudgeEvaluation(hired, { runId: run.id, deliverableId: deliverable.id, score: 0.88, reasoning: "Specific and well sourced." });
    await createRun(hired, { status: "FAILED", createdAt: daysAgo(9), error: "Search backend timed out" });

    const result = await sendMessageToWorker(t.session, hired.worker.id, "What did your last run produce?");
    expect(result.classification).toBe("QUESTION");
    const reply = await db.workerMessage.findUniqueOrThrow({ where: { id: result.replyMessageId } });
    expect(reply.content).toContain("“Weekly AI Infra Funding Report — Sep 16”");
    expect(reply.content).toContain("scored 88/100");
    expect(reply.metadata).toMatchObject({ simulated: true });

    const failures = await sendMessageToWorker(t.session, hired.worker.id, "Why did a run fail?");
    const failReply = await db.workerMessage.findUniqueOrThrow({ where: { id: failures.replyMessageId } });
    expect(failReply.content).toContain("Search backend timed out");

    const cost = await sendMessageToWorker(t.session, hired.worker.id, "How much have you cost so far?");
    const costReply = await db.workerMessage.findUniqueOrThrow({ where: { id: cost.replyMessageId } });
    expect(costReply.content).toMatch(/\$0\.33 across 2 runs/);

    expect((await listMessages(t.organization.id, hired.worker.id, 4)).map((m) => m.role)).toEqual(["USER", "WORKER", "USER", "WORKER"]);
    expect((await db.workerMessage.count({ where: { workerId: hired.worker.id, instructionActive: true } }))).toBe(0);
  });

  it("answers 'why these sources?' from what the last run actually did", async () => {
    const run = await createRun(hired, { status: "SUCCEEDED", createdAt: daysAgo(1) });
    await createDeliverable(hired, run.id, { title: "Weekly AI Infra Funding Report — Sep 21", data: records(9) });
    const calls = [
      { toolName: "web_search", input: { query: "AI infrastructure funding announcements" } },
      { toolName: "web_search", input: { query: "vector database series a" } },
      { toolName: "fetch_url", input: { url: "https://news.example/funding/nearsidedb" } },
      { toolName: "fetch_url", input: { url: "https://www.directory.example/companies/tinygrid" } },
      { toolName: "extract_data", input: { text: "…", fields: ["company"] } },
      { toolName: "fetch_url", input: { url: "https://news.example/funding/broken" }, status: "FAILED" as const },
    ];
    for (const c of calls) {
      await db.toolCall.create({ data: { runId: run.id, workerId: hired.worker.id, toolName: c.toolName, input: toJson(c.input), status: c.status ?? "SUCCEEDED", simulated: true } });
    }
    await db.runStep.createMany({
      data: [
        { runId: run.id, index: 0, kind: "DETERMINISTIC", status: "SUCCEEDED", componentId: "validate_records", title: "Validate records", output: toJson({ before: 10, after: 9, dropped: 1 }) },
        { runId: run.id, index: 1, kind: "DETERMINISTIC", status: "SUCCEEDED", componentId: "dedupe", title: "Remove duplicates", output: toJson({ before: 9, after: 9, removed: 0 }) },
        { runId: run.id, index: 2, kind: "DELIVERABLE", status: "SUCCEEDED", title: "Delivered", output: toJson({ records: 9 }) },
      ],
    });

    const result = await sendMessageToWorker(t.session, hired.worker.id, "Why did you pick these sources?");
    expect(result.classification).toBe("QUESTION");
    const reply = await db.workerMessage.findUniqueOrThrow({ where: { id: result.replyMessageId } });
    expect(reply.content).toMatch(/open the most relevant results myself/);
    expect(reply.content).toContain("searched the web twice (“AI infrastructure funding announcements” and “vector database series a”)");
    expect(reply.content).toContain("read 2 pages on news.example and directory.example");
    expect(reply.content).toContain("kept 9 of 10 records after validation and de-duplication");
    // Not the status boilerplate every other question used to get.
    expect(reply.content).not.toMatch(/scheduled|current score/);
  });

  it("turns a polite 'can you also include…?' into a proposed change, not a status reply", async () => {
    const result = await sendMessageToWorker(t.session, hired.worker.id, "Can you also include the CEO's LinkedIn?");
    expect(result.classification).toBe("SPEC_CHANGE");
    expect(result.proposedVersionId).toBeDefined();
    const version = await db.workerVersion.findUniqueOrThrow({ where: { id: result.proposedVersionId! } });
    expect(version.changeSummary).toBe("Include the CEO's LinkedIn");
    const reply = await db.workerMessage.findUniqueOrThrow({ where: { id: result.replyMessageId } });
    expect(reply.content).toContain("for your approval");
  });

  it("badges templated replies Simulated only when the classification ran on the mock provider", async () => {
    const real = llm.generateObject.bind(llm);
    const spy = vi.spyOn(llm, "generateObject").mockImplementation(async (req, tracking) => ({ ...(await real(req, tracking)), simulated: false }) as never);
    try {
      const instruction = await sendMessageToWorker(t.session, hired.worker.id, "This time, focus on Series A rounds only.");
      const change = await sendMessageToWorker(t.session, hired.worker.id, "From now on, run daily at 8am.");
      for (const id of [instruction.replyMessageId, change.replyMessageId]) {
        expect((await db.workerMessage.findUniqueOrThrow({ where: { id } })).metadata).toMatchObject({ simulated: false });
      }
    } finally {
      spy.mockRestore();
    }
  });

  it("rejects empty messages, unknown workers and retired workers", async () => {
    await expect(sendMessageToWorker(t.session, hired.worker.id, "   ")).rejects.toMatchObject({ code: "VALIDATION" });
    await expect(sendMessageToWorker(t.session, "nope", "hi")).rejects.toMatchObject({ code: "NOT_FOUND" });
    await db.worker.update({ where: { id: hired.worker.id }, data: { status: "RETIRED" } });
    await expect(sendMessageToWorker(t.session, hired.worker.id, "status?")).rejects.toMatchObject({ code: "CONFLICT" });
  });
});
