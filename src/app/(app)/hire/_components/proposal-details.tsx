import type { WorkerProposal } from "@/server/domain";
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from "@/components/ui/accordion";
import { Card } from "@/components/ui/card";
import { formatPercent } from "@/lib/format";

/**
 * Body text in the foreground colour. The primitive gives every paragraph but the last a bottom margin; that is
 * switched off, so blocks holding paragraphs are spaced with flex gaps — `space-y` spaces with that same bottom
 * margin and would lose to the override.
 */
const contentClass = "flex flex-col gap-3 text-foreground [&_p:not(:last-child)]:mb-0";

/**
 * The two parts of the proposal a manager reads only when they want to: why the engine chose this design, and
 * how each run gets reviewed. They fold into closed rows at the end so the page stays "résumé, how the work
 * flows, what it costs" — the facts that decide a hire — instead of five full sections after the résumé.
 */
export function ProposalDetails({ proposal, specTitle }: { proposal: WorkerProposal; specTitle?: string }) {
  return (
    <section aria-labelledby="proposal-details-heading">
      {/* The rows' own headings are h3s; this keeps them from reading as part of "Cost and schedule". */}
      <h2 id="proposal-details-heading" className="sr-only">
        More about this design
      </h2>
      <Card className="gap-0 py-1">
        <Accordion type="multiple" className="px-(--card-spacing)">
          <AccordionItem value="rationale">
            <AccordionTrigger>Why this design</AccordionTrigger>
            <AccordionContent className={contentClass}>
              {specTitle ? <p className="text-muted-foreground">How the staffing engine matched “{specTitle}”.</p> : null}
              <ul className="space-y-3 text-pretty">
                {proposal.rationale.map((line, i) => (
                  <li key={`${i}-${line}`}>{line}</li>
                ))}
              </ul>
            </AccordionContent>
          </AccordionItem>
          <AccordionItem value="review">
            <AccordionTrigger>How the work gets reviewed</AccordionTrigger>
            <AccordionContent className={contentClass}>
              <ReviewMethod proposal={proposal} />
            </AccordionContent>
          </AccordionItem>
        </Accordion>
      </Card>
    </section>
  );
}

/** How every run gets scored, said once in a sentence — the weights matter less than the fact that it happens. */
function ReviewMethod({ proposal }: { proposal: WorkerProposal }) {
  const { evaluation } = proposal.blueprint;
  return (
    <div className="flex flex-col gap-5">
      <p className="text-pretty">
        Every run is scored three ways — automatic checks, an AI reviewer and your own feedback — and passes at{" "}
        <span className="metric font-medium">{formatPercent(evaluation.passThreshold)}</span>.
      </p>
      <div className="flex flex-col gap-2.5">
        <p className="text-footnote font-medium text-muted-foreground">The reviewer looks for</p>
        <ul className="space-y-2">
          {evaluation.rubric.map((criterion) => (
            <li key={criterion.id} className="text-pretty">
              <span className="font-medium">{criterion.criterion}</span>
              <span className="text-muted-foreground"> — {criterion.description}</span>
            </li>
          ))}
        </ul>
      </div>
      {evaluation.deterministicChecks.length > 0 ? (
        <div className="flex flex-col gap-2.5">
          <p className="text-footnote font-medium text-muted-foreground">Checked automatically</p>
          <ul className="space-y-2">
            {evaluation.deterministicChecks.map((check) => (
              <li key={check.id} className="text-pretty text-muted-foreground">
                {check.description}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}
