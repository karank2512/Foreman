"use client";

import { useCallback, useEffect, useRef, useState, type CSSProperties } from "react";
import { createPortal } from "react-dom";
import Link from "next/link";
import { LogoGlyph } from "@/components/shell/logo";
import { INK_BAND_ID } from "./section";
import { cn } from "@/lib/utils";

// Literal paths rather than the constants in `@/server/auth/access`: a client component must not
// value-import anything under `@/server` (CLAUDE.md rule 8).
const SIGN_IN_PATH = "/sign-in";
const SIGN_UP_PATH = "/sign-up";
const DEFAULT_SIGNED_IN_PATH = "/workforce";

const SECTION_LINKS = [
  { href: "#how", label: "How it works" },
  { href: "#product", label: "Product" },
  { href: "#security", label: "Security" },
  { href: "#pricing", label: "Pricing" },
] as const;

const FOCUSABLE = 'a[href], button:not([disabled]), [tabindex]:not([tabindex="-1"])';
const NAV_HEIGHT = 48;

export interface MarketingNavProps {
  /** A visitor with a live session gets one "Open workforce" pill instead of the two signed-out CTAs. */
  signedIn: boolean;
  /** Hide the in-page section links (the auth pages reuse the bar without the landing sections). */
  showSections?: boolean;
}

/**
 * The frosted 48px marketing bar. Client-side for three reasons only: the mobile panel, the Escape/focus
 * handling, and the colour flip while the dark band sits under the bar.
 *
 * The mobile panel is portaled to `document.body`. The bar's `backdrop-filter` turns the <header> into the
 * containing block for any `position: fixed` descendant, so a panel rendered inside it would resolve
 * `top`/`bottom` against the 48px bar (a 64px strip) instead of the viewport.
 */
export function MarketingNav({ signedIn, showSections = true }: MarketingNavProps) {
  const [onInk, setOnInk] = useState(false);
  const [open, setOpen] = useState(false);
  const [entered, setEntered] = useState(false);
  const panel = useRef<HTMLDivElement>(null);

  const close = useCallback(() => setOpen(false), []);

  // Invert the bar while the ink band is the thing directly beneath it. A rAF-throttled scroll read is
  // steadier here than an IntersectionObserver, whose rootMargin would need recomputing on every resize.
  useEffect(() => {
    if (!showSections) return;
    const band = document.getElementById(INK_BAND_ID);
    if (!band) return;

    let frame = 0;
    const measure = () => {
      frame = 0;
      const { top, bottom } = band.getBoundingClientRect();
      setOnInk(top <= NAV_HEIGHT && bottom > NAV_HEIGHT);
    };
    const schedule = () => {
      if (frame === 0) frame = requestAnimationFrame(measure);
    };

    measure();
    window.addEventListener("scroll", schedule, { passive: true });
    window.addEventListener("resize", schedule);
    return () => {
      if (frame !== 0) cancelAnimationFrame(frame);
      window.removeEventListener("scroll", schedule);
      window.removeEventListener("resize", schedule);
    };
  }, [showSections]);

  useEffect(() => {
    if (!open) {
      setEntered(false);
      return;
    }
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

  // While the panel is open the bar sits on the panel's own material, so it stops inverting.
  const inverted = onInk && !open;

  let row = 0;
  const stagger = (): { className: string; style: CSSProperties } => ({
    className: cn(
      "transition-[opacity,transform] duration-[280ms] ease-out [transition-delay:calc(var(--i)*20ms)] motion-reduce:[transition-delay:0ms]",
      entered ? "translate-y-0 opacity-100" : "-translate-y-2 opacity-0 motion-reduce:translate-y-0",
    ),
    style: { "--i": row++ } as CSSProperties,
  });

  return (
    <header
      data-inverted={inverted ? "" : undefined}
      className={cn(
        "sticky top-0 z-40 h-(--nav-height) backdrop-blur-[20px] backdrop-saturate-[180%] transition-colors duration-200 ease-standard",
        inverted
          ? "bg-[rgb(22_22_23_/_0.8)] text-white shadow-[inset_0_-0.5px_0_rgb(255_255_255_/_0.14)]"
          : "bg-[rgb(251_251_253_/_0.8)] text-foreground shadow-[inset_0_-0.5px_0_var(--hairline)]",
      )}
    >
      <div className="mx-auto flex h-full w-full max-w-(--container-app) items-center gap-6 px-4 sm:px-6">
        <Link href="/" className="inline-flex min-h-11 items-center gap-2 rounded-sm outline-none" onClick={close}>
          <LogoGlyph className="text-current" />
          <span className="text-[15px] leading-none font-semibold tracking-[-0.02em] whitespace-nowrap">Foreman</span>
        </Link>

        {showSections ? (
          <nav aria-label="Sections" className="ml-2 hidden items-center gap-7 md:flex">
            {SECTION_LINKS.map((link) => (
              <a
                key={link.href}
                href={link.href}
                className="text-footnote rounded-sm font-medium opacity-80 transition-opacity duration-200 ease-standard outline-none hover:opacity-100"
              >
                {link.label}
              </a>
            ))}
          </nav>
        ) : null}

        <div className="ml-auto hidden items-center gap-4 md:flex">
          {signedIn ? (
            <Link
              href={DEFAULT_SIGNED_IN_PATH}
              className="text-footnote inline-flex h-7 items-center rounded-full bg-primary px-3.5 font-medium text-primary-foreground transition-colors duration-200 ease-standard outline-none hover:bg-primary-hover active:bg-primary-active"
            >
              Open workforce
            </Link>
          ) : (
            <>
              <Link
                href={SIGN_IN_PATH}
                className="text-footnote rounded-sm font-medium opacity-80 transition-opacity duration-200 ease-standard outline-none hover:opacity-100"
              >
                Sign in
              </Link>
              <Link
                href={SIGN_UP_PATH}
                className="text-footnote inline-flex h-7 items-center rounded-full bg-primary px-3.5 font-medium text-primary-foreground transition-colors duration-200 ease-standard outline-none hover:bg-primary-hover active:bg-primary-active"
              >
                Get started
              </Link>
            </>
          )}
        </div>

        <button
          type="button"
          aria-expanded={open}
          aria-controls="marketing-menu"
          aria-label={open ? "Close menu" : "Open menu"}
          onClick={() => setOpen((v) => !v)}
          className="-mr-2 ml-auto flex size-11 items-center justify-center rounded-full outline-none md:hidden"
        >
          <span aria-hidden="true" className="relative block h-[9px] w-4">
            <span
              className={cn(
                "absolute inset-x-0 top-0 block h-[1.5px] rounded-full bg-current transition-transform duration-[240ms] ease-standard",
                open && "translate-y-[3.75px] rotate-45",
              )}
            />
            <span
              className={cn(
                "absolute inset-x-0 bottom-0 block h-[1.5px] rounded-full bg-current transition-transform duration-[240ms] ease-standard",
                open && "-translate-y-[3.75px] -rotate-45",
              )}
            />
          </span>
        </button>
      </div>

      {open
        ? createPortal(
            <div
              id="marketing-menu"
              ref={panel}
              role="dialog"
              aria-modal="true"
              aria-label="Menu"
              className={cn(
                "fixed inset-x-0 top-(--nav-height) bottom-0 z-40 flex flex-col overflow-y-auto bg-[rgb(251_251_253_/_0.96)] px-4 pt-8 pb-8 text-foreground backdrop-blur-[20px] backdrop-saturate-[180%] transition-opacity duration-[280ms] ease-out md:hidden",
                entered ? "opacity-100" : "opacity-0",
              )}
            >
              {showSections ? (
                <nav aria-label="Sections" className="flex flex-col gap-3">
                  {SECTION_LINKS.map((link) => {
                    const motion = stagger();
                    return (
                      <a
                        key={link.href}
                        href={link.href}
                        onClick={close}
                        className={cn(
                          "flex min-h-11 w-fit items-center text-[28px] leading-tight font-semibold tracking-[-0.015em]",
                          motion.className,
                        )}
                        style={motion.style}
                      >
                        {link.label}
                      </a>
                    );
                  })}
                </nav>
              ) : null}

              <div className="mt-auto pt-10">
                {signedIn ? (
                  <Link
                    href={DEFAULT_SIGNED_IN_PATH}
                    onClick={close}
                    className="flex h-12 w-full items-center justify-center rounded-full bg-primary text-[17px] font-medium text-primary-foreground transition-colors duration-200 ease-standard hover:bg-primary-hover"
                  >
                    Open workforce
                  </Link>
                ) : (
                  <>
                    <Link
                      href={SIGN_UP_PATH}
                      onClick={close}
                      className="flex h-12 w-full items-center justify-center rounded-full bg-primary text-[17px] font-medium text-primary-foreground transition-colors duration-200 ease-standard hover:bg-primary-hover"
                    >
                      Get started
                    </Link>
                    <Link
                      href={SIGN_IN_PATH}
                      onClick={close}
                      className="mt-3 flex h-12 w-full items-center justify-center rounded-full bg-secondary text-[17px] font-medium text-secondary-foreground transition-colors duration-200 ease-standard hover:bg-secondary-hover"
                    >
                      Sign in
                    </Link>
                  </>
                )}
              </div>
            </div>,
            document.body,
          )
        : null}
    </header>
  );
}
