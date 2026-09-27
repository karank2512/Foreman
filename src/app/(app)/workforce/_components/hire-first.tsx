import Link from "next/link";
import { Button } from "@/components/ui/button";
import { EXAMPLE_JOBS, type ExampleJob } from "@/app/(app)/hire/schema";

/**
 * The example pills deep-link by example *id*: /hire resolves `prefill` with `exampleJobById`, which only knows
 * the ids in `EXAMPLE_JOBS`, so a pill that carried the brief text itself would open an empty form. One list of
 * briefs, shared with the Describe step, keeps the two surfaces from drifting apart.
 */
export function hireExampleHref(job: Pick<ExampleJob, "id">): string {
  return `/hire?prefill=${encodeURIComponent(job.id)}`;
}

/**
 * What a brand-new workspace sees instead of a roster: one sentence about the job to be done, one pill, and
 * three briefs to borrow. No dashed box, no illustration.
 */
export function HireFirst({ canHire }: { canHire: boolean }) {
  return (
    <section className="flex flex-col items-center px-4 py-16 text-center sm:py-24">
      <h2 className="text-headline max-w-[16ch] text-balance text-foreground">Hire your first AI worker</h2>
      <p className="text-body mt-5 max-w-[52ch] text-pretty text-muted-foreground">
        Describe a job the way you&apos;d brief a new contractor — the outcome, how often, and who it&apos;s for. We
        scope it, design a worker for it, and put them on the schedule.
      </p>

      {canHire ? (
        <>
          <Button size="lg" className="mt-9" asChild>
            <Link href="/hire">Hire a worker</Link>
          </Button>
          <p className="text-footnote mt-12 text-muted-foreground">Or start from one of these</p>
          <div className="mt-3 flex flex-wrap items-center justify-center gap-2">
            {EXAMPLE_JOBS.map((job) => (
              <Button key={job.id} variant="secondary" asChild>
                <Link href={hireExampleHref(job)}>{job.label}</Link>
              </Button>
            ))}
          </div>
        </>
      ) : (
        <p className="text-footnote mt-9 text-muted-foreground">
          Ask a workspace admin to make the first hire — you&apos;ll see everything they do here.
        </p>
      )}
    </section>
  );
}
