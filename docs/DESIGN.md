# Design system — "Quiet confidence"

The product UI follows a premium consumer-tech design *language* (large confident type, generous whitespace, one accent colour, frosted chrome, soft depth) under **our own brand**. We borrow a sensibility, not assets: no third-party logos, product names, imagery, copy, or font files.

This document is the source of truth for every page. `src/components/README.md` documents the component APIs that implement it.

## Principles

Design language: "Quiet confidence". The goal is the calm, product-first feel of a premium consumer-tech website, applied to a B2B staffing portal, under our own brand. The current UI is a slate/indigo "Linear clone": 14px text, rings on every card, uppercase eyebrows, icon on every label, and three badges per worker. Those are the tells this redesign removes.

1. Typography does the work. Hierarchy comes from size and weight, not from boxes, icons or color. Every page has one dominant element: a 32–80px semibold title with tight tracking. Everything else steps down clearly. Never put two things of equal weight side by side.
2. One accent, used rarely. Blue (#0071e3) is for the primary action, links and focus. Nothing else is blue. There is no purple or indigo anywhere. Status colors (green, orange, red) appear only as small dots or text, never as big tinted fills. The exception is the one "needs you" callout.
3. Depth instead of borders. Content sits on white cards with an 18px radius, placed on a #f5f5f7 canvas and lifted by a barely visible shadow. Hairlines (1px, #e5e5ea) are only for separating rows inside a list. No card gets both a ring and a shadow. Never nest a bordered box inside a bordered box.
4. Generous whitespace is the layout. The app has 56px between page sections and 24px of card padding. Marketing sections have 120–160px of vertical padding. When in doubt, remove a divider and add space.
5. Pills for actions, text for navigation. Buttons are rounded-full pills with at most one primary per view. Secondary actions are gray pills. Tertiary actions are blue text links with a trailing chevron ("View all ›"). Navigation is plain text, not icon plus label.
6. Say it in one sentence. Every row, card and empty state leads with a human sentence ("Alex drafted the weekly competitor digest"), with metadata demoted to 13px secondary text on the right. No label:value soup and no ids unless they are needed.
7. Show one status, not three. Each object shows the single most important state (running, needs review, paused), as a dot plus word. Health and score merge into one number. The "Simulated" marker appears once globally in the nav, plus inline on artifacts that were generated. It is not repeated on every section.
8. Frosted chrome, solid content. Only the global nav, local nav, sticky action bars and menus are translucent (backdrop blur 20px, saturate 180%). Page content is never translucent.
9. Motion explains, never decorates. Use 200–400ms ease-out fades and 8–16px slide-ups for things entering the viewport or opening. No bouncing, no parallax, no shimmering gradients, no infinite animations except a live "running" dot. Honor prefers-reduced-motion everywhere.
10. Real UI instead of illustration. Marketing visuals are real HTML/CSS mock cards built from the product's own components. There are no stock images, 3D blobs, gradient orbs, emoji or AI-art.
11. Mobile is a first-class layout, not a squashed desktop. Keep 16px side gutters, 44px minimum touch targets, and 16px minimum input text (so iOS doesn't zoom). The nav collapses to a full-screen frosted menu, and sticky bottom action bars replace right-aligned header buttons.
12. The brand is original. The wordmark is "Foreman" with its own three-node glyph in monochrome. No fruit logos, no product names or imagery from any other company, and no borrowed marketing copy. We borrow a sensibility, not assets.

## Tokens (`src/app/globals.css`)

```css
/* src/app/globals.css — replace the current :root and @theme inline blocks. Keep the three @imports and the `@custom-variant dark` line (light-only stays). Every shadcn token name is preserved, so the primitives restyle automatically. New tokens follow. */

@theme inline {
  /* Fonts: the system stack serves SF on Apple devices. Inter (next/font, --font-inter) is the non-Apple fallback. No SF font files ship. */
  --font-sans: -apple-system, BlinkMacSystemFont, "SF Pro Text", var(--font-inter), "Helvetica Neue", Helvetica, Arial, sans-serif;
  --font-display: -apple-system, BlinkMacSystemFont, "SF Pro Display", var(--font-inter), "Helvetica Neue", Helvetica, Arial, sans-serif;
  --font-heading: var(--font-display);
  --font-mono: ui-monospace, "SF Mono", SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace;

  --color-background: var(--background);
  --color-foreground: var(--foreground);
  --color-card: var(--card);
  --color-card-foreground: var(--card-foreground);
  --color-popover: var(--popover);
  --color-popover-foreground: var(--popover-foreground);
  --color-primary: var(--primary);
  --color-primary-foreground: var(--primary-foreground);
  --color-primary-hover: var(--primary-hover);
  --color-primary-active: var(--primary-active);
  --color-secondary: var(--secondary);
  --color-secondary-foreground: var(--secondary-foreground);
  --color-secondary-hover: var(--secondary-hover);
  --color-muted: var(--muted);
  --color-muted-foreground: var(--muted-foreground);
  --color-accent: var(--accent);
  --color-accent-foreground: var(--accent-foreground);
  --color-destructive: var(--destructive);
  --color-border: var(--border);
  --color-hairline: var(--hairline);
  --color-input: var(--input);
  --color-ring: var(--ring);
  --color-link: var(--link);
  --color-tertiary: var(--text-tertiary);
  --color-canvas: var(--surface-secondary);
  --color-canvas-raised: var(--surface-tertiary);
  --color-ink: var(--surface-ink);
  --color-ink-foreground: var(--surface-ink-foreground);
  --color-success: var(--success);
  --color-success-soft: var(--success-soft);
  --color-warning: var(--warning);
  --color-warning-soft: var(--warning-soft);
  --color-danger: var(--danger);
  --color-danger-soft: var(--danger-soft);
  --color-info: var(--info);
  --color-info-soft: var(--info-soft);
  --color-chart-1: var(--chart-1);
  --color-chart-2: var(--chart-2);
  --color-chart-3: var(--chart-3);
  --color-chart-4: var(--chart-4);
  --color-chart-5: var(--chart-5);
  --color-sidebar: var(--sidebar);
  --color-sidebar-foreground: var(--sidebar-foreground);
  --color-sidebar-primary: var(--sidebar-primary);
  --color-sidebar-primary-foreground: var(--sidebar-primary-foreground);
  --color-sidebar-accent: var(--sidebar-accent);
  --color-sidebar-accent-foreground: var(--sidebar-accent-foreground);
  --color-sidebar-border: var(--sidebar-border);
  --color-sidebar-ring: var(--sidebar-ring);

  /* Radii are explicit, not multiplier-derived, so each maps to a deliberate role. */
  --radius-xs: 6px;     /* checkbox, kbd */
  --radius-sm: 8px;     /* menu items, small chips, tooltips */
  --radius-md: 10px;    /* segmented-control thumb, code inline */
  --radius-lg: 12px;    /* inputs, inset panels, code blocks */
  --radius-xl: 18px;    /* cards: the default surface */
  --radius-2xl: 22px;   /* dialogs, popovers of substance */
  --radius-3xl: 28px;   /* marketing tiles, showcase frames */
  --radius-4xl: 36px;   /* hero showcase frame */

  --shadow-card: var(--elev-1);
  --shadow-card-hover: var(--elev-2);
  --shadow-popover: var(--elev-3);
  --shadow-bar: var(--elev-bar);

  --ease-out: var(--motion-ease-out);
  --ease-standard: var(--motion-ease-standard);
  --ease-in-out: var(--motion-ease-in-out);

  --container-app: 1200px;
  --container-marketing: 1024px;
  --container-text: 692px;
  --container-reading: 720px;
}

:root {
  /* Surfaces */
  --background: #ffffff;                 /* default page (marketing, auth, reading view) */
  --foreground: #1d1d1f;                 /* primary text (16.1:1 on white) */
  --surface-secondary: #f5f5f7;          /* app canvas + alternating marketing sections */
  --surface-tertiary: #fbfbfd;           /* nav base tint, subtle raised areas */
  --surface-ink: #000000;                /* the single dark showcase band on marketing */
  --surface-ink-foreground: #f5f5f7;
  --card: #ffffff;
  --card-foreground: #1d1d1f;
  --popover: #ffffff;                    /* solid fallback; frosted via .material-thick */
  --popover-foreground: #1d1d1f;

  /* Text roles */
  --muted-foreground: #6e6e73;           /* secondary text: 5.0:1 on white, 4.6:1 on #f5f5f7 */
  --text-tertiary: #86868b;              /* ONLY for ≥18px text, placeholders, disabled, or decorative numerals (3.6:1) */
  --link: #0066cc;                       /* inline text links: 5.6:1 */

  /* Accent: the only brand color */
  --primary: #0071e3;                    /* 4.6:1 with white text */
  --primary-foreground: #ffffff;
  --primary-hover: #0077ed;
  --primary-active: #006edb;
  --ring: #0071e3;

  /* Neutrals for fills */
  --secondary: #e8e8ed;                  /* gray pill button, segmented track */
  --secondary-foreground: #1d1d1f;
  --secondary-hover: #dcdce1;
  --muted: #f5f5f7;                      /* inset panels, table hover, skeleton base */
  --accent: #f0f0f3;                     /* menu item hover / highlighted row */
  --accent-foreground: #1d1d1f;

  /* Lines */
  --border: #e5e5ea;                     /* row dividers, separators */
  --hairline: rgb(0 0 0 / 0.08);         /* frosted-bar bottom edge, card edge on white */
  --input: #d2d2d7;                      /* input borders */

  /* Status: text-safe foregrounds + whisper-soft fills */
  --success: #248a3d;  --success-soft: #eaf6ec;
  --warning: #b25000;  --warning-soft: #fff4e5;   /* "waiting on you" */
  --danger:  #d70015;  --danger-soft:  #fff0f1;
  --info:    #0071e3;  --info-soft:    #eaf3fd;   /* running / in progress */
  --neutral: #6e6e73;
  --destructive: #d70015;

  /* Charts: accent first, then status hues; neutral gray for "other". */
  --chart-1: #0071e3;
  --chart-2: #6e6e73;
  --chart-3: #248a3d;
  --chart-4: #c75d00;
  --chart-5: #d70015;
  --chart-grid: #ececf0;
  --chart-axis: #86868b;

  /* Radius base (kept for shadcn internals that reference --radius) */
  --radius: 12px;

  /* "sidebar" tokens now style the global nav, mobile menu and Sheet. */
  --sidebar: rgb(251 251 253 / 0.8);
  --sidebar-foreground: #1d1d1f;
  --sidebar-primary: #0071e3;
  --sidebar-primary-foreground: #ffffff;
  --sidebar-accent: rgb(0 0 0 / 0.05);
  --sidebar-accent-foreground: #1d1d1f;
  --sidebar-border: rgb(0 0 0 / 0.08);
  --sidebar-ring: #0071e3;

  /* Materials (frosted chrome) */
  --material-nav: rgb(251 251 253 / 0.8);
  --material-nav-dark: rgb(22 22 23 / 0.8);     /* nav while over the ink band */
  --material-thick: rgb(255 255 255 / 0.82);    /* menus, popovers, sticky action bars */
  --material-thin: rgb(255 255 255 / 0.6);
  --blur-material: saturate(180%) blur(20px);
  --blur-overlay: blur(6px);
  --overlay: rgb(0 0 0 / 0.32);

  /* Elevation: soft, wide, low-alpha */
  --elev-1: 0 1px 2px rgb(0 0 0 / 0.04), 0 4px 16px rgb(0 0 0 / 0.04);
  --elev-2: 0 2px 4px rgb(0 0 0 / 0.04), 0 12px 32px rgb(0 0 0 / 0.08);
  --elev-3: 0 0 0 0.5px rgb(0 0 0 / 0.08), 0 8px 30px rgb(0 0 0 / 0.12);
  --elev-bar: 0 -0.5px 0 rgb(0 0 0 / 0.08);
  --elev-thumb: 0 1px 3px rgb(0 0 0 / 0.12), 0 0 0 0.5px rgb(0 0 0 / 0.04);  /* segmented-control thumb, switch knob */

  /* Focus */
  --focus-ring: 0 0 0 4px rgb(0 113 227 / 0.28);

  /* Motion */
  --motion-ease-out: cubic-bezier(0.22, 1, 0.36, 1);
  --motion-ease-standard: cubic-bezier(0.4, 0, 0.6, 1);
  --motion-ease-in-out: cubic-bezier(0.65, 0, 0.35, 1);
  --duration-instant: 120ms;
  --duration-fast: 200ms;
  --duration-base: 280ms;
  --duration-slow: 400ms;
  --reveal-distance: 16px;

  /* Layout & spacing */
  --nav-height: 48px;
  --localnav-height: 52px;
  --gutter: 16px;                                  /* mobile side gutter */
  --gutter-lg: 24px;
  --space-section-app: 56px;                       /* between Sections in the app */
  --space-section-marketing: clamp(88px, 11vw, 160px);
  --space-card: 24px;                              /* card padding (20px under 640px) */
  --space-card-sm: 20px;
  --space-stack: 16px;                             /* form field stack */
}

@media (prefers-reduced-motion: reduce) {
  :root { --duration-fast: 0ms; --duration-base: 0ms; --duration-slow: 0ms; --reveal-distance: 0px; }
}

/* Frosted material utilities (Tailwind v4 @utility) */
@utility material-nav {
  background-color: var(--material-nav);
  -webkit-backdrop-filter: var(--blur-material);
  backdrop-filter: var(--blur-material);
  box-shadow: inset 0 -0.5px 0 var(--hairline);
}
@utility material-thick {
  background-color: var(--material-thick);
  -webkit-backdrop-filter: var(--blur-material);
  backdrop-filter: var(--blur-material);
}
/* Fallback: browsers without backdrop-filter get an opaque surface so text stays legible. */
@supports not ((backdrop-filter: blur(1px)) or (-webkit-backdrop-filter: blur(1px))) {
  .material-nav { background-color: #fbfbfd; }
  .material-thick { background-color: #ffffff; }
}

@layer base {
  * { @apply border-border; }
  html { font-family: var(--font-sans); color-scheme: light; -webkit-text-size-adjust: 100%; }
  body {
    background: var(--background);
    color: var(--foreground);
    font-size: 17px; line-height: 1.47059; letter-spacing: -0.022em;   /* marketing/auth base */
    -webkit-font-smoothing: antialiased; -moz-osx-font-smoothing: grayscale;
    font-feature-settings: "kern";
  }
  :focus-visible { outline: none; box-shadow: var(--focus-ring); border-radius: inherit; }
  ::selection { background-color: rgb(0 113 227 / 0.18); }
  a { color: inherit; text-decoration: none; }
  .prose-link, main p a:not([data-slot]) { color: var(--link); }
  .prose-link:hover, main p a:not([data-slot]):hover { text-decoration: underline; text-underline-offset: 0.15em; }
  button:not(:disabled), [role="button"]:not(:disabled) { cursor: pointer; }
  body * { scrollbar-width: thin; scrollbar-color: #d2d2d7 transparent; }
}
```

## Typography

FONT STACK AND WIRING (no SF font files):
- In src/app/layout.tsx, remove Geist and Geist_Mono. Use `import { Inter } from "next/font/google"; const inter = Inter({ subsets: ["latin"], variable: "--font-inter", display: "swap", axes: ["opsz"] });`. Put `inter.variable` on <html>. `axes: ["opsz"]` loads Inter's optical-size axis, so display sizes tighten on their own. If the optical axis isn't in the installed next/font version, drop `axes`.
- The --font-sans and --font-display stacks (see tokens) start with `-apple-system, BlinkMacSystemFont`. Apple devices render the OS system font (which switches between Text and Display optical sizes by itself). Windows, Android and Linux fall through to Inter. "SF Pro Text"/"SF Pro Display" only match when the user has them installed locally. We never bundle or download them.
- Mono: `ui-monospace, "SF Mono", SFMono-Regular, Menlo, Consolas, monospace`. Use it only for ids, JSON, code and trace output.
- Tracking differs by font. The values below are tuned for the system font. Inter renders slightly wider at display sizes, so add `html:not(.apple-font) .text-display* { letter-spacing: calc(<value> - 0.01em) }`. Only do this if QA on Windows shows loose display headlines. It's optional, and skipping it is fine.
- `viewport.themeColor`: "#ffffff" for marketing/auth and "#f5f5f7" for the app (set it in (app)/layout via generateViewport).

TYPE SCALE (desktop → mobile under 734px). Define each as a Tailwind v4 `@utility text-<role>` in globals.css so pages never hand-roll sizes:
| Role | Use | Size/line-height | Weight | Tracking |
|---|---|---|---|---|
| display-xl | Marketing hero headline only | 80/84px → 48/52px | 600 | -0.015em |
| display | Marketing section headlines, final CTA | 56/60px → 40/44px | 600 | -0.005em |
| headline | Marketing sub-sections, auth H1, deliverable title, worker name on profile | 40/44px → 32/36px | 600 | -0.003em (auth/app: -0.02em) |
| title-1 | App page H1 (PageHeader) | 32/40px → 28/34px | 600 | -0.02em |
| title-2 | Section headings (Section), dialog titles, big card titles | 22/28px → 21/26px | 600 | -0.012em |
| title-3 | Card titles, worker names in cards, list primary line on marketing | 17/22px | 600 | -0.022em |
| body-lg (lead) | Marketing subheads, hero subhead, auth subhead | 21/29px → 19/27px | 400 | 0.004em |
| body | Marketing body, reading view, auth | 17/25px | 400 | -0.022em |
| body-app | App base text (set on the (app) shell container, not body) | 15/22px | 400 | -0.01em |
| callout | Dense rows, table cells, form help | 14/20px | 400 | -0.012em |
| footnote | Metadata, timestamps, secondary lines, nav links | 13/18px | 400 (500 for nav) | -0.006em |
| caption | Chart axes, legal, tiny labels | 12/16px | 400 | 0 |
| metric-xl | Big KPI numbers (usage headline, worker score) | 48/52px → 40/44px | 600 | -0.02em, tabular-nums |
| metric | Stat strip numbers | 34/40px → 28/34px | 600 | -0.02em, tabular-nums |

RULES:
- Bump the app base text from 14px to 15px. It is the single biggest "feels premium" change. Dense tables and activity rows use callout (14px).
- Kill the uppercase `eyebrow` utility. Redefine it as sentence case at 13px/18px, weight 600, color var(--muted-foreground), with no letter-spacing. Marketing eyebrows ("New in scheduling") use 17px weight 600 in var(--warning) orange or foreground. Use them at most once per section.
- Weights are only 400 and 600, plus 500 for nav and pill labels. Never use 700 or 800 and never use light weights. Marketing step numbers may use 600 in var(--text-tertiary).
- `text-wrap: balance` on every heading. `text-wrap: pretty` on paragraphs. Paragraph max width is 692px (--container-text) on marketing and 65ch in the app.
- Keep the `metric` utility (tabular-nums), and apply it to every live-updating number and numeric column.
- Font size is never below 12px. Inputs are 16px under 640px (no iOS zoom), 15px in app, 17px on auth.

## Navigation

APP SHELL: replace the left sidebar with a global frosted top nav and page-level local navs.

1. Global nav (new `src/components/shell/global-nav.tsx`; AppShell keeps its props: user, simulated, pendingApprovals)
- `position: sticky; top: 0; z-40; height: var(--nav-height)` (48px). Apply the `material-nav` utility (rgba(251,251,253,.8), saturate(180%) blur(20px), 0.5px bottom hairline). The inner container is max-w-[1200px] with px-4 sm:px-6.
- Left: the wordmark links to /workforce. The glyph is the existing three-node SVG, drawn in #1d1d1f at 20px with no colored tile. "Foreman" is set in 15px weight 600 at -0.02em on one line.
- Center-left (md+): primary sections as plain text links at 13px/500, gap-7. Rest color is #1d1d1f at 80% opacity. Hover goes to 100%. Active is 100% with weight 600, plus a 2px × 16px rounded underline 6px below the text, drawn in foreground (not blue). The links are Workforce, Jobs, Approvals and Activity. There are no icons.
- Approvals count: show a small 18px-high pill after the label when there are pending items. It is var(--warning-soft) with var(--warning) text, 11px/600 tabular-nums, and an aria-label like "3 pending approvals". This is the only colored element in the nav.
- Right cluster, gap-3:
  - Simulated chip (when simulated). A 22px pill with bg #f5f5f7 at 0.5px var(--hairline), a 6px var(--warning) dot, and "Simulated" at 12px/500 in #6e6e73. The existing tooltip explanation stays.
  - A "Hire" primary pill in the small size (h-7, px-3.5, 13px/500, blue). It is the global primary action; hide it on /hire.
  - The user menu trigger: a 28px circular org monogram (bg #1d1d1f, white initials 11px/600).
- User menu: a DropdownMenu in the material-thick style with radius 14px. The header shows the org name at 15px/600 and the email at 13px secondary. Items are Usage, Settings, then a separator, then "Sign out". Usage and Settings move out of primary nav into this menu, keeping the bar to 4 destinations.
- The skip link remains the first focusable element.

2. Mobile (under 768px)
- The same 48px frosted bar holds the wordmark (glyph plus "Foreman"), the Simulated dot-chip (dot only, with aria-label), and a two-line menu button (2 × 16px bars, 1.5px thick, 6px apart). The menu button morphs into an X over 240ms.
- Open state: a full-screen overlay below the bar with bg rgba(251,251,253,.96) and blur. It lists links at 28px/600 with -0.015em tracking and 12px vertical gap, 32px from the top, 16px gutters. The links are Workforce, Jobs, Approvals (count), Activity, then a 32px gap, then Usage and Settings at 17px/500 in secondary color. A full-width "Hire a worker" primary pill (h-12) sits at the bottom, with the org, email and "Sign out" in 13px.
- Links stagger in at 20ms apart with opacity 0→1 and translateY(-8px→0) over 280ms ease-out. With reduced motion there is no transform and the overlay appears instantly. Body scroll is locked while open. Close on route change (keep the current usePathname effect) and on Escape. Focus is trapped inside the overlay.
- The old left Sheet (MobileNav) is deleted, and so is the SidebarNav.

3. Local nav (sub-navigation for pages with sections, like the product sub-nav on premium consumer sites)
- A new `src/components/shell/local-nav.tsx`. It is sticky under the global nav (`top: var(--nav-height)`), 52px tall, material-nav, full-bleed with the inner container at max-w 1200.
- Left: the object title at 21px/600 with -0.012em tracking (e.g., "Alex"). The title fades in (opacity 0→1, 200ms) once the page header scrolls out of view, using an IntersectionObserver on the H1.
- Right: section links at 13px/500. Active is foreground with weight 600. Inactive is #1d1d1f at 72% opacity. Add one optional small primary pill (e.g., "Run now").
- Used on: the worker profile (tabs), job detail (Spec / Workers / Runs / Deliverables / Versions as in-page anchors), and run detail (Timeline / Evaluation / Debug anchors).
- Mobile: links scroll horizontally with `scroll-snap-type: x proximity` and a 24px fade mask on the right edge. The active link scrolls into view on load.

4. Section headers inside pages
- PageHeader is left-aligned. An optional back link sits above the title ("‹ Workforce" at 14px in var(--link)), replacing the multi-level breadcrumb. The title is title-1, the description is 17px secondary (max 65ch), and actions sit right-aligned on desktop.
- Actions on mobile: the primary action moves to a sticky bottom bar. The bar is material-thick with a top hairline and safe-area padding, and holds a full-width pill.
- Section headers: title-2 with an optional 15px secondary description. The trailing action is a blue text link with a chevron ("View all ›"), not an outline button.

5. Marketing nav (for "/" and the auth pages)
- The same 48px frosted bar: wordmark on the left. Centered 13px links: How it works, Product, Security, Pricing. They are in-page anchors with `scroll-margin-top: 64px`.
- Right: "Sign in" as a 13px text link and "Get started" as a small blue pill. A signed-in visitor sees an "Open Workforce" pill instead.
- While the bar overlaps the dark showcase band, it switches to --material-nav-dark with white text (IntersectionObserver on the section, 200ms color transition).
- Mobile: the same full-screen overlay pattern.

6. Main container and z-order
- The app `<main>` gets bg var(--surface-secondary) (#f5f5f7), max-w-[1200px], px-4 sm:px-6, pt-10 pb-24, and body-app type.
- Z-order: global nav z-40, local nav z-30, sticky action bar z-30, dialogs z-50.
- Make "/", "/sign-up" and the marketing anchors public in `src/server/auth/access.ts` decideAccess. Today every page is gated and "/" redirects to /workforce. The middleware matcher stays the same.

## Components

Change shadcn primitives in src/components/ui/* with minimal class edits; the tokens do most of the work. Shared components in src/components/* are listed after.

BUTTON (ui/button.tsx)
- Base: rounded-full, font-weight 500, tracking -0.01em. Transition background-color/box-shadow/opacity at 200ms ease-standard.
- Remove `active:translate-y-px`. Pressed state uses the bg -active token or opacity-90.
- Focus: the --focus-ring 4px halo (ring-4 ring-primary/30); no border change.
- Sizes:
  - xs h-6 px-2.5 12px
  - sm h-7 px-3.5 13px
  - default h-9 px-4 14px (app)
  - lg h-11 px-5.5 17px (auth, hire flow, marketing)
  - xl h-12 px-7 17px (marketing hero CTAs; add it)
  - Icon sizes: circular size-8 / size-9. Icon buttons are only for truly iconographic actions (close, overflow "…", copy).
- Variants:
  - default: bg-primary text-white, hover:bg-primary-hover, active:bg-primary-active.
  - secondary: the "gray pill", bg #e8e8ed text foreground, hover #dcdce1. The workhorse for non-primary actions.
  - outline: kept for compatibility but restyled. bg white, 1px var(--input) border, hover bg #f5f5f7. Use it sparingly; prefer secondary.
  - ghost: transparent, hover bg rgb(0 0 0 / .05).
  - link: text var(--link), no underline at rest, underline on hover, h-auto p-0, optional trailing ChevronRight size-3.5 via `data-icon=inline-end`.
  - destructive: text var(--danger) on bg var(--danger-soft), hover a slightly darker soft fill. ConfirmDialog keeps a solid red for the final confirm.
- Only one default-variant button per view. Disabled state is opacity 40%.

CARD (ui/card.tsx)
- Base: bg-card rounded-[18px] (radius-xl) shadow-card. Remove `ring-1 ring-foreground/10`. Padding p-6 (p-5 under 640px). CardHeader gap-1.5, CardTitle title-3, CardDescription 14px secondary.
- CardFooter: no top border or tinted background. Actions are left-aligned or split with justify-between.
- Clickable cards: the whole card is the link target. Hover gets shadow-card-hover and translateY(-2px) at 280ms ease-out, and there's no underline on the title.
- Cards placed on a white surface (marketing white sections, dialogs) use bg #f5f5f7 with no shadow. Add a `variant="tile"` prop or a class convention for this.
- Inset panels inside cards: bg #f5f5f7 rounded-[12px] p-4, no border.

INPUT / TEXTAREA / SELECT
- h-11 in the app (textarea min-h-28), rounded-[12px], bg white, 1px var(--input) border, px-3.5, text 16px under 640px and 15px above.
- Placeholder var(--text-tertiary). Focus: border-primary plus a 4px rgb(0 113 227/.15) halo.
- Invalid: border var(--danger), with a 13px danger message below and a leading 12px circle-alert icon.
- Auth pages use floating-label inputs: h-14, label at 17px secondary moving to 12px on top when focused or filled, 180ms.
- Select trigger matches inputs, with a trailing chevron-up-down 14px in secondary color.
- Labels: 14px/500 foreground, placed above with 6px gap. Help text 13px secondary.

CHECKBOX / RADIO / SWITCH
- Checkbox 18px rounded-[5px], 1px #d2d2d7 border, checked bg-primary with a white check.
- Radio 18px circle, checked has a 6px white center on blue.
- Switch 28×48 track: off #e9e9eb, on primary. The 24px white knob gets --elev-thumb. Transition 200ms ease-standard.

TABS (ui/tabs.tsx)
- Two looks.
  - (a) Segmented control (TabsList default) for filters and 2–5 short options. Track bg #e8e8ed, rounded-full, p-0.5, h-8. The active trigger is a white pill with --elev-thumb, 13px/500. Inactive is 13px/500 foreground at 80%. The thumb slides between options with a 240ms transform (use layout via CSS anchor, or just accept an instant swap when motion is reduced).
  - (b) Local-nav tabs (worker profile) are text links in LocalNav (see navigation), not TabsList.

BADGE (ui/badge.tsx) and STATUS BADGE (status-badge.tsx)
- Default status rendering becomes a "status dot": a 7px dot plus a 13px/500 label in foreground, with no background and no ring. Tone colors: success, info (pulsing only while running), warning, danger, neutral.
- Only attention states get the soft pill (bg *-soft, text tone color, h-6 px-2.5 rounded-full): "Needs review", "Waiting for you", "Failed".
- Update the static maps in src/lib/status (TONE_CLASSES) to the new tokens: emerald→success, amber→warning, rose→danger, sky→info, slate→neutral.
- Rule: one status element per object in lists.

SIMULATED BADGE
- A neutral 22px pill: bg #f5f5f7, 0.5px hairline, 6px var(--warning) dot, 12px/500 "Simulated" in #6e6e73, cursor help. The existing tooltip copy stays. Remove the flask icon and the dashed amber border.
- Placement: always in the global nav, and inline in the meta line of run, deliverable and usage artifacts ("Simulated run · 2.4s · $0.00 billed"). Remove it from Section action slots and from StatCard hints.

SCORE RING (score-ring.tsx)
- 3px stroke on a #e8e8ed track, with a round linecap. The number is centered at 15px/600 tabular-nums for size 44, and at 28px for size 72.
- Band color applies to the arc only (≥80 success, 65–79 warning, <65 danger). The number stays in foreground.
- Null shows a dashed #d2d2d7 track and a "—" in tertiary.
- On the worker profile header, replace the ring with a metric-xl number plus a "Performance" caption and the band word ("Strong", "Watch", "At risk").

WORKER AVATAR
- Circle, sizes 32/40/48/72. Keep the static color map, but move every entry to a pastel fill (~92% lightness) with ~40%-lightness initials of the same hue, weight 600. Never saturated fills, never gradients, never emoji.

STAT CARD (stat-card.tsx), rebuilt as StatStrip plus Stat
- The four KPIs sit in one white card, split into 4 columns (2×2 under 768px) separated by 1px var(--border) vertical hairlines. Each cell has 24px padding.
- Each cell: label at 13px/500 secondary; value in metric (34px/600, -0.02em); optional hint at 13px secondary.
- The trend line is a 13px word in the tone color ("↑ 12% vs last month"), with no icon component.
- Remove the corner icons. Keep the sparkline only on spend: 80×28, 1.5px stroke in foreground at 40% opacity, no fill.

SECTION (section.tsx)
- The h2 uses title-2; the description is 15px secondary; spacing is space-y-5.
- The action slot expects `<Button variant="link">View all <ChevronRight data-icon="inline-end"/></Button>`.
- Stack sections at gap var(--space-section-app) (space-y-14).

PAGE HEADER
- An optional back link (`backHref`, `backLabel`) replaces the breadcrumbs prop. Keep breadcrumbs support but render only the parent as "‹ Parent". Show more than one level only on deep pages, as "Workforce › Alex" in 13px.
- h1 uses title-1; the description is 17px secondary; margin-bottom 40px.
- Actions: at most one primary plus one secondary pill, with the rest in a "…" DropdownMenu (a circular icon button with bg #e8e8ed).

EMPTY STATE
- Center-aligned with py-20. An optional 32px line icon in var(--text-tertiary) with no circle background. Title in title-2, description at 17px secondary (max 44ch), then one pill CTA (default size lg).
- Drop the dashed border box. Inside a card, the card itself is the frame.

DATA TABLE / TABLE
- The table sits inside a card with p-0 and overflow hidden.
- Header row: 13px/600 secondary, sentence case, no background, bottom hairline, h-11, px-6.
- Rows: min-h-14, 15px, hairline dividers inset 24px from the left (not full-bleed), hover bg #f9f9fb.
- Numbers right-aligned in tabular-nums. The first column is the human label in weight 500.
- Row click navigates. There's no chevron column; instead the title turns var(--link) on hover.
- Under 640px, tables become stacked lists: title on line 1, meta on line 2.

DIALOG / CONFIRM DIALOG
- Overlay var(--overlay) with backdrop blur(6px).
- Content: bg white, rounded-[22px], p-7, shadow-popover, max-w-[440px]. Enter with a fade plus scale .96→1 at 240ms ease-out; exit 160ms.
- Title in title-2, body 15px secondary.
- Footer: pills right-aligned, secondary then primary. Under 640px they stack full-width with the primary on top.
- ConfirmDialog destructive confirm: a solid bg var(--danger) white-text pill.

SHEET
- Used only for the review panel on mobile and the run-step details. It's a bottom sheet on mobile (rounded-t-[22px], a 36×5 grab handle in #d2d2d7) and a right panel at 420px on desktop, with shadow-popover.

DROPDOWN MENU / POPOVER / SELECT CONTENT
- material-thick, rounded-[14px], shadow-popover (includes the 0.5px edge), p-1.5.
- Items: h-9, rounded-[8px], px-3, 14px. Hover bg rgb(0 0 0/.05). Icons at 16px in secondary color, and only where they aid scanning.
- Separators: 1px var(--border) with mx-3 my-1.5.
- Animation: fade plus translateY(-4px→0) at 180ms.

TOOLTIP
- bg rgb(29 29 31/.92) with blur, white 12px text, rounded-[8px], px-2.5 py-1.5, max-w-64, delay 300ms.

TOAST (sonner)
- Drop `richColors` (colored toast backgrounds read as generic). White material-thick, rounded-[14px], shadow-popover, 15px title, 13px secondary description.
- The status shows as a 16px tone-colored icon only. Position is bottom-center on mobile and top-right on desktop.

ACCORDION / COLLAPSIBLE
- Full-width rows, hairline between items, 17px/600 trigger, and a chevron-down (14px, secondary) that rotates 180° over 240ms. Content fades in with height auto (use the Radix CSS var).

PROGRESS
- 4px tall, rounded-full, track #e8e8ed, fill primary. The indeterminate state is a 30% bar sliding at 1.2s ease-in-out, and it is static under reduced motion.

SKELETON
- bg #ececf0, radius matched to the content (18px cards, 8px text lines), gentle opacity pulse 0.6↔1 over 1.6s. No shimmer gradient.

SEPARATOR
- 1px var(--border). Prefer whitespace over separators.

MARKDOWN (deliverable body)
- An `article` class: max-w-[720px], body 17px/1.6. h1 is 32px, h2 22px with a 40px top margin, h3 17px/600. Lists 17px with 8px item gap. Tables follow the table style. Blockquote uses a 3px #d2d2d7 left rule (the one allowed left rule, because it's typographic) and secondary text. Links use var(--link). Code blocks: bg #f5f5f7, rounded-[12px], 13px mono.

JSON VIEW / COPY BUTTON
- JSON: bg #f5f5f7, rounded-[12px], 13px mono, p-4, with a max-h and internal scroll.
- Copy button: a circular 28px ghost button in the top-right corner, with a 1.2s "Copied" tooltip.

CHARTS (recharts: usage-chart, cost-chart, performance-chart, sparkline)
- Series lines are 2px with monotone curves. The area fill is the series color at 8% opacity fading to 0.
- Dots only on hover (r 4, white 2px stroke). No vertical grid. Horizontal grid is 1px var(--chart-grid) with 4 ticks max.
- Axis ticks are 12px in var(--chart-axis). No axis lines.
- Tooltip is material-thick at radius 12 with the value in 15px/600.
- Bars get a 6px top radius, max bar width 28px.
- Legends are inline text with 8px dots, placed above the chart and right-aligned.

RELATIVE TIME, AUTO REFRESH
- No visual change; timestamps are always 13px secondary. When AutoRefresh is active, show a subtle live dot in the page meta ("Live"), not a spinner.

HIRE STEPPER (hire/_components/stepper.tsx)
- Replace the chip stepper with a 13px "Step 2 of 5 · Clarify" label in secondary color, over a 5-segment progress rail (4px tall, 4px gaps, rounded-full). Completed segments are foreground, current is primary, upcoming is #e8e8ed. No emerald checks.

LOGO
- Monochrome glyph (#1d1d1f, 20px), no tile, no shadow, no ring. The favicon uses the same glyph as black on white.

## Pages

GLOBAL FOR THE APP
- The canvas is #f5f5f7 and content sits in white 18px cards.
- The container is 1200px with 40px top padding. Sections are 56px apart.
- Every page opens with PageHeader (title-1). Only one primary pill per page.
- Remove any Section-level SimulatedBadge, corner icons on stats, and nested bordered boxes.

1. MARKETING LANDING "/"
- Public route. Built from server components, plus one small client `<Reveal>` island for scroll animation.
- Section-by-section structure and copy are in the landingPage field.
- Implementation notes:
  - New files: `src/app/(marketing)/page.tsx` (replacing `src/app/page.tsx`'s redirect), `src/app/(marketing)/layout.tsx` (marketing nav plus footer), and `src/app/(marketing)/_components/*` (hero, steps, feature-row, showcase, trust, pricing-teaser, cta, footer, and mock cards).
  - Signed-in visitors see "Open Workforce" in the nav instead of a redirect.
  - Add `/`, `/sign-up`, `/privacy` and `/terms` to the public allowlist in access.ts.
  - Page metadata: an original title/description plus OpenGraph. The OG image is generated with next/og from the headline in brand type, black on white.

2. SIGN-IN (/sign-in)
- Delete the dot-grid backdrop, the radial glow and the BriefcaseBusiness tile.
- Layout: white page, marketing nav on top (wordmark only, plus "Create account" at right). The content column is max-w-[400px], centered, with pt-[12vh].
- Hierarchy: 40px glyph → H1 "Sign in" (headline, 40px) → 17px secondary "Pick up where your team left off." → floating-label Email (h-14) → floating-label Password with a show/hide text toggle ("Show") inside the field → "Keep me signed in" checkbox (optional) → primary pill "Sign in" (lg, full width, h-11) → a centered 14px link "Forgot password?" (only if the reset flow ships; otherwise omit it) → hairline → 15px "New to Foreman? Create an account ›".
- Errors: one inline alert above the fields (bg danger-soft, 14px danger text, rounded-12). Never reveal whether the email exists.
- Session-expired: a neutral info alert, "Your session ended. Sign in again to continue."
- Demo credentials: remove the prefill entirely in production. Only when `NODE_ENV !== "production"` or a DEMO_MODE env flag is set, show a secondary pill "Explore the demo workspace" below the form that fills and submits.
- Footer: 12px secondary, © year, Privacy, Terms.

3. SIGN-UP (/sign-up), new
- The same shell as sign-in.
- H1 "Create your account", sub "Your first worker can be on the job today."
- Fields: Full name, Work email, Company name (becomes the organization), Password with live requirement text "At least 12 characters". The requirement text is 13px secondary and turns success-colored with a check once met.
- A checkbox: "I agree to the Terms and Privacy Policy" (links).
- Primary "Create account". Below, "Already have an account? Sign in ›".
- After sign-up, go to /hire with a one-time welcome line at the top of the hire page: "Welcome, Dana. Let's hire your first worker."
- Field-level errors appear under each field. The submit button shows a spinner and "Creating account…" while pending.

4. WORKFORCE (/workforce)
- Header: "Workforce", sub "Your AI workers and how they're doing." Action: "Hire a worker" primary. The global nav already has Hire, so on this page make the header action a secondary "Hire a worker" only if the nav one is hidden. Pick one: keep the nav pill and remove the header button on desktop.
- Order:
  - (1) "Needs you". Show only when there are items. It's a single white card titled "3 things need you" (title-2 inside the card). Rows are avatar 32 + sentence ("Alex wants approval to send the weekly digest to 4 recipients") + a right-aligned "Review" secondary pill. Max 3 rows, then "See all ›". No amber strip, no colored background.
  - (2) Stat strip: one card, four stats (Active workers, Runs today, Waiting for review, Spend this month). No icons.
  - (3) "Your team": the worker grid, 3 columns xl, 2 md, 1 mobile, gap-6.
  - (4) "Recent activity": a card with 6 rows and "View all ›".
- Worker card redesign:
  - Top row: avatar 48 + name (title-3) + title (14px secondary). The score (44px ring) is on the right.
  - One status line at 13px ("● Running now" / "● Idle · next run tomorrow 9:00" / "● Paused").
  - A 2×2 fact grid as plain text: 13px secondary label over a 15px value. No icons, no inset gray box.
  - Footer: "Run now" secondary pill (sm) + "View profile ›" link.
  - Remove the three-badge row, the job-title third line (put it in a tooltip or on the profile) and the healthReason paragraph (it becomes the status line in warning color: "● Needs attention · quality dipped last 3 runs").
- The first-run empty state is a large centered hero inside the canvas: 40px "Hire your first AI worker", 17px description, lg primary pill, and 3 example-job gray pills that deep-link to /hire?prefill=….

5. HIRE FLOW (/hire)
- A focused single column at max-w-[720px], centered, with the stepper label at the top. Remove any side content.
- Step 1 "Describe":
  - H1 in headline size: "What do you need done?"
  - Sub: "Describe it like you'd brief a new contractor: the outcome, how often, and who it's for."
  - A large white card containing a borderless textarea at 19px/1.5 with min-h 200px and placeholder "Every Monday, summarize what our three main competitors shipped last week and email it to the product team." A 13px secondary character hint sits at the bottom right.
  - Below the card: "Try an example" with 4 gray pills.
  - Primary lg pill "Continue", right-aligned (on mobile, full-width in a sticky bottom bar).
- Clarify:
  - One question per card. The question is 17px/600. Options are selectable tiles (radius 14, 1px #d2d2d7, selected has a 2px primary border plus a check at top-right). The free-text answer uses the same input style.
  - "Back" is a text link at left; "Continue" is primary at right.
- Spec review: render the JobSpec as a document.
  - Title in headline size, then sections Outcome / Deliverable / Schedule / Sources / Success criteria, each with a 17px/600 heading, 17px body and an "Edit" link that opens inline editing.
  - A sticky bottom material bar holds "Looks right, design my worker" (primary) and "Discard" (link, danger color, with confirm).
- Proposal pending: centered, a 44px progress ring (indeterminate, static when motion is reduced), the headline "Designing your worker…", and 3 status lines that cross-fade every 2.5s (deterministic text from the flow state, not random).
- Proposal: a "résumé" card (white, radius 22, p-8).
  - Avatar 72, name in headline size, title in 21px secondary, and a 17px bio paragraph.
  - Three columns under a hairline: "Skills" (plain list), "Tools & access" (each tool as a sentence, e.g. "Can search the web" or "Asks before sending email"), and "Expected cost" (metric number + "per run, estimated").
  - Actions: "Hire Alex" primary lg + "Ask for changes" secondary. Alternates appear as smaller cards below under "Other candidates".
- Remove the emerald check chips, multicolor step rings and dense proposal-details grids.

6. JOBS (/jobs)
- Header "Jobs", sub "Everything you've asked for, and who's on it."
- A segmented control filter (All · Active · Draft · Closed) replaces the chips.
- The table sits in a card with columns Job (title 15/500 + one-line summary 13 secondary), Workers (overlapping avatars 28, max 3 + "+2"), Status (dot), and Updated (relative, right-aligned). Mobile uses stacked rows.
- Job detail: a back link, then the H1 job title with a status dot line ("● Active · created Mar 3"). Actions: "Hire another worker" secondary and "…" (Close job, Discard).
- LocalNav anchors: Spec, Workers, Runs, Deliverables, History.
- Two columns on lg (8/4). The main column holds the spec as a document card (same as hire spec review, read-only, with an "Edit spec" link creating a new version). The side column holds a "Workers on this job" card (avatar rows + score) and a "Recent runs" card (5 rows).
- Spec versions go in an accordion at the bottom titled "Version history".

7. WORKER PROFILE (/workers/[id]), 9 tabs
- Header (no card, directly on the canvas):
  - Back link "‹ Workforce". Avatar 72, then the name in headline size (40px), then the title in 17px secondary, then "Hired for Weekly competitor digest ›" in var(--link) at 15px.
  - One status line at 13px.
  - Right side on desktop: a metric-xl score + "Performance · Strong", then the actions "Run now" (primary), "Talk to Alex" (secondary) and "…" (Pause, Edit schedule, Replace, Retire; Retire in danger color with confirm).
  - A health callout only when it needs attention: a warning-soft rounded-14 panel, "Alex's last three reviews dipped below 65. See performance ›".
- LocalNav:
  - Visible links: Overview, Activity, Deliverables, Performance, and "Talk to Alex" (display label; keep the WORKER_TABS ids and the frozen WORKER_TAB_LABELS, and override the display in tab-nav.tsx). A "More" dropdown holds Cost, Permissions, Versions and Debug.
  - When the active tab lives in More, the More trigger reads "Cost ▾" in weight 600.
  - Mobile shows all 9 as a horizontal scroll with no More menu.
- Per tab:
  - Overview: an "About Alex" card (bio 17px + what they do each run as a numbered plain list), a stat strip (Runs, Success rate, Avg score, Cost this month), a "Latest deliverable" preview card (title, first 3 lines, "Read ›"), and a "Schedule" card ("Every Monday at 9:00, next in 3 days").
  - Activity: a feed grouped by day. The day header is sticky at 13px/600 secondary. Rows are sentences with the time at right.
  - Deliverables: a list card with rows of title, date, review state (dot) and score (right).
  - Performance: a hero chart card (score over time with 65/80 reference lines as 1px dashed #d2d2d7 labeled "Watch" / "Strong"), then criteria as horizontal 6px bars in a card, then review history. The primary action is "Write a performance review".
  - Talk to Alex: the chat fills the viewport height minus the navs, max-w 760 centered. The user's bubbles are right-aligned, bg primary with white text. The worker's bubbles are left-aligned on bg #e9e9eb. Bubbles are radius 18, 15px/1.4, with 4px spacing inside a group and 16px between groups. Timestamps are 12px tertiary between groups. The composer is a material-thick sticky bottom bar with a rounded-full input (h-11) and a circular 32px primary send button with an arrow-up icon. Suggested prompts show as gray pills when the chat is empty.
  - Cost: a metric-xl "$4.12 this month" headline + "Simulated · priced, not billed" when applicable, then a bar chart, then a breakdown table by model tier and tool.
  - Permissions: an inset grouped list (white card, rows at h-16). Each tool is a sentence title + 13px explanation, and the right side holds a switch or an "Asks first" segmented option (Allowed / Asks first / Off). Save happens in a sticky bar when dirty. The schedule editor goes in a separate card.
  - Versions: a timeline list with "Current" as a 13px/600 success text tag on the active version. Each row shows the version number, date, a change summary sentence and the score. The "Propose an improvement" card sits at the top with a secondary action. The compare action opens the Replace page.
  - Debug: visually demoted. A 15px secondary intro, "Raw model calls and tool traces, for troubleshooting." Collapsed accordions with mono JSON views, no charts.

8. RUN DETAIL (/runs/[id])
- Back link "‹ Alex". H1: "Monday digest run" (or "Run on Mar 3, 9:00"). The meta line is 13px: "● Completed · 2m 14s · $0.03 · Simulated".
- Live state: a 2px primary progress rail pinned under the global nav, a pulsing 7px info dot, and the status line "Working, step 4 of ~7". Keep AutoRefresh and RunLive.
- LocalNav anchors: Timeline, Deliverable, Evaluation, Debug.
- Timeline: one white card holding a vertical list with a 1px #e5e5ea connecting line at x=20 and 9px step nodes (success/info/warning/danger fill). Each step is a human sentence at 15px ("Alex searched the web for 'competitor X changelog'"), with duration and tokens at 13px secondary on the right. Clicking expands an inset #f5f5f7 panel (radius 12) with the details (inputs/outputs; JSON in mono).
- A pending approval is rendered inline as an elevated card (shadow-card-hover): "Alex needs your OK to send an email", a preview, and "Approve" (primary) / "Decline" (secondary). No colored left border.
- Evaluation cards: the score as metric + per-criterion bars + reviewer notes as a 17px quote.
- The debug trace goes in a collapsed accordion.
- Actions: "Retry" or "Cancel run" (secondary), plus "…".

9. DELIVERABLE (/deliverables/[id])
- Reading view on a WHITE background (not the canvas) to feel like a document.
- A centered article at max-w 720: back link, then the title in headline size, then the meta "By Alex · Mar 3 · Score 84 · Simulated". Actions below the title: "Download" secondary pill and "Copy" link.
- The body uses the Markdown article styles.
- Review panel: on lg it's a sticky right column (w-[320px], top = nav+24px) with a white card containing "How did Alex do?". It has a 5-option rating segmented control, a feedback textarea, and "Accept" (primary) / "Request changes" (secondary). On mobile it's a sticky bottom bar with a "Review" pill that opens the bottom Sheet.
- After a decision, show a quiet line: "Accepted by you · Mar 3".

10. APPROVALS (/approvals)
- Header "Approvals", sub "Actions your workers won't take without you."
- A segmented control: Waiting (count) · Decided.
- Waiting: a stack of cards (max-w 820). Each card:
  - Avatar 40 + a 17px/600 sentence: "Alex wants to send an email to 4 people".
  - 13px secondary: "Requested 12 min ago · Weekly competitor digest".
  - An inset preview panel (recipients, subject, first lines) with "Show full ›".
  - Buttons: "Approve" primary + "Decline" secondary. Decline opens a small textarea for a reason.
- The empty state reads "You're all caught up." with 17px secondary "New requests will appear here and in the nav."
- Decided: the table (Request, Worker, Decision dot, By, When).

11. ACTIVITY (/activity)
- Header "Activity".
- Filters: a segmented control (All · Runs · Deliverables · Decisions) plus a worker Select (gray pill trigger).
- The feed is grouped by day with sticky day headers inside one card per day. Rows: avatar 32 + sentence + 13px time on the right, row height 56. Infinite load with a "Show more" secondary pill (no auto infinite scroll).

12. USAGE (/usage)
- Header "Usage" with a range segmented control (7 days · 30 days · 90 days) in the actions slot.
- A hero card: metric-xl "$12.40", caption "spent in the last 30 days", "↓ 8% vs previous period" in tone. In simulated mode, a 13px note reads "Simulated. Costs are priced for reference, nothing is billed."
- The chart card is full width.
- Two cards in a 2-column grid: "By worker" and "By model tier" tables.
- The billing card is simplified to the plan name, the period and a "Manage billing" secondary. Hide it until billing exists.

13. SETTINGS (/settings)
- A layout inspired by a desktop system-preferences window.
  - lg: a left list column (220px) of plain text links (Workspace, Members, Model providers, Credentials, Runtime, Danger zone), with the active one in a white rounded-10 pill. The right column (max-w 720) holds the grouped inset lists.
  - Mobile: a single list that drills into each section.
- Each group is a white card of rows (label 15px left; value, control or chevron right; hairlines inset 24px), with the group title at 13px/600 secondary above the card.
- Credentials: never display secrets. Show "Added Mar 3 · ends in ••••4f2a" plus "Replace" and "Remove" links.
- Provider cards: a status dot + "Simulated" or "Live".
- Danger zone: a separate card with a red text button, and typed-confirmation in the dialog.

14. REPLACE (/workers/[id]/replace/[versionId])
- A side-by-side comparison like a product compare page.
- H1 "Replace Alex with version 3?", sub "Here's what changes. Alex's history stays with the old version."
- Two columns (Current | Proposed), each headed by avatar 48, name, and a version tag. Aligned rows follow: Model tier, Instructions summary, Tools & access, Schedule, Expected cost per run, Recent score or projected.
- Rows that differ get a 6px primary dot with "Changed" at 12px on the proposed side. Unchanged values are secondary text.
- Mobile: the columns stack, with each row showing "Before → After".
- A sticky bottom material bar: "Replace Alex" primary + "Keep current version" secondary. Confirm via dialog.

15. LOADING / ERROR / NOT-FOUND
- Loading: skeletons that mirror the final layout (title bar 32px, stat strip, cards). No spinners.
- Error: a centered title-2 "Something went wrong on our side.", 17px secondary copy, "Try again" primary + "Go to Workforce" link. No stack traces in production.
- 404: "We couldn't find that page." with the same layout.

## Public landing page (`/`)

Public marketing page at "/". All copy below is original to this brand. Layout follows the premium-consumer rhythm: full-bleed sections alternating white (#fff) and light gray (#f5f5f7), centered headlines, and generous vertical padding (var(--space-section-marketing)). Content width is 1024px and the text column is 692px. Every visual is HTML/CSS mock cards built from the product's own components, with static sample data, wrapped in `role="img"` plus a descriptive aria-label (or aria-hidden with an adjacent caption). There are no images, gradients, blobs or emoji.

0. NAV (frosted, 48px, sticky)
- Wordmark "Foreman".
- Links: How it works · Product · Security · Pricing.
- Right: "Sign in" (text) and "Get started" (small primary pill).

1. HERO (white; pt 120px, pb 0; centered)
- Headline (display-xl): "Describe the job. Meet your new hire."
- Subhead (body-lg, secondary, max 640px): "Tell us what needs doing in plain English. We scope the work, design an AI worker for it, and put them on a schedule. Every deliverable is reviewed, scored, and yours to keep. If it isn't working, you replace them in a click."
- CTAs (xl pills, gap 16): "Get started" (primary) and "See how it works" (secondary gray pill, scrolls to #how).
- Beneath, 13px tertiary: "No credit card required."
- Showcase frame starts 64px below the CTAs. It's a rounded-[36px] #f5f5f7 frame, 1024px wide, that bleeds into the next section (negative bottom margin). Inside is a mock Workforce page:
  - A mini frosted nav.
  - A stat strip (Active workers 6 · Runs today 14 · Waiting for review 2 · Spend this month $38.20).
  - Three worker cards with invented names: Maya, "Market research analyst", score 88; Theo, "Support inbox triager", score 81; Priya, "Lead list builder", score 74 with a warning dot.
- Motion: the frame rises 24px and fades in over 600ms on load (the one longer animation, skipped under reduced motion).

2. HOW IT WORKS (#how; gray; 3 columns on md, stacked on mobile)
- Headline (display): "Three steps from idea to output."
- Each step has a large number (48px/600, tertiary color), a title-3 and a 17px secondary body:
  - 1, "Write the brief." "A few sentences is enough. We'll ask a couple of sharp questions, then turn it into a clear job spec you can edit."
  - 2, "Hire your worker." "Review a candidate's skills, tools, and expected cost before they start. Approve, and they're on the schedule."
  - 3, "Review the work." "Each run produces a deliverable you can read, rate, and send back. Scores build up into an honest performance record."
- Under each step, a small mock: a brief textarea, a résumé card, a deliverable card with a score ring.

3. FEATURE: RESUME BEFORE THE FIRST RUN (#product; white; text left, mock right on lg; stacked on mobile)
- Eyebrow (17px/600, warning orange): "Hiring"
- Headline (headline): "See exactly who you're hiring."
- Body: "Every worker comes with a résumé: what they'll do on each run, which tools they can use, what they're allowed to do without asking, and what it should cost. No black boxes."
- Link: "How workers are designed ›"
- Mock: a proposal résumé card for "Maya, Market research analyst". Skills list; tools as sentences ("Searches the public web", "Asks before emailing anyone"); "About $0.04 per run".

4. FEATURE: EVERY RUN, NARRATED (gray; mock left, text right)
- Headline: "Every run, told in plain English."
- Body: "Follow along step by step: what was searched, what was read, what was written. When something goes sideways, you'll know where and why."
- Mock: a run timeline with 5 human sentences and durations, one step expanded into an inset panel.

5. FEATURE: YOU APPROVE WHAT MATTERS (white; text left, mock right)
- Headline: "Nothing sensitive happens without you."
- Body: "Decide which actions need your sign-off. Sending an email, posting an update, touching a customer record: your worker pauses, shows you the draft, and waits."
- Mock: an approval card, "Theo wants to reply to 3 customers", with Approve / Decline pills.

6. SHOWCASE BAND (the only dark section; bg #000, text #f5f5f7; full-bleed; pt/pb 160px)
- Headline (display, white): "Your whole team, on one page."
- Sub (body-lg, #a1a1a6): "Who's working, what's waiting on you, and what it's costing, updated as it happens."
- A large mock: a Workforce plus performance chart composition on a #1d1d1f frame with radius 36. The chart is an SVG-free recharts-like line built from inline SVG paths, with a static blue line and gray grid.
- The nav switches to its dark material while over this band.

7. FEATURE: PERFORMANCE AND REPLACE (gray; two tiles side by side, radius 28, white, p-10)
- Tile A: headline "Performance reviews, not guesswork." Body: "Scores for accuracy, completeness, and usefulness, tracked across every run. Spot a slide before it becomes a problem." Mock: a score chart with Strong/Watch reference lines.
- Tile B: headline "Not working out? Replace them." Body: "Propose an improved version, compare it side by side, and switch over. The full history stays on file." Mock: the Before → After comparison rows.

8. TRUST AND SECURITY (#security; white; centered headline + 2×3 grid of short items; no icons, or single 24px monochrome line icons only)
- Headline (display): "Built to be trusted with real work."
- Sub: "Your workers act on your behalf, so the guardrails are part of the product, not an add-on."
- Items (title-3 + 15px body):
  - "Permissions enforced on our servers": "Tool access is checked on every action, not just shown in the interface."
  - "Approval before sensitive steps": "Actions you mark as sensitive wait for a person."
  - "Your workspace, walled off": "Every record is scoped to your organization, and every request is checked."
  - "A complete audit trail": "Every run, tool call, and decision is logged and reviewable."
  - "Secrets stay secret": "Credentials are stored encrypted and never shown again after you add them."
  - "Costs you can see": "Every run shows its cost to the cent."
- Note for the implementer: publish only claims that are true at launch. Verify each item against docs/SECURITY.md and the security workstream. Drop "encrypted" unless credential encryption at rest ships. Link "Read our security overview ›" to /security once it exists.

9. PRICING TEASER (#pricing; gray)
- Headline: "Pay for the work, not the seats."
- Sub: "Start free, then pay for what your workers actually do. Every run is itemized."
- Three white cards (radius 22), each with the name (title-2), one-line description, price placeholder, 4 plain bullet lines and a pill:
  - "Starter": "For trying out your first worker."
  - "Team": "For teams putting several workers on real jobs." (visually emphasized with a 2px primary border; no "Most popular" ribbon)
  - "Enterprise": "For custom controls, SSO, and volume."
- Implementer note: the owner must supply real prices. Until then, render "Pricing coming soon" and route the CTAs to /sign-up and a contact mailto. Never invent numbers in production.

10. FINAL CTA (white; centered; pt/pb 160px)
- Headline (display): "Your next hire is a paragraph away."
- Pills: "Get started" (primary xl) and "Sign in" (secondary xl).

11. FOOTER (gray #f5f5f7; 12px/16px, #6e6e73; hairline top)
- Four columns (collapsing into accordions on mobile):
  - Product: How it works, Security, Pricing.
  - Company: About, Contact.
  - Resources: Help center, Status.
  - Legal: Privacy, Terms.
- Bottom row: "© 2026 Foreman. All rights reserved." at left and "Made for teams who'd rather review than repeat." at right.
- Don't link pages that don't exist. Omit them until built.

Motion on the landing page: each section's headline, body and mock get the Reveal treatment (fade + 16px rise, 400ms ease-out, 60ms stagger, once per element, threshold 0.2).

## Motion

PRINCIPLES
- Motion confirms cause and effect or eases content in, and nothing else. Transitions run 120–400ms. No springs with overshoot, no parallax, no scroll-jacking, no auto-playing carousels, and no infinite decorative loops.
- Easing tokens:
  - --motion-ease-out cubic-bezier(0.22,1,0.36,1) for entering or revealing.
  - --motion-ease-standard cubic-bezier(0.4,0,0.6,1) for state changes and hovers.
  - --motion-ease-in-out cubic-bezier(0.65,0,0.35,1) for things that move and settle (the segmented thumb).
- Duration tokens: instant 120ms (press feedback), fast 200ms (hover, color, menus), base 280ms (dialogs, card hover lift, nav overlay), slow 400ms (scroll reveals). The single 600ms exception is the hero showcase frame.
- Animate only opacity and transform, plus background-color and box-shadow for hovers. Never animate width, height or top (the accordion uses the Radix height var).

SPECIFICS
- Buttons: bg-color over 200ms standard. Pressed state is opacity .9 for 120ms. No translate or scale.
- Clickable cards: shadow-card → shadow-card-hover and translateY(-2px) over 280ms ease-out.
- Global nav: shadow and hairline always present. When the page scrolls past 8px, the material opacity goes .72→.8 over 200ms (optional).
- Mobile menu: the icon bars rotate into an X over 240ms. The overlay fades over 280ms. Links stagger 20ms each with translateY(-8px→0).
- Local nav title: fades in over 200ms when the H1 leaves the viewport.
- Dialog: overlay fades over 200ms. Content does opacity 0→1 plus scale .96→1 over 240ms ease-out; exit is 160ms.
- Dropdown/popover: opacity plus translateY(-4px) over 180ms.
- Sheet: slides from the bottom or right over 320ms ease-out.
- Toasts: sonner defaults, capped at 280ms.
- Segmented control: the thumb translates between options over 240ms in-out. Tabs content cross-fades over 160ms.
- Live states:
  - The running dot is 7px info with a 1.6s ease-out ring pulse (scale 1→2.2, opacity .5→0). It's the ONLY infinite animation allowed, and it's shown only while a run is in flight.
  - The live progress rail advances with a width transition over 400ms.
- Skeleton: opacity pulse 0.6↔1 over 1.6s. No shimmer.
- Number changes (stat values on AutoRefresh): no count-up animation. Values swap in place with tabular-nums so nothing jitters.
- Scroll reveal (marketing only; never inside the app):
  - A client component `src/app/(marketing)/_components/reveal.tsx` using one shared IntersectionObserver (threshold 0.2, rootMargin "0px 0px -10% 0px"). It sets `data-revealed` once and then unobserves.
  - CSS: `[data-reveal]{opacity:0;transform:translateY(var(--reveal-distance));transition:opacity var(--duration-slow) var(--ease-out),transform var(--duration-slow) var(--ease-out);transition-delay:calc(var(--i,0)*60ms)} [data-reveal][data-revealed]{opacity:1;transform:none}`
  - Progressive enhancement: the hidden initial state applies only under `html.js` (set by a tiny inline script in the marketing layout, or `@media (scripting: enabled)`). Content is always visible without JS, for crawlers and in thumbnails.
- Reduced motion:
  - `@media (prefers-reduced-motion: reduce)` sets every duration token to 0ms and --reveal-distance to 0, so reveals appear instantly.
  - It also disables the running-dot pulse (static dot), the indeterminate progress slide (static 30% bar) and the hero rise.
  - Also add `*,*::before,*::after{animation-duration:.01ms!important;animation-iteration-count:1!important;transition-duration:.01ms!important;scroll-behavior:auto!important}` as a global safety net.
  - Smooth anchor scrolling (`scroll-behavior:smooth` on html) applies only under `prefers-reduced-motion: no-preference`.

## Things that make a UI look AI-generated — and what we do instead

"AI-GENERATED LOOK" TELLS, AND THE REMEDY FOR EACH

1. Purple or indigo accent (the current --primary is oklch indigo-violet). Remedy: a single blue #0071e3 for actions and links only, and near-black text for everything else.
2. Gradient blobs, radial glows, dot-grid backdrops and "aurora" meshes (the current auth layout has a dot grid plus a primary/4% glow). Remedy: flat white or #f5f5f7 surfaces. Depth comes only from soft shadows and scale of type.
3. Emoji or the "✓" glyph used as UI (the hire stepper uses "✓"), plus sparkle icons for "AI". Remedy: no emoji anywhere, and no Sparkles icon to mean "magic". Say what happens in words.
4. Lucide icon soup, meaning an icon on every label, stat, fact and nav item (WorkerCard facts, StatCard corners, sidebar). Remedy: icons only where they're faster than a word (close, more, search, send, copy, back chevron), at 16px in secondary color. Nav and labels are text only.
5. Badge overload (worker cards show status + health + run badges + a Simulated badge on the section). Remedy: one status per object as a dot plus word, health merged into the score, and Simulated shown globally once plus inline on generated artifacts.
6. Borders on everything, nested bordered boxes (card ring → bg-muted/40 bordered fact grid) and dashed outlines. Remedy: cards with no border and a soft shadow on a gray canvas, inset panels as flat #f5f5f7 fills, and hairlines only between list rows.
7. Equal-weight everything (14px text everywhere, 20px page titles barely larger than body, 4 identical KPI tiles). Remedy: a steep type scale (32px page titles, 22px sections, 15px body) and one clear focal point per page. Group KPIs into one strip.
8. Uppercase tracked micro-labels ("WORKSPACE", the `eyebrow` utility). Remedy: sentence-case 13px semibold secondary labels. Use eyebrows only on marketing, once per section.
9. Dense cards stuffed with label:value grids. Remedy: lead with one human sentence, demote metadata to 13px secondary, and move detail into the profile.
10. Generic SaaS copy ("Supercharge your workflow", "Unlock the power of AI", "Seamless", "Revolutionize"). Remedy: concrete, contractor-style copy that names the outcome ("Every Monday, a digest of what competitors shipped").
11. Colored tinted toasts and alert boxes with left accent borders. Remedy: white material toasts with a small tone icon. Callouts are soft-tinted panels with no side stripe.
12. Rainbow status palette used liberally (emerald, amber, rose and sky all at once on one screen). Remedy: status color only in 7px dots and short text, with fills reserved for the single "needs you" state.
13. Too many primary buttons and outline buttons in every header. Remedy: one blue pill per view, gray pills for secondary actions, and chevron text links for tertiary ones. Overflow goes into a "…" menu.
14. Stock "AI" illustrations, robots, brains, glowing orbs and 3D renders. Remedy: real product UI as HTML/CSS mock cards, with names and data that look like a real team's work.
15. Tiny sidebar-first dashboard chrome (a 240px sidebar that eats width, nav in 13px). Remedy: a frosted top nav with 4 destinations, a user menu for the rest, and full-width content up to 1200px.
16. Over-rounded AND over-shadowed controls (shadow-xs on buttons, ring-inset on logo tiles). Remedy: pills have no shadow. Shadow is reserved for cards, menus and dialogs.
17. Shimmer skeletons, count-up numbers, bouncing entrances and confetti. Remedy: the restrained motion spec, with reduced motion honored.
18. "Most popular" ribbons, fake testimonials, fake logos walls and invented metrics ("10x faster", "Trusted by 5,000 teams"). Remedy: none until they're real. The trust section states verifiable product guarantees only.
19. Inconsistent radii (6, 8, 10, 12, 16px mixed) and spacing. Remedy: the radius roles (inputs 12, cards 18, dialogs 22, tiles 28, hero 36) and spacing tokens, enforced through primitives rather than per-page classes.
20. Copying another company's look literally (its logo, product names, product photography, exact headline phrasing, SF font files). Remedy: an original wordmark and glyph, original copy, system fonts and Inter only, so we borrow the sensibility and nothing else.

IMPLEMENTATION GUARDRAILS
- Update src/components/README.md's "Visual language" table to this system. Change the "Linear / Vercel feel" and "indigo" guidance, and remove the rule against touching ui primitives for this redesign pass.
- Keep class names static (no `bg-${tone}`). The redesigned TONE_CLASSES map references the new token utilities (text-success, bg-warning-soft…).
- Don't introduce dark mode in this pass. Keep `@custom-variant dark` class-scoped as today.
- After the change, run an axe or contrast check. #86868b must never be used for body text under 18px.

## Implementation notes (wave B, design-foundation)

Two things bite silently if you don't know them, so they are settled once in the foundation:

- **`cn()` must know the type scale.** tailwind-merge reads any `text-<unknown>` as a text *colour*, so an unconfigured `cn("text-footnote", "text-muted-foreground")` drops the size. `src/lib/utils.ts` exports a `createCn(...)` instance that registers every `@utility text-*` role as a font size. **Import `cn` from `@/lib/utils`, never from the bare `cn` package** — `tests/ui/cn.test.ts` enforces both halves.
- **The font stacks keep a literal fallback: `var(--font-inter, "Inter")`.** An unresolved `var()` makes the whole `font-family` invalid at computed-value time and the page renders in the browser's default serif. The fallback matters for any tree rendered outside the root `<html>` — `app/global-error.tsx` replaces the root layout and therefore never gets next/font's variable.
- Focus is one base rule (`:focus-visible { box-shadow: var(--focus-ring) }`). A component that already carries a `shadow-*` utility would replace it, so those add `focus-visible:ring-4 focus-visible:ring-primary/30` instead (Tailwind's ring and shadow compose). The base rule does not set `border-radius: inherit`: a box-shadow already follows the element's own radius, and inheriting one would reshape elements that have none.
- Toasts sit top-center (one position, no viewport-dependent switch), which is the one place this implementation diverges from the "bottom-center on mobile, top-right on desktop" line above.
