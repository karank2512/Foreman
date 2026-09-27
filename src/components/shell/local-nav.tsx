"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import Link from "next/link";
import { cn } from "@/lib/utils";

export interface LocalNavItem {
  label: string;
  /** A route (`/workers/x?tab=cost`) or an in-page anchor (`#timeline`). */
  href: string;
  active?: boolean;
}

export interface LocalNavProps {
  /** The object this page is about ("Alex"). Revealed once the page H1 scrolls away. */
  title: string;
  items: readonly LocalNavItem[];
  /** At most one small primary pill ("Run now"). */
  action?: ReactNode;
  /** Element whose exit from the viewport reveals the title. Default: the page's `<h1>`. */
  watchSelector?: string;
  className?: string;
}

/**
 * Sub-navigation for pages with sections (worker profile, job detail, run detail). Sticks directly under the
 * global nav and carries the same frosted material, so the two read as one piece of chrome.
 */
export function LocalNav({ title, items, action, watchSelector = "h1", className }: LocalNavProps) {
  const [showTitle, setShowTitle] = useState(false);
  const list = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const heading = document.querySelector(watchSelector);
    if (!heading) {
      setShowTitle(true);
      return;
    }
    const observer = new IntersectionObserver(([entry]) => setShowTitle(!entry?.isIntersecting), {
      rootMargin: "-56px 0px 0px 0px",
    });
    observer.observe(heading);
    return () => observer.disconnect();
  }, [watchSelector]);

  // On a narrow screen the links scroll sideways; make sure the current one starts in view.
  useEffect(() => {
    list.current?.querySelector<HTMLElement>('[aria-current="page"]')?.scrollIntoView({
      block: "nearest",
      inline: "center",
    });
  }, []);

  return (
    <div
      data-slot="local-nav"
      className={cn("material-nav sticky top-(--nav-height) z-30 h-(--localnav-height)", className)}
    >
      <div className="mx-auto flex h-full w-full max-w-(--container-app) items-center gap-4 px-4 sm:px-6">
        <p
          aria-hidden={!showTitle}
          className={cn(
            "hidden min-w-0 shrink-0 truncate text-[21px] leading-none font-semibold tracking-[-0.012em] transition-opacity duration-200 ease-out sm:block",
            showTitle ? "opacity-100" : "opacity-0",
          )}
        >
          {title}
        </p>

        <div
          ref={list}
          className="-mx-1 flex h-full min-w-0 flex-1 items-center gap-5 overflow-x-auto px-1 [-ms-overflow-style:none] [scrollbar-width:none] [scroll-snap-type:x_proximity] sm:justify-end [&::-webkit-scrollbar]:hidden"
        >
          {items.map((item) => (
            <Link
              key={item.href}
              href={item.href}
              aria-current={item.active ? "page" : undefined}
              className={cn(
                // Full-height anchors: the whole 52px bar is the hit area, not just the 18px of text.
                "flex h-full shrink-0 items-center rounded-sm text-footnote whitespace-nowrap outline-none [scroll-snap-align:center]",
                item.active ? "font-semibold text-foreground" : "font-medium text-foreground/72 hover:text-foreground",
              )}
            >
              {item.label}
            </Link>
          ))}
        </div>

        {action ? <div className="flex shrink-0 items-center">{action}</div> : null}
      </div>
    </div>
  );
}
