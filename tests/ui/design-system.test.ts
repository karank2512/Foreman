import { readFile, readdir } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { SCORE_BAND_CLASSES, TONE_CLASSES } from "@/lib/status";

/**
 * The design system lives in CSS and JSX, which this suite cannot render (vitest compiles `.ts` only). What it
 * *can* do is hold the contract in docs/DESIGN.md to the source: the tokens that must exist, the tells the
 * redesign removes, and the security requirement that the root layout reads the CSP nonce.
 */

const root = new URL("../../", import.meta.url);
const read = (path: string) => readFile(new URL(path, root), "utf8");

async function walk(dir: string): Promise<string[]> {
  const entries = await readdir(new URL(dir, root), { withFileTypes: true });
  const files = await Promise.all(
    entries.map(async (e) => {
      if (e.name === "node_modules") return [];
      if (e.isDirectory()) return walk(`${dir}${e.name}/`);
      return e.name.endsWith(".tsx") || e.name.endsWith(".ts") ? [`${dir}${e.name}`] : [];
    }),
  );
  return files.flat();
}

describe("tokens (src/app/globals.css)", () => {
  it("uses the one blue accent and no indigo or violet brand colour", async () => {
    const css = await read("src/app/globals.css");
    expect(css).toContain("--primary: #0071e3");
    expect(css).toContain("--link: #0066cc");
    expect(css).toContain("--background: #ffffff");
    expect(css).toContain("--surface-secondary: #f5f5f7");
    // The old brand was an oklch indigo-violet; nothing in the token layer may reintroduce it.
    expect(css).not.toMatch(/--primary:\s*oklch/);
    expect(css.toLowerCase()).not.toContain("indigo");
  });

  it("declares every status, radius, elevation and motion token pages depend on", async () => {
    const css = await read("src/app/globals.css");
    for (const token of [
      "--success:",
      "--warning:",
      "--danger:",
      "--info:",
      "--hairline:",
      "--text-tertiary:",
      "--radius-xl: 18px",
      "--radius-2xl: 22px",
      "--elev-1:",
      "--elev-3:",
      "--focus-ring:",
      "--motion-ease-out:",
      "--nav-height: 48px",
      "--localnav-height: 52px",
      "--container-app: 1200px",
    ]) {
      expect(css, token).toContain(token);
    }
  });

  it("defines the full type scale as utilities so pages never hand-roll sizes", async () => {
    const css = await read("src/app/globals.css");
    for (const role of [
      "display-xl",
      "display",
      "headline",
      "title-1",
      "title-2",
      "title-3",
      "body-lg",
      "body",
      "body-app",
      "callout",
      "footnote",
      "caption",
      "metric-xl",
      "metric",
    ]) {
      expect(css, role).toContain(`@utility text-${role} {`);
    }
    // `metric` (tabular-nums only) stays, because pages already use it on numeric cells.
    expect(css).toContain("@utility metric {");
  });

  it("keeps the eyebrow label sentence case — the uppercase micro-label is one of the tells", async () => {
    const css = await read("src/app/globals.css");
    const eyebrow = css.slice(css.indexOf("@utility eyebrow {"));
    const body = eyebrow.slice(0, eyebrow.indexOf("}"));
    expect(body).not.toContain("uppercase");
    expect(body).toContain("letter-spacing: 0");
  });

  it("ships the frosted materials with an opaque fallback", async () => {
    const css = await read("src/app/globals.css");
    expect(css).toContain("@utility material-nav {");
    expect(css).toContain("@utility material-thick {");
    expect(css).toContain("@supports not ((backdrop-filter: blur(1px))");
  });

  it("honours prefers-reduced-motion at the token level and as a safety net", async () => {
    const css = await read("src/app/globals.css");
    expect(css).toContain("@media (prefers-reduced-motion: reduce)");
    expect(css).toContain("--reveal-distance: 0px");
    expect(css).toContain("animation-iteration-count: 1 !important");
  });

  it("gives focus a blue halo and hides the scroll-reveal only where scripting can undo it", async () => {
    const css = await read("src/app/globals.css");
    expect(css).toContain("box-shadow: var(--focus-ring)");
    expect(css).toContain("@media (scripting: enabled)");
    expect(css).toContain("[data-reveal][data-revealed]");
  });
});

describe("root layout (src/app/layout.tsx)", () => {
  it("is async and reads the CSP nonce, so every route renders dynamically", async () => {
    const source = await read("src/app/layout.tsx");
    expect(source).toContain('from "next/headers"');
    expect(source).toContain("export default async function RootLayout");
    expect(source).toMatch(/await headers\(\)\)\.get\("x-nonce"\)/);
  });

  it("wires Inter as the non-system fallback and ships no third-party display font", async () => {
    const source = await read("src/app/layout.tsx");
    expect(source).toContain('Inter } from "next/font/google"');
    expect(source).toContain('variable: "--font-inter"');
    expect(source).not.toContain("Geist");
  });

  it("sets the title template and a light theme colour", async () => {
    const source = await read("src/app/layout.tsx");
    expect(source).toContain('template: "%s · Foreman"');
    expect(source).toContain('applicationName: "Foreman"');
    expect(source).not.toContain("AI Staffing");
    expect(source).toContain('themeColor: "#ffffff"');
    expect(await read("src/app/(app)/layout.tsx")).toContain('themeColor: "#f5f5f7"');
  });
});

describe("app shell", () => {
  it("replaced the left sidebar with the frosted top nav", async () => {
    const shell = await read("src/components/app-shell.tsx");
    expect(shell).toContain("GlobalNav");
    expect(shell).not.toContain("SidebarNav");
    expect(shell).toContain('href="#main"'); // the skip link is still the first focusable element
    const files = await readdir(new URL("src/components/shell/", root));
    expect(files).toContain("global-nav.tsx");
    expect(files).toContain("mobile-menu.tsx");
    expect(files).toContain("local-nav.tsx");
    expect(files).not.toContain("sidebar-nav.tsx");
    expect(files).not.toContain("mobile-nav.tsx");
  });

  it("carries the brand's own monochrome glyph, with no tile and no borrowed mark", async () => {
    const logo = await read("src/components/shell/logo.tsx");
    expect(logo).toContain("Foreman");
    expect(logo).not.toContain("AI Staffing");
    expect(logo).not.toContain("bg-primary");
    expect(logo).not.toContain("uppercase");
  });

  it("sets one full-length wordmark at every width — the name needs no short form", async () => {
    const logo = await read("src/components/shell/logo.tsx");
    expect(logo).not.toMatch(/\bshort\b/);
    const nav = await read("src/components/shell/global-nav.tsx");
    expect(nav.match(/<Wordmark\b/g)).toHaveLength(1);
    expect(nav).toContain('aria-label="Foreman — go to Workforce"');
    expect(nav).not.toContain("sr-only\">Foreman");
    const marketing = await read("src/app/(marketing)/_components/marketing-nav.tsx");
    expect(marketing).toMatch(/whitespace-nowrap">Foreman<\/span>/);
    expect(marketing).not.toContain("AI Staffing");
  });

  it("locks body scroll and traps focus while the mobile menu is open", async () => {
    const menu = await read("src/components/shell/mobile-menu.tsx");
    expect(menu).toContain('document.body.style.overflow = "hidden"');
    expect(menu).toContain('event.key === "Escape"');
    expect(menu).toContain('aria-modal="true"');
  });
});

describe("status and score tones", () => {
  it("maps every tone onto the design tokens, not Tailwind palette shades", () => {
    const shades = /\b(emerald|amber|rose|sky|slate|indigo|violet)-/;
    for (const [tone, classes] of Object.entries(TONE_CLASSES)) {
      for (const [role, value] of Object.entries(classes)) {
        expect(value, `${tone}.${role}`).not.toMatch(shades);
      }
    }
    expect(TONE_CLASSES.success.dot).toBe("bg-success");
    expect(TONE_CLASSES.attention.dot).toBe("bg-warning");
    expect(TONE_CLASSES.failure.dot).toBe("bg-danger");
    expect(TONE_CLASSES.running.dot).toBe("bg-info");
  });

  it("uses the agreed band words for scores", () => {
    expect(SCORE_BAND_CLASSES.good.label).toBe("Strong");
    expect(SCORE_BAND_CLASSES.fair.label).toBe("Watch");
    expect(SCORE_BAND_CLASSES.poor.label).toBe("At risk");
    for (const band of Object.values(SCORE_BAND_CLASSES)) {
      expect(band.stroke).not.toMatch(/\b(emerald|amber|rose|slate)-/);
    }
  });
});

describe("shared components", () => {
  it("shows one status per object as a dot plus a word", async () => {
    const badge = await read("src/components/status-badge.tsx");
    expect(badge).toContain("size-[7px]");
    expect(badge).toContain('emphasis = "auto"');
  });

  it("drops the flask icon and dashed border from the Simulated marker", async () => {
    const simulated = await read("src/components/simulated-badge.tsx");
    expect(simulated).not.toContain("FlaskConical");
    expect(simulated).not.toContain("border-dashed");
  });

  it("keeps StatCard's props source-compatible while the strip becomes the real layout", async () => {
    const stat = await read("src/components/stat-card.tsx");
    expect(stat).toContain("export function StatStrip");
    expect(stat).toContain("export function Stat(");
    expect(stat).toContain("export function StatCard");
    expect(stat).toContain("icon?: IconProp"); // accepted, deliberately not rendered
  });

  it("gives cards a soft shadow instead of a ring, and no card gets both", async () => {
    const card = await read("src/components/ui/card.tsx");
    expect(card).toContain("shadow-card");
    expect(card).not.toContain("ring-1");
  });

  it("makes every button a pill with no lift on press", async () => {
    const button = await read("src/components/ui/button.tsx");
    expect(button).toContain("rounded-full");
    expect(button).not.toContain("translate-y-px");
    for (const size of ["xs:", "sm:", "default:", "lg:", "xl:"]) expect(button, size).toContain(size);
  });
});

describe("no AI-generated tells in the shared UI", () => {
  // Scoped to the shared kit and the chrome this workstream owns; the page redesigns land in wave C.
  it("keeps emoji and the sparkle icon out of every shared component", async () => {
    const files = [
      ...(await walk("src/components/")),
      "src/app/layout.tsx",
      "src/app/global-error.tsx",
      "src/app/not-found.tsx",
      "src/app/(app)/layout.tsx",
      "src/app/(app)/error.tsx",
      "src/app/(app)/not-found.tsx",
      "src/app/(app)/loading.tsx",
      "src/app/(dev)/styleguide/page.tsx",
    ];
    const emoji = /\p{Extended_Pictographic}/u;
    for (const file of files) {
      const source = await read(file);
      expect(source, file).not.toMatch(emoji);
      expect(source, file).not.toContain("Sparkles");
    }
  });

  it("puts no icon on a nav item, a stat or a status", async () => {
    for (const file of [
      "src/components/shell/nav-items.ts",
      "src/components/shell/global-nav.tsx",
      "src/components/status-badge.tsx",
    ]) {
      expect(await read(file), file).not.toContain("lucide-react");
    }
  });
});
