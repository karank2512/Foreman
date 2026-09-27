import Link from "next/link";
import { cn } from "@/lib/utils";

export interface ViewTab {
  label: string;
  href: string;
  active: boolean;
  /** Shown after the label in tabular numerals, e.g. the count of waiting requests. */
  count?: number;
}

/**
 * Segmented control built from links, so the chosen view lives in the URL and survives a refresh or a share.
 * Same shape as the `TabsList` segmented control, without needing client state.
 */
export function ViewTabs({ label, tabs }: { label: string; tabs: ViewTab[] }) {
  return (
    // Three layers because the scroller clips what overflows it: on phones it grows to 44px so each option's 44px
    // tap band fits inside, and the negative margin that keeps the row in place must not sit on the outer box,
    // whose margins belong to the parent's `space-y-*`. The right edge fades so a cut-off option reads as
    // "scroll for more".
    <div role="group" aria-label={label} className="w-fit max-w-full">
      <div className="overflow-x-auto [scrollbar-width:none] max-md:-my-1.5 max-md:py-1.5 max-sm:pr-6 max-sm:[mask-image:linear-gradient(to_right,#000_calc(100%_-_24px),transparent)] [&::-webkit-scrollbar]:hidden">
        <div className="flex h-8 w-max items-center gap-0.5 rounded-full bg-secondary p-0.5">
          {tabs.map((tab) => (
            <Link
              key={tab.href}
              href={tab.href}
              scroll={false}
              aria-current={tab.active ? "page" : undefined}
              className={cn(
                "text-footnote relative inline-flex h-7 shrink-0 items-center gap-1.5 rounded-full px-3.5 font-medium whitespace-nowrap transition-[background-color,color] duration-200 ease-standard outline-none",
                "max-md:before:absolute max-md:before:inset-x-0 max-md:before:top-[calc(50%_-_22px)] max-md:before:h-11",
                tab.active ? "bg-background text-foreground shadow-thumb" : "text-foreground/75 hover:text-foreground",
              )}
            >
              {tab.label}
              {tab.count !== undefined && tab.count > 0 ? (
                <span className={cn("tabular-nums", tab.active ? "text-muted-foreground" : "text-foreground/60")}>
                  {tab.count}
                </span>
              ) : null}
            </Link>
          ))}
        </div>
      </div>
    </div>
  );
}
