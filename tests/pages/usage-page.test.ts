import { createElement as h } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeAll, describe, expect, it } from "vitest";
import { chartDays, dayLabelStep } from "@/app/(app)/usage/_lib/chart-days";
import { spendTrend } from "@/app/(app)/usage/_lib/trend";
import type { UsageModelRow, UsageWorkerRow } from "@/server/queries/usage";
import { loadForSsr } from "./_ssr";

type Tables = typeof import("@/app/(app)/usage/_components/usage-tables");
type Tooltip = typeof import("@/components/ui/tooltip");

/**
 * The parts of /usage that turned numbers into alarms or leaked the platform's margin (design-detail-16, -23).
 * The query behind the page is covered in settings.test.ts; this is the presentation.
 */

describe("usage › the spend comparison line (design-detail-23)", () => {
  it("has nothing to compare against when the previous window was empty", () => {
    expect(spendTrend(1.97, 0)).toEqual({ kind: "none" });
    expect(spendTrend(0, 0)).toEqual({ kind: "none" });
    expect(spendTrend(1, Number.NaN)).toEqual({ kind: "none" });
  });

  it("calls a change under half a percent 'flat'", () => {
    expect(spendTrend(10, 10)).toEqual({ kind: "flat" });
    expect(spendTrend(10.04, 10)).toEqual({ kind: "flat" });
    expect(spendTrend(9.96, 10)).toEqual({ kind: "flat" });
  });

  it("gives a percentage when the previous window was a real amount and the change is modest", () => {
    expect(spendTrend(12, 10)).toEqual({ kind: "percent", direction: "up", ratio: expect.closeTo(0.2, 6) });
    expect(spendTrend(8, 10)).toEqual({ kind: "percent", direction: "down", ratio: expect.closeTo(0.2, 6) });
    // Spending nothing this time is a clean "down 100%".
    expect(spendTrend(0, 10)).toEqual({ kind: "percent", direction: "down", ratio: 1 });
    // A tripling is the last change still said as a percentage.
    expect(spendTrend(30, 10)).toEqual({ kind: "percent", direction: "up", ratio: expect.closeTo(2, 6) });
  });

  it("says the previous amount instead of '↑ 491%' when the baseline was tiny or the jump is a multiple", () => {
    // The finding's case: a brand-new workspace whose first week is compared with a few cents.
    expect(spendTrend(1.97, 0.333)).toEqual({ kind: "amount", direction: "up", previousUsd: 0.333 });
    expect(spendTrend(30.01, 10)).toEqual({ kind: "amount", direction: "up", previousUsd: 10 });
    // Below a cent the baseline is a rounding error, whichever way it moved.
    expect(spendTrend(0.05, 0.005)).toEqual({ kind: "amount", direction: "up", previousUsd: 0.005 });
    expect(spendTrend(0.001, 0.005)).toEqual({ kind: "amount", direction: "down", previousUsd: 0.005 });
  });
});

describe("usage › by worker (design-detail-16, design-detail-23)", () => {
  const rows: UsageWorkerRow[] = [
    { workerId: "worker_1", workerName: "Alex", avatarColor: "blue", href: "/workers/worker_1", costUsd: 1.5, billableUsd: 2.1, runs: 3, costPerRunUsd: 0.5 },
    { workerId: null, workerName: "Platform (scoping, reviews, chat)", avatarColor: null, href: null, costUsd: 0.47, billableUsd: 0.658, runs: 0, costPerRunUsd: null },
  ];
  let html: string;

  beforeAll(async () => {
    const [{ WorkerCostTable }, { TooltipProvider }] = await Promise.all([
      loadForSsr<Tables>("src/app/(app)/usage/_components/usage-tables.tsx"),
      loadForSsr<Tooltip>("src/components/ui/tooltip.tsx"),
    ]);
    // The app layout provides the tooltip context the Simulated badge in these tables expects.
    html = renderToStaticMarkup(h(TooltipProvider, null, h(WorkerCostTable, { rows, organizationName: "Acme Robotics" })));
  });

  it("shows cost only — the billable column and the margin never reach the customer", () => {
    expect(html).toContain("$1.50");
    expect(html).toContain("$0.47");
    expect(html).not.toMatch(/billable/i);
    expect(html).not.toContain("$2.10");
    expect(html).not.toContain("$0.66");
  });

  it("gives the platform row the workspace monogram instead of an empty circle", () => {
    expect(html).toMatch(/aria-hidden="true">AR<\/span>/);
    expect(html).not.toMatch(/aria-hidden="true"><\/span>/);
    expect(html).toContain("Platform (scoping, reviews, chat)");
    // Still no link: there is no worker to open.
    expect(html).not.toContain('href="?tab=cost"');
  });
});

describe("usage › by model names tiers, not raw ids (design-detail-14)", () => {
  const row = (model: string, provider: string, providerLabel: string, simulated: boolean): UsageModelRow => ({
    provider,
    providerLabel,
    model,
    calls: 4,
    inputTokens: 1200,
    outputTokens: 300,
    costUsd: 0.0123,
    simulated,
  });
  const render = async (rows: UsageModelRow[], routes: Array<{ tier: "fast" | "standard" | "reasoning"; model: string }>) => {
    const [{ ModelCostTable }, { TooltipProvider }] = await Promise.all([
      loadForSsr<Tables>("src/app/(app)/usage/_components/usage-tables.tsx"),
      loadForSsr<Tooltip>("src/components/ui/tooltip.tsx"),
    ]);
    return renderToStaticMarkup(h(TooltipProvider, null, h(ModelCostTable, { rows, markSimulated: false, routes })));
  };

  it("calls a simulator row by its tier and drops the mock id", async () => {
    const simulated = [
      { tier: "fast" as const, model: "mock-fast" },
      { tier: "standard" as const, model: "mock-standard" },
      { tier: "reasoning" as const, model: "mock-reasoning" },
    ];
    const html = await render([row("mock-standard", "mock", "Simulator", true), row("mock-fast", "mock", "Simulator", true)], simulated);
    expect(html).toContain("Standard model");
    expect(html).toContain("Fast model");
    expect(html).not.toContain("mock-standard");
    expect(html).not.toContain("mock-fast");
  });

  it("keeps a live model's id as the quiet detail beside its tier", async () => {
    const live = [
      { tier: "fast" as const, model: "small-1" },
      { tier: "standard" as const, model: "big-2" },
      { tier: "reasoning" as const, model: "big-2" },
    ];
    const html = await render([row("big-2", "acme", "Acme AI", false), row("retired-0", "acme", "Acme AI", false)], live);
    expect(html).toContain("Standard / Reasoning model");
    expect(html).toContain("big-2 · Acme AI");
    // An id today's routing no longer serves has no tier to borrow, so it keeps its own name.
    expect(html).toContain("retired-0");
  });
});

describe("usage › the day-by-day chart's props (design-detail-16)", () => {
  // Client-component props are serialized into the page payload, so anything passed through is readable in the
  // browser even when nothing renders it.
  const byDay = [
    { date: "2026-09-26", costUsd: 0.5, billableUsd: 0.7, modelCostUsd: 0.4, toolCostUsd: 0.1 },
    { date: "2026-09-27", costUsd: 0, billableUsd: 0, modelCostUsd: 0, toolCostUsd: 0 },
  ];

  it("hands the client only what the chart draws, so the billable figure and the margin never leave the server", () => {
    const days = chartDays(byDay);
    expect(days).toEqual([
      { date: "2026-09-26", modelCostUsd: 0.4, toolCostUsd: 0.1 },
      { date: "2026-09-27", modelCostUsd: 0, toolCostUsd: 0 },
    ]);
    expect(JSON.stringify(days)).not.toMatch(/billable/i);
  });
});

describe("usage › day labels fit the chart", () => {
  it("keeps the desktop cadence — at most eight labels — on a wide plot and before the first measure", () => {
    expect(dayLabelStep(7, 1056)).toBe(1);
    expect(dayLabelStep(30, 1056)).toBe(4);
    expect(dayLabelStep(90, 1056)).toBe(12);
    expect(dayLabelStep(30, 0)).toBe(4);
    expect(dayLabelStep(30, -40)).toBe(4);
  });

  it("labels fewer days on a phone so 'Sep 21Sep 22…' never runs together", () => {
    // A 390px screen leaves about 270px of plot inside the card.
    expect(dayLabelStep(7, 270)).toBe(2);
    expect(dayLabelStep(30, 270)).toBe(8);
    expect(dayLabelStep(90, 270)).toBe(23);
    // However narrow, one label still shows.
    expect(dayLabelStep(7, 10)).toBe(7);
    expect(dayLabelStep(0, 270)).toBe(1);
  });
});
