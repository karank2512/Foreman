import type { ModelTier } from "@/server/domain";
import { TIER_LABELS } from "./versions-labels";

/** Model ids the built-in simulator reports, one per tier ("mock-standard"). */
const SIMULATOR_MODEL = /^mock-(fast|standard|reasoning)$/;

export interface ModelRowLabel {
  /** "Standard model", or the id itself when it no longer maps to a tier. */
  title: string;
  /** The live model id as a secondary line ("claude-sonnet-5"); null for the simulator, whose ids mean nothing. */
  detail: string | null;
}

/**
 * Names a usage-ledger model row by its tier. The ledger stores only the model id, so live ids are matched
 * against today's tier routing; one model serving two tiers reads "Standard / Reasoning model". Pure.
 */
export function modelRowLabel(modelId: string, routes: ReadonlyArray<{ tier: ModelTier; model: string }>): ModelRowLabel {
  const simulated = SIMULATOR_MODEL.exec(modelId);
  if (simulated) return { title: `${TIER_LABELS[simulated[1] as ModelTier]} model`, detail: null };

  const tiers = routes.filter((r) => r.model === modelId).map((r) => TIER_LABELS[r.tier]);
  if (tiers.length === 0) return { title: modelId, detail: null };
  return { title: `${tiers.join(" / ")} model`, detail: modelId };
}
