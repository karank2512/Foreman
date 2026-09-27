import { cn } from "@/lib/utils";

/**
 * The composition inside the one dark band: a performance chart next to the team it belongs to. Drawn as
 * inline SVG paths rather than a chart library, because this is marketing furniture — no data, no runtime.
 */

const ROWS: { name: string; initials: string; role: string; state: string; tone: "running" | "idle" | "attention"; score: string }[] = [
  { name: "Maya", initials: "MO", role: "Market research", state: "Running now", tone: "running", score: "88" },
  { name: "Theo", initials: "TB", role: "Support triage", state: "Idle · 9:00 tomorrow", tone: "idle", score: "81" },
  { name: "Nadia", initials: "NK", role: "Contract review", state: "Waiting on you", tone: "attention", score: "79" },
  { name: "Priya", initials: "PR", role: "Lead lists", state: "Needs attention", tone: "attention", score: "74" },
];

const DOT = {
  running: "bg-[#2997ff]",
  idle: "bg-[#86868b]",
  attention: "bg-[#ff9f0a]",
} as const;

/** 12 weekly scores, 60 → 92, drawn in a 320×120 box. */
const POINTS = [62, 66, 64, 71, 69, 75, 78, 76, 82, 85, 84, 89];

function chartPath(values: number[], width: number, height: number): string {
  const min = 55;
  const max = 95;
  const step = width / (values.length - 1);
  return values
    .map((value, index) => {
      const x = index * step;
      const y = height - ((value - min) / (max - min)) * height;
      return `${index === 0 ? "M" : "L"}${x.toFixed(1)} ${y.toFixed(1)}`;
    })
    .join(" ");
}

function PerformanceChart() {
  const width = 320;
  const height = 120;
  const line = chartPath(POINTS, width, height);
  const area = `${line} L${width} ${height} L0 ${height} Z`;

  return (
    <svg viewBox={`0 0 ${width} ${height}`} className="h-[120px] w-full" preserveAspectRatio="none" aria-hidden="true">
      {[0, 0.25, 0.5, 0.75, 1].map((ratio) => (
        <line
          key={ratio}
          x1="0"
          x2={width}
          y1={ratio * height}
          y2={ratio * height}
          stroke="rgb(255 255 255 / 0.08)"
          strokeWidth="1"
        />
      ))}
      <path d={area} fill="rgb(41 151 255 / 0.12)" />
      <path d={line} fill="none" stroke="#2997ff" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export function DarkWorkforceMock({ className }: { className?: string }) {
  return (
    <div
      role="img"
      aria-label="A dark workspace view: average worker score climbing from 62 to 89 over twelve weeks, beside a list of four workers — Maya running now at 88, Theo idle at 81, Nadia waiting on a decision at 79 and Priya needing attention at 74."
      className={cn("rounded-4xl bg-[#1d1d1f] p-5 sm:p-8", className)}
    >
      <div className="grid grid-cols-1 gap-5 lg:grid-cols-12">
        <div className="rounded-3xl bg-[rgb(255_255_255_/_0.04)] p-6 lg:col-span-7">
          <div className="flex items-baseline justify-between gap-4">
            <p className="text-[15px] font-semibold text-white">Team performance</p>
            <p className="text-[12px] text-[#86868b]">Last 12 weeks</p>
          </div>
          <p className="mt-4 text-[40px] leading-none font-semibold tracking-[-0.02em] tabular-nums text-white">
            84
          </p>
          <p className="mt-2 text-[13px] text-[#86868b]">
            Average score · <span className="text-[#30d158]">↑ 9 points since March</span>
          </p>
          <div className="mt-6">
            <PerformanceChart />
          </div>
          <div className="mt-3 flex justify-between text-[12px] tabular-nums text-[#86868b]">
            <span>Mar</span>
            <span>Apr</span>
            <span>May</span>
          </div>
        </div>

        <div className="rounded-3xl bg-[rgb(255_255_255_/_0.04)] p-6 lg:col-span-5">
          <p className="text-[15px] font-semibold text-white">Your team</p>
          <ul className="mt-3">
            {ROWS.map((row) => (
              <li
                key={row.name}
                className="flex items-center gap-3 border-t border-[rgb(255_255_255_/_0.1)] py-3.5 first:border-t-0 first:pt-2"
              >
                <span className="inline-flex size-8 shrink-0 items-center justify-center rounded-full bg-[rgb(255_255_255_/_0.1)] text-[11px] font-semibold text-white">
                  {row.initials}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[15px] font-medium text-white">{row.name}</span>
                  <span className="mt-0.5 flex items-center gap-1.5 text-[12px] text-[#86868b]">
                    <span className={cn("size-[6px] shrink-0 rounded-full", DOT[row.tone])} />
                    <span className="truncate">{row.state}</span>
                  </span>
                </span>
                <span className="text-[17px] font-semibold tabular-nums text-white">{row.score}</span>
              </li>
            ))}
          </ul>
          <p className="mt-4 text-[13px] text-[#86868b]">6 workers · $38.20 this month</p>
        </div>
      </div>
    </div>
  );
}
