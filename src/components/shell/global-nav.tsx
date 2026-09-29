"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { SimulatedBadge } from "@/components/simulated-badge";
import { Wordmark } from "@/components/shell/logo";
import { MobileMenu } from "@/components/shell/mobile-menu";
import {
  HIRE_HREF,
  NAV_ITEMS,
  approvalsLabel,
  formatCount,
  isActivePath,
} from "@/components/shell/nav-items";
import { UserMenu, type ShellUser } from "@/components/shell/user-menu";
import { cn } from "@/lib/utils";

export interface GlobalNavProps {
  user: ShellUser;
  /** `llm.isSimulated()` — shows the global Simulated chip, the only place it appears in the chrome. */
  simulated: boolean;
  /** Approvals awaiting a decision; shown as a count pill after the Approvals link. */
  pendingApprovals: number;
}

/**
 * The frosted 48px bar that every authenticated page hangs under. Four text destinations, one primary pill and
 * the account menu — everything else lives inside a page. Client-side only because it needs `usePathname()`.
 *
 * The Hire pill is the one blue action in the chrome, so it only appears for roles that can actually hire
 * (`user.canHire`, ADMIN and up) — a member who tapped it would land on a refusal page.
 */
export function GlobalNav({ user, simulated, pendingApprovals }: GlobalNavProps) {
  const pathname = usePathname() ?? "";
  const onHire = isActivePath(pathname, [HIRE_HREF]);

  return (
    <header className="material-nav sticky top-0 z-40 h-(--nav-height)">
      <div className="mx-auto flex h-full w-full max-w-(--container-app) items-center px-4 sm:px-6">
        {/* 44px tall inside the 48px bar: on a phone the wordmark is the way home, so it gets a full tap box. */}
        <Link href="/workforce" aria-label="Foreman — go to Workforce" className="flex h-11 items-center rounded-sm outline-none">
          <Wordmark />
        </Link>

        <nav aria-label="Main" className="ml-9 hidden items-center gap-7 md:flex">
          {NAV_ITEMS.map((item) => {
            const active = isActivePath(pathname, item.match);
            const count = item.badge === "pendingApprovals" ? pendingApprovals : 0;
            return (
              <Link
                key={item.href}
                href={item.href}
                aria-current={active ? "page" : undefined}
                className={cn(
                  "relative inline-flex items-center gap-1.5 rounded-sm text-footnote whitespace-nowrap transition-opacity duration-200 ease-standard outline-none",
                  active
                    ? "font-semibold text-foreground after:absolute after:top-[calc(100%+6px)] after:left-0 after:h-0.5 after:w-4 after:rounded-full after:bg-foreground"
                    : "font-medium text-foreground/80 hover:text-foreground",
                )}
              >
                {item.label}
                {count > 0 ? (
                  <span
                    className="inline-flex h-[18px] items-center rounded-full bg-warning-soft px-1.5 text-[11px] font-semibold text-warning tabular-nums"
                    aria-label={approvalsLabel(count)}
                  >
                    {formatCount(count)}
                  </span>
                ) : null}
              </Link>
            );
          })}
        </nav>

        <div className="ml-auto flex items-center gap-3">
          {simulated ? (
            <>
              <SimulatedBadge dotOnly className="md:hidden" />
              <SimulatedBadge className="hidden md:inline-flex" />
            </>
          ) : null}

          {onHire || !user.canHire ? null : (
            <Link
              href={HIRE_HREF}
              className="hidden h-7 items-center rounded-full bg-primary px-3.5 text-footnote font-medium text-primary-foreground transition-colors duration-200 ease-standard outline-none hover:bg-primary-hover active:bg-primary-active md:inline-flex"
            >
              Hire
            </Link>
          )}

          <span className="hidden md:inline-flex">
            <UserMenu user={user} />
          </span>

          <MobileMenu user={user} pendingApprovals={pendingApprovals} />
        </div>
      </div>
    </header>
  );
}
