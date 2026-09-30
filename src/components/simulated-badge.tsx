import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

export const SIMULATED_EXPLANATION =
  "Made by the built-in simulator: no model API key is set, or this is the demo workspace. Add a key in .env to go live.";

export interface SimulatedBadgeProps {
  /** Dot only, for the mobile nav where the word would crowd the bar. The label moves to the accessible name. */
  dotOnly?: boolean;
  className?: string;
}

/**
 * The "Simulated" marker: a quiet neutral chip with one amber dot. It appears once globally in the nav, and
 * inline in the meta line of artifacts that were generated (runs, deliverables, usage) — never on a section
 * heading or a stat.
 */
export function SimulatedBadge({ dotOnly = false, className }: SimulatedBadgeProps) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          data-slot="simulated-badge"
          tabIndex={0}
          aria-label={dotOnly ? "Simulated" : undefined}
          className={cn(
            "inline-flex h-[22px] w-fit shrink-0 cursor-help items-center gap-1.5 rounded-full bg-muted text-caption font-medium whitespace-nowrap text-muted-foreground shadow-[inset_0_0_0_0.5px_var(--hairline)] outline-none focus-visible:ring-4 focus-visible:ring-primary/30",
            dotOnly ? "w-[22px] justify-center" : "px-2.5",
            className,
          )}
        >
          <span aria-hidden="true" className="size-1.5 rounded-full bg-warning" />
          {dotOnly ? null : "Simulated"}
        </span>
      </TooltipTrigger>
      <TooltipContent side="bottom">{SIMULATED_EXPLANATION}</TooltipContent>
    </Tooltip>
  );
}

/**
 * One quiet line above simulated work. Simulated output is shaped like the real thing (and can score well), so on
 * the pages where someone reads it, the chip alone is too easy to miss.
 */
export function SimulatedWorkNote({ className }: { className?: string }) {
  return (
    <p className={cn("flex items-start gap-2 text-footnote text-pretty text-muted-foreground", className)}>
      <span aria-hidden="true" className="mt-[5px] size-1.5 shrink-0 rounded-full bg-warning" />
      <span>
        Sample content from the built-in simulator. It shows how the work is shaped, not real findings. Add a model
        provider key in .env for real results.
      </span>
    </p>
  );
}
