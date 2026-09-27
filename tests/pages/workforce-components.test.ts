import { readFile } from "node:fs/promises";
import { createElement as h, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeAll, describe, expect, it } from "vitest";
import { EXAMPLE_JOBS, exampleJobById, ScopeJobInputSchema } from "@/app/(app)/hire/schema";
import type { AttentionItem, WorkerCardView } from "@/server/queries/workforce";
import { loadForSsr } from "./_ssr";

type HireFirst = typeof import("@/app/(app)/workforce/_components/hire-first");
type NeedsYou = typeof import("@/app/(app)/workforce/_components/needs-you");
type WorkerCard = typeof import("@/app/(app)/workforce/_components/worker-card");

/**
 * The Workforce page's pieces, rendered the way Next renders them on the server: no router, no DOM, no
 * hydration. The page itself needs a session and the database, so it is held to its source. The client leaves
 * (Run now, Approve/Decline) only call their actions from event handlers, so inert stubs stand in for them.
 */

const inert = async () => ({ ok: true as const, data: {} });
const stubs = {
  "next/navigation": {
    useRouter: () => ({ push() {}, replace() {}, refresh() {} }),
    usePathname: () => "/workforce",
    useSearchParams: () => new URLSearchParams(),
  },
  "src/app/(app)/workforce/actions": { startRunAction: inert },
  "src/app/(app)/approvals/actions": { decideApprovalAction: inert },
};

let hireFirst: HireFirst;
let needsYou: NeedsYou;
let workerCard: WorkerCard;

beforeAll(async () => {
  const dir = "src/app/(app)/workforce/_components";
  [hireFirst, needsYou, workerCard] = await Promise.all([
    loadForSsr<HireFirst>(`${dir}/hire-first.tsx`, stubs),
    loadForSsr<NeedsYou>(`${dir}/needs-you.tsx`, stubs),
    loadForSsr<WorkerCard>(`${dir}/worker-card.tsx`, stubs),
  ]);
});

const root = new URL("../../", import.meta.url);
const render = (element: ReactElement) => renderToStaticMarkup(element);
const hrefs = (html: string) => [...html.matchAll(/href="([^"]*)"/g)].map((m) => m[1]!.replace(/&amp;/g, "&"));

describe("workforce › first-run hero (design-core-004)", () => {
  it("links every example pill to a brief that /hire can actually prefill", () => {
    const html = render(h(hireFirst.HireFirst, { canHire: true }));
    const pills = hrefs(html).filter((href) => href.startsWith("/hire?prefill="));
    expect(pills).toHaveLength(EXAMPLE_JOBS.length);
    for (const href of pills) {
      // /hire resolves the param with exampleJobById, which only knows ids — a sentence here lands on a blank form.
      const prefill = new URL(href, "http://localhost").searchParams.get("prefill");
      const job = exampleJobById(prefill ?? undefined);
      expect(job, `${href} resolves to an example job`).not.toBeNull();
      expect(ScopeJobInputSchema.safeParse(job?.description).success).toBe(true);
    }
  });

  it("offers the same three briefs as the Describe step, by label", () => {
    const html = render(h(hireFirst.HireFirst, { canHire: true }));
    for (const job of EXAMPLE_JOBS) expect(html).toContain(`>${job.label}<`);
  });

  it("keeps an id intact through the query string", () => {
    for (const job of EXAMPLE_JOBS) {
      expect(new URL(hireFirst.hireExampleHref(job), "http://localhost").searchParams.get("prefill")).toBe(job.id);
    }
  });

  it("shows no pills to someone who can't hire", () => {
    const html = render(h(hireFirst.HireFirst, { canHire: false }));
    expect(hrefs(html).some((href) => href.startsWith("/hire"))).toBe(false);
    expect(html).toContain("Ask a workspace admin");
  });
});

const sam = { workerId: "wrk_sam", workerName: "Sam", avatarColor: "sky" };
const LONG_ERROR = "The web search tool returned no results for the last three queries, so the report could not be assembled";
const LONG_FEEDBACK = "Please tighten the executive summary to five bullets and cite a source for every funding round you list";

const attention: AttentionItem[] = [
  { ...sam, kind: "health", workerTitle: "Market analyst", reason: "Quality score 54 is below the 65 threshold.", score: 54 },
  { ...sam, kind: "run_failed", runId: "run_1", error: LONG_ERROR, at: "2026-09-21T09:00:00.000Z" },
  {
    ...sam,
    kind: "deliverable_rejected",
    deliverableId: "dlv_1",
    title: "AI Infra Market Map — 2026-09-19",
    feedback: LONG_FEEDBACK,
    at: "2026-09-21T10:00:00.000Z",
  },
];

/** The class list of every `<p>` that carries a row's meta line. */
const metaLines = (html: string) => [...html.matchAll(/<p class="([^"]*text-footnote[^"]*)">/g)].map((m) => m[1]!);

describe("workforce › needs-you rows keep their separators on one line (design-core-011)", () => {
  it("renders each meta line as a single clipped line, never a wrapping flex row with a line-clamped excerpt", () => {
    const html = render(h(needsYou.NeedsYou, { items: attention }));
    const lines = metaLines(html);
    expect(lines).toHaveLength(attention.length);
    for (const classes of lines) {
      expect(classes).toContain("truncate");
      expect(classes).not.toContain("flex");
    }
    expect(html).not.toContain("line-clamp");
  });

  it("keeps the whole excerpt reachable on hover once it is clipped", () => {
    const html = render(h(needsYou.NeedsYou, { items: attention }));
    expect(html).toContain(`title="${LONG_ERROR}"`);
    expect(html).toContain(`title="${LONG_FEEDBACK}"`);
    expect(html).toContain('title="Quality score 54 is below the 65 threshold."');
  });
});

describe("workforce › a sent-back deliverable is told from the worker's side (design-core-013)", () => {
  const rejected = attention.filter((item) => item.kind === "deliverable_rejected");

  it("says what is still open, not what the reviewer already did", () => {
    const html = render(h(needsYou.NeedsYou, { items: rejected }));
    expect(html).toContain("Sam still owes you a better “AI Infra Market Map — 2026-09-19”");
    expect(html).not.toContain("You sent “");
    expect(html).toContain("You sent it back");
  });

  it("points at the feedback rather than a bare Open", () => {
    const html = render(h(needsYou.NeedsYou, { items: rejected }));
    expect(html).toMatch(/href="\/deliverables\/dlv_1"[^>]*>See feedback</);
    expect(html).not.toMatch(/>Open</);
  });
});

const samCard: WorkerCardView = {
  id: "wrk_sam",
  name: "Sam",
  title: "Market analyst",
  avatarColor: "sky",
  jobId: "job_1",
  jobTitle: "AI infra market map",
  status: "ACTIVE",
  health: "NEEDS_ATTENTION",
  healthReason: "Quality score 54 is below the 65 threshold across the last 3 runs.",
  score: 54,
  schedule: "Weekly on Friday at 9:00",
  nextRunAt: "2099-01-01T09:00:00.000Z",
  lastRun: { id: "run_9", status: "SUCCEEDED", at: "2026-09-21T09:00:00.000Z" },
  activeRun: null,
  costThisMonthUsd: 4.12,
  deliverables: 6,
  deliverablesAwaitingReview: 0,
  hiredAt: "2026-08-01T00:00:00.000Z",
};

describe("workforce › worker card status line and facts (design-core-011)", () => {
  it("keeps the health reason on the status line, clipped instead of wrapped behind a leading dot", () => {
    const html = render(h(workerCard.WorkerCard, { worker: samCard, canRun: true }));
    const status = html.match(/<p class="([^"]*)"><span data-slot="status-badge"[^>]*data-status="NEEDS_ATTENTION"/);
    expect(status, "status line wraps the badge").not.toBeNull();
    expect(status?.[1]).not.toContain("flex-wrap");
    expect(html).toMatch(/<span class="[^"]*truncate[^"]*" title="Quality score 54[^"]*">Quality score 54/);
    // The old markup glued the separator to the reason, so a wrapped line began with "· Quality…".
    expect(html).not.toContain(">· Quality");
  });

  it("reads the last run as a sentence with no separator to strand", () => {
    const html = render(h(workerCard.WorkerCard, { worker: samCard, canRun: true }));
    expect(html).toMatch(/Delivered <time/);
    expect(html).not.toContain("Delivered ·");
  });

  it("pins the footer to the bottom so a row of cards keeps its pills level", () => {
    const html = render(h(workerCard.WorkerCard, { worker: samCard, canRun: true }));
    expect(html).toMatch(/data-slot="card-footer" class="[^"]*mt-auto/);
  });
});

describe("workforce › the stat strip says Simulated nowhere (design-core-013)", () => {
  it("keeps the spend hint to the usage link; the nav and artifacts carry the Simulated marker", async () => {
    const source = await readFile(new URL("src/app/(app)/workforce/page.tsx", root), "utf8");
    expect(source).not.toContain("Simulated — priced");
    expect(source).not.toContain("spendSimulated");
    expect(source).toContain("See usage");
  });
});
