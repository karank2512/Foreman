import { readFile, readdir } from "node:fs/promises";
import { describe, expect, it } from "vitest";

/**
 * The public landing page, held to its source. Vitest compiles `.ts` only (tsconfig keeps `jsx: preserve` for
 * Next), so nothing here mounts. The live checks — the open menu panel filling the viewport below the bar,
 * a 390px page with no sideways scroll, absolute og:url / og:image tags, a PNG set in Inter — were made
 * against a running server; these assertions pin the code that produced them.
 */

const root = new URL("../../", import.meta.url);
const read = (path: string) => readFile(new URL(path, root), "utf8");
const MARKETING = "src/app/(marketing)/";
const COMPONENTS = `${MARKETING}_components/`;

describe("share metadata (design-public-auth-003)", () => {
  it("sets an absolute metadataBase in the marketing and auth layouts, so og:url and canonical resolve", async () => {
    for (const layout of [`${MARKETING}layout.tsx`, "src/app/(auth)/layout.tsx"]) {
      expect(await read(layout), layout).toMatch(/metadataBase:\s*new URL\(config\.publicUrl \?\? /);
    }
  });

  it("attaches the generated card image to both the Open Graph and Twitter objects", async () => {
    const page = await read(`${MARKETING}page.tsx`);
    expect(page).toMatch(/const SHARE_IMAGE = \{\s*url: "\/opengraph-image",\s*width: 1200,\s*height: 630,/);
    const openGraph = page.slice(page.indexOf("openGraph: {"), page.indexOf("twitter: {"));
    const twitter = page.slice(page.indexOf("twitter: {"));
    // A page-level `openGraph` object replaces the root's whole object, images included, so each lists it.
    expect(openGraph).toContain("images: [SHARE_IMAGE]");
    expect(twitter).toContain('card: "summary_large_image"');
    expect(twitter).toContain("images: [SHARE_IMAGE]");
  });
});

describe("share image (src/app/opengraph-image.tsx, design-public-auth-010)", () => {
  it("hands Inter to the renderer instead of leaving the card on the default sans", async () => {
    const source = await read("src/app/opengraph-image.tsx");
    expect(source).toContain("export const size = { width: 1200, height: 630 }");
    expect(source).toContain('name: "Inter"');
    expect(source).toMatch(/fontFamily:[^\n]*"Inter"/);
    expect(source).toMatch(/new ImageResponse\([\s\S]*\{ \.\.\.size, fonts \},?\s*\)/);
    // A font that cannot be fetched degrades to the default face; it never fails the request.
    expect(source).toMatch(/\.catch\(\(\) => \[\]\)/);
  });
});

describe("mobile menu (design-public-auth-001)", () => {
  it("portals the full-screen panel to <body>, outside the backdrop-filtered bar", async () => {
    const source = await read(`${COMPONENTS}marketing-nav.tsx`);
    expect(source).toContain('import { createPortal } from "react-dom"');
    // The dialog must be the portal's own child: a `position: fixed` panel rendered inside the blurred
    // <header> sizes itself against the 48px bar (a 64px strip) instead of the viewport.
    expect(source).toMatch(/createPortal\(\s*<div\s+id="marketing-menu"/);
    expect(source).toMatch(/<\/div>,\s*document\.body,?\s*\)/);
    // The portal is the fix — the bar keeps its frosted material.
    expect(source).toContain("backdrop-blur-[20px]");
  });
});

describe("phone-width layout (design-public-auth-004)", () => {
  it("gives every responsive marketing grid an explicit phone track, never an implicit auto track", async () => {
    const files = (await readdir(new URL(COMPONENTS, root))).filter((file) => file.endsWith(".tsx"));
    expect(files.length).toBeGreaterThan(0);
    let checked = 0;
    for (const file of files) {
      const source = await read(`${COMPONENTS}${file}`);
      // Every class list that switches column count at a breakpoint must also set the unprefixed track:
      // `grid-cols-1` is minmax(0,1fr), which clamps to the container; `auto` grows to a nowrap child.
      for (const match of source.matchAll(/"([^"\n]*\b(?:sm|md|lg|xl):grid-cols-\d[^"\n]*)"/g)) {
        checked += 1;
        expect(match[1], `${file}: ${match[1]}`).toMatch(/(?:^|\s)grid-cols-\d/);
      }
    }
    expect(checked).toBeGreaterThan(0);
  });

  it("lets the grid children that hold mocks shrink below their content", async () => {
    for (const file of ["feature-row.tsx", "review-tiles.tsx", "how-it-works.tsx", "pricing-teaser.tsx", "trust.tsx"]) {
      expect(await read(`${COMPONENTS}${file}`), file).toContain("min-w-0");
    }
  });
});

describe("scroll reveal (design-public-auth-011)", () => {
  it("keeps the hero out of the reveal, so the headline and calls to action are the first paint", async () => {
    const hero = await read(`${COMPONENTS}hero.tsx`);
    expect(hero).not.toContain("reveal(");
    expect(hero).not.toContain("data-reveal");
    expect(hero).toContain("marketing-hero-rise");
  });

  it("hides nothing until the island has mounted and stamped <html data-reveal-ready>", async () => {
    const island = await read(`${COMPONENTS}reveal.tsx`);
    expect(island).toContain('export const REVEAL_READY_ATTRIBUTE = "data-reveal-ready"');
    const css = await read(`${MARKETING}marketing.css`);
    const selector = "html:not([data-reveal-ready]) [data-reveal]";
    expect(css).toContain(selector);
    const body = css.slice(css.indexOf(selector), css.indexOf("}", css.indexOf(selector)));
    expect(body).toContain("opacity: 1");
    expect(body).toContain("transform: none");
    expect(await read(`${MARKETING}layout.tsx`)).toContain('import "./marketing.css"');
  });

  it("marks what is already on screen as revealed before arming the hidden state, so nothing flashes out", async () => {
    const island = await read(`${COMPONENTS}reveal.tsx`);
    const armed = island.indexOf("setAttribute(REVEAL_READY_ATTRIBUTE");
    expect(armed).toBeGreaterThan(-1);
    expect(island.lastIndexOf('dataset.revealed = ""', armed)).toBeGreaterThan(-1);
    expect(island).toContain("getBoundingClientRect().top < fold");
  });
});

describe("footer and in-page links (design-public-auth-005/006/009)", () => {
  it("lists only destinations that exist — every item has an href and no look-alike dead words remain", async () => {
    const footer = await read(`${COMPONENTS}site-footer.tsx`);
    expect(footer).toMatch(/interface FooterItem \{\s*label: string;\s*href: string;\s*\}/);
    expect(footer).not.toMatch(/\{ label: "[^"]+" \}/); // an item with no href
    for (const word of ["Privacy", "Terms", "About", "Contact", "Help center", "Status"]) {
      expect(footer).not.toContain(`label: "${word}"`);
    }
    expect(footer).not.toContain("<span>{item.label}</span>");
  });

  it("makes each footer link a 44px row on phones", async () => {
    const footer = await read(`${COMPONENTS}site-footer.tsx`);
    expect(footer).toMatch(/const ITEM_CLASS = "[^"]*(?:^|\s)min-h-11(?:\s|")/);
    expect(footer).toMatch(/const ITEM_CLASS = "[^"]*(?:^|\s)min-w-11(?:\s|")/);
    // Both the in-page anchor and the Link variant carry it.
    expect((footer.match(/className=\{ITEM_CLASS\}/g) ?? []).length).toBe(2);
  });

  it("promises nothing it can't deliver: no 'Talk to us' without a way to talk, no anchor to the wrong section", async () => {
    const pricing = await read(`${COMPONENTS}pricing-teaser.tsx`);
    const prices = [...pricing.matchAll(/price: "([^"]+)"/g)].map((match) => match[1]);
    expect(prices).toHaveLength(3);
    expect(prices).not.toContain("Talk to us");
    // Every card's button does the one thing that works today.
    expect((pricing.match(/cta: \{ label: "Get started", href: SIGN_UP_PATH \}/g) ?? []).length).toBe(3);
    expect(await read(`${MARKETING}page.tsx`)).not.toContain("How workers are designed");
  });

  it("pads the feature-row tertiary link to a 44px row", async () => {
    const row = await read(`${COMPONENTS}feature-row.tsx`);
    expect(row).toMatch(/<a[^>]*py-\[10px\][^>]*leading-\[25px\]/);
  });
});
