import type { ReactNode } from "react";
import type { JobSpec } from "@/server/domain";
import type { ToolMeta } from "@/server/queries/hire";
import { formatUsd, sentenceCase } from "@/lib/format";
import { cn } from "@/lib/utils";
import { DELIVERABLE_FORMAT_SENTENCES } from "../schema";

/**
 * The job spec rendered as a document: headings and prose separated by whitespace and hairlines, not a grid of
 * labelled boxes. Each section is a `<section>` with a 17px/600 heading, 17px body, and an optional inline
 * "Edit" action supplied by the parent (only the fields `updateJobSpec` accepts can be edited).
 */

const INPUT_SOURCE_SENTENCES: Record<JobSpec["inputs"][number]["source"], string> = {
  web: "from the public web",
  provided_data: "from data you provide",
  user_instruction: "from your instructions",
  previous_runs: "from previous runs",
};

export function DocSection({ title, action, children, className }: { title: string; action?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={cn("py-8 first:pt-0 last:pb-0", className)}>
      <div className="mb-3.5 flex flex-wrap items-baseline justify-between gap-x-6 gap-y-1">
        <h2 className="text-title-3 text-foreground">{title}</h2>
        {action}
      </div>
      <div className="space-y-4 text-body text-pretty">{children}</div>
    </section>
  );
}

/** Plain bullets, 17px, with a quiet marker — no icons, no tinted dots. */
export function DocList({ items, empty, ordered = false }: { items: string[]; empty?: string; ordered?: boolean }) {
  if (items.length === 0) return empty ? <p className="text-muted-foreground">{empty}</p> : null;
  const className = cn("space-y-2.5 pl-5 marker:text-muted-foreground", ordered ? "list-decimal" : "list-disc");
  return ordered ? (
    <ol className={className}>
      {items.map((item, i) => (
        <li key={`${i}-${item}`}>{item}</li>
      ))}
    </ol>
  ) : (
    <ul className={className}>
      {items.map((item, i) => (
        <li key={`${i}-${item}`}>{item}</li>
      ))}
    </ul>
  );
}

export function DeliverableSection({ spec }: { spec: JobSpec }) {
  const { deliverable } = spec;
  return (
    <DocSection title="What lands each time">
      <p>
        <span className="font-medium">{deliverable.title}</span> — {deliverable.description}
      </p>
      <p className="text-muted-foreground">
        Delivered as {DELIVERABLE_FORMAT_SENTENCES[deliverable.format]}
        {deliverable.targetCount ? <>, with about <span className="metric">{deliverable.targetCount}</span> records each run</> : null}.
      </p>

      {deliverable.fields.length > 0 ? (
        <div className="space-y-2.5">
          <p className="text-callout font-medium text-muted-foreground">Each record carries</p>
          <ul className="space-y-2">
            {deliverable.fields.map((field) => {
              const label = sentenceCase(field.name);
              // The scoper often describes a field with its own name ("lead_investor — Lead investor"); say it once.
              const describes = field.description.trim().toLowerCase() !== label.toLowerCase();
              return (
                <li key={field.name}>
                  {/* The exact column key stays one hover away for whoever maps it into a CRM. */}
                  <span title={field.name} className="font-medium">
                    {label}
                  </span>
                  <span className="text-muted-foreground">
                    {describes ? ` — ${field.description}` : null}
                    {field.required ? " (required)" : ""}
                  </span>
                </li>
              );
            })}
          </ul>
        </div>
      ) : null}

      {deliverable.sections.length > 0 ? (
        <div className="space-y-2.5">
          <p className="text-callout font-medium text-muted-foreground">Report sections</p>
          <DocList items={deliverable.sections} ordered />
        </div>
      ) : null}
    </DocSection>
  );
}

export function SourcesSection({ spec, toolMeta }: { spec: JobSpec; toolMeta: Record<string, ToolMeta> }) {
  const hasInputs = spec.inputs.length > 0;
  const hasTools = spec.toolsLikelyNeeded.length > 0;
  return (
    <DocSection title="Where the work comes from">
      {hasInputs ? (
        <ul className="space-y-2.5">
          {spec.inputs.map((input) => (
            <li key={input.name}>
              <span className="font-medium">{input.name}</span>
              <span className="text-muted-foreground">
                {" — "}
                {input.description} ({INPUT_SOURCE_SENTENCES[input.source]})
              </span>
            </li>
          ))}
        </ul>
      ) : null}

      {hasTools ? (
        <div className="space-y-2.5">
          <p className="text-callout font-medium text-muted-foreground">Tools the worker will likely need</p>
          <ul className="space-y-2.5">
            {spec.toolsLikelyNeeded.map((name) => {
              const meta = toolMeta[name];
              return (
                <li key={name}>
                  <span className="font-medium">{meta?.displayName ?? sentenceCase(name)}</span>
                  <span className="text-muted-foreground">
                    {" — "}
                    {meta?.humanDescription ?? "Registered tool."}
                    {meta?.defaultRequiresApproval ? " Asks you first." : ""}
                  </span>
                </li>
              );
            })}
          </ul>
        </div>
      ) : null}

      {!hasInputs && !hasTools ? <p className="text-muted-foreground">No outside sources — the worker reasons over what the job provides.</p> : null}
    </DocSection>
  );
}

export function CriteriaSection({ spec }: { spec: JobSpec }) {
  return (
    <DocSection title="What good looks like">
      <ul className="space-y-3">
        {spec.successCriteria.map((criterion) => (
          <li key={criterion.id}>
            {criterion.description}
            {criterion.metric || criterion.target ? (
              <span className="text-muted-foreground">
                {" — "}
                {criterion.metric ?? "target"}
                {criterion.target ? <span className="metric"> {criterion.target}</span> : null}
              </span>
            ) : null}
          </li>
        ))}
      </ul>
    </DocSection>
  );
}

export function BoundariesSection({ spec }: { spec: JobSpec }) {
  const { budget } = spec;
  const hasBudget = budget.maxCostPerRunUsd !== undefined || budget.maxMonthlyUsd !== undefined;
  return (
    <DocSection title="Boundaries">
      <DocList items={spec.constraints} empty="No special constraints." />
      {spec.outOfScope.length > 0 ? (
        <div className="space-y-2.5">
          <p className="text-callout font-medium text-muted-foreground">Out of scope</p>
          <DocList items={spec.outOfScope} />
        </div>
      ) : null}
      <div className="space-y-2.5">
        <p className="text-callout font-medium text-muted-foreground">Needs your sign-off</p>
        <DocList items={spec.approvalPolicy.requireApprovalFor} empty="Nothing — every run finishes on its own." />
        {spec.approvalPolicy.notes ? <p className="text-muted-foreground">{spec.approvalPolicy.notes}</p> : null}
      </div>
      <p className="text-muted-foreground">
        {hasBudget ? (
          <>
            Capped at <span className="metric">{budget.maxCostPerRunUsd !== undefined ? formatUsd(budget.maxCostPerRunUsd) : "no limit"}</span> per run
            {budget.maxMonthlyUsd !== undefined ? (
              <>
                {" and "}
                <span className="metric">{formatUsd(budget.maxMonthlyUsd)}</span> per month
              </>
            ) : null}
            .
          </>
        ) : (
          "No budget cap requested — the platform default of a few dollars per run applies."
        )}
      </p>
    </DocSection>
  );
}

export function AssumptionsSection({ spec }: { spec: JobSpec }) {
  if (spec.assumptions.length === 0) return null;
  return (
    <DocSection title="What we assumed">
      <p className="text-muted-foreground">Edit the spec if any of these are wrong.</p>
      <DocList items={spec.assumptions} />
    </DocSection>
  );
}
