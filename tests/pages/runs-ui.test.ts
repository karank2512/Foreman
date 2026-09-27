import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { createElement as h, isValidElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { ledeFor, plainText } from "@/app/(app)/deliverables/[deliverableId]/_components/lede";
import { isUnstaffed, openSeatLine, specDescription } from "@/app/(app)/jobs/[jobId]/_components/job-layout";
import {
  approveConfirmLabel,
  heldBackToolStepIds,
  recipientsOf,
  runHeading,
} from "@/app/(app)/runs/[runId]/_components/step-meta";
import type { ActivityItem } from "@/server/activity";
import { loadForSsr } from "./_ssr";

type ApprovalModule = typeof import("@/app/(app)/runs/[runId]/_components/approval-decision");
type FindingsModule = typeof import("@/app/(app)/runs/_components/evaluation-findings");
type LiveHeaderModule = typeof import("@/app/(app)/runs/[runId]/_components/live-header");
type JobActivityModule = typeof import("@/app/(app)/jobs/[jobId]/_components/job-activity");

/**
 * /runs, /deliverables and /jobs detail pages: the run-page approval safeguard, the phone-width layout rules and
 * the state-dependent copy. Pages need a session and the database, so their layout rules are held to source;
 * the client pieces are server-rendered with inert stubs (see ./_ssr).
 */

const root = new URL("../../", import.meta.url);
const source = (path: string) => readFile(new URL(path, root), "utf8");
// The same CommonJS copy the bundled components require, so the provider and the tooltips share one context.
const { TooltipProvider } = createRequire(new URL("package.json", root))("@radix-ui/react-tooltip") as {
  TooltipProvider: (props: { children?: ReactNode }) => ReactElement;
};
const render = (element: ReactElement) => renderToStaticMarkup(h(TooltipProvider, null, element));

// ── Approval on the run page (content-injection-run-page-one-click-approve) ──────────────────────────────────

interface RecordedDialog {
  title: string;
  confirmLabel: string;
  destructive?: boolean;
  trigger: ReactNode;
  description: ReactNode;
  onConfirm: () => Promise<void>;
}

const dialogs: RecordedDialog[] = [];
const decisions: unknown[][] = [];
let refreshes = 0;

const approvalStubs = {
  // Stand-in that records what each confirmation would ask, and renders only its trigger — like the real one
  // while closed. The real ConfirmDialog is what runs `onConfirm`, and only from its own confirm button.
  "src/components/confirm-dialog": {
    ConfirmDialog: (props: RecordedDialog) => {
      dialogs.push(props);
      return props.trigger;
    },
  },
  "src/app/(app)/runs/[runId]/actions": {
    decideApprovalAction: async (...args: unknown[]) => {
      decisions.push(args);
      return { ok: true as const, data: undefined };
    },
  },
  "src/app/(app)/runs/[runId]/_components/run-live": {
    useRunLive: () => ({ refresh: () => void refreshes++, polling: false, live: null }),
  },
  sonner: { toast: { success() {}, error() {} } },
};

let approvalMod: ApprovalModule;
let findingsMod: FindingsModule;
let liveHeaderMod: LiveHeaderModule;
let jobActivityMod: JobActivityModule;

beforeAll(async () => {
  [approvalMod, findingsMod, liveHeaderMod, jobActivityMod] = await Promise.all([
    loadForSsr<ApprovalModule>("src/app/(app)/runs/[runId]/_components/approval-decision.tsx", approvalStubs),
    loadForSsr<FindingsModule>("src/app/(app)/runs/_components/evaluation-findings.tsx"),
    loadForSsr<LiveHeaderModule>("src/app/(app)/runs/[runId]/_components/live-header.tsx", {
      "src/app/(app)/runs/[runId]/_components/run-live": { useRunLive: () => ({}) },
    }),
    loadForSsr<JobActivityModule>("src/app/(app)/jobs/[jobId]/_components/job-activity.tsx"),
  ]);
});

const injected = {
  id: "apr_1",
  title: "Send “Weekly digest” to 6 recipients by email",
  description: "The weekly digest, ready to go out.",
  toolName: "send_notification",
  payload: {
    body: "# Weekly digest\n\n## Summary\n\nThis week **12 rounds** were announced across the market, led by compute and inference.",
    channel: "email",
    subject: "Weekly digest",
    recipients: ["a@acme.example", "b@acme.example", "c@acme.example", "d@acme.example", "product@acme.example", "attacker@evil.example"],
  },
};

function renderApproval(canDecide = true) {
  return render(
    h(approvalMod.ApprovalDecision, { runId: "run_1", workerId: "wrk_1", workerName: "Maya", approval: injected, canDecide }),
  );
}

function triggerOf(dialog: RecordedDialog): ReactElement<{ onClick?: unknown; children?: ReactNode }> {
  if (!isValidElement(dialog.trigger)) throw new Error("trigger is not an element");
  return dialog.trigger as ReactElement<{ onClick?: unknown; children?: ReactNode }>;
}

describe("run page › approving a request needs a confirmation (content-injection-run-page-one-click-approve)", () => {
  beforeEach(() => {
    dialogs.length = 0;
    decisions.length = 0;
    refreshes = 0;
  });

  it("puts Approve and Decline behind confirmations; neither button can commit on its own", () => {
    const html = renderApproval();
    expect(html).toContain(">Approve<");
    expect(html).toContain(">Decline<");
    expect(decisions).toHaveLength(0);

    const approve = dialogs.find((d) => d.title === "Let Maya go ahead?");
    const decline = dialogs.find((d) => d.title === "Tell Maya not to do this?");
    expect(approve).toBeDefined();
    expect(decline?.destructive).toBe(true);
    // The pill only opens the dialog: no click handler of its own that could reach the server action.
    for (const dialog of [approve!, decline!]) expect(triggerOf(dialog).props.onClick).toBeUndefined();
  });

  it("names the consequence and every recipient in the approve confirmation — including one injected into the list", () => {
    renderApproval();
    const approve = dialogs.find((d) => d.title === "Let Maya go ahead?")!;
    expect(approve.confirmLabel).toBe("Send to 6 recipients");
    const body = render(h("div", null, approve.description));
    for (const address of injected.payload.recipients) expect(body).toContain(address);
    expect(body).toContain("All 6 recipients");
  });

  it("commits only through the dialog's confirm, with the run, request, decision and worker", async () => {
    renderApproval();
    expect(decisions).toHaveLength(0);
    await dialogs.find((d) => d.title === "Let Maya go ahead?")!.onConfirm();
    expect(decisions).toEqual([["run_1", "apr_1", "approve", "", "wrk_1"]]);
    expect(refreshes).toBe(1);
  });

  it("keeps the dialog open (throws) and re-syncs when the server refuses", async () => {
    const refusing = await loadForSsr<ApprovalModule>("src/app/(app)/runs/[runId]/_components/approval-decision.tsx", {
      ...approvalStubs,
      "src/app/(app)/runs/[runId]/actions": {
        decideApprovalAction: async () => ({ ok: false as const, error: "This request has expired." }),
      },
    });
    render(h(refusing.ApprovalDecision, { runId: "run_1", workerId: "wrk_1", workerName: "Maya", approval: injected }));
    await expect(dialogs.find((d) => d.title === "Let Maya go ahead?")!.onConfirm()).rejects.toThrow("This request has expired.");
    expect(refreshes).toBe(1);
  });

  it("previews the message as text, not raw markdown (the exact JSON stays one click away)", () => {
    const html = renderApproval();
    const preview = html.slice(0, html.indexOf("Everything that will be sent"));
    expect(preview).toContain("12 rounds were announced");
    expect(preview).not.toContain("# Weekly digest");
    expect(preview).not.toContain("**12 rounds**");
    expect(html).toContain("Everything that will be sent");
  });

  it("offers no decision to a role that can't make one", () => {
    const html = renderApproval(false);
    expect(dialogs).toHaveLength(0);
    expect(html).toContain("Your role can’t decide this one");
  });

  it("labels the confirm by what happens", () => {
    expect(approveConfirmLabel({ recipients: ["one@acme.example"] })).toBe("Send to 1 recipient");
    expect(approveConfirmLabel({ query: "funding" })).toBe("Approve");
    expect(recipientsOf({ recipients: ["a@x.test", "", 3, "b@x.test"] })).toEqual(["a@x.test", "b@x.test"]);
    expect(recipientsOf(null)).toEqual([]);
  });
});

// ── Timeline: one row per waiting send (design-detail-09) ─────────────────────────────────────────────────────

describe("run page › a send waiting on you is one timeline row (design-detail-09)", () => {
  const step = (id: string, kind: "TOOL_CALL" | "APPROVAL" | "MODEL_CALL", status: "PENDING" | "WAITING" | "SUCCEEDED", componentId = "notifier") => ({
    id,
    kind,
    status,
    componentId,
  });

  it("hides the pending tool step linked to the waiting approval", () => {
    const steps = [step("m", "MODEL_CALL", "SUCCEEDED"), step("t", "TOOL_CALL", "PENDING"), step("a", "APPROVAL", "WAITING")];
    const details = { t: { input: {}, toolCalls: [{ id: "tc_1" }] }, a: { input: { approvalId: "apr", toolCallId: "tc_1" }, toolCalls: [] } };
    expect([...heldBackToolStepIds(steps, details)]).toEqual(["t"]);
  });

  it("falls back to the pending tool step right above the approval before details load", () => {
    const steps = [step("t", "TOOL_CALL", "PENDING"), step("a", "APPROVAL", "WAITING")];
    expect([...heldBackToolStepIds(steps, {})]).toEqual(["t"]);
  });

  it("keeps both rows once the request is decided, and keeps unrelated tool steps", () => {
    const decided = [step("t", "TOOL_CALL", "SUCCEEDED"), step("a", "APPROVAL", "SUCCEEDED")];
    expect(heldBackToolStepIds(decided, {}).size).toBe(0);
    const otherComponent = [step("t", "TOOL_CALL", "PENDING", "researcher"), step("a", "APPROVAL", "WAITING", "notifier")];
    expect(heldBackToolStepIds(otherComponent, {}).size).toBe(0);
  });
});

// ── Run header (design-detail-20) ─────────────────────────────────────────────────────────────────────────────

describe("run page › header names the run, not the job (design-detail-20)", () => {
  it("titles the run by when it happened", () => {
    const heading = runHeading("2026-09-21T09:00:00.000Z", "2026-09-21T08:59:00.000Z");
    expect(heading).toMatch(/^Run on Sep 2[01], \d{1,2}:\d{2} [AP]M$/);
    expect(runHeading(null, "2026-09-22T10:00:00.000Z")).toMatch(/^Run on Sep 2[12], /);
    expect(runHeading(null, "not a date")).toBe("Run");
  });

  it("only counts time up while the run is actually working", () => {
    expect(liveHeaderMod.activeTime({ status: "RUNNING", durationMs: 12_300 })).toMatch(/so far$/);
    expect(liveHeaderMod.activeTime({ status: "WAITING_FOR_APPROVAL", durationMs: 49_500 })).toMatch(/of work$/);
    expect(liveHeaderMod.activeTime({ status: "WAITING_FOR_APPROVAL", durationMs: 49_500 })).not.toMatch(/so far/);
    expect(liveHeaderMod.activeTime({ status: "QUEUED", durationMs: null })).toBeNull();
    expect(liveHeaderMod.activeTime({ status: "SUCCEEDED", durationMs: 4_200 })).not.toMatch(/so far|of work/);
  });

  it("uses the heading for the document title and the local nav", async () => {
    const page = await source("src/app/(app)/runs/[runId]/page.tsx");
    expect(page).toContain("export async function generateMetadata");
    expect(page).toContain("title={heading}");
    expect(page).not.toContain("title={job.title}");
  });
});

// ── Evaluation card (design-detail-04, design-detail-20) ─────────────────────────────────────────────────────

describe("evaluation findings (design-detail-04, design-detail-20)", () => {
  const longDetail =
    "expected at least 90% of required fields filled (company, category, stage, amount_usd, source_url)";
  const evaluations = [
    {
      id: "e1",
      type: "DETERMINISTIC" as const,
      score: 1,
      passed: true,
      summary: null,
      createdAt: "2026-09-21T09:01:00.000Z",
      details: {
        kind: "deterministic" as const,
        checks: [{ id: "c1", description: "Required fields are filled", passed: true, score: 1, weight: 1, observed: "100% filled (60 of 60 cells)", expected: longDetail }],
      },
    },
    {
      id: "e2",
      type: "LLM_JUDGE" as const,
      score: 0.96,
      passed: true,
      summary: null,
      createdAt: "2026-09-21T09:01:00.000Z",
      details: {
        kind: "llm_judge" as const,
        model: "mock-standard",
        simulated: true,
        overallReasoning: "Strong work.",
        criteria: [
          { id: "a", criterion: "Coverage", score: 0.97, weight: 1, reasoning: "Covers it." },
          { id: "b", criterion: "Accuracy", score: 0.96, weight: 2, reasoning: "Accurate." },
          { id: "c", criterion: "Insight", score: 0.95, weight: 1, reasoning: "Useful." },
        ],
      },
    },
  ];

  it("shows the headline as the same whole number the section intro uses", () => {
    const html = render(h(findingsMod.EvaluationFindings, { evaluations: evaluations as never, workerName: "Alex", score: 97.6 }));
    expect(html).toContain(">98<");
    expect(html).not.toContain("97.6");
    expect(findingsMod.headlineScore(null, [{ score: 0.5 }, { score: 1 }])).toBe(75);
  });

  it("states relative weight as a share of the rubric, never 'weight 200%'", () => {
    const html = render(h(findingsMod.EvaluationFindings, { evaluations: evaluations as never, workerName: "Alex" }));
    expect(html).not.toMatch(/weight \d+%/);
    expect(html).toContain("counts for 50%");
    expect(html).toContain("counts for 25%");
    expect(findingsMod.criterionShare(1, [1, 1, 1])).toBeNull();
  });

  it("stacks a check's measurement under its sentence instead of beside it", () => {
    const html = render(h(findingsMod.EvaluationFindings, { evaluations: evaluations as never, workerName: "Alex" }));
    const row = html.slice(html.indexOf("Required fields are filled"), html.indexOf(longDetail) + longDetail.length);
    expect(row).not.toContain("shrink-0");
    expect(html).toMatch(/<span class="block[^"]*">Required fields are filled<\/span><span class="[^"]*block[^"]*break-words/);
  });
});

// ── Phone-width overflow (design-core-003, design-detail-01, design-detail-03) ───────────────────────────────

describe("detail pages keep their columns to the screen at phone width", () => {
  // A grid item's default min-width:auto lets its widest table or line widen the whole mobile layout viewport.
  it.each([
    ["src/app/(app)/jobs/[jobId]/page.tsx", "design-core-003"],
    ["src/app/(app)/deliverables/[deliverableId]/page.tsx", "design-detail-01"],
    ["src/app/(app)/runs/[runId]/page.tsx", "design-detail-03"],
  ])("%s (%s): the main column and the aside are min-w-0", async (path) => {
    const page = await source(path);
    const columns = [...page.matchAll(/className=(?:"|\{`)([^"`]*lg:col-span-(?:8|4)[^"`]*)/g)].map((m) => m[1]!);
    expect(columns.length).toBeGreaterThanOrEqual(2);
    for (const cls of columns) expect(cls.split(/\s+/), cls).toContain("min-w-0");
  });

  it("the run page's facts card comes before the debug trace when stacked (design-detail-03)", async () => {
    const page = await source("src/app/(app)/runs/[runId]/page.tsx");
    expect(page.indexOf("<aside")).toBeLessThan(page.indexOf("<DebugTrace"));
  });
});

// ── Deliverable reading view (design-detail-18) ───────────────────────────────────────────────────────────────

describe("deliverable reading view (design-detail-18)", () => {
  const content =
    "# Weekly AI Infra Funding Report\n\n## Summary\n\n12 funding rounds were reviewed for Weekly AI Infra Funding Report; here is what stands out.\n\n### Headline numbers\n- **12 funding rounds** across **10 category values**.";

  it("drops a clipped lede that only repeats the report's opening", () => {
    const summary = "12 funding rounds were reviewed for Weekly AI Infra Funding Report; here is what stands out. 12 funding rounds across 10 category values; the…";
    expect(ledeFor(summary, content, "MARKDOWN")).toBeNull();
  });

  it("keeps a lede that says something the report doesn't, and every lede on data deliverables", () => {
    expect(ledeFor("A different framing of the week that the report never states in these words.", content, "MARKDOWN")).not.toBeNull();
    expect(ledeFor("12 funding rounds were reviewed for Weekly AI Infra Funding Report", content, "CSV")).not.toBeNull();
    expect(ledeFor(null, content, "MARKDOWN")).toBeNull();
    expect(plainText("1. **Bold** and [a link](https://x.test)")).toBe("bold and a link");
  });

  it("is a white page with no raw id row, and the run link has a name", async () => {
    const page = await source("src/app/(app)/deliverables/[deliverableId]/page.tsx");
    expect(page).toContain("data-reading-view");
    expect(page).not.toContain('label="Id"');
    expect(page).toMatch(/aria-label=\{`See the run/);
  });
});

// ── Job detail (design-core-005, design-core-010) ─────────────────────────────────────────────────────────────

describe("job detail before anyone is hired (design-core-005)", () => {
  it("collapses to the spec and one line only while nobody was hired and nothing ran", () => {
    expect(isUnstaffed({ workers: [], stats: { runs: 0, succeeded: 0, failed: 0, deliverables: 0, accepted: 0, totalCostUsd: 0 } })).toBe(true);
    expect(isUnstaffed({ workers: [{} as never], stats: { runs: 0, succeeded: 0, failed: 0, deliverables: 0, accepted: 0, totalCostUsd: 0 } })).toBe(false);
  });

  it("describes the spec truthfully for its state", () => {
    expect(specDescription(false, false)).not.toContain("approved.");
    expect(specDescription(true, false)).toContain("not approved yet");
    expect(specDescription(true, true)).toBe("What you asked for, as scoped and approved.");
    expect(openSeatLine("DRAFT")).toContain("Finish setting it up");
    expect(openSeatLine("SPEC_APPROVED")).toContain("The seat is open");
  });

  it("has no hire button inside the empty spec card, and the desktop hire pill is gray (the nav's Hire is the primary)", async () => {
    const page = await source("src/app/(app)/jobs/[jobId]/page.tsx");
    expect(page).not.toContain("Continue setup</Link>");
    expect(page).toMatch(/unstaffed \?/);
    const actions = await source("src/app/(app)/jobs/[jobId]/_components/job-actions.tsx");
    const primary = actions.slice(actions.indexOf("const primary ="), actions.indexOf(") : null;", actions.indexOf("const primary =")));
    expect(primary.match(/<Button variant="secondary" asChild>/g)).toHaveLength(2);
  });
});

describe("job detail › recent activity (design-core-010)", () => {
  const item = (i: number): ActivityItem => ({
    id: `act_${i}`,
    type: "RUN_SUCCEEDED",
    title: `Alex finished run ${i}`,
    detail: null,
    actorType: "WORKER",
    actorName: "Alex",
    workerId: "wrk_1",
    jobId: "job_1",
    runId: `run_${i}`,
    worker: { id: "wrk_1", name: "Alex", avatarColor: "amber" },
    metadata: {} as ActivityItem["metadata"],
    createdAt: "2026-09-21T09:00:00.000Z",
    href: `/runs/run_${i}`,
  });

  it("caps the card with a View all link filtered to the worker on the seat", () => {
    const html = render(h(jobActivityMod.JobActivity, { items: Array.from({ length: 30 }, (_, i) => item(i)), workerId: "wrk_1" }));
    expect(html.match(/Alex finished run \d+/g)).toHaveLength(jobActivityMod.JOB_ACTIVITY_ROWS);
    expect(jobActivityMod.JOB_ACTIVITY_ROWS).toBeLessThanOrEqual(6);
    expect(html).toContain('href="/activity?worker=wrk_1"');
    expect(html).toContain("View all");
  });

  it("renders titles as plain sentences, not links inside a paragraph (which the app styles blue)", () => {
    const html = render(h(jobActivityMod.JobActivity, { items: [item(1)], workerId: null }));
    expect(html).not.toMatch(/<p[^>]*>(?:(?!<\/p>).)*<a /);
    expect(html).not.toContain("View all");
  });
});
