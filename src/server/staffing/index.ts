/**
 * Staffing Engine public surface (contract: docs/CONTRACTS.md § staffing, types: ./types.ts).
 * Scoping → spec lifecycle → worker design → hire. Everything DB-backed is org-scoped through the session.
 */
export { scopeJob, buildJobSpec } from "./scoping";
export { updateJobSpec, approveJobSpec, reviseJobSpec, discardJob } from "./spec-lifecycle";
export { getHireFlowState } from "./flow-state";
export { proposeWorker } from "./propose";
export { hireWorker } from "./hire";
export { assertHeadcount } from "./headcount";
export { designBlueprint, reportTableColumns } from "./design";
export { estimateCost } from "./cost";
export { ALL_AGENT_BASELINE_DEFAULT_TIER, BASELINE_SHAPES, convertDeterministicToAgents, convertedSteps } from "./all-agent-baseline";
export type { AllAgentBaselineOptions, BaselineShape, ConvertedStep } from "./all-agent-baseline";
export { deriveKpis, deriveEvaluationPlan } from "./kpis";
export { draftFromTemplate } from "./templates";
export type { HireFlowState, HireStep } from "./types";
