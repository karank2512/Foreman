"use client";

import { useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { WorkerAvatar } from "@/components/worker-avatar";
import { cn } from "@/lib/utils";

/** Radix Select cannot represent "no value" as an item, so "all" is a sentinel that maps to no query param. */
const ALL = "all";

export interface ActivityFiltersProps {
  workers: Array<{ id: string; name: string; title: string; avatarColor: string; status: string }>;
  /** Event-type segments, in order. `value` is the `type` query param; "" is the All segment. */
  groups: Array<{ value: string; label: string }>;
  /** Current selection (from searchParams); undefined = everything. */
  workerId?: string;
  group?: string;
}

function hrefFor(worker: string | undefined, type: string | undefined): string {
  const params = new URLSearchParams();
  if (worker) params.set("worker", worker);
  if (type) params.set("type", type);
  // A new filter always starts from the newest events — an old cursor would make the first page look empty.
  const query = params.toString();
  return query ? `/activity?${query}` : "/activity";
}

/**
 * Event type as a segmented control, worker as a gray pill select. Both live in the URL, so a filtered feed is
 * shareable and "Load more" keeps the selection.
 */
export function ActivityFilters({ workers, groups, workerId, group }: ActivityFiltersProps) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();

  // An id that matches no worker (a stale link) would leave the trigger blank; fall back to "Everyone".
  const workerValue = workerId && workers.some((w) => w.id === workerId) ? workerId : ALL;

  return (
    <div className="flex flex-wrap items-center gap-3" aria-busy={pending}>
      {/* The scroller is separate from the gray track because it clips what overflows it: on phones it grows to
          44px (the negative margin keeps the row where it was) so each option's 44px tap band fits inside, and
          its right edge fades so a cut-off option reads as "scroll for more". */}
      <div
        role="group"
        aria-label="Filter by event type"
        className="max-w-full overflow-x-auto [scrollbar-width:none] max-md:-my-1.5 max-md:py-1.5 max-sm:pr-6 max-sm:[mask-image:linear-gradient(to_right,#000_calc(100%_-_24px),transparent)] [&::-webkit-scrollbar]:hidden"
      >
        <div className="flex h-8 w-max items-center gap-0.5 rounded-full bg-secondary p-0.5">
          {groups.map((g) => {
            const active = (group ?? "") === g.value;
            return (
              <Link
                key={g.value || ALL}
                href={hrefFor(workerId, g.value || undefined)}
                scroll={false}
                aria-current={active ? "page" : undefined}
                className={cn(
                  "text-footnote relative inline-flex h-7 shrink-0 items-center rounded-full px-3.5 font-medium whitespace-nowrap transition-[background-color,color] duration-200 ease-standard outline-none",
                  "max-md:before:absolute max-md:before:inset-x-0 max-md:before:top-[calc(50%_-_22px)] max-md:before:h-11",
                  active ? "bg-background text-foreground shadow-thumb" : "text-foreground/75 hover:text-foreground",
                )}
              >
                {g.label}
              </Link>
            );
          })}
        </div>
      </div>

      <Select
        value={workerValue}
        onValueChange={(value) => startTransition(() => router.push(hrefFor(value === ALL ? undefined : value, group)))}
      >
        <SelectTrigger
          size="sm"
          aria-label="Filter by worker"
          className="text-footnote min-w-40 rounded-full border-transparent bg-secondary pr-3 pl-4 font-medium transition-colors hover:bg-secondary-hover sm:text-[13px]"
        >
          <SelectValue placeholder="Everyone" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={ALL}>Everyone</SelectItem>
          {workers.map((w) => (
            <SelectItem key={w.id} value={w.id}>
              <WorkerAvatar name={w.name} color={w.avatarColor} size="xs" />
              <span>
                {w.name}
                {w.status === "RETIRED" ? <span className="text-muted-foreground"> · retired</span> : null}
              </span>
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}
