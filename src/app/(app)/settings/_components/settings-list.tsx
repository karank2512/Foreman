import type { ReactNode } from "react";
import { Card } from "@/components/ui/card";
import { TONE_CLASSES, type StatusTone } from "@/lib/status";
import { cn } from "@/lib/utils";

/**
 * The grouped-list shell the whole account area is built from: a 13px sentence-case group title above a white
 * card of hairline rows. The hairlines are inset 24px (the row's own `mx-6`), so nothing nests a box in a box.
 */

export function SettingsGroup({
  title,
  description,
  footer,
  children,
  className,
}: {
  title?: string;
  description?: ReactNode;
  /** A quiet sentence under the card — explanations live here, not inside the rows. */
  footer?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section className={cn("space-y-3", className)}>
      {title ? (
        <div className="space-y-1 px-1">
          <h3 className="eyebrow">{title}</h3>
          {description ? <p className="text-footnote text-pretty text-muted-foreground">{description}</p> : null}
        </div>
      ) : null}
      <Card className="gap-0 py-2">{children}</Card>
      {footer ? <p className="text-footnote max-w-[62ch] text-pretty text-muted-foreground px-1">{footer}</p> : null}
    </section>
  );
}

/** One row: a 15px label (plus an optional sentence under it) on the left, a value or control on the right. */
export function SettingsRow({
  label,
  hint,
  children,
  /** Top-align the control when the left side runs to two or more lines. */
  align = "center",
  className,
}: {
  label: ReactNode;
  hint?: ReactNode;
  children?: ReactNode;
  align?: "center" | "start";
  className?: string;
}) {
  return (
    <div
      className={cn(
        "mx-6 flex flex-col gap-2 border-b border-border py-4 last:border-0 sm:flex-row sm:justify-between sm:gap-6",
        align === "center" ? "sm:items-center" : "sm:items-start",
        className,
      )}
    >
      <div className="min-w-0 space-y-0.5">
        <div className="text-[15px] font-medium text-pretty text-foreground">{label}</div>
        {hint ? <div className="text-footnote text-pretty text-muted-foreground">{hint}</div> : null}
      </div>
      {children ? (
        <div className="flex shrink-0 flex-wrap items-center gap-3 sm:justify-end">{children}</div>
      ) : null}
    </div>
  );
}

/** The right-hand value of a row when it is just text. */
export function SettingsValue({ children, className }: { children: ReactNode; className?: string }) {
  return <span className={cn("text-[15px] text-muted-foreground", className)}>{children}</span>;
}

/** A 7px dot plus a word — the only place colour appears in this area. One per row. */
export function StatusLine({ tone, children, className }: { tone: StatusTone; children: ReactNode; className?: string }) {
  return (
    <span className={cn("inline-flex items-center gap-2 text-footnote font-medium text-foreground", className)}>
      <span className={cn("size-[7px] shrink-0 rounded-full", TONE_CLASSES[tone].dot)} aria-hidden="true" />
      {children}
    </span>
  );
}

/** Env var names, slugs, key fragments. Never a whole value. */
export function Mono({ children }: { children: ReactNode }) {
  return <span className="font-mono text-[13px] text-foreground">{children}</span>;
}

/**
 * Server tuning — env vars, commands — that only the person running the platform acts on. Folded away so a
 * workspace owner reads product language first and the ops detail is one click away, not the headline.
 * Native `<details>`, so it works in server components with no client state.
 */
export function OperatorNotes({ children }: { children: ReactNode }) {
  return (
    <details className="group/operator px-1">
      <summary className="w-fit cursor-pointer list-none rounded-sm text-footnote font-medium text-link outline-none select-none hover:underline [&::-webkit-details-marker]:hidden">
        <span className="group-open/operator:hidden">For operators ›</span>
        <span className="hidden group-open/operator:inline">Hide operator notes</span>
      </summary>
      <div className="text-footnote mt-2 max-w-[62ch] space-y-2 text-pretty text-muted-foreground">{children}</div>
    </details>
  );
}

/** The one tinted panel in the area, for the single state that needs a person (budget spent, workspace suspended). */
export function Callout({ tone = "attention", children }: { tone?: "attention" | "failure"; children: ReactNode }) {
  return (
    <p
      className={cn(
        "rounded-lg px-4 py-3 text-callout text-pretty",
        tone === "attention" ? "bg-warning-soft text-warning" : "bg-danger-soft text-danger",
      )}
    >
      {children}
    </p>
  );
}
