# UI kit — shared components, helpers and conventions

Everything a page needs to look like the rest of the product. **Import each component from its own file** (no barrel). `src/components/ui/*` are the shadcn primitives, restyled to carry the design system — change them there, not per page.

The visual contract is `docs/DESIGN.md` ("Quiet confidence"). `/(dev)/styleguide` renders every token and primitive on one page in development; open it after touching `globals.css` or a primitive.

## Rules

1. **Server components by default.** Add `"use client"` only for interactivity (state, effects, event handlers, `usePathname`). Keep client files small and leaf-level; fetch data in the server page and pass plain props down.
2. **Never value-import `@/server/*` in a client file** — exceptions: `@/server/domain` and `@/server/runtime/types` (pure, zod-only). Everything else under `@/server`, and Prisma enums, are `import type` only.
3. Props crossing server → client must be plain JSON: no `Date`, no `Decimal`, no functions (server actions excepted), no lucide component references. Map in `queries/*` (`Number(x)`, `.toISOString()`).
4. Format with `@/lib/format` — never hand-roll money, token, duration or date strings.
5. Light theme only. Don't add `dark:` classes. Don't build class names dynamically (`bg-${color}-100` will not exist in the CSS) — use a static map like `WorkerAvatar` does.
6. Browser storage only inside `useEffect` / event handlers.
7. Language: contractor-style and human — "Hire", "Replace", "Alex searched the web for…", never "agent executed tool".

## Visual language

Calm, confident, product-first. Hierarchy comes from **type size and whitespace**, not from boxes, icons or colour. One accent, one status per object, one primary button per view.

| Thing | Convention |
|---|---|
| Accent (`primary` `#0071e3`) | Only: the ONE primary pill per view, links (`text-link`), focus rings, and the "running" status. Nothing else is blue, and nothing anywhere is indigo or purple. |
| Buttons | Pills. `default` blue (one per view) · `secondary` gray (the workhorse) · `link` blue text with a trailing `<ChevronRight data-icon="inline-end" />` for tertiary · `destructive` = danger text on a soft fill. The solid red pill exists only on `ConfirmDialog`'s final confirm. Overflow goes in a "…" `DropdownMenu`. |
| Status colours | `success` green · `attention` orange (waiting on a human) · `failure` red · `running` blue · `idle` gray — always via `StatusBadge` or `TONE_CLASSES` from `@/lib/status`, never a Tailwind palette shade. Colour appears as a 7px dot or short text; soft fills are for the one state that needs a person. |
| Scores (0–100) | ≥ 80 "Strong" · 65–79 "Watch" · < 65 "At risk" · `null` an em-dash. `ScoreRing` in cards, `ScoreMetric` on a profile header. Health merges into the score — never show both. |
| Simulated | `SimulatedBadge` once globally in the nav, plus inline in the meta line of generated artifacts ("Simulated run · 2.4s · $0.00 billed"). Never on a section heading or a stat. |
| Type | Use the scale utilities, never raw sizes: `text-display-xl/display/headline` (marketing) · `text-title-1` (PageHeader `<h1>`) · `text-title-2` (Section, dialogs) · `text-title-3` (card titles) · `text-body` 17px · `text-body-app` 15px (app base, set by `AppShell`) · `text-callout` 14px · `text-footnote` 13px · `text-caption` 12px · `text-metric-xl` / `text-metric` for numbers. Weights are 400/500/600 only — never 700, never light. `eyebrow` is sentence case, never uppercase. |
| Numbers | `metric` (tabular-nums) on anything in a column or that updates live; right-align numeric table columns. Mono (`font-mono`) only for ids, code and JSON. |
| Surfaces | Canvas `bg-canvas` (#f5f5f7); content on white `Card`s — 18px radius, `shadow-card`, **no ring**. Inset panels: `rounded-lg bg-muted p-4`, no border. Hairlines (`border-border`) only between list rows. Never nest a bordered box in a bordered box. |
| Radii | inputs 12 (`rounded-lg`) · cards 18 (`rounded-xl`) · dialogs 22 · menus 14 · tiles 28 · pills full. Enforced by the primitives — don't pick per page. |
| Spacing | Between page sections `space-y-14` (56px) · card padding is the Card's own 24px · between cards `gap-6` · stacked form fields `space-y-4`. When in doubt, remove a divider and add space. |
| Icons | lucide, only where an icon is faster than a word (close, more, copy, send, back chevron), `size-4` in `text-muted-foreground`. Never an icon per nav item, label, stat or fact. |
| Motion | 120–400ms, `ease-out` entering / `ease-standard` state changes. Animate opacity and transform only. `LiveDot` is the single infinite animation, and only while a run is in flight. Honour `prefers-reduced-motion` (the tokens already do). |
| Charts (recharts) | Series `var(--chart-1)` blue → `--chart-2` gray → `--chart-3` green → `--chart-4` orange → `--chart-5` red; grid `var(--chart-grid)`, axis text `var(--chart-axis)` at 12px, no axis lines, no vertical grid. |

**Don't**: uppercase micro-labels · an icon on every label · three badges on one card · gradients, glows or dot grids · emoji or a "✓" glyph as UI · `ring-1` plus a shadow on the same card · two primary buttons in one header · `text-tertiary` (#86868b) on text under 18px.

## Page recipe

```tsx
// src/app/(app)/workforce/page.tsx — server component
export const metadata: Metadata = { title: "Workforce" };          // → "Workforce · AI Staffing Agency"

export default async function WorkforcePage() {
  const s = await requireSession();
  const data = await getWorkforce(s.organizationId);
  return (
    <>
      <PageHeader title="Workforce" description="Your AI workers and how they're doing." />
      <div className="space-y-14">
        <StatStrip>
          <Stat label="Active workers" value={data.active} hint="Everyone is on the job" />
          …
        </StatStrip>
        <Section title="Your team" actions={
          <Button variant="link" asChild><Link href="/activity">View all <ChevronRight data-icon="inline-end" /></Link></Button>
        }>
          {data.workers.length === 0
            ? <EmptyState title="No workers yet" description="…" action={<Button size="lg">Hire a worker</Button>} />
            : <div className="grid gap-6 md:grid-cols-2 xl:grid-cols-3">{/* <Card> per worker */}</div>}
        </Section>
      </div>
      <AutoRefresh active={data.hasRunsInFlight} />
    </>
  );
}
```

- `AppShell` (global nav, canvas, 1200px container, 40px top padding, `text-body-app`) comes from `(app)/layout.tsx` — pages render content only, **starting with `PageHeader`** (it owns the `<h1>`).
- The global nav already carries the "Hire" pill, so a page header rarely needs a primary button too.
- Detail pages: `PageHeader` `backHref` / `backLabel`, then `LocalNav` for in-page sections. Two-column detail layout: `grid gap-6 lg:grid-cols-12` with the main column `lg:col-span-8`.
- Card pattern: `<Card><CardHeader><CardTitle/><CardDescription/><CardAction/></CardHeader><CardContent/>[<CardFooter/>]</Card>`. Lists inside cards: `divide-y divide-border` rows, not nested cards.
- `(app)/loading.tsx`, `error.tsx`, `not-found.tsx` already exist; call `notFound()` from `next/navigation` when a query throws `NOT_FOUND`.
- Server actions: wrap the body in `runAction` and let the client toast — see `@/lib/action-result`.

## Components

| Component | Import | Kind |
|---|---|---|
| `AppShell` | `@/components/app-shell` | server (layout only) |
| `GlobalNav` · `MobileMenu` · `UserMenu` | `@/components/shell/*` | client (rendered by AppShell) |
| `LocalNav` | `@/components/shell/local-nav` | client |
| `Wordmark` · `LogoGlyph` | `@/components/shell/logo` | server-safe |
| `PageHeader` | `@/components/page-header` | server-safe |
| `Section` | `@/components/section` | server-safe |
| `StatStrip` · `Stat` · `StatCard` | `@/components/stat-card` | server-safe |
| `EmptyState` | `@/components/empty-state` | server-safe |
| `StatusBadge` | `@/components/status-badge` | server-safe |
| `WorkerAvatar` | `@/components/worker-avatar` | server-safe |
| `ScoreRing` · `ScoreMetric` | `@/components/score-ring` | server-safe |
| `Sparkline` | `@/components/sparkline` | server-safe |
| `SimulatedBadge` | `@/components/simulated-badge` | server-safe (tooltip hydrates) |
| `LiveDot` | `@/components/live-dot` | server-safe |
| `Markdown` | `@/components/markdown` | server-safe |
| `DataTable` | `@/components/data-table` | server-safe |
| `JsonView` | `@/components/json-view` | server-safe (copy button hydrates) |
| `RelativeTime` | `@/components/relative-time` | client |
| `AutoRefresh` | `@/components/auto-refresh` | client |
| `CopyButton` | `@/components/copy-button` | client |
| `ConfirmDialog` | `@/components/confirm-dialog` | client |

"Server-safe" = no hooks; usable from server and client components alike. All accept an optional `className` unless noted.

### AppShell — `{ user: { name, email, organizationName, canHire }, simulated, pendingApprovals, children }`
Used once, by `(app)/layout.tsx`. Renders the skip link, the frosted `GlobalNav` (Workforce · Jobs · Approvals · Activity, the Simulated chip, the "Hire" pill and the account menu) and `<main>` on the canvas. `canHire` is `can(role, "workers.hire")`: the Hire pill and the mobile menu's "Hire a worker" only render when it is true. The mobile menu portals its overlay to `document.body` (the frosted bar's `backdrop-filter` would otherwise trap a fixed panel inside the 48px bar). Destinations live in `shell/nav-items.ts`; detail routes light their parent via `match` prefixes (`/workers`, `/runs`, `/deliverables` → Workforce). Usage and Settings are in the user menu, not the bar.

### LocalNav — `{ title, items, action?, watchSelector? }`
Sticky under the global nav for pages with sections (worker profile, job detail, run detail). `items: { label, href, active? }[]` — routes or in-page anchors. The title fades in once the page `<h1>` scrolls out of view; on mobile the links scroll horizontally and the active one starts in view.
```tsx
<LocalNav title={worker.name} items={tabs} action={<Button size="sm">Run now</Button>} />
```

### PageHeader — `{ title, description?, actions?, backHref?, backLabel?, breadcrumbs? }`
`title` is the only `<h1>` (`text-title-1`); `description` is 17px secondary, max 65ch. `backHref` renders "‹ Label" above the title. `breadcrumbs` still works — only the parent is shown, unless the trail is genuinely two levels deep. At most one primary plus one secondary in `actions`.
```tsx
<PageHeader title="Alex" description="Market research analyst · hired Sep 2" backHref="/workforce" backLabel="Workforce"
  actions={<><Button variant="secondary">Talk to Alex</Button><Button>Run now</Button></>} />
```

### Section — `{ title, description?, actions?, children }`
Titled block (`<h2>`, `text-title-2`). Doesn't wrap children in a Card. The action slot expects a text link, not a button.

### StatStrip + Stat — `Stat { label, value, hint?, trend?, icon? }`
Four KPIs in one white card split by hairlines (2×2 under 768px). `trend`: `{ direction?, label?, tone?, values? }` — `tone` defaults from direction (override where up is bad, e.g. cost); `values` draws a sparkline, and only one stat per strip should have one. `icon` is accepted for source compatibility and **not rendered**. `StatCard` is the standalone fallback for a lone KPI.
```tsx
<StatStrip>
  <Stat label="Spend this month" value={formatUsd(total)}
    trend={{ direction: "up", label: "12% vs last month", tone: "negative", values: dailyCosts }} />
</StatStrip>
```

### EmptyState — `{ icon?, title, description?, action? }`
Centred, `py-20`, no dashed box — inside a card the card is the frame. Title `text-title-2`, description 17px max 44ch, one `size="lg"` pill.

### StatusBadge — `{ kind, status, emphasis? }`
A 7px tone dot plus a word. `emphasis="auto"` (default) promotes states waiting on a person, and failures, to a soft pill; force with `"dot"` or `"pill"`. Every value of every lifecycle enum is mapped (compile-time exhaustive); unknown strings degrade to a humanized idle status. Notable labels: `WAITING_FOR_APPROVAL` → "Needs approval", `PENDING_REVIEW` → "Awaiting review", `SUCCEEDED` → "Completed", version `REJECTED` → "Declined". RUNNING pulses. **One per object.**

### WorkerAvatar — `{ name, color, size? }`
`color`: `Worker.avatarColor` (domain `AVATAR_COLORS`; unknown → neutral gray). `size`: `xs` 24 · `sm` 32 · `md` 40 (default) · `lg` 48 · `xl` 72. Pastel fill, same-hue initials, no ring. The frozen `violet` / `indigo` tokens render in lime / cyan — there is no purple in this design.

### ScoreRing / ScoreMetric — `{ score, size? }` / `{ score, label? }`
`ScoreRing`: a 3px arc, default 44px; the band colours the arc only, the number stays in foreground; `null` = dashed track and an em-dash. `ScoreMetric` is the profile-header form — a big number plus "Performance · Strong".

### Sparkline — `{ values, fill?, className? }`
Oldest → newest, `currentColor`, default `h-7 w-20 text-foreground/40`. `fill` adds an 8% area — off by default. Use recharts for anything with axes.

### SimulatedBadge — `{ dotOnly?, className? }`
Unconditional — you decide when: `{run.simulated ? <SimulatedBadge /> : null}`. `dotOnly` is the mobile-nav form. The global one is rendered by `AppShell`.

### LiveDot — `{ label? }`
A pulsing blue dot plus "Live", for pages that are polling (`AutoRefresh`) or runs in flight. Never a spinner.

### Markdown — `{ content, variant? }`
Safe renderer (no `dangerouslySetInnerHTML`; parser is `parseMarkdown` in `@/lib/markdown`). `variant="article"` (default) is the 17px/1.6 reading view at 720px for deliverables; `variant="compact"` is 15px for chat replies and dense cards.

### DataTable — `{ rows, columns?, maxRows?, showIndex? }`
Read-only table for worker-produced records: humanized headers, grouped right-aligned numbers, short external links, "—" for empty, sticky header, "Showing N of M records" footer. For app entities (runs, jobs, approvals) build a real table with `@/components/ui/table` inside a `<Card className="py-0">`.

### JsonView — `{ value, label?, defaultOpen? }`
Collapsible (native `<details>`), lightly tinted, with copy. Debug surfaces only — pass the parsed value, not a JSON string.

### RelativeTime — `{ iso }` · AutoRefresh — `{ active, intervalMs? }` · CopyButton — `{ value, label? }`
`RelativeTime` is hydration-safe and self-updating, with the absolute time as `title`. `AutoRefresh` renders nothing and `router.refresh()`es every `intervalMs` (default 4000, min 1000) while `active`, pausing in hidden tabs — pair it with a `LiveDot` in the page meta. `CopyButton` is a circular icon button, or a small text button with `label`.

### ConfirmDialog — `{ trigger, title, description, confirmLabel, destructive?, onConfirm }`
`onConfirm: () => Promise<void>` — resolve closes the dialog; **throw** to keep it open and toast the message. Pending state, double-submit and dismissal-while-pending are handled. `destructive` gives the confirm the one solid red pill in the product.

## Primitives (`src/components/ui/*`)

Restyled, API-compatible shadcn. `Button` (variants default/secondary/outline/ghost/destructive/link; sizes xs/sm/default/lg/xl + icon·icon-xs·icon-sm·icon-lg; under `md` every size below 44px gets an invisible 44px hit area — a fixed 44px `::before` band or square centred on the control, never an inset derived from its drawn height — as do the `sm` `SelectTrigger`, `TabsTrigger`, `LocalNav` links, the wordmark and the PageHeader back link. Hand-rolled pills and segmented links in pages need the same: `relative max-md:before:absolute max-md:before:inset-x-0 max-md:before:top-[calc(50%_-_22px)] max-md:before:h-11`) · `Card` (+ `variant="tile"` for cards on a white background) · `Input`/`Textarea`/`Select` (44px, 12px radius) · `Tabs` (`TabsList` is a segmented control; page-level tabs belong in `LocalNav`) · `Badge` (+ tone variants success/warning/danger/info/neutral) · `Dialog`/`Sheet`/`Popover`/`DropdownMenu` (frosted `material-thick`) · `Switch` (green when on) · `Progress` (omit `value` for the indeterminate rail) · `Skeleton` (opacity pulse, no shimmer) · `Table` (hairline rows) · `Tooltip` · `Checkbox`/`RadioGroup` (18px).

CSS utilities from `globals.css` worth knowing: `material-nav`, `material-thick`, the `text-*` scale, `eyebrow`, `metric`, `live-dot`, and `[data-reveal]` for marketing scroll reveals.

## Helpers (`src/lib`)

| File | Exports |
|---|---|
| `format.ts` | `formatUsd` · `formatUsdPrecise` · `formatTokens` · `formatDuration` · `formatPercent` · `formatNumber` · `formatRelativeTime` · `formatDateTime` · `formatDate` · `titleCase` · `sentenceCase` · `pluralize` · `EMPTY`. All accept `null`/`undefined` → "—". |
| `action-result.ts` | `ActionResult<T>`, `runAction(fn)` |
| `status.ts` | `getStatusMeta`, `statusLabel`, `STATUS_META`, `TONE_CLASSES`, `scoreBand`, `SCORE_BAND_CLASSES` |
| `markdown.ts` | `parseMarkdown`, `parseInline`, `inlineToText`, `sanitizeHref` |
| `cell-format.ts`, `json-highlight.ts`, `initials.ts` | internals of DataTable / JsonView / avatars (`displayUrl`, `safeStringify`, `initialsOf` are handy) |
| `utils.ts` | `cn(...)` |
