"use client";

import { useEffect } from "react";

/**
 * The <html> attribute that arms the hidden start state of every `[data-reveal]` element (see marketing.css).
 * Exported for the source-contract test; the CSS selector is the real consumer.
 */
export const REVEAL_READY_ATTRIBUTE = "data-reveal-ready";

/**
 * One shared IntersectionObserver for every `[data-reveal]` element on the page.
 *
 * Nothing is hidden until this island has mounted: `marketing.css` keeps every reveal target visible while
 * <html> lacks `data-reveal-ready`, so the first paint — before the client bundle arrives, on a slow network,
 * or if hydration never happens — already shows the whole page. On mount, anything already inside the
 * viewport is marked revealed *before* the attribute is set (same style recalc, so nothing visible ever
 * flashes out), and only the content still below the fold gets the fade-and-rise as it scrolls in.
 * `prefers-reduced-motion` is handled by the tokens (duration 0, distance 0), so there is no motion branch.
 */
export function ScrollReveal() {
  useEffect(() => {
    const root = document.documentElement;
    const targets = [...document.querySelectorAll<HTMLElement>("[data-reveal]:not([data-revealed])")];
    if (targets.length === 0) return;

    // Very old browsers (and some in-app webviews) have no observer: leave everything visible.
    if (typeof IntersectionObserver === "undefined") {
      for (const element of targets) element.dataset.revealed = "";
      return;
    }

    const fold = window.innerHeight;
    const pending: HTMLElement[] = [];
    for (const element of targets) {
      // Any part of the element above the fold counts: it has been painted, so it must not disappear.
      if (element.getBoundingClientRect().top < fold) element.dataset.revealed = "";
      else pending.push(element);
    }
    root.setAttribute(REVEAL_READY_ATTRIBUTE, "");

    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (!entry.isIntersecting) continue;
          (entry.target as HTMLElement).dataset.revealed = "";
          observer.unobserve(entry.target);
        }
      },
      // threshold 0 + a 10% bottom inset: an element reveals as its top crosses 90% of the viewport, which
      // also works for mocks that are taller than the screen (a ratio threshold would never fire on those).
      { threshold: 0, rootMargin: "0px 0px -10% 0px" },
    );

    for (const element of pending) observer.observe(element);
    return () => {
      observer.disconnect();
      root.removeAttribute(REVEAL_READY_ATTRIBUTE);
    };
  }, []);

  return null;
}
