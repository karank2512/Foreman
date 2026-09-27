"use client";

import { useCallback, useEffect, useRef, useState, type CSSProperties } from "react";
import { createPortal } from "react-dom";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { signOutAction } from "@/app/(auth)/actions";
import {
  ACCOUNT_ITEMS,
  HIRE_HREF,
  NAV_ITEMS,
  approvalsLabel,
  formatCount,
  isActivePath,
} from "@/components/shell/nav-items";
import type { ShellUser } from "@/components/shell/user-menu";
import { cn } from "@/lib/utils";

export interface MobileMenuProps {
  user: ShellUser;
  pendingApprovals: number;
}

const FOCUSABLE = 'a[href], button:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * Under `md` the four destinations live behind a two-line menu button that morphs into an X. The panel is a
 * full-screen frosted overlay under the bar: body scroll is locked, focus is trapped, and it closes on Escape
 * or on any navigation.
 *
 * The panel is portaled to `document.body` rather than rendered next to the button. The bar is `material-nav`,
 * and `backdrop-filter` makes an element the containing block for its fixed-position descendants — inside the
 * header, `top: 48px; bottom: 0` resolves against the 48px bar and the "full-screen" menu is a 64px strip.
 *
 * Every row is at least 44px tall (the mobile touch minimum) while the text keeps the 28px / 17px rhythm.
 */
export function MobileMenu({ user, pendingApprovals }: MobileMenuProps) {
  const [open, setOpen] = useState(false);
  const [entered, setEntered] = useState(false);
  const pathname = usePathname() ?? "";
  const panel = useRef<HTMLDivElement>(null);

  const close = useCallback(() => setOpen(false), []);

  // Navigation (including a redirect after an action) always dismisses the panel.
  useEffect(() => {
    setOpen(false);
  }, [pathname]);

  useEffect(() => {
    if (!open) {
      setEntered(false);
      return;
    }
    // One frame in the closed state first, so the enter transition actually runs.
    const raf = requestAnimationFrame(() => setEntered(true));
    const { overflow } = document.body.style;
    document.body.style.overflow = "hidden";
    return () => {
      cancelAnimationFrame(raf);
      document.body.style.overflow = overflow;
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    panel.current?.querySelector<HTMLElement>(FOCUSABLE)?.focus();

    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        event.preventDefault();
        setOpen(false);
        return;
      }
      if (event.key !== "Tab" || !panel.current) return;
      const items = [...panel.current.querySelectorAll<HTMLElement>(FOCUSABLE)];
      const first = items[0];
      const last = items[items.length - 1];
      if (!first || !last) return;
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    }

    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [open]);

  let row = 0;
  const enter = (): { className: string; style: CSSProperties } => ({
    className: cn(
      "transition-[opacity,transform] duration-[280ms] ease-out [transition-delay:calc(var(--i)*20ms)] motion-reduce:[transition-delay:0ms]",
      entered ? "translate-y-0 opacity-100" : "-translate-y-2 opacity-0 motion-reduce:translate-y-0",
    ),
    style: { "--i": row++ } as CSSProperties,
  });

  const overlay = open ? (
    <div
      id="mobile-menu"
      ref={panel}
      role="dialog"
      aria-modal="true"
      aria-label="Menu"
      className={cn(
        "fixed inset-x-0 top-(--nav-height) bottom-0 z-40 flex flex-col overflow-y-auto bg-[rgb(251_251_253_/_0.96)] px-4 pt-7 pb-8 backdrop-blur-[20px] backdrop-saturate-[180%] transition-opacity duration-[280ms] ease-out md:hidden",
        entered ? "opacity-100" : "opacity-0",
      )}
    >
      <nav aria-label="Main" className="flex flex-col gap-1">
        {NAV_ITEMS.map((item) => {
          const active = isActivePath(pathname, item.match);
          const count = item.badge === "pendingApprovals" ? pendingApprovals : 0;
          const motion = enter();
          return (
            <Link
              key={item.href}
              href={item.href}
              aria-current={active ? "page" : undefined}
              onClick={close}
              className={cn(
                "flex min-h-11 w-fit items-center gap-2.5 text-[28px] leading-tight font-semibold tracking-[-0.015em]",
                active ? "text-foreground" : "text-foreground/80",
                motion.className,
              )}
              style={motion.style}
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

      <nav aria-label="Account" className="mt-5 flex flex-col">
        {ACCOUNT_ITEMS.map((item) => {
          const motion = enter();
          return (
            <Link
              key={item.href}
              href={item.href}
              onClick={close}
              className={cn(
                "flex min-h-11 w-fit items-center text-[17px] font-medium text-muted-foreground",
                motion.className,
              )}
              style={motion.style}
            >
              {item.label}
            </Link>
          );
        })}
      </nav>

      <div className="mt-auto pt-10">
        {user.canHire ? (
          <Link
            href={HIRE_HREF}
            onClick={close}
            className="flex h-12 w-full items-center justify-center rounded-full bg-primary text-[17px] font-medium text-primary-foreground transition-colors duration-200 ease-standard hover:bg-primary-hover"
          >
            Hire a worker
          </Link>
        ) : null}
        <div className="mt-5 flex items-end justify-between gap-4 text-footnote">
          <div className="min-w-0">
            <p className="truncate font-medium text-foreground">{user.organizationName}</p>
            <p className="truncate text-muted-foreground">{user.email}</p>
          </div>
          <form action={signOutAction}>
            {/* Negative margins keep the 13px line where it was; the padding gives the tap a 44px box. */}
            <button type="submit" className="-my-3 -mr-2 flex min-h-11 items-center px-2 font-medium text-link">
              Sign out
            </button>
          </form>
        </div>
      </div>
    </div>
  ) : null;

  return (
    <>
      <button
        type="button"
        aria-expanded={open}
        aria-controls="mobile-menu"
        aria-label={open ? "Close menu" : "Open menu"}
        onClick={() => setOpen((v) => !v)}
        className="-mr-2 flex size-11 items-center justify-center rounded-full outline-none md:hidden"
      >
        <span aria-hidden="true" className="relative block h-[9px] w-4">
          <span
            className={cn(
              "absolute inset-x-0 top-0 block h-[1.5px] rounded-full bg-foreground transition-transform duration-[240ms] ease-standard",
              open && "translate-y-[3.75px] rotate-45",
            )}
          />
          <span
            className={cn(
              "absolute inset-x-0 bottom-0 block h-[1.5px] rounded-full bg-foreground transition-transform duration-[240ms] ease-standard",
              open && "-translate-y-[3.75px] -rotate-45",
            )}
          />
        </span>
      </button>

      {/* `open` only becomes true after a click, so `document` exists whenever the portal renders. */}
      {overlay && typeof document !== "undefined" ? createPortal(overlay, document.body) : null}
    </>
  );
}
