import Link from "next/link";
import { ChevronDown } from "lucide-react";
import { LocalNav, type LocalNavItem } from "@/components/shell/local-nav";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";
import { WORKER_TAB_LABELS, type WorkerTab } from "../_tabs/types";

export interface WorkerTabNavProps {
  workerId: string;
  /** Persona name — the chat tab reads "Talk to Alex", and the bar reveals the name on scroll. */
  workerName: string;
  active: WorkerTab;
  className?: string;
}

/**
 * What a manager reaches for, in the order they reach for it; the rest lives under "More" on a wide screen.
 * The ids and `WORKER_TAB_LABELS` stay the frozen seam — only the grouping and display order live here.
 */
export const PRIMARY_TABS = ["overview", "activity", "deliverables", "performance", "chat"] as const satisfies readonly WorkerTab[];
export const MORE_TABS = ["cost", "permissions", "versions", "debug"] as const satisfies readonly WorkerTab[];

/** Display labels stay in the tab nav: the ids and `WORKER_TAB_LABELS` are the frozen seam. */
export function tabLabel(tab: WorkerTab, workerName: string): string {
  return tab === "chat" ? `Talk to ${workerName}` : WORKER_TAB_LABELS[tab];
}

export function tabHref(workerId: string, tab: WorkerTab): string {
  return tab === "overview" ? `/workers/${workerId}` : `/workers/${workerId}?tab=${tab}`;
}

/** The "More" trigger names the tab you are on when it lives inside the menu ("Cost ▾"). */
export function moreLabel(active: WorkerTab): string {
  return (MORE_TABS as readonly WorkerTab[]).includes(active) ? WORKER_TAB_LABELS[active] : "More";
}

// The page column is 1200px wide; the bar itself spans the window, like the global nav above it.
const FULL_BLEED = "ml-[calc(50%-50vw)] w-dvw";

/**
 * The profile's section bar: the shared frosted LocalNav, mounted full-bleed under the global nav. Every tab is
 * a real URL, so the back button and shared links work.
 *
 * From 768px up it shows the five everyday tabs plus a "More" menu (Cost, Permissions, Versions, Debug), so the
 * profile reads as a person rather than an admin console. On a phone every tab scrolls sideways instead — a menu
 * behind a menu is harder to reach than a swipe. Only one of the two bars is ever displayed.
 */
export function WorkerTabNav({ workerId, workerName, active, className }: WorkerTabNavProps) {
  const item = (tab: WorkerTab): LocalNavItem => ({
    label: tabLabel(tab, workerName),
    href: tabHref(workerId, tab),
    active: tab === active,
  });
  const inMore = (MORE_TABS as readonly WorkerTab[]).includes(active);

  return (
    <>
      <LocalNav
        title={workerName}
        items={[...PRIMARY_TABS, ...MORE_TABS].map(item)}
        className={cn(FULL_BLEED, "md:hidden", className)}
      />
      <LocalNav
        title={workerName}
        items={PRIMARY_TABS.map(item)}
        className={cn(FULL_BLEED, "max-md:hidden", className)}
        action={
          <DropdownMenu modal={false}>
            <DropdownMenuTrigger
              className={cn(
                // Reads like its neighbours: same 13px nav type, 20px after the last link, the whole bar as hit area.
                "ml-1 flex h-(--localnav-height) items-center gap-1 rounded-sm text-footnote whitespace-nowrap outline-none",
                inMore ? "font-semibold text-foreground" : "font-medium text-foreground/72 hover:text-foreground",
              )}
            >
              {moreLabel(active)}
              <ChevronDown aria-hidden="true" className="size-3.5" />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="min-w-44">
              {MORE_TABS.map((tab) => (
                <DropdownMenuItem key={tab} asChild>
                  <Link
                    href={tabHref(workerId, tab)}
                    aria-current={tab === active ? "page" : undefined}
                    className={cn(tab === active && "font-semibold")}
                  >
                    {tabLabel(tab, workerName)}
                  </Link>
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
        }
      />
    </>
  );
}
