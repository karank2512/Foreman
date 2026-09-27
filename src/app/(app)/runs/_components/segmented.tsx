import Link from "next/link";
import { cn } from "@/lib/utils";

/**
 * A segmented control whose "state" is the URL, so list pages stay server components and every filter is
 * shareable. Shared by the runs, deliverables and jobs indexes (all three are one owner's routes).
 */

export interface SegmentOption {
  label: string;
  href: string;
  active: boolean;
  /** Optional count after the label. */
  count?: number;
}

export interface SegmentedLinksProps {
  /** Accessible name for the group: "Filter runs by status". */
  label: string;
  options: SegmentOption[];
  className?: string;
}

/**
 * Under `md` each 28px option carries a 44px `::before` tap band. The scroller clips whatever overflows it, so on
 * phones it grows to exactly 44px (the negative margin keeps the row where it was), and its right edge fades so a
 * cut-off option reads as "scroll for more". The extra right padding lets the last option scroll clear of the fade.
 */
const HIT_AREA = "relative max-md:before:absolute max-md:before:inset-x-0 max-md:before:top-[calc(50%_-_22px)] max-md:before:h-11";

export function SegmentedLinks({ label, options, className }: SegmentedLinksProps) {
  return (
    <nav
      aria-label={label}
      className={cn(
        "-mx-1 max-w-full overflow-x-auto px-1 py-1 [-ms-overflow-style:none] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden",
        "max-md:-my-0.5 max-md:py-1.5 max-sm:pr-6 max-sm:[mask-image:linear-gradient(to_right,#000_calc(100%_-_24px),transparent)]",
        className,
      )}
    >
      <div className="inline-flex h-8 w-max items-center rounded-full bg-secondary p-0.5">
        {options.map((option) => (
          <Link
            key={option.href}
            href={option.href}
            scroll={false}
            aria-current={option.active ? "page" : undefined}
            className={cn(
              HIT_AREA,
              "inline-flex h-7 items-center gap-1.5 rounded-full px-3.5 text-[13px] font-medium whitespace-nowrap outline-none transition-[background-color,color,box-shadow] duration-200 ease-in-out focus-visible:ring-4 focus-visible:ring-primary/30",
              option.active ? "bg-background text-foreground shadow-thumb" : "text-foreground/80 hover:text-foreground",
            )}
          >
            {option.label}
            {option.count !== undefined ? (
              <span className={cn("metric text-caption", option.active ? "text-muted-foreground" : "text-foreground/50")}>
                {option.count}
              </span>
            ) : null}
          </Link>
        ))}
      </div>
    </nav>
  );
}

/** Build a query string from the given params, dropping empty values. */
export function withParams(base: string, params: Record<string, string | undefined>): string {
  const qs = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) if (value) qs.set(key, value);
  const s = qs.toString();
  return s ? `${base}?${s}` : base;
}
