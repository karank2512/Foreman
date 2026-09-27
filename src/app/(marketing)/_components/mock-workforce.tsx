import { LogoGlyph } from "@/components/shell/logo";
import { WorkerAvatar } from "@/components/worker-avatar";
import { ScoreRing } from "@/components/score-ring";
import { cn } from "@/lib/utils";

/**
 * The hero's product shot. Not an image and not a screenshot: the real workforce layout rebuilt from the
 * product's own pieces (avatars, score rings, hairline stat strip) with invented sample data, so what the
 * page promises is literally what ships. The whole frame is one `role="img"`, which makes everything inside
 * presentational to assistive tech — so nothing in here is focusable.
 */

interface MockWorker {
  name: string;
  color: string;
  title: string;
  score: number;
  status: { tone: "running" | "idle" | "attention"; label: string };
  facts: [string, string][];
}

const WORKERS: MockWorker[] = [
  {
    name: "Maya Okonkwo",
    color: "sky",
    title: "Market research analyst",
    score: 88,
    status: { tone: "running", label: "Running now · step 4 of 7" },
    facts: [
      ["Runs", "34"],
      ["Success rate", "97%"],
      ["Last review", "Strong"],
      ["Cost this month", "$12.80"],
    ],
  },
  {
    name: "Theo Brandt",
    color: "emerald",
    title: "Support inbox triager",
    score: 81,
    status: { tone: "idle", label: "Idle · next run tomorrow 9:00" },
    facts: [
      ["Runs", "112"],
      ["Success rate", "94%"],
      ["Last review", "Strong"],
      ["Cost this month", "$18.40"],
    ],
  },
  {
    name: "Priya Raman",
    color: "amber",
    title: "Lead list builder",
    score: 74,
    status: { tone: "attention", label: "Needs attention · quality dipped last 3 runs" },
    facts: [
      ["Runs", "21"],
      ["Success rate", "86%"],
      ["Last review", "Watch"],
      ["Cost this month", "$7.00"],
    ],
  },
];

const STATS: [string, string, string][] = [
  ["Active workers", "6", "Everyone is on the job"],
  ["Runs today", "14", "3 still in flight"],
  ["Waiting for review", "2", "Oldest: 12 min"],
  ["Spend this month", "$38.20", "↓ 8% vs last month"],
];

const DOT_CLASSES = {
  running: "bg-info",
  idle: "bg-muted-foreground",
  attention: "bg-warning",
} as const;

const STATUS_TEXT = {
  running: "text-foreground",
  idle: "text-muted-foreground",
  attention: "text-warning",
} as const;

function MockNav() {
  return (
    <div className="flex h-12 items-center gap-6 bg-[rgb(251_251_253_/_0.86)] px-5 shadow-[inset_0_-0.5px_0_var(--hairline)] backdrop-blur-[20px]">
      <span className="inline-flex items-center gap-1.5">
        <LogoGlyph className="size-4" />
        <span className="text-[13px] leading-none font-semibold tracking-[-0.02em]">AI Staffing Agency</span>
      </span>
      <span className="hidden items-center gap-5 text-[12px] font-medium sm:flex">
        <span className="relative font-semibold after:absolute after:top-[calc(100%+5px)] after:left-0 after:h-0.5 after:w-4 after:rounded-full after:bg-foreground">
          Workforce
        </span>
        <span className="text-foreground/70">Jobs</span>
        <span className="inline-flex items-center gap-1.5 text-foreground/70">
          Approvals
          <span className="text-warning inline-flex h-[16px] items-center rounded-full bg-warning-soft px-1.5 text-[10px] font-semibold tabular-nums">
            2
          </span>
        </span>
        <span className="text-foreground/70">Activity</span>
      </span>
      <span className="ml-auto flex items-center gap-2.5">
        <span className="hidden h-[22px] items-center gap-1.5 rounded-full bg-muted px-2 text-[11px] font-medium text-muted-foreground shadow-[0_0_0_0.5px_var(--hairline)] sm:inline-flex">
          <span className="size-1.5 rounded-full bg-warning" />
          Simulated
        </span>
        <span className="inline-flex h-6 items-center rounded-full bg-primary px-3 text-[12px] font-medium text-primary-foreground">
          Hire
        </span>
        <span className="inline-flex size-6 items-center justify-center rounded-full bg-foreground text-[10px] font-semibold text-background">
          AR
        </span>
      </span>
    </div>
  );
}

function MockStatStrip() {
  return (
    <div className="grid grid-cols-2 gap-px overflow-hidden rounded-xl bg-border shadow-card md:grid-cols-4">
      {STATS.map(([label, value, hint]) => (
        <div key={label} className="flex flex-col gap-1 bg-card p-4 sm:p-5">
          <p className="truncate text-[12px] leading-4 font-medium text-muted-foreground">{label}</p>
          <p className="text-[26px] leading-8 font-semibold tracking-[-0.02em] tabular-nums sm:text-[30px]">
            {value}
          </p>
          <p className="truncate text-[12px] leading-4 text-muted-foreground">{hint}</p>
        </div>
      ))}
    </div>
  );
}

function MockWorkerCard({ worker }: { worker: MockWorker }) {
  return (
    <div className="flex flex-col gap-4 rounded-xl bg-card p-5 shadow-card">
      <div className="flex items-start gap-3">
        <WorkerAvatar name={worker.name} color={worker.color} size="lg" />
        <div className="min-w-0 flex-1">
          <p className="text-title-3 truncate">{worker.name.split(" ")[0]}</p>
          <p className="truncate text-[13px] leading-[18px] text-muted-foreground">{worker.title}</p>
        </div>
        <ScoreRing score={worker.score} />
      </div>

      <p className={cn("flex items-center gap-2 text-[13px] leading-[18px]", STATUS_TEXT[worker.status.tone])}>
        <span className={cn("size-[7px] shrink-0 rounded-full", DOT_CLASSES[worker.status.tone])} />
        <span className="truncate">{worker.status.label}</span>
      </p>

      <div className="grid grid-cols-2 gap-x-4 gap-y-3">
        {worker.facts.map(([label, value]) => (
          <div key={label}>
            <p className="text-[12px] leading-4 text-muted-foreground">{label}</p>
            <p className="text-[15px] leading-5 font-medium tabular-nums">{value}</p>
          </div>
        ))}
      </div>

      <div className="flex items-center justify-between border-t border-border pt-4">
        <span className="text-[13px] inline-flex h-7 items-center rounded-full bg-secondary px-3.5 font-medium">
          Run now
        </span>
        <span className="text-[13px] font-medium text-link">View profile ›</span>
      </div>
    </div>
  );
}

export interface WorkforceMockProps {
  className?: string;
}

/** The 1024px hero frame: canvas, mini nav, stat strip and three worker cards. */
export function WorkforceMock({ className }: WorkforceMockProps) {
  return (
    <div
      role="img"
      aria-label="The workforce page: six active workers, fourteen runs today, two deliverables waiting for review and $38.20 spent this month. Maya, a market research analyst, is mid-run and scores 88. Theo, a support inbox triager, is idle until tomorrow and scores 81. Priya, a lead list builder, needs attention and scores 74."
      className={cn("overflow-hidden rounded-4xl bg-canvas shadow-card", className)}
    >
      <MockNav />
      <div className="flex flex-col gap-5 p-4 sm:gap-6 sm:p-7">
        <MockStatStrip />
        <div className="grid grid-cols-1 gap-4 sm:gap-5 md:grid-cols-3">
          {WORKERS.map((worker) => (
            <MockWorkerCard key={worker.name} worker={worker} />
          ))}
        </div>
      </div>
    </div>
  );
}
