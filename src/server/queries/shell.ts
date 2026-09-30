import { db } from "@/server/db";
import { isOrgSimulated } from "@/server/models";

export interface ShellData {
  /** True when this workspace runs on the deterministic simulator: no live provider is configured, or it is the demo. */
  simulated: boolean;
  /** Approvals a human can act on right now. */
  pendingApprovals: number;
}

/**
 * Data for the app chrome, loaded once per request by `src/app/(app)/layout.tsx`.
 *
 * An approval only counts while its run is still WAITING_FOR_APPROVAL: a PENDING row whose run was cancelled or
 * failed in the meantime is about to be expired by the runtime and is no longer actionable — the same filter
 * the /approvals pending list uses, so the badge and the list always agree.
 */
export async function getShellData(organizationId: string): Promise<ShellData> {
  const [pendingApprovals, simulated] = await Promise.all([
    db.approval.count({ where: { organizationId, status: "PENDING", run: { status: "WAITING_FOR_APPROVAL" } } }),
    isOrgSimulated(organizationId),
  ]);
  return { simulated, pendingApprovals };
}
