import { endOfDay, startOfDay, subDays } from "date-fns";
import { config } from "@/server/config";
import { db } from "@/server/db";
import { titleCase } from "@/lib/format";
import { isOrgSimulated, llm } from "@/server/models";
import { tools } from "@/server/tools";
import { getUsageSummary, type UsageSummary } from "@/server/usage";

/** Range picker options for /usage (`?range=7|30|90`). */
export const USAGE_RANGES = [7, 30, 90] as const;
export type UsageRangeDays = (typeof USAGE_RANGES)[number];
export const DEFAULT_USAGE_RANGE: UsageRangeDays = 30;

/** Tolerant parse of the `?range=` search param; anything unexpected falls back to the default. */
export function parseUsageRange(raw: string | string[] | undefined): UsageRangeDays {
  const value = Array.isArray(raw) ? raw[0] : raw;
  const n = Number(value);
  return (USAGE_RANGES as readonly number[]).includes(n) ? (n as UsageRangeDays) : DEFAULT_USAGE_RANGE;
}

export interface UsageWorkerRow {
  workerId: string | null;
  workerName: string;
  avatarColor: string | null;
  /** `/workers/<id>` when the worker still exists; null for platform usage and removed workers. */
  href: string | null;
  costUsd: number;
  billableUsd: number;
  runs: number;
  costPerRunUsd: number | null;
}

export interface UsageModelRow {
  provider: string;
  providerLabel: string;
  model: string;
  calls: number;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  simulated: boolean;
}

export interface UsageToolRow {
  toolName: string;
  displayName: string;
  calls: number;
  costUsd: number;
  costPerCallUsd: number | null;
}

export interface UsagePageData {
  days: UsageRangeDays;
  from: string;
  to: string;
  /** No live model provider configured — every model call in this window ran on the simulator. */
  simulatedMode: boolean;
  /** billable = cost × marginMultiplier (config.usage.marginMultiplier). */
  marginMultiplier: number;
  hasUsage: boolean;
  totals: UsageSummary["totals"] & {
    modelCostUsd: number;
    toolCostUsd: number;
    /** simulatedCostUsd ÷ costUsd, null when there is no spend. */
    simulatedShare: number | null;
    runs: number;
  };
  byDay: UsageSummary["byDay"];
  byWorker: UsageWorkerRow[];
  byModel: UsageModelRow[];
  byTool: UsageToolRow[];
}

/**
 * Everything /usage renders for one range. The ledger aggregation lives in `usage.getUsageSummary`; this layer
 * only adds what the page needs on top: links, human labels, per-call reference prices and the billing config.
 */
export async function getUsagePage(organizationId: string, days: UsageRangeDays, now: Date = new Date()): Promise<UsagePageData> {
  const from = startOfDay(subDays(now, days - 1));
  const to = endOfDay(now);
  const summary = await getUsageSummary(organizationId, { from, to });

  // UsageRecord.workerId has no FK: confirm the worker still exists before linking to its profile.
  const workerIds = summary.byWorker.map((w) => w.workerId).filter((id): id is string => id !== null);
  const existing = workerIds.length
    ? await db.worker.findMany({ where: { organizationId, id: { in: workerIds } }, select: { id: true } })
    : [];
  const existingIds = new Set(existing.map((w) => w.id));

  const providerLabels = new Map(llm.status().providers.map((p) => [p.id as string, p.label]));
  const modelCostUsd = summary.byModel.reduce((sum, m) => sum + m.costUsd, 0);
  const toolCostUsd = summary.byTool.reduce((sum, t) => sum + t.costUsd, 0);
  const runs = summary.byWorker.reduce((sum, w) => sum + w.runs, 0);
  const { totals } = summary;

  return {
    days,
    from: summary.from,
    to: summary.to,
    simulatedMode: await isOrgSimulated(organizationId),
    marginMultiplier: config.usage.marginMultiplier,
    hasUsage: totals.modelCalls + totals.toolCalls > 0,
    totals: {
      ...totals,
      modelCostUsd,
      toolCostUsd,
      simulatedShare: totals.costUsd > 0 ? Math.min(1, totals.simulatedCostUsd / totals.costUsd) : null,
      runs,
    },
    byDay: summary.byDay,
    byWorker: summary.byWorker.map((w) => ({
      ...w,
      href: w.workerId !== null && existingIds.has(w.workerId) ? `/workers/${w.workerId}` : null,
      costPerRunUsd: w.runs > 0 ? w.costUsd / w.runs : null,
    })),
    byModel: summary.byModel.map((m) => ({
      ...m,
      providerLabel: providerLabels.get(m.provider) ?? titleCase(m.provider),
    })),
    byTool: summary.byTool.map((t) => {
      const tool = tools.get(t.toolName);
      return {
        ...t,
        displayName: tool?.displayName ?? titleCase(t.toolName),
        costPerCallUsd: tool ? tool.costPerCallUsd : t.calls > 0 ? t.costUsd / t.calls : null,
      };
    }),
  };
}
