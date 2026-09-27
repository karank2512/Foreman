import { Card } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";

/** Mirrors /usage: title with the range picker, the headline card, the chart, then the first table. */
export default function UsageLoading() {
  return (
    <div role="status" aria-live="polite" aria-busy="true">
      <span className="sr-only">Loading usage…</span>

      <div className="mb-10 flex flex-col gap-5 sm:flex-row sm:items-start sm:justify-between">
        <div className="space-y-3">
          <Skeleton className="h-8 w-32 rounded-lg" />
          <Skeleton className="h-5 w-[26rem] max-w-full rounded-lg" />
        </div>
        <Skeleton className="h-8 w-full rounded-full sm:w-56" />
      </div>

      <div className="space-y-14">
        <Card className="p-0">
          <div className="grid gap-px bg-border lg:grid-cols-[1.3fr_1fr]">
            <div className="space-y-3 bg-card p-6 sm:p-8">
              <Skeleton className="h-4 w-40 rounded-lg" />
              <Skeleton className="h-12 w-44 rounded-lg" />
              <Skeleton className="h-4 w-36 rounded-lg" />
            </div>
            <div className="grid grid-cols-2 gap-px bg-border lg:grid-cols-1">
              {Array.from({ length: 2 }, (_, i) => (
                <div key={i} className="space-y-2 bg-card p-5 sm:p-6">
                  <Skeleton className="h-3.5 w-16 rounded-lg" />
                  <Skeleton className="h-5 w-20 rounded-lg" />
                </div>
              ))}
            </div>
          </div>
        </Card>

        <section className="space-y-5">
          <div className="space-y-2">
            <Skeleton className="h-6 w-32 rounded-lg" />
            <Skeleton className="h-4 w-80 max-w-full rounded-lg" />
          </div>
          <Card>
            <Skeleton className="h-64 w-full rounded-lg sm:h-72" />
          </Card>
        </section>

        <section className="space-y-5">
          <div className="space-y-2">
            <Skeleton className="h-6 w-28 rounded-lg" />
            <Skeleton className="h-4 w-72 max-w-full rounded-lg" />
          </div>
          <Card className="py-2 sm:py-0">
            {Array.from({ length: 4 }, (_, i) => (
              <div key={i} className="mx-6 flex items-center gap-6 border-b border-border py-4 last:border-0">
                <Skeleton className="size-8 shrink-0 rounded-full" />
                <Skeleton className="h-4 w-36 rounded-lg" />
                <Skeleton className="ml-auto h-4 w-16 rounded-lg" />
                <Skeleton className="hidden h-4 w-16 rounded-lg sm:block" />
              </div>
            ))}
          </Card>
        </section>
      </div>
    </div>
  );
}
