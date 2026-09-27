import { startOfDay, subDays, subHours, subMinutes } from "date-fns";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { recordActivity } from "@/server/activity";
import { db, toJson } from "@/server/db";
import { getActivityFeed, groupActivityByDay, hasActivityInFlight, listActivityWorkers } from "@/server/queries/activity";
import { getApprovalRefs, getApprovalsPage, listApprovals } from "@/server/queries/approvals";
import { getWorkforce } from "@/server/queries/workforce";
import { decideApproval } from "@/server/runtime";
import { recordUsage } from "@/server/usage";
import { createTestOrg } from "../helpers/factory";
import { createHiredWorker } from "../helpers/fixtures";

type TestOrg = Awaited<ReturnType<typeof createTestOrg>>;
type Hired = Awaited<ReturnType<typeof createHiredWorker>>;

/**
 * Query-level tests for the Workforce / Approvals / Activity pages. Rows are written directly with `db`
 * (the fixtures never go through the runtime) except decisions, which use the real `decideApproval`.
 */

async function createRun(
  t: TestOrg,
  hired: Hired,
  data: {
    status: "QUEUED" | "RUNNING" | "WAITING_FOR_APPROVAL" | "SUCCEEDED" | "FAILED" | "CANCELLED";
    finishedAt?: Date;
    createdAt?: Date;
    error?: string;
    trigger?: "MANUAL" | "SCHEDULED" | "RETRY";
    workerVersionId?: string;
  },
) {
  return db.run.create({
    data: {
      organizationId: t.organization.id,
      jobId: hired.job.id,
      workerId: hired.worker.id,
      workerVersionId: data.workerVersionId ?? hired.version.id,
      status: data.status,
      trigger: data.trigger,
      simulated: true,
      error: data.error,
      finishedAt: data.finishedAt,
      ...(data.createdAt ? { createdAt: data.createdAt } : {}),
    },
  });
}

async function createDeliverable(
  t: TestOrg,
  hired: Hired,
  runId: string,
  data: {
    status: "PENDING_REVIEW" | "ACCEPTED" | "REJECTED";
    title?: string;
    feedback?: string;
    reviewedAt?: Date;
    createdAt?: Date;
    workerVersionId?: string;
  },
) {
  return db.deliverable.create({
    data: {
      organizationId: t.organization.id,
      jobId: hired.job.id,
      workerId: hired.worker.id,
      workerVersionId: data.workerVersionId ?? hired.version.id,
      runId,
      title: data.title ?? "Weekly report",
      content: "# Report",
      status: data.status,
      feedback: data.feedback,
      reviewedAt: data.reviewedAt,
      ...(data.createdAt ? { createdAt: data.createdAt } : {}),
    },
  });
}

/** A run paused on a send_notification approval, exactly as the runtime leaves it (minus the checkpoint). */
async function createPendingApproval(t: TestOrg, hired: Hired, opts: { runStatus?: "WAITING_FOR_APPROVAL" | "CANCELLED"; title?: string; createdAt?: Date } = {}) {
  const run = await createRun(t, hired, { status: opts.runStatus ?? "WAITING_FOR_APPROVAL" });
  const payload = { channel: "email", recipients: ["team@acme.example"], subject: "Weekly report", body: "…" };
  const toolCall = await db.toolCall.create({
    data: { runId: run.id, workerId: hired.worker.id, toolName: "send_notification", input: toJson(payload), status: "PENDING_APPROVAL", simulated: true },
  });
  const approval = await db.approval.create({
    data: {
      organizationId: t.organization.id,
      runId: run.id,
      workerId: hired.worker.id,
      toolCallId: toolCall.id,
      toolName: "send_notification",
      title: opts.title ?? `${hired.worker.name} wants to email the weekly report to 1 recipient`,
      description: "Sends the finished report by email.",
      payload: toJson(payload),
      ...(opts.createdAt ? { createdAt: opts.createdAt } : {}),
    },
  });
  return { run, toolCall, approval };
}

describe("queries/workforce: getWorkforce", () => {
  let t: TestOrg;
  let other: TestOrg;
  let alex: Hired;
  let sam: Hired;

  beforeAll(async () => {
    t = await createTestOrg("pages-workforce");
    other = await createTestOrg("pages-workforce-other");
    alex = await createHiredWorker(t.organization.id, { name: "Alex" });
    sam = await createHiredWorker(t.organization.id, { name: "Sam", withNotifier: true });
    await createHiredWorker(other.organization.id, { name: "Stranger" });

    // Sam: struggling. Alex: healthy with a run in flight.
    await db.worker.update({ where: { id: sam.worker.id }, data: { health: "NEEDS_ATTENTION", healthReason: "2 of the last 3 runs failed", score: 41 } });
    await db.worker.update({ where: { id: alex.worker.id }, data: { health: "HEALTHY", score: 88 } });

    const now = new Date();
    // "Runs today" is a local-calendar-day count, so keep today's fixtures after midnight even when the suite runs at 1am.
    const midnight = startOfDay(now).getTime();
    const earlierToday = (d: Date) => new Date(Math.max(d.getTime(), midnight + 1000));
    const succeeded = await createRun(t, alex, { status: "SUCCEEDED", finishedAt: earlierToday(subHours(now, 2)), createdAt: earlierToday(subHours(now, 3)) });
    await createRun(t, alex, { status: "RUNNING", createdAt: earlierToday(subMinutes(now, 5)) });
    await createRun(t, sam, { status: "FAILED", finishedAt: earlierToday(subHours(now, 1)), createdAt: earlierToday(subHours(now, 1)), error: "Cost limit exceeded" });
    // Old failure: outside the 7-day attention window, still counts nowhere on the dashboard.
    await createRun(t, sam, { status: "FAILED", finishedAt: subDays(now, 20), createdAt: subDays(now, 20) });
    await createDeliverable(t, alex, succeeded.id, { status: "PENDING_REVIEW", title: "Funding report — week 38" });
    await createDeliverable(t, alex, succeeded.id, { status: "ACCEPTED", reviewedAt: subDays(now, 1) });
    await createDeliverable(t, sam, succeeded.id, { status: "REJECTED", title: "Market analysis", feedback: "Half the rows were duplicates", reviewedAt: subHours(now, 4) });
    await createPendingApproval(t, sam, { title: "Sam wants to email the digest" });

    await recordUsage({ organizationId: t.organization.id, kind: "MODEL", provider: "mock", resource: "mock-standard", inputTokens: 1000, outputTokens: 200, costUsd: 0.25, simulated: true, workerId: alex.worker.id });
    await recordUsage({ organizationId: t.organization.id, kind: "TOOL", provider: "tool", resource: "web_search", costUsd: 0.05, simulated: true, workerId: sam.worker.id });
    await recordUsage({ organizationId: other.organization.id, kind: "MODEL", provider: "mock", resource: "mock-standard", costUsd: 9, simulated: true });
    await recordActivity({ organizationId: t.organization.id, type: "RUN_SUCCEEDED", title: "Alex delivered the weekly report", workerId: alex.worker.id, runId: succeeded.id });
  });
  afterAll(async () => {
    await t.cleanup();
    await other.cleanup();
  });

  it("is org-scoped: another org sees none of it", async () => {
    const view = await getWorkforce(other.organization.id);
    expect(view.workers.map((w) => w.name)).toEqual(["Stranger"]);
    expect(view.attention).toEqual([]);
    expect(view.stats).toMatchObject({ activeWorkers: 1, runsToday: 0, runsInFlight: 0, deliverablesAwaitingReview: 0, deliverablesTotal: 0 });
    expect(view.stats.spendThisMonthUsd).toBeCloseTo(9, 6);
    expect(view.recentActivity).toEqual([]);
    expect(view.hasRunsInFlight).toBe(false);
  });

  it("counts workers, runs, deliverables and spend for the org", async () => {
    const view = await getWorkforce(t.organization.id);
    expect(view.simulated).toBe(true);
    expect(view.stats).toMatchObject({
      activeWorkers: 2,
      pausedWorkers: 0,
      retiredWorkers: 0,
      runsToday: 4, // succeeded, running, recent failure, waiting-for-approval — not the 20-day-old failure
      runsInFlight: 2, // RUNNING + WAITING_FOR_APPROVAL
      deliverablesAwaitingReview: 1,
      deliverablesTotal: 3,
      spendSimulated: true,
    });
    expect(view.stats.spendThisMonthUsd).toBeCloseTo(0.3, 6);
    expect(view.stats.spendByDay.length).toBeGreaterThan(0);
    expect(view.stats.spendByDay.reduce((a, b) => a + b, 0)).toBeCloseTo(0.3, 6);
    expect(view.hasRunsInFlight).toBe(true);
    expect(view.recentActivity).toHaveLength(1);
    expect(view.recentActivity[0]).toMatchObject({ title: "Alex delivered the weekly report", href: expect.stringMatching(/^\/runs\//) });
  });

  it("orders the attention strip: approvals → workers needing attention → failed runs → rejected deliverables", async () => {
    const { attention } = await getWorkforce(t.organization.id);
    expect(attention.map((a) => a.kind)).toEqual(["approval", "health", "run_failed", "deliverable_rejected"]);
    expect(attention[0]).toMatchObject({ kind: "approval", workerName: "Sam", toolLabel: expect.any(String), title: "Sam wants to email the digest" });
    // The strip's Approve confirmation shows exactly what will be sent, so the payload travels with the item.
    expect(attention[0]).toMatchObject({ payload: { channel: "email", recipients: ["team@acme.example"], subject: "Weekly report" } });
    expect(attention[1]).toMatchObject({ kind: "health", workerName: "Sam", reason: "2 of the last 3 runs failed", score: 41 });
    expect(attention[2]).toMatchObject({ kind: "run_failed", workerName: "Sam", error: "Cost limit exceeded" });
    expect(attention[3]).toMatchObject({ kind: "deliverable_rejected", workerName: "Sam", title: "Market analysis", feedback: "Half the rows were duplicates" });
    // Every item is plain JSON with ISO timestamps.
    for (const item of attention) {
      if ("at" in item) expect(() => new Date(item.at).toISOString()).not.toThrow();
    }
  });

  it("builds roster cards with the worker needing attention first and per-worker facts filled in", async () => {
    const { workers } = await getWorkforce(t.organization.id);
    expect(workers.map((w) => w.name)).toEqual(["Sam", "Alex"]);

    const alexCard = workers.find((w) => w.name === "Alex")!;
    expect(alexCard).toMatchObject({ status: "ACTIVE", health: "HEALTHY", score: 88, deliverables: 2, deliverablesAwaitingReview: 1, jobTitle: alex.job.title });
    expect(alexCard.lastRun?.status).toBe("SUCCEEDED");
    expect(alexCard.activeRun?.status).toBe("RUNNING");
    expect(alexCard.costThisMonthUsd).toBeCloseTo(0.25, 6);
    expect(alexCard.schedule).toMatch(/weekly/i);
    expect(alexCard.nextRunAt).toBeNull();
    expect(typeof alexCard.hiredAt).toBe("string");

    const samCard = workers.find((w) => w.name === "Sam")!;
    expect(samCard).toMatchObject({ health: "NEEDS_ATTENTION", healthReason: "2 of the last 3 runs failed", deliverables: 1, deliverablesAwaitingReview: 0 });
    expect(samCard.lastRun?.status).toBe("FAILED");
    expect(samCard.activeRun?.status).toBe("WAITING_FOR_APPROVAL");
    expect(samCard.costThisMonthUsd).toBeCloseTo(0.05, 6);
  });

  it("drops retired workers from the roster but keeps counting them", async () => {
    const retired = await createHiredWorker(t.organization.id, { name: "Riley" });
    await db.worker.update({ where: { id: retired.worker.id }, data: { status: "RETIRED", retiredAt: new Date() } });
    try {
      const view = await getWorkforce(t.organization.id);
      expect(view.workers.map((w) => w.name)).not.toContain("Riley");
      expect(view.stats.retiredWorkers).toBe(1);
      expect(view.stats.activeWorkers).toBe(2);
    } finally {
      await db.job.delete({ where: { id: retired.job.id } });
    }
  });
});

describe("queries/workforce: the attention strip drops what was already dealt with", () => {
  let t: TestOrg;
  const ids: { listedRuns: string[]; listedDeliverables: string[] } = { listedRuns: [], listedDeliverables: [] };

  beforeAll(async () => {
    t = await createTestOrg("pages-workforce-attention");
    const now = new Date();
    const at = (hoursAgo: number) => subHours(now, hoursAgo);
    const failAt = (hired: Hired, hoursAgo: number, extra: { workerVersionId?: string } = {}) =>
      createRun(t, hired, { status: "FAILED", createdAt: at(hoursAgo + 0.1), finishedAt: at(hoursAgo), error: "Boom", ...extra });

    // Ben failed three times, then a run succeeded (resolved), then failed again (still open).
    const ben = await createHiredWorker(t.organization.id, { name: "Ben" });
    for (const h of [96, 84, 72]) await failAt(ben, h);
    await createRun(t, ben, { status: "SUCCEEDED", createdAt: at(60), finishedAt: at(59.5) });
    const benLate = await failAt(ben, 24);

    // Eve failed once, long enough ago that the old "newest 3" cut would have hidden her behind resolved rows.
    const eve = await createHiredWorker(t.organization.id, { name: "Eve" });
    const eveFail = await failAt(eve, 120);

    // Cora failed and the user asked her to try again (the retry is still queued).
    const cora = await createHiredWorker(t.organization.id, { name: "Cora" });
    await failAt(cora, 48);
    await createRun(t, cora, { status: "QUEUED", trigger: "RETRY" });

    // Rosa's v1 failed and had work sent back; the user replaced v1 with v2.
    const rosa = await createHiredWorker(t.organization.id, { name: "Rosa" });
    const rosaFail = await failAt(rosa, 12);
    await createDeliverable(t, rosa, rosaFail.id, { status: "REJECTED", title: "Rosa v1 report", reviewedAt: at(11), createdAt: at(12) });
    const rosaV2 = await db.workerVersion.create({
      data: { workerId: rosa.worker.id, jobSpecId: rosa.jobSpec.id, version: 2, status: "ACTIVE", blueprint: toJson(rosa.blueprint), changeReason: "REPLACEMENT", parentVersionId: rosa.version.id, activatedAt: at(10) },
    });
    await db.workerVersion.update({ where: { id: rosa.version.id }, data: { status: "REPLACED", retiredAt: at(10) } });
    await db.worker.update({ where: { id: rosa.worker.id }, data: { currentVersionId: rosaV2.id } });

    // Riley was retired; nothing of theirs needs the user any more.
    const riley = await createHiredWorker(t.organization.id, { name: "Riley" });
    const rileyFail = await failAt(riley, 5);
    await createDeliverable(t, riley, rileyFail.id, { status: "REJECTED", title: "Riley report", reviewedAt: at(4), createdAt: at(5) });
    await db.worker.update({ where: { id: riley.worker.id }, data: { status: "RETIRED", retiredAt: at(3) } });

    // Dex had a report sent back, then delivered one that was accepted (resolved), then another sent back (open).
    const dex = await createHiredWorker(t.organization.id, { name: "Dex" });
    const dexRun = await createRun(t, dex, { status: "SUCCEEDED", createdAt: at(80), finishedAt: at(79) });
    await createDeliverable(t, dex, dexRun.id, { status: "REJECTED", title: "Dex first", reviewedAt: at(70), createdAt: at(72) });
    await createDeliverable(t, dex, dexRun.id, { status: "ACCEPTED", title: "Dex second", reviewedAt: at(47), createdAt: at(48) });
    const dexLate = await createDeliverable(t, dex, dexRun.id, { status: "REJECTED", title: "Dex third", reviewedAt: at(23), createdAt: at(24) });

    ids.listedRuns = [benLate.id, eveFail.id];
    ids.listedDeliverables = [dexLate.id];
  });
  afterAll(async () => {
    await t.cleanup();
  });

  it("lists only open failures and rejections from current versions of seated workers", async () => {
    const { attention } = await getWorkforce(t.organization.id);
    const runs = attention.flatMap((a) => (a.kind === "run_failed" ? [a.runId] : []));
    const deliverables = attention.flatMap((a) => (a.kind === "deliverable_rejected" ? [a.deliverableId] : []));
    expect(runs).toEqual(ids.listedRuns);
    expect(deliverables).toEqual(ids.listedDeliverables);
    expect(attention.map((a) => a.workerName)).not.toContain("Riley");
    expect(attention.map((a) => a.workerName)).not.toContain("Rosa");
    expect(attention.map((a) => a.workerName)).not.toContain("Cora");
  });
});

describe("queries/approvals", () => {
  let t: TestOrg;
  let other: TestOrg;
  let maya: Hired;
  let alex: Hired;

  beforeAll(async () => {
    t = await createTestOrg("pages-approvals");
    other = await createTestOrg("pages-approvals-other");
    maya = await createHiredWorker(t.organization.id, { name: "Maya", withNotifier: true });
    alex = await createHiredWorker(t.organization.id, { name: "Alex", withNotifier: true });
    const stranger = await createHiredWorker(other.organization.id, { name: "Stranger", withNotifier: true });
    await createPendingApproval(other, stranger);
  });
  afterAll(async () => {
    await t.cleanup();
    await other.cleanup();
  });

  it("lists pending requests only while their run is still waiting, oldest first, with the tool's display name", async () => {
    const older = await createPendingApproval(t, maya, { title: "older", createdAt: subMinutes(new Date(), 30) });
    const newer = await createPendingApproval(t, alex, { title: "newer" });
    const stale = await createPendingApproval(t, maya, { title: "stale", runStatus: "CANCELLED" });

    const pending = await listApprovals(t.organization.id, { status: "PENDING" });
    expect(pending.map((a) => a.title)).toEqual(["newer", "older"]); // newest first from listApprovals
    expect(pending.map((a) => a.id)).not.toContain(stale.approval.id);
    expect(pending[1]).toMatchObject({
      id: older.approval.id,
      status: "PENDING",
      toolName: "send_notification",
      runId: older.run.id,
      runStatus: "WAITING_FOR_APPROVAL",
      simulated: true,
      worker: { id: maya.worker.id, name: "Maya", avatarColor: maya.worker.avatarColor },
      jobTitle: maya.job.title,
      decidedAt: null,
      decidedBy: null,
      note: null,
    });
    expect(pending[1].toolLabel).not.toBe("send_notification"); // registry display name, not the raw id
    expect(pending[1].payload).toMatchObject({ channel: "email" });

    const page = await getApprovalsPage(t.organization.id);
    expect(page.pending.map((a) => a.title)).toEqual(["older", "newer"]); // page: longest-waiting on top
    // Still PENDING in the DB but no longer actionable: neither offered for a decision nor shown as decided
    // (the runtime expires it in the same transaction that cancels the run, so this state is transient).
    expect(page.decided.map((a) => a.id)).not.toContain(stale.approval.id);

    expect(await listApprovals(t.organization.id, { status: "PENDING", workerId: alex.worker.id })).toHaveLength(1);
    expect(await listApprovals(other.organization.id)).toHaveLength(1);
    expect((await listApprovals(other.organization.id))[0].worker.name).toBe("Stranger");
    expect(await getApprovalRefs(other.organization.id, newer.approval.id)).toBeNull();
    expect(await getApprovalRefs(t.organization.id, newer.approval.id)).toEqual({ runId: newer.run.id, workerId: alex.worker.id, workerName: "Alex" });
  });

  it("moves a decided request to the history with who decided, when, and the note", async () => {
    const { approval, run } = await createPendingApproval(t, maya, { title: "decide me" });
    await decideApproval({ organizationId: t.organization.id, approvalId: approval.id, userId: t.user.id, decision: "reject", note: "Not this week" });

    const page = await getApprovalsPage(t.organization.id, { workerId: maya.worker.id });
    expect(page.pending.map((a) => a.id)).not.toContain(approval.id);
    const decided = page.decided.find((a) => a.id === approval.id);
    expect(decided).toMatchObject({ status: "REJECTED", decidedBy: t.user.name, note: "Not this week", runId: run.id, runStatus: "QUEUED" });
    expect(decided?.decidedAt && new Date(decided.decidedAt).getTime()).toBeGreaterThan(0);
    // Newest decision first.
    expect(page.decided[0].id).toBe(approval.id);
  });
});

describe("queries/activity", () => {
  let t: TestOrg;
  let other: TestOrg;
  let alex: Hired;
  let maya: Hired;

  beforeAll(async () => {
    t = await createTestOrg("pages-activity");
    other = await createTestOrg("pages-activity-other");
    alex = await createHiredWorker(t.organization.id, { name: "Alex" });
    maya = await createHiredWorker(t.organization.id, { name: "Maya" });
    const now = new Date();
    // Grouping is by LOCAL calendar day, so the five "today" events must stay after midnight even when the suite
    // runs at 00:30: space them evenly across however much of today has passed (at most an hour apart).
    const step = Math.min(60 * 60 * 1000, Math.max(1000, (now.getTime() - startOfDay(now).getTime()) / 10));
    const earlierToday = (n: number) => new Date(now.getTime() - n * step);
    const events = [
      { type: "WORKER_HIRED", title: "You hired Alex", workerId: alex.worker.id, at: subDays(now, 2) },
      { type: "RUN_QUEUED", title: "Alex's run was queued", workerId: alex.worker.id, at: subDays(now, 1) },
      { type: "RUN_SUCCEEDED", title: "Alex finished a run", workerId: alex.worker.id, at: earlierToday(5) },
      { type: "DELIVERABLE_CREATED", title: "Alex delivered a report", workerId: alex.worker.id, at: earlierToday(4) },
      { type: "APPROVAL_REQUESTED", title: "Maya wants to send an email", workerId: maya.worker.id, at: earlierToday(3) },
      { type: "PERMISSION_CHANGED", title: "You changed Maya's permissions", workerId: maya.worker.id, at: earlierToday(2) },
      { type: "NOTE", title: "Schedule updated", workerId: maya.worker.id, at: earlierToday(1) },
    ] as const;
    for (const e of events) {
      await db.activityEvent.create({ data: { organizationId: t.organization.id, type: e.type, title: e.title, workerId: e.workerId, createdAt: e.at } });
    }
    await recordActivity({ organizationId: other.organization.id, type: "NOTE", title: "Someone else's note" });
  });
  afterAll(async () => {
    await t.cleanup();
    await other.cleanup();
  });

  it("pages newest-first with a cursor and never crosses org boundaries", async () => {
    const first = await getActivityFeed(t.organization.id, { limit: 3 });
    expect(first.items.map((i) => i.title)).toEqual(["Schedule updated", "You changed Maya's permissions", "Maya wants to send an email"]);
    expect(first.nextCursor).toBe(first.items[2].createdAt);

    const second = await getActivityFeed(t.organization.id, { limit: 3, before: first.nextCursor! });
    expect(second.items.map((i) => i.title)).toEqual(["Alex delivered a report", "Alex finished a run", "Alex's run was queued"]);
    expect(second.nextCursor).not.toBeNull();

    const last = await getActivityFeed(t.organization.id, { limit: 3, before: second.nextCursor! });
    expect(last.items.map((i) => i.title)).toEqual(["You hired Alex"]);
    expect(last.nextCursor).toBeNull();

    // A garbage cursor is ignored rather than throwing.
    expect((await getActivityFeed(t.organization.id, { limit: 3, before: "not-a-date" })).items).toHaveLength(3);

    const foreign = await getActivityFeed(other.organization.id);
    expect(foreign.items.map((i) => i.title)).toEqual(["Someone else's note"]);
  });

  it("filters by worker and by type group (NOTE only appears unfiltered)", async () => {
    const maya_ = await getActivityFeed(t.organization.id, { workerId: maya.worker.id });
    expect(maya_.items.map((i) => i.type)).toEqual(["NOTE", "PERMISSION_CHANGED", "APPROVAL_REQUESTED"]);

    const runs = await getActivityFeed(t.organization.id, { group: "runs" });
    expect(runs.items.map((i) => i.type)).toEqual(["RUN_SUCCEEDED", "RUN_QUEUED"]);

    const hiring = await getActivityFeed(t.organization.id, { group: "hiring" });
    expect(hiring.items.map((i) => i.type)).toEqual(["WORKER_HIRED"]);

    const permissions = await getActivityFeed(t.organization.id, { group: "permissions", workerId: alex.worker.id });
    expect(permissions.items).toEqual([]);
  });

  it("groups by local day preserving order, and lists the org's workers for the filter", async () => {
    const feed = await getActivityFeed(t.organization.id);
    const days = groupActivityByDay(feed.items);
    expect(days.length).toBeGreaterThanOrEqual(3);
    expect(days.flatMap((d) => d.items.map((i) => i.id))).toEqual(feed.items.map((i) => i.id));
    for (const day of days) {
      expect(day.day).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(new Set(day.items.map((i) => groupActivityByDay([i])[0].day))).toEqual(new Set([day.day]));
    }
    expect(groupActivityByDay([])).toEqual([]);

    const workers = await listActivityWorkers(t.organization.id);
    expect(workers.map((w) => w.name).sort()).toEqual(["Alex", "Maya"]);
    expect(await hasActivityInFlight(t.organization.id)).toBe(false);
    await createRun(t, alex, { status: "QUEUED" });
    expect(await hasActivityInFlight(t.organization.id)).toBe(true);
    expect(await hasActivityInFlight(other.organization.id)).toBe(false);
  });
});
