import Link from "next/link";
import { ChevronRight } from "lucide-react";
import { ActivityRow } from "@/app/(app)/activity/_components/activity-row";
import { EmptyState } from "@/components/empty-state";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import type { ActivityItem } from "@/server/activity";

/** A side column, not a feed: it stops before it outgrows the main column. The rest is on /activity. */
export const JOB_ACTIVITY_ROWS = 6;

export interface JobActivityProps {
  items: ActivityItem[];
  /** Whoever holds the seat now — "View all" opens the feed filtered to them. */
  workerId?: string | null;
}

/**
 * The job's latest events — hires, runs, deliverables, reviews — as the same sentence rows the Activity page
 * uses (foreground title, time on the right), capped with a "View all" link.
 */
export function JobActivity({ items, workerId = null }: JobActivityProps) {
  const shown = items.slice(0, JOB_ACTIVITY_ROWS);
  const allHref = workerId ? `/activity?worker=${encodeURIComponent(workerId)}` : "/activity";

  return (
    <Card>
      <CardHeader>
        <CardTitle>Recent activity</CardTitle>
        <CardDescription>What has happened on this job, newest first.</CardDescription>
      </CardHeader>
      <CardContent>
        {shown.length === 0 ? (
          <EmptyState title="Quiet so far" description="Events appear here as the job moves along." className="py-10" />
        ) : (
          <>
            {/* The hairline sits on a plain wrapper: on the row itself it would bend round its hover radius. */}
            <ul className="divide-y divide-border">
              {shown.map((item) => (
                <li key={item.id}>
                  <ActivityRow item={item} />
                </li>
              ))}
            </ul>
            {items.length > shown.length ? (
              <Button variant="link" asChild className="mt-3">
                <Link href={allHref}>
                  View all <ChevronRight data-icon="inline-end" aria-hidden="true" />
                </Link>
              </Button>
            ) : null}
          </>
        )}
      </CardContent>
    </Card>
  );
}
