import { createElement as h, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  attentionSentence,
  exampleTitle,
  formatLabel,
  reviewVerdict,
  timeZoneLabel,
} from "@/app/(app)/workers/[workerId]/_components/labels";
import { modelRowLabel } from "@/app/(app)/workers/[workerId]/_tabs/cost-labels";
import {
  describeStepConfig,
  describeStepSummary,
  humanizeDiffEntry,
} from "@/app/(app)/workers/[workerId]/replace/[versionId]/_components/change-copy";
import type { BlueprintDiffEntry } from "@/server/domain";
import type { DebugModelCall, DebugToolCall, ToolGrantView } from "@/server/queries/worker-manage";
import type { WorkerHeaderView } from "@/server/queries/worker-profile";
import { createTestOrg } from "../helpers/factory";
import { createHiredWorker, makeBlueprint } from "../helpers/fixtures";
import { loadForSsr } from "./_ssr";

type TabNav = typeof import("@/app/(app)/workers/[workerId]/_components/tab-nav");
type Header = typeof import("@/app/(app)/workers/[workerId]/_components/worker-header");
type Grants = typeof import("@/app/(app)/workers/[workerId]/_tabs/permissions-grants-table");
type DebugLists = typeof import("@/app/(app)/workers/[workerId]/_tabs/debug-call-lists");
type ChangeListModule = typeof import("@/app/(app)/workers/[workerId]/replace/[versionId]/_components/change-list");
type Overview = typeof import("@/app/(app)/workers/[workerId]/_tabs/overview");
type ChatMessageModule = typeof import("@/app/(app)/workers/[workerId]/_tabs/chat-message");
type Tooltip = typeof import("@/components/ui/tooltip");

/**
 * The worker profile's presentation, rendered the way Next renders it on the server (see ./_ssr). Server actions
 * and router hooks only matter from event handlers, so inert stubs stand in for them. Covers the design-QA
 * findings on /workers/[id]: the local nav, the header, the overview, permissions, debug, cost and replace pages.
 */

const inert = async () => ({ ok: true as const, data: {} });
const stubs = {
  "next/navigation": {
    useRouter: () => ({ push() {}, replace() {}, refresh() {} }),
    usePathname: () => "/workers/w_1",
    useSearchParams: () => new URLSearchParams(),
  },
  "src/app/(app)/workers/[workerId]/actions": {
    runNowAction: inert,
    pauseWorkerAction: inert,
    resumeWorkerAction: inert,
    retireWorkerAction: inert,
    generateReviewAction: inert,
  },
  "src/app/(app)/workers/[workerId]/manage-actions": { updateToolGrantAction: inert, sendMessageAction: inert },
};

const DIR = "src/app/(app)/workers/[workerId]";
let tabNav: TabNav;
let header: Header;
let grants: Grants;
let debugLists: DebugLists;
let changeList: ChangeListModule;
let chatMessage: ChatMessageModule;
let tooltip: Tooltip;

beforeAll(async () => {
  [tabNav, header, grants, debugLists, changeList, chatMessage, tooltip] = await Promise.all([
    loadForSsr<TabNav>(`${DIR}/_components/tab-nav.tsx`, stubs),
    loadForSsr<Header>(`${DIR}/_components/worker-header.tsx`, stubs),
    loadForSsr<Grants>(`${DIR}/_tabs/permissions-grants-table.tsx`, stubs),
    loadForSsr<DebugLists>(`${DIR}/_tabs/debug-call-lists.tsx`, stubs),
    loadForSsr<ChangeListModule>(`${DIR}/replace/[versionId]/_components/change-list.tsx`, stubs),
    loadForSsr<ChatMessageModule>(`${DIR}/_tabs/chat-message.tsx`, stubs),
    loadForSsr<Tooltip>("src/components/ui/tooltip.tsx"),
  ]);
});

const render = (element: ReactElement) => renderToStaticMarkup(h(tooltip.TooltipProvider, null, element));
/** Visible text, tags stripped — enough to assert on copy. */
const textOf = (html: string) =>
  html
    .replace(/<[^>]+>/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, " ")
    .trim();

describe("worker profile › local nav (design-detail-06)", () => {
  const html = () => render(h(tabNav.WorkerTabNav, { workerId: "w_1", workerName: "Alex", active: "overview" }));

  it("gives a wide screen the five everyday tabs, with Talk to Alex in them, and a More menu", () => {
    const desktop = html().split('data-slot="local-nav"')[2]!;
    const links = [...desktop.matchAll(/<a [^>]*>([^<]+)<\/a>/g)].map((m) => m[1]);
    expect(links).toEqual(["Overview", "Activity", "Deliverables", "Performance", "Talk to Alex"]);
    expect(desktop).toContain(">More<");
    expect(desktop).toMatch(/class="[^"]*max-md:hidden/);
  });

  it("keeps every tab one swipe away on a phone, everyday tabs first", () => {
    const mobile = html().split('data-slot="local-nav"')[1]!;
    const links = [...mobile.matchAll(/<a [^>]*>([^<]+)<\/a>/g)].map((m) => m[1]);
    expect(links).toEqual([
      "Overview",
      "Activity",
      "Deliverables",
      "Performance",
      "Talk to Alex",
      "Cost",
      "Permissions",
      "Versions",
      "Debug",
    ]);
    expect(mobile).toMatch(/class="[^"]*md:hidden/);
  });

  it("names the tab you are on when it lives in More", () => {
    expect(tabNav.moreLabel("cost")).toBe("Cost");
    expect(tabNav.moreLabel("debug")).toBe("Debug");
    expect(tabNav.moreLabel("chat")).toBe("More");
    const desktop = render(h(tabNav.WorkerTabNav, { workerId: "w_1", workerName: "Alex", active: "permissions" })).split(
      'data-slot="local-nav"',
    )[2]!;
    expect(desktop).toMatch(/font-semibold[^>]*>Permissions<svg/);
  });
});

function headerView(overrides: Partial<WorkerHeaderView> = {}): WorkerHeaderView {
  return {
    id: "w_1",
    name: "Maya",
    title: "AI Customer Feedback Analyst",
    avatarColor: "sky",
    status: "ACTIVE",
    health: "HEALTHY",
    healthReason: null,
    score: 98,
    scoreUpdatedAt: null,
    hiredAt: "2026-09-17T12:00:00.000Z",
    retiredAt: null,
    lastRunAt: null,
    job: { id: "job_1", title: "Customer Feedback Digest" },
    schedule: { kind: "DAILY", description: "Daily at 8am", nextRunAt: "2026-09-22T13:00:00.000Z" },
    currentVersion: { id: "v_1", version: 1, changeReason: "INITIAL_HIRE", activatedAt: null },
    summary: null,
    simulated: true,
    inFlightRun: null,
    pendingApprovals: 0,
    openProposal: null,
    permissions: { "workers.run": true, "workers.manage": true, "reviews.generate": true, "workers.chat": true, "workers.hire": true },
    ...overrides,
  } as WorkerHeaderView;
}

const NOW = new Date("2026-09-27T12:00:00.000Z");
const waiting = { id: "run_1", status: "WAITING_FOR_APPROVAL" as const, trigger: "SCHEDULED" as const, createdAt: "2026-09-22T13:00:00.000Z" };

describe("worker profile › header (design-detail-11, -22, -10, -21)", () => {
  it("never prints a past 'next run' time; says why it has not happened instead", () => {
    expect(textOf(renderToStaticMarkup(h("p", null, header.nextRunFact(headerView({ inFlightRun: waiting }), NOW))))).toBe(
      "Next run once you approve this one",
    );
    const running = headerView({ inFlightRun: { ...waiting, status: "RUNNING" } });
    expect(header.nextRunFact(running, NOW)).toBe("Next run after this one");
    expect(header.nextRunFact(headerView(), NOW)).toBe("Next run due now");
    const future = headerView({ schedule: { kind: "DAILY", description: "Daily at 8am", nextRunAt: "2026-09-28T13:00:00.000Z" } });
    expect(textOf(renderToStaticMarkup(h("p", null, header.nextRunFact(future, NOW))))).toMatch(/^Next run/);
  });

  it("links to the waiting request once — from the callout, not the status line too", () => {
    const html = render(h(header.WorkerHeader, { worker: headerView({ inFlightRun: waiting, pendingApprovals: 1 }), now: NOW }));
    expect(html).not.toContain("See what it needs");
    expect(html).not.toContain("Watch live");
    expect(html.match(/href="\/approvals"/g)).toHaveLength(1);
    expect(textOf(html)).toContain("Next run once you approve this one");
    expect(textOf(html)).not.toMatch(/Next run \d+ days? ago/);
  });

  it("draws each separator before a fact, so a wrapped line never ends in a dot", () => {
    const html = render(h(header.WorkerHeader, { worker: headerView(), now: NOW }));
    const facts = html.match(/<ul aria-label="Maya at a glance"[^>]*>([\s\S]*?)<\/ul>/)?.[1] ?? "";
    expect(facts.match(/<li /g)).toHaveLength(5);
    expect(facts).toContain("before:content-[&#x27;·&#x27;_/_&#x27;&#x27;]");
    // No literal middle dots left in the markup for a line to wrap after.
    expect(textOf(facts)).not.toContain("·");
  });

  it("shows one warning panel: health and the drafted replacement share it, with no second score", () => {
    const worker = headerView({
      name: "Sam",
      score: 54.6,
      health: "NEEDS_ATTENTION",
      healthReason: "Quality score 54 is below the 65 threshold and 3 of the last 5 runs failed",
      openProposal: { versionId: "v_2", version: 2, changeReason: "REPLACEMENT" },
    });
    const callouts = header.headerCallouts(worker);
    expect(callouts).toHaveLength(1);
    expect(callouts[0]).toMatchObject({ tone: "warning", href: "/workers/w_1/replace/v_2", linkLabel: "Compare and decide" });
    expect(callouts[0]!.text).toBe(
      "Sam needs attention: the performance score is under 65 and 3 of the last 5 runs failed. A replacement for Sam is drafted as version 2, and is not live until you decide.",
    );
    const html = render(h(header.WorkerHeader, { worker, now: NOW }));
    expect(html.match(/bg-warning-soft/g)).toHaveLength(1);
    expect(textOf(html)).not.toContain("54");
  });

  it("keeps the approval callout first and the proposal as a separate white note", () => {
    const callouts = header.headerCallouts(
      headerView({ inFlightRun: waiting, openProposal: { versionId: "v_2", version: 2, changeReason: "SPEC_CHANGE" } }),
    );
    expect(callouts.map((c) => c.tone)).toEqual(["warning", "neutral"]);
  });

  it("tells the Run now dialog a run is already going and that chat instructions are queued", () => {
    const html = render(
      h(header.WorkerHeader, { worker: headerView({ inFlightRun: { ...waiting, status: "QUEUED" } }), now: NOW, queuedInstructions: 1 }),
    );
    expect(textOf(html)).toContain("Run again");
    expect(textOf(html)).not.toContain("Run now");
  });
});

describe("worker profile › copy helpers", () => {
  it("fills a deliverable title template the way the runtime does (design-detail-07, design-core-016)", () => {
    const now = new Date(2026, 8, 22, 9);
    expect(exampleTitle("Customer Feedback Report — {{date}}", { now })).toBe("Customer Feedback Report — 2026-09-22");
    expect(exampleTitle("{{job_title}} — {{date}}", { now, jobTitle: "Market Map" })).toBe("Market Map — 2026-09-22");
    // Without a job title the placeholder is dropped rather than shown.
    expect(exampleTitle("{{job_title}} — {{date}}", { now })).toBe("2026-09-22");
    expect(exampleTitle("Weekly digest", { now })).toBe("Weekly digest");
  });

  it("maps formats to words, from the enum or the blueprint slug (design-detail-07)", () => {
    expect(formatLabel("MARKDOWN")).toBe("Report");
    expect(formatLabel("markdown")).toBe("Report");
    expect(formatLabel("csv")).toBe("CSV");
    expect(formatLabel("JSON")).toBe("JSON");
  });

  it("states health without a second, floored score (design-detail-10)", () => {
    expect(attentionSentence("Sam", "Quality score 54 is below the 65 threshold")).toBe(
      "Sam needs attention: the performance score is under 65.",
    );
    expect(attentionSentence("Sam", "3 of the last 5 runs failed")).toBe("Sam needs attention: 3 of the last 5 runs failed.");
  });

  it("gives the review's call as one sentence, with no score or engine text (design-detail-10)", () => {
    expect(reviewVerdict("Sam", "REPLACE")).toBe("Sam's latest review says it's time for a replacement.");
    expect(reviewVerdict("Sam", "IMPROVE")).toBe("Sam's latest review says there's room to improve.");
  });

  it("names the schedule's clock instead of 'the server's local time' (design-detail-22)", () => {
    const now = new Date("2026-09-27T12:00:00.000Z");
    expect(timeZoneLabel("UTC", now)).toBe("UTC");
    expect(timeZoneLabel("Etc/UTC", now)).toBe("UTC");
    expect(timeZoneLabel("America/Chicago", now)).toBe("Central Time");
    expect(timeZoneLabel()).not.toMatch(/server/i);
  });

  it("labels cost rows by model tier, keeping a live model id as detail only (design-detail-14)", () => {
    const simulated = [
      { tier: "fast" as const, model: "mock-fast" },
      { tier: "standard" as const, model: "mock-standard" },
      { tier: "reasoning" as const, model: "mock-reasoning" },
    ];
    expect(modelRowLabel("mock-standard", simulated)).toEqual({ title: "Standard model", detail: null });
    expect(modelRowLabel("mock-fast", simulated)).toEqual({ title: "Fast model", detail: null });
    const live = [
      { tier: "fast" as const, model: "gpt-5-mini" },
      { tier: "standard" as const, model: "gpt-5" },
      { tier: "reasoning" as const, model: "gpt-5" },
    ];
    expect(modelRowLabel("gpt-5", live)).toEqual({ title: "Standard / Reasoning model", detail: "gpt-5" });
    expect(modelRowLabel("retired-model-1", live)).toEqual({ title: "retired-model-1", detail: null });
  });
});

describe("worker profile › permissions rows (design-detail-05)", () => {
  const grant: ToolGrantView = {
    toolName: "extract_structured",
    displayName: "Data extraction",
    humanDescription: "Turns page text and notes into clean structured records with the fields the job needs.",
    category: null,
    sideEffect: "none",
    defaultRequiresApproval: false,
    reason: "Turn article text into clean records with exactly the fields the job asks for, and nothing else.",
    inBlueprint: true,
    hasGrant: true,
    requiresApproval: false,
    revoked: false,
    revokedAt: null,
    maxCallsPerRun: null,
    updatedAt: null,
  };

  it("shows the whole reason as a wrapping line, never a single-line truncation", () => {
    const html = render(h(grants.PermissionsGrantsTable, { workerId: "w_1", workerName: "Alex", grants: [grant], readOnly: false }));
    expect(html).toContain(grant.reason!);
    expect(html).not.toMatch(/class="[^"]*\btruncate\b/);
    expect(html).not.toContain("max-w-[46ch]");
  });

  it("stacks the text over the control on a phone, with the text block at full width", () => {
    const html = render(h(grants.PermissionsGrantsTable, { workerId: "w_1", workerName: "Alex", grants: [grant], readOnly: false }));
    expect(html).toMatch(/class="[^"]*flex-col items-stretch[^"]*sm:flex-row/);
    expect(html).toMatch(/class="w-full min-w-0 flex-1 break-words"/);
  });
});

describe("worker profile › debug lists (design-detail-13, -14)", () => {
  const call = (i: number): DebugModelCall => ({
    id: `mc_${i}`,
    runId: `run_${i}`,
    purpose: "runtime.researcher",
    provider: "mock",
    model: "mock-standard",
    tier: "standard",
    inputTokens: 1200,
    outputTokens: 300,
    costUsd: 0.01,
    latencyMs: 800,
    simulated: true,
    request: {},
    response: {},
    error: null,
    createdAt: "2026-09-22T12:00:00.000Z",
  });

  it("drops the per-row Simulated pill and says it once for the list", () => {
    const calls = Array.from({ length: 20 }, (_, i) => call(i));
    const html = render(h(debugLists.DebugModelCallList, { calls }));
    expect(html).not.toContain("Simulated");
    expect(debugLists.simulatedNote(calls)).toBe("All 20 ran on the simulator.");
    expect(debugLists.simulatedNote([{ simulated: true }, { simulated: false }])).toBe("1 of 2 ran on the simulator.");
    expect(debugLists.simulatedNote([{ simulated: false }])).toBeNull();
  });

  it("names the model tier in the row and keeps provider:model for the expanded trace", () => {
    const html = render(h(debugLists.DebugModelCallList, { calls: [call(1)] }));
    const summary = html.slice(html.indexOf("<summary"), html.indexOf("</summary>"));
    expect(textOf(summary)).toContain("Standard model");
    expect(summary).not.toContain("mock:mock-standard");
    expect(html).toContain("mock:mock-standard");
  });

  it("drops the pill from tool rows too", () => {
    const tool: DebugToolCall = {
      id: "tc_1",
      runId: "run_1",
      toolName: "web_search",
      status: "SUCCEEDED",
      attempt: 1,
      costUsd: 0.008,
      latencyMs: 300,
      simulated: true,
      input: {},
      output: {},
      error: null,
      createdAt: "2026-09-22T12:00:00.000Z",
    } as DebugToolCall;
    expect(render(h(debugLists.DebugToolCallList, { calls: [tool] }))).not.toContain("Simulated");
  });

  it("keeps the pill off every chat reply (design-detail-13)", () => {
    const html = render(
      h(chatMessage.ChatMessage, {
        worker: { name: "Alex", avatarColor: "sky" },
        message: {
          id: "m_1",
          role: "WORKER",
          content: "Got it.",
          classification: null,
          createdAt: "2026-09-22T12:00:00.000Z",
          simulated: true,
          proposedVersionId: null,
          proposedVersion: null,
          proposalStatus: null,
          href: null,
          normalizedInstruction: null,
        },
      }),
    );
    expect(html).not.toContain("Simulated");
  });
});

describe("replace page › every difference in plain terms (design-detail-08)", () => {
  const ctx = { toolNames: { web_search: "Web search", fetch_url: "Web page reader" } };

  it("describes an added step by what it does, not its JSON config", () => {
    expect(
      describeStepSummary(
        'validate records · {"requiredFields":["company","category","stage","amount_usd","source_url"],"dropInvalid":true} · writes records',
        ctx,
      ),
    ).toBe("Drops records missing company, category, stage, amount USD or source URL");
    expect(describeStepSummary('dedupe · {"keyFields":["company"]} · writes records', ctx)).toBe("Removes duplicates by company");
    expect(describeStepSummary("agent · standard tier · tools: web_search, fetch_url · up to 8 turns · writes records", ctx)).toBe(
      "Standard model · uses Web search and Web page reader · up to 8 turns",
    );
  });

  it("covers every deterministic operation", () => {
    expect(describeStepConfig("rank", { by: "amount_usd", direction: "desc", limit: 15 })).toBe(
      "Ranks by amount USD, highest first, keeping the top 15",
    );
    expect(describeStepConfig("filter", { field: "severity", op: "neq", value: "low" })).toBe("Keeps records where severity is not low");
    expect(describeStepConfig("filter", { field: "source_url", op: "exists" })).toBe("Keeps records that have a source URL");
    expect(describeStepConfig("compute_stats", { groupBy: "category", numericFields: ["amount_usd"] })).toBe(
      "Counts by category and summarizes amount USD",
    );
    expect(describeStepConfig("to_csv", {})).toBe("Exports every field to CSV");
    expect(describeStepConfig(null, { keyFields: ["id"] })).toBe("Removes duplicates by ID");
  });

  it("humanizes config, tier, tool and deliverable entries and leaves others alone", () => {
    const entries: BlueprintDiffEntry[] = [
      { path: "components.dedupe.config", label: "Remove duplicates · configuration", kind: "changed", before: '{"keyFields":["company"]}', after: '{"keyFields":["company","stage"]}' },
      { path: "components.researcher.modelTier", label: "Researcher · model tier", kind: "changed", before: "fast", after: "standard" },
      { path: "tools.web_search", label: "Tools · web_search", kind: "added", after: "no approval needed — Find sources" },
      { path: "deliverable.titleTemplate", label: "Deliverable · title", kind: "changed", before: "Map — {{date}}", after: "Market Map — {{date}}" },
      { path: "deliverable.format", label: "Deliverable · format", kind: "changed", before: "markdown", after: "csv" },
      { path: "evaluation.checks.c1", label: "Check · no duplicates", kind: "changed", before: 'No duplicates · {"keyFields":["company"]} · weight 0.2', after: 'No duplicates · {"keyFields":["company"]} · weight 0.3' },
      { path: "persona.name", label: "Persona · name", kind: "changed", before: "Sam", after: "Sasha" },
    ];
    const out = entries.map((e) => humanizeDiffEntry(e, ctx));
    expect(out[0]).toMatchObject({ before: "Removes duplicates by company", after: "Removes duplicates by company and stage" });
    expect(out[1]).toMatchObject({ before: "Fast model", after: "Standard model" });
    expect(out[2]!.label).toBe("Tools · Web search");
    expect(out[3]!.after).toMatch(/^Market Map — \d{4}-\d{2}-\d{2}$/);
    expect(out[4]).toMatchObject({ before: "Report", after: "CSV" });
    expect(out[5]).toMatchObject({ before: "No duplicates · weight 0.2", after: "No duplicates · weight 0.3" });
    expect(out[6]).toEqual(entries[6]);
    for (const e of out) expect(`${e.before ?? ""}${e.after ?? ""}`).not.toMatch(/[{}]|\{\{/);
  });

  it("renders the change list without raw JSON", () => {
    const html = render(
      h(changeList.ChangeList, {
        entries: [
          {
            path: "components.validate",
            label: "Validate records · step added",
            kind: "added",
            after: 'validate records · {"requiredFields":["company"],"dropInvalid":true} · writes records',
          },
        ],
        baseLabel: "the current version",
        targetLabel: "Version 2",
        toolNames: {},
      }),
    );
    expect(textOf(html)).toContain("Drops records missing company");
    expect(html).not.toContain("requiredFields");
    expect(html).not.toContain("writes records");
  });
});

describe("worker profile › overview (design-core-016, design-detail-07, -12)", () => {
  let t: Awaited<ReturnType<typeof createTestOrg>>;
  let overview: Overview;

  beforeAll(async () => {
    t = await createTestOrg("worker-ui");
    overview = await loadForSsr<Overview>(`${DIR}/_tabs/overview.tsx`, stubs);
  });
  afterAll(async () => {
    await t.cleanup();
  });

  async function renderOverview(workerId: string, workerName: string): Promise<string> {
    const element = await overview.default({ session: t.session, workerId, workerName });
    return textOf(render(element));
  }

  it("lists Cost per run once when the job has its own cost target, with the plan on that row", async () => {
    const hired = await createHiredWorker(t.organization.id, { userId: t.user.id });
    const text = await renderOverview(hired.worker.id, hired.worker.name);
    expect(text.match(/Cost per run/g)).toHaveLength(1);
    expect(text).toMatch(/Cost per run Target at most \$0\.50 · Not enough data · planned \$\d+\.\d{2}/);
  });

  it("never shows a raw {{date}} template and says 'Nothing spent yet' before the first run", async () => {
    const hired = await createHiredWorker(t.organization.id, { userId: t.user.id, name: "Rae" });
    const text = await renderOverview(hired.worker.id, "Rae");
    expect(text).not.toContain("{{");
    expect(text).toMatch(/It ends with “Weekly AI Infra Funding Report — \d{4}-\d{2}-\d{2}”\./);
    expect(text).toContain("Nothing spent yet");
    expect(text).not.toMatch(/— a run/);
  });

  it("keeps a single planned-cost row when the job set no cost target", async () => {
    const base = makeBlueprint();
    const blueprint = { ...base, kpis: base.kpis.filter((k) => k.metric !== "cost_per_run_usd") };
    const hired = await createHiredWorker(t.organization.id, { userId: t.user.id, blueprint, name: "Lee" });
    const text = await renderOverview(hired.worker.id, "Lee");
    expect(text.match(/Cost per run/g)).toHaveLength(1);
    expect(text).toMatch(/Cost per run Planned \$\d+\.\d{2}/);
  });
});
