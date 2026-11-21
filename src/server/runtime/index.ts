/**
 * Runtime public surface (contract: docs/CONTRACTS.md § runtime, types in ./types).
 *
 * A durable, DB-backed execution engine: `enqueueRun` puts work on the queue, the executor (or `executeRun`
 * inline) drives a run from its checkpoint through the blueprint's components, pausing for approvals and
 * surviving restarts. Everything here is org-scoped and every executor write to a Run is fenced by its lease.
 */

export { enqueueRun, claimNextRun, recoverStaleRuns, retryRun } from "./queue";
export { executeRun } from "./run";
export { transitionRun } from "./transitions";
export { cancelRun, cancelWorkerRuns } from "./cancel";
export { decideApproval } from "./approvals";
export { tickScheduler } from "./scheduler";
export { startExecutor, stopExecutor } from "./executor";

// Pure helpers the demo seed replays runs with, so seeded history uses the engine's own prompts, clipping,
// titles, report builder and error text instead of re-implementing (and drifting from) them.
export { compact, oneLine } from "./compact";
export { deliverableSummary, narrativeSummary, renderTitle } from "./deliverable";
export { DECLINED_MESSAGE } from "./approvals";
export { runDeterministic, type ReportMeta } from "./deterministic";
export { buildInitialMessage, buildSystemPrompt, repairPrompt } from "./messages";
// How a json-output agent's final answer becomes its output (scripts/bench-cost.ts replays answers the same way).
export { parseJsonAnswer, type ParsedJson } from "./json";

export * from "./types";
