import { createElement as h } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeAll, describe, expect, it } from "vitest";
import { spendTrend } from "@/app/(app)/usage/_lib/trend";
import type { UsageWorkerRow } from "@/server/queries/usage";
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
