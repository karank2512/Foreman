import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

/**
 * Regression guards for the mobile chrome fixes (design-core-001/002/006/007/012/015, design-detail-02/17).
 * Vitest cannot render `.tsx` here (jsx is `preserve` and the config is frozen), so like design-system.test.ts
 * these hold the contract in the source: the shapes that were measured broken in a real browser at 390×844.
 */

const root = new URL("../../", import.meta.url);
const read = (path: string) => readFile(new URL(path, root), "utf8");

describe("mobile menu (src/components/shell/mobile-menu.tsx)", () => {
  it("portals the overlay to document.body so the frosted bar cannot become its containing block", async () => {
    const menu = await read("src/components/shell/mobile-menu.tsx");
    // `backdrop-filter` on the header made a fixed descendant resolve `bottom: 0` against the 48px bar (64px strip).
    expect(menu).toContain('import { createPortal } from "react-dom"');
    expect(menu).toMatch(/createPortal\(overlay, document\.body\)/);
    // The overlay itself still spans from under the bar to the bottom of the viewport.
    expect(menu).toContain("fixed inset-x-0 top-(--nav-height) bottom-0");
    // The header never contains the panel: the only element rendered inline is the toggle button.
    const inlineReturn = menu.slice(menu.lastIndexOf("return ("));
    expect(inlineReturn).not.toContain('id="mobile-menu"');
    expect(inlineReturn).toContain('aria-controls="mobile-menu"');
  });

  it("keeps every row at least 44px tall, including Usage/Settings and Sign out", async () => {
    const menu = await read("src/components/shell/mobile-menu.tsx");
    const rows = [...menu.matchAll(/className=\{?cn\(\s*"([^"]+)"|className="([^"]+)"/g)].map((m) => m[1] ?? m[2]);
    const primary = rows.find((r) => r?.includes("text-[28px]"));
    const account = rows.find((r) => r?.includes("text-[17px] font-medium text-muted-foreground"));
    const signOut = rows.find((r) => r?.includes("text-link"));
    expect(primary).toContain("min-h-11");
    expect(account).toContain("min-h-11");
    expect(signOut).toContain("min-h-11");
  });
});

describe("Hire actions follow the role matrix (workers.hire is ADMIN+)", () => {
  it("passes canHire from the layout, computed with can()", async () => {
    const layout = await read("src/app/(app)/layout.tsx");
    expect(layout).toContain('import { can } from "@/server/auth/permissions"');
    expect(layout).toContain('canHire: can(s.role, "workers.hire")');
    expect(await read("src/components/shell/user-menu.tsx")).toContain("canHire: boolean");
  });

  it("hides the Hire pill and 'Hire a worker' unless the user can hire", async () => {
    const nav = await read("src/components/shell/global-nav.tsx");
    expect(nav).toContain("onHire || !user.canHire ? null");
    const menu = await read("src/components/shell/mobile-menu.tsx");
    const hire = menu.slice(menu.indexOf("Hire a worker") - 400, menu.indexOf("Hire a worker"));
    expect(hire).toContain("user.canHire ?");
  });
});

describe("worker avatar (src/components/worker-avatar.tsx)", () => {
  it("renders no purple: violet/indigo tokens map onto other pastels and unknowns fall back to gray", async () => {
    const avatar = await read("src/components/worker-avatar.tsx");
    expect(avatar).not.toMatch(/\b(bg|text)-(violet|indigo|purple|fuchsia)-\d+/);
    expect(avatar).toContain('violet: "bg-lime-100');
    expect(avatar).toContain('indigo: "bg-cyan-100');
    expect(avatar).toContain('const FALLBACK_CLASSES = "bg-secondary text-muted-foreground"');
    expect(avatar).not.toContain("FALLBACK_COLOR");
  });
});

describe("stat strip (src/components/stat-card.tsx)", () => {
  it("never truncates the metric and drops the sparkline in the 2×2 mobile layout", async () => {
    const stat = await read("src/components/stat-card.tsx");
    const value = stat.match(/className="([^"]*text-metric[^"]*)"/)?.[1] ?? "";
    expect(value).not.toContain("truncate");
    expect(value).toContain("min-w-0");
    const spark = stat.match(/<Sparkline[^>]*className="([^"]+)"/)?.[1] ?? "";
    expect(spark).toContain("hidden");
    expect(spark).toContain("md:inline-block");
    expect(stat).toContain("p-5 md:p-6");
  });
});

describe("44px touch targets under md", () => {
  it("gives every button size below 44px an invisible hit area (rendered classes: shell-render.test.ts)", async () => {
    const button = await read("src/components/ui/button.tsx");
    expect(button).toMatch(/"group\/button relative inline-flex/);
    // Only the `size` block — the `variant` block has its own `default:` line.
    const sizes = button.slice(button.indexOf("size: {"), button.indexOf("compoundVariants")).split("\n");
    for (const size of ["xs:", "sm:", "default:"]) {
      expect(sizes.find((l) => l.trim().startsWith(size)) ?? "", size).toContain("${HIT_AREA}");
    }
    for (const size of ["icon:", '"icon-xs":', '"icon-sm":', '"icon-lg":']) {
      expect(sizes.find((l) => l.trim().startsWith(size)) ?? "", size).toContain("${HIT_SQUARE}");
    }
    // lg/xl are already 44px+ and must not grow further.
    for (const size of ["lg:", "xl:"]) {
      const line = sizes.find((l) => l.trim().startsWith(size)) ?? "";
      expect(line, size).not.toContain("HIT_");
      expect(line, size).not.toContain("max-md:before");
    }
    // A fixed 44px box, not an inset derived from the drawn height (which lost the 1px border: 42px measured).
    expect(button).not.toMatch(/max-md:before:-inset/);
    expect(button).toContain("max-md:before:h-11");
    expect(button).toContain("max-md:before:size-11");
  });

  it("makes segmented options, local-nav links and the back link tappable", async () => {
    expect(await read("src/components/ui/tabs.tsx")).toContain("max-md:before:-inset-y-2");
    const localNav = await read("src/components/shell/local-nav.tsx");
    expect(localNav).toContain("flex h-full shrink-0 items-center");
    const header = await read("src/components/page-header.tsx");
    expect(header).toContain("max-md:-my-3.5 max-md:py-3.5");
  });
});

describe("root layout", () => {
  it("declares its smooth scrolling to Next.js so route transitions stay silent", async () => {
    const layout = await read("src/app/layout.tsx");
    expect(layout).toContain('data-scroll-behavior="smooth"');
    expect(await read("src/app/globals.css")).toContain("scroll-behavior: smooth");
  });
});
