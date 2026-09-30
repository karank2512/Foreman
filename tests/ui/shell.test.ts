import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { db, toJson } from "@/server/db";
import { createTestOrg } from "../helpers/factory";
import { createHiredWorker } from "../helpers/fixtures";

// The shell only needs `isOrgSimulated()` (the demo workspace case has its own test in tests/runtime). Mocking keeps
// this suite independent of the models module's internals.
const isSimulated = vi.fn(() => true);
vi.mock("@/server/models", () => ({ isOrgSimulated: async () => isSimulated() }));

const { getShellData } = await import("@/server/queries/shell");

type TestOrg = Awaited<ReturnType<typeof createTestOrg>>;

async function addApproval(
  org: TestOrg,
  hired: Awaited<ReturnType<typeof createHiredWorker>>,
  runStatus: "WAITING_FOR_APPROVAL" | "CANCELLED" | "RUNNING",
  approvalStatus: "PENDING" | "APPROVED" | "EXPIRED",
) {
  const run = await db.run.create({
    data: {
      organizationId: org.organization.id,
      jobId: hired.job.id,
      workerId: hired.worker.id,
      workerVersionId: hired.version.id,
      status: runStatus,
      simulated: true,
    },
  });
  const toolCall = await db.toolCall.create({
    data: {
      runId: run.id,
      workerId: hired.worker.id,
      toolName: "send_notification",
      input: toJson({ channel: "email" }),
      status: "PENDING_APPROVAL",
    },
  });
  await db.approval.create({
    data: {
      organizationId: org.organization.id,
      runId: run.id,
      workerId: hired.worker.id,
      toolCallId: toolCall.id,
      toolName: "send_notification",
      title: "Send the weekly report",
      payload: toJson({ channel: "email" }),
      status: approvalStatus,
    },
  });
}

describe("getShellData", () => {
  let org: TestOrg;
  let other: TestOrg;

  beforeAll(async () => {
    org = await createTestOrg("shell");
    other = await createTestOrg("shell-other");
    const hired = await createHiredWorker(org.organization.id);
    const otherHired = await createHiredWorker(other.organization.id);

    await addApproval(org, hired, "WAITING_FOR_APPROVAL", "PENDING"); // counts
    await addApproval(org, hired, "WAITING_FOR_APPROVAL", "PENDING"); // counts
    await addApproval(org, hired, "WAITING_FOR_APPROVAL", "APPROVED"); // already decided
    await addApproval(org, hired, "CANCELLED", "PENDING"); // run no longer waiting → not actionable
    await addApproval(org, hired, "RUNNING", "EXPIRED");
    await addApproval(other, otherHired, "WAITING_FOR_APPROVAL", "PENDING"); // another tenant
  });

  afterAll(async () => {
    await org?.cleanup();
    await other?.cleanup();
  });

  it("counts only actionable approvals, scoped to the organization", async () => {
    expect((await getShellData(org.organization.id)).pendingApprovals).toBe(2);
    expect((await getShellData(other.organization.id)).pendingApprovals).toBe(1);
  });

  it("returns zero for an organization with nothing pending", async () => {
    const empty = await createTestOrg("shell-empty");
    try {
      expect(await getShellData(empty.organization.id)).toEqual({ simulated: true, pendingApprovals: 0 });
    } finally {
      await empty.cleanup();
    }
  });

  it("reflects the model layer's simulated flag", async () => {
    isSimulated.mockReturnValueOnce(false);
    expect((await getShellData(org.organization.id)).simulated).toBe(false);
    expect((await getShellData(org.organization.id)).simulated).toBe(true);
  });
});
