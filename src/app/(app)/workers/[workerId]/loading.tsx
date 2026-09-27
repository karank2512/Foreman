import { Skeleton } from "@/components/ui/skeleton";

/**
 * Profile-shaped fallback. Tabs are `?tab=` on this same route, so this is what a manager sees between tabs —
 * it mirrors the real furniture (back link, avatar + name, the quiet fact line, the section bar, a stat strip
 * and two row lists) so nothing jumps when the data lands. No spinner.
 */
export default function WorkerProfileLoading() {
  return (
    <div role="status" aria-live="polite" aria-busy="true">
      <span className="sr-only">Loading the worker profile…</span>

      <div className="mb-5 flex flex-col gap-5 sm:flex-row sm:items-start sm:justify-between sm:gap-8">
        <div className="space-y-3">
          <Skeleton className="h-4 w-24 rounded-sm" />
          <div className="flex items-center gap-4 sm:gap-5">
            <Skeleton className="size-14 rounded-full sm:size-18" />
            <div className="space-y-2.5">
              <Skeleton className="h-8 w-48 rounded-lg sm:h-10 sm:w-60" />
              <Skeleton className="h-4 w-40 rounded-sm" />
            </div>
          </div>
          <Skeleton className="h-4 w-56 max-w-full rounded-sm" />
        </div>
        <div className="flex items-center gap-7 max-sm:hidden">
          <div className="space-y-2">
            <Skeleton className="h-11 w-16 rounded-lg" />
            <Skeleton className="h-3.5 w-24 rounded-sm" />
          </div>
          <Skeleton className="h-9 w-24 rounded-full" />
        </div>
      </div>

      {/* The one quiet fact line: status · hired · schedule · next run. */}
      <div className="mb-6 flex flex-wrap items-center gap-2.5">
        <Skeleton className="h-3.5 w-20 rounded-sm" />
        <Skeleton className="h-3.5 w-24 rounded-sm" />
        <Skeleton className="h-3.5 w-36 rounded-sm" />
        <Skeleton className="h-3.5 w-28 rounded-sm" />
      </div>

      {/* The section bar, full-bleed like the real LocalNav: five tabs and "More" (a phone scrolls all nine). */}
      <div className="ml-[calc(50%-50vw)] flex h-(--localnav-height) w-dvw items-center justify-end gap-5 overflow-hidden bg-canvas-raised px-4 sm:px-6">
        {["w-16", "w-14", "w-20", "w-22", "w-24", "w-11"].map((w) => (
          <Skeleton key={w} className={`h-3.5 shrink-0 rounded-sm ${w}`} />
        ))}
      </div>

      <div className="space-y-14 pt-10">
        <div className="grid grid-cols-2 gap-px overflow-hidden rounded-xl bg-border shadow-card md:grid-cols-4">
          {Array.from({ length: 4 }, (_, i) => (
            <div key={i} className="space-y-3 bg-card p-6">
              <Skeleton className="h-3.5 w-24 rounded-sm" />
              <Skeleton className="h-8 w-20 rounded-lg" />
              <Skeleton className="h-3.5 w-28 rounded-sm" />
            </div>
          ))}
        </div>

        {Array.from({ length: 2 }, (_, section) => (
          <div key={section} className="space-y-5">
            <div className="space-y-2">
              <Skeleton className="h-6 w-44 rounded-lg" />
              <Skeleton className="h-4 w-80 max-w-full rounded-sm" />
            </div>
            <div className="rounded-xl bg-card shadow-card">
              {Array.from({ length: 4 }, (_, row) => (
                <div
                  key={row}
                  className="flex items-start justify-between gap-6 px-5 py-4.5 [&:not(:first-child)]:border-t [&:not(:first-child)]:border-border sm:px-6"
                >
                  <div className="min-w-0 flex-1 space-y-2">
                    <Skeleton className="h-4 w-64 max-w-full rounded-sm" />
                    <Skeleton className="h-3.5 w-44 max-w-full rounded-sm" />
                  </div>
                  <Skeleton className="h-4 w-14 shrink-0 rounded-sm" />
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
