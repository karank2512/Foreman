import { readdir } from "node:fs/promises";
import path from "node:path";
import { createElement as h, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeAll, describe, expect, it } from "vitest";
import { can } from "@/server/auth/permissions";
import { loadForSsr } from "../pages/_ssr";

type GlobalNavModule = typeof import("@/components/shell/global-nav");
type ButtonModule = typeof import("@/components/ui/button");
type SelectModule = typeof import("@/components/ui/select");
type StatModule = typeof import("@/components/stat-card");

/**
 * The chrome and primitives rendered the way Next renders them on the server (esbuild + renderToStaticMarkup,
 * see tests/pages/_ssr.ts), for the design QA findings that are about what reaches the page: who sees the Hire
 * pill (design-core-006), the 44px tap boxes under `md` (design-core-012, design-detail-17) and the mobile stat
 * strip (design-core-002). mobile-chrome.test.ts holds the parts that only exist after a click (the portaled menu).
 */

let pathname = "/workforce";
const inert = async () => undefined;
const stubs = {
  "next/navigation": {
    usePathname: () => pathname,
    useRouter: () => ({ push() {}, replace() {}, refresh() {} }),
    useSearchParams: () => new URLSearchParams(),
  },
  "src/app/(auth)/actions": { signOutAction: inert },
};

let nav: GlobalNavModule;
let ui: ButtonModule;
let select: SelectModule;
let stat: StatModule;

beforeAll(async () => {
  [nav, ui, select, stat] = await Promise.all([
    loadForSsr<GlobalNavModule>("src/components/shell/global-nav.tsx", stubs),
    loadForSsr<ButtonModule>("src/components/ui/button.tsx"),
    loadForSsr<SelectModule>("src/components/ui/select.tsx"),
    loadForSsr<StatModule>("src/components/stat-card.tsx"),
  ]);
});

const render = (element: ReactElement) => renderToStaticMarkup(element);
const hrefs = (html: string) => [...html.matchAll(/href="([^"]*)"/g)].map((m) => m[1]);
const classOf = (html: string, marker: string) =>
  [...html.matchAll(/class="([^"]*)"/g)].map((m) => m[1]!).find((c) => c.includes(marker)) ?? "";

function shellFor(role: "OWNER" | "ADMIN" | "MEMBER") {
  return render(
    h(nav.GlobalNav, {
      user: {
        name: "Dana",
        email: "dana@example.test",
        organizationName: "Pentest Shell",
        // Exactly what (app)/layout.tsx passes.
        canHire: can(role, "workers.hire"),
      },
      simulated: false,
      pendingApprovals: 0,
    }),
  );
}

describe("global nav › Hire pill follows workers.hire (design-core-006)", () => {
  it("does not offer a MEMBER the Hire pill, which would land them on a refusal page", () => {
    pathname = "/workforce";
    const html = shellFor("MEMBER");
    expect(hrefs(html)).not.toContain("/hire");
    expect(html).not.toMatch(/>Hire</);
    // The rest of the chrome is unchanged for them.
    for (const href of ["/workforce", "/jobs", "/approvals", "/activity"]) expect(hrefs(html)).toContain(href);
  });

  it("shows it to admins and owners, except on /hire itself", () => {
    pathname = "/workforce";
    for (const role of ["ADMIN", "OWNER"] as const) {
      const html = shellFor(role);
      expect(hrefs(html), role).toContain("/hire");
      expect(html, role).toMatch(/>Hire</);
    }
    pathname = "/hire";
    expect(hrefs(shellFor("OWNER"))).not.toContain("/hire");
  });

  it("gives the wordmark (the way home on a phone) a 44px tap box inside the 48px bar", () => {
    pathname = "/workforce";
    const logo = classOf(shellFor("MEMBER"), "rounded-sm outline-none");
    expect(logo.split(" ")).toEqual(expect.arrayContaining(["flex", "h-11", "items-center"]));
  });
});

describe("44px tap boxes under md (design-core-012, design-detail-17)", () => {
  // An absolute ::before sits on the padding box, so a negative inset sized from the drawn height lost the 1px
  // border on each side (measured 42px on a 36px pill). The band is now a fixed 44px centred on the control.
  const BAND = ["max-md:before:absolute", "max-md:before:top-[calc(50%_-_22px)]", "max-md:before:h-11"];
  const SQUARE = [
    "max-md:before:absolute",
    "max-md:before:top-[calc(50%_-_22px)]",
    "max-md:before:left-[calc(50%_-_22px)]",
    "max-md:before:size-11",
  ];
  const button = (props: Record<string, unknown>) => classOf(render(h(ui.Button, props, "Go")), "group/button");

  it("gives every pill below 44px a 44px band and every icon button a 44px square", () => {
    for (const size of ["xs", "sm", "default"] as const) {
      const cls = button({ size }).split(" ");
      expect(cls, size).toEqual(expect.arrayContaining([...BAND, "max-md:before:inset-x-0", "relative"]));
      expect(cls.some((c) => /before:-inset/.test(c)), `${size} has no inset-based hit area`).toBe(false);
    }
    for (const size of ["icon", "icon-xs", "icon-sm", "icon-lg"] as const) {
      expect(button({ size }).split(" "), size).toEqual(expect.arrayContaining(SQUARE));
    }
  });

  it("leaves 44px+ pills alone and gives text links the band at every size", () => {
    for (const size of ["lg", "xl"] as const) expect(button({ size }), size).not.toContain("max-md:before");
    for (const size of ["sm", "default", "lg", "xl"] as const) {
      const cls = button({ variant: "link", size }).split(" ");
      expect(cls, `link ${size}`).toEqual(expect.arrayContaining([...BAND, "h-auto"]));
    }
  });

  it("gives the 36px sm Select trigger (the Activity worker filter) the same band", () => {
    const trigger = (size: "sm" | "default") =>
      classOf(
        render(h(select.Select, null, h(select.SelectTrigger, { size, "aria-label": "Filter" }, "Everyone"))),
        "data-[size=sm]:h-9",
      ).split(" ");
    expect(trigger("sm")).toEqual(
      expect.arrayContaining([
        "relative",
        "max-md:data-[size=sm]:before:absolute",
        "max-md:data-[size=sm]:before:top-[calc(50%_-_22px)]",
        "max-md:data-[size=sm]:before:h-11",
      ]),
    );
  });
});

describe("stat strip on a phone (design-core-002)", () => {
  it("never truncates the number and hides the sparkline below md", () => {
    const html = render(
      h(stat.Stat, { label: "Spend this month", value: "$1,234.56", trend: { values: [1, 2, 3], label: "up" } }),
    );
    expect(html).toContain("$1,234.56");
    expect(classOf(html, "text-metric")).not.toContain("truncate");
    const spark = [...html.matchAll(/<svg[^>]*class="([^"]*)"/g)].map((m) => m[1]!).find((c) => c.includes("w-20"));
    expect(spark?.split(" ")).toEqual(expect.arrayContaining(["hidden", "md:inline-block"]));
  });
});

describe("repository hygiene (design-core-017, design-detail-24)", () => {
  it("has no Finder-style duplicates (\"page 2.tsx\") or other space-named files under src/ or tests/", async () => {
    const root = path.resolve(import.meta.dirname, "../..");
    const offenders: string[] = [];
    for (const dir of ["src", "tests"]) {
      const entries = await readdir(path.join(root, dir), { recursive: true });
      for (const entry of entries) if (path.basename(entry).includes(" ")) offenders.push(path.join(dir, entry));
    }
    expect(offenders).toEqual([]);
  });
});
