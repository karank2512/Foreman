import type { ReactNode } from "react";
import Link from "next/link";
import { cn } from "@/lib/utils";

export interface BreadcrumbEntry {
  label: string;
  /** Omit on the last (current) entry. */
  href?: string;
}

export interface PageHeaderProps {
  /** Page title. A string in most cases; a node when the title carries an avatar or a status line. */
  title: ReactNode;
  /** One sentence of orientation under the title. */
  description?: ReactNode;
  /** Right-aligned controls: at most one primary pill plus one secondary; the rest go in a "…" menu. */
  actions?: ReactNode;
  /** Where "‹ Back" points. Replaces breadcrumbs on detail pages. */
  backHref?: string;
  /** Label for the back link. Defaults to the parent breadcrumb, then "Back". */
  backLabel?: string;
  /**
   * Legacy trail. Only the parent is rendered, as "‹ Parent" — deep pages that genuinely need two levels pass
   * three entries and get "Workforce › Alex" above the title.
   */
  breadcrumbs?: BreadcrumbEntry[];
  className?: string;
}

/** First element of every page. Owns the only `<h1>` and the 40px of air between it and the content. */
export function PageHeader({
  title,
  description,
  actions,
  backHref,
  backLabel,
  breadcrumbs,
  className,
}: PageHeaderProps) {
  const trail = breadcrumbs?.filter((c) => c.href) ?? [];
  const parent = trail[trail.length - 1];
  const href = backHref ?? parent?.href;
  const label = backLabel ?? parent?.label ?? "Back";
  // Two-level trails ("Workforce › Alex") only earn their space when the page is genuinely nested twice.
  const deep = trail.length > 1 ? trail : null;

  return (
    <header data-slot="page-header" className={cn("mb-10 flex flex-col gap-3", className)}>
      {deep ? (
        <nav aria-label="Breadcrumb" className="flex items-center gap-1.5 text-footnote text-muted-foreground">
          {deep.map((crumb, index) => (
            <span key={`${crumb.label}-${index}`} className="flex items-center gap-1.5">
              {index > 0 ? <span aria-hidden="true">›</span> : null}
              <Link
                href={crumb.href ?? "#"}
                className="rounded-sm text-link outline-none hover:underline max-md:-my-3.5 max-md:py-3.5"
              >
                {crumb.label}
              </Link>
            </span>
          ))}
        </nav>
      ) : href ? (
        // Under `md` the padding grows the tap box to 44px; the negative margin keeps the line where it was.
        <Link
          href={href}
          className="w-fit rounded-sm text-callout text-link outline-none hover:underline max-md:-my-3.5 max-md:py-3.5"
        >
          ‹ {label}
        </Link>
      ) : null}

      <div className="flex flex-col gap-5 sm:flex-row sm:items-start sm:justify-between sm:gap-8">
        <div className="min-w-0 space-y-2">
          <h1 className="text-title-1 text-balance text-foreground">{title}</h1>
          {description ? (
            <p className="text-body max-w-[65ch] text-pretty text-muted-foreground">{description}</p>
          ) : null}
        </div>
        {actions ? <div className="flex shrink-0 flex-wrap items-center gap-2.5">{actions}</div> : null}
      </div>
    </header>
  );
}
