import { format } from "date-fns";
import type { WorkerProposal } from "@/server/domain";
import type { ToolMeta } from "@/server/queries/hire";
import { RelativeTime } from "@/components/relative-time";
import { SimulatedBadge } from "@/components/simulated-badge";
import { Card } from "@/components/ui/card";
import { WorkerAvatar } from "@/components/worker-avatar";
import { formatUsd, sentenceCase } from "@/lib/format";
import { MODEL_TIER_LABELS, operationLabel } from "../schema";

/**
 * The runtime fills `{{date}}` / `{{job_title}}` on each run; here we show what the first one would be called.
 * Same placeholders and date format as the runtime's `renderTitle` (src/server/runtime/deliverable.ts), so the
 * title promised here is the one that lands in the deliverables list ("… — 2026-09-27").
 */
function exampleDeliverableTitle(template: string, jobTitle: string): string {
  return template
    .replace(/\{\{\s*date\s*\}\}/gi, format(new Date(), "yyyy-MM-dd"))
    .replace(/\{\{\s*job_title\s*\}\}/gi, jobTitle)
    .trim();
}

/** "Searches the public web" — the tool in a sentence, with its approval posture as a second clause. */
function toolSentence(displayName: string, meta: ToolMeta | undefined, requiresApproval: boolean): string {
  const base = meta?.humanDescription ?? displayName;
  return requiresApproval ? `${base} Asks you first.` : base;
}

/**
 * "Meet your worker", top half: the résumé. Big avatar, the name as the page's single `<h1>`, the role, a bio,
 * then three plain columns — what they do, what they can touch, what it costs.
 */
export function ProposalResume({
  proposal,
  toolMeta,
}: {
  proposal: WorkerProposal;
  toolMeta: Record<string, ToolMeta>;
}) {
  const { blueprint } = proposal;
  const { persona } = blueprint;

  return (
    <article className="rounded-[22px] bg-card p-8 shadow-card max-sm:p-6">
      <header className="flex flex-col gap-6 sm:flex-row sm:items-start sm:gap-7">
        <WorkerAvatar name={persona.name} color={persona.avatarColor} size="xl" />
        <div className="min-w-0 flex-1 space-y-3">
          <div className="space-y-1">
            <p className="text-footnote text-muted-foreground">Your proposed hire</p>
            <h1 className="text-headline text-balance text-foreground">{persona.name}</h1>
            <p className="text-body-lg text-muted-foreground">{persona.title}</p>
          </div>
          <p className="max-w-[58ch] text-body text-pretty">{persona.summary}</p>
          <p className="flex flex-wrap items-center gap-x-2 gap-y-1.5 text-footnote text-muted-foreground">
            <span>
              Designed <RelativeTime iso={proposal.generatedAt} />
            </span>
            {proposal.simulated ? (
              <>
                <span aria-hidden="true">·</span>
                <SimulatedBadge />
              </>
            ) : null}
          </p>
        </div>
      </header>

      <div className="mt-8 grid gap-8 border-t border-border pt-7 sm:grid-cols-3">
        <section className="space-y-2.5">
          <h2 className="text-callout font-medium text-muted-foreground">What {persona.name} does each run</h2>
          <ul className="space-y-2 text-callout">
            {blueprint.responsibilities.map((line, i) => (
              <li key={`${i}-${line}`}>{line}</li>
            ))}
          </ul>
        </section>

        <section className="space-y-2.5">
          <h2 className="text-callout font-medium text-muted-foreground">Tools and access</h2>
          {blueprint.tools.length === 0 ? (
            <p className="text-callout text-muted-foreground">No outside tools — works only from what the job provides.</p>
          ) : (
            <ul className="space-y-2.5 text-callout">
              {blueprint.tools.map((tool) => {
                const meta = toolMeta[tool.toolName];
                const name = meta?.displayName ?? sentenceCase(tool.toolName);
                return (
                  <li key={tool.toolName}>
                    <span>{toolSentence(name, meta, tool.requiresApproval)}</span>
                    <span className="block text-footnote text-muted-foreground">{tool.reason}</span>
                  </li>
                );
              })}
            </ul>
          )}
        </section>

        <section className="space-y-1">
          <h2 className="text-callout font-medium text-muted-foreground">Expected cost</h2>
          <p className="text-metric text-foreground">{formatUsd(blueprint.costEstimate.perRunUsd)}</p>
          <p className="text-footnote text-muted-foreground">per run, estimated</p>
        </section>
      </div>
    </article>
  );
}

/**
 * The pipeline as a numbered list in a card — the same shape the worker profile uses once they are hired. Each
 * row says what the step does and whether it thinks (an LLM step) or runs automatically. A vertical list keeps
 * every step visible at any width: no sideways scroller to clip the last steps, no negative margin to push a
 * phone's page wider than its screen, and no row stretched to the height of the tallest one.
 */
export function ProposalPipeline({ proposal, jobTitle }: { proposal: WorkerProposal; jobTitle: string }) {
  const { blueprint } = proposal;
  const format = blueprint.deliverable.format;
  const formatWord = format === "csv" ? "a CSV" : format === "json" ? "structured data" : "a report";

  return (
    <div className="space-y-4">
      <Card className="py-0">
        <ol className="divide-y divide-border">
          {blueprint.components.map((component, index) => {
            const isAgent = component.type === "agent";
            return (
              <li key={component.id} className="grid grid-cols-[1.25rem_minmax(0,1fr)] items-baseline gap-x-3 px-(--card-spacing) py-4">
                <span aria-hidden="true" className="metric text-callout text-tertiary">
                  {index + 1}
                </span>
                <div className="space-y-1">
                  <p className="font-medium text-pretty">{component.name}</p>
                  <p className="text-footnote text-pretty text-muted-foreground">{component.description}</p>
                  <p className="text-footnote text-muted-foreground">
                    {isAgent ? `Thinks · ${MODEL_TIER_LABELS[component.modelTier]}` : `Automatic · ${operationLabel(component.operation)}`}
                  </p>
                </div>
              </li>
            );
          })}
        </ol>
      </Card>
      <p className="text-callout text-pretty text-muted-foreground">
        Ends with <span className="font-medium text-foreground">“{exampleDeliverableTitle(blueprint.deliverable.titleTemplate, jobTitle)}”</span> as {formatWord}.
        Automatic steps are free, fast and give the same answer every time.
      </p>
    </div>
  );
}
