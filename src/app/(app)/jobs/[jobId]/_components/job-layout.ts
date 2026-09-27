import type { JobDetailView } from "@/server/queries/jobs";

/**
 * Which job detail layout to show, and the sentences that change with the job's state. Pure, so the page's
 * branching is testable without a session or a database.
 */

/**
 * Before anyone is hired there is nothing to count, list or look back on: the page is the spec and one line
 * about the open seat, not a stat strip of zeros and four empty cards.
 */
export function isUnstaffed(data: Pick<JobDetailView, "workers" | "stats">): boolean {
  return data.workers.length === 0 && data.stats.runs === 0;
}

/** What the spec section is, in the words that are true for this job right now. */
export function specDescription(hasSpec: boolean, approved: boolean): string {
  if (!hasSpec) return "What you asked for. It hasn’t been scoped yet.";
  return approved ? "What you asked for, as scoped and approved." : "What you asked for, as scoped so far — not approved yet.";
}

/** The one quiet line an unstaffed job gets in place of empty worker, run and deliverable cards. */
export function openSeatLine(status: JobDetailView["job"]["status"]): string {
  if (status === "DRAFT") return "Nobody is on this job yet. Finish setting it up and you can hire a worker for it.";
  if (status === "SPEC_APPROVED") return "The seat is open. Once you hire, their runs and deliverables show up here.";
  return "Nobody was hired for this job.";
}
