import type { ReactNode } from "react";
import Link from "next/link";
import { ChevronRight } from "lucide-react";
import { RelativeTime } from "@/components/relative-time";
import { Button } from "@/components/ui/button";
import { Card, CardAction, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { WorkerAvatar } from "@/components/worker-avatar";
import type { AttentionItem } from "@/server/queries/workforce";
import { ApprovalDecision } from "@/app/(app)/approvals/_components/approval-decision";
import { PayloadPreview } from "@/app/(app)/approvals/_components/payload-preview";
import { requestSentence } from "@/app/(app)/approvals/_components/request";

/** Three is enough to act on; more than that belongs on the page that lists them. */
const MAX_ROWS = 3;

function keyOf(item: AttentionItem): string {
  switch (item.kind) {
    case "approval":
      return `approval:${item.approvalId}`;
    case "health":
      return `health:${item.workerId}`;
    case "run_failed":
      return `run:${item.runId}`;
    case "deliverable_rejected":
      return `deliverable:${item.deliverableId}`;
  }
}

/**
 * The separator between two facts on a meta line. The line never wraps (see `Row`), so the dot can't be left
 * hanging at the end of one line with its fact on the next.
 */
function Sep() {
  return <span aria-hidden="true">{" · "}</span>;
}

/** A quote or error excerpt: clipped with an ellipsis on the one meta line, with the whole text on hover. */
function Excerpt({ text, quote = false }: { text: string; quote?: boolean }) {
  return <span title={text}>{quote ? `“${text}”` : text}</span>;
}

function Row({
  item,
  sentence,
  meta,
  preview,
  action,
}: {
  item: AttentionItem;
  sentence: string;
  meta: ReactNode;
  preview?: ReactNode;
  action: ReactNode;
}) {
  return (
    <li className="flex flex-col gap-4 py-5 first:pt-0 last:pb-0 sm:flex-row sm:items-start sm:gap-4">
      <Link href={`/workers/${item.workerId}`} className="shrink-0 rounded-full outline-none max-sm:hidden">
        <WorkerAvatar name={item.workerName} color={item.avatarColor} size="sm" />
      </Link>
      <div className="min-w-0 flex-1 space-y-2">
        <div className="flex items-start gap-3">
          <Link href={`/workers/${item.workerId}`} className="shrink-0 rounded-full outline-none sm:hidden">
            <WorkerAvatar name={item.workerName} color={item.avatarColor} size="sm" />
          </Link>
          <div className="min-w-0 flex-1 space-y-0.5">
            <p className="text-body-app text-pretty text-foreground">{sentence}</p>
            {/* One line, clipped with an ellipsis: metadata never wraps under the sentence it qualifies. */}
            <p className="text-footnote truncate text-muted-foreground">{meta}</p>
          </div>
        </div>
        {preview}
      </div>
      <div className="shrink-0 sm:pl-2">{action}</div>
    </li>
  );
}

function AttentionRow({ item, blockedReason }: { item: AttentionItem; blockedReason?: string }) {
  switch (item.kind) {
    case "approval":
      return (
        <Row
          item={item}
          sentence={requestSentence(item.workerName, item.title)}
          meta={
            <>
              Asked <RelativeTime iso={item.requestedAt} />
              <Sep />
              <Link href={`/runs/${item.runId}`} className="outline-none hover:text-foreground">
                the run is paused
              </Link>
            </>
          }
          preview={<PayloadPreview payload={item.payload} workerName={item.workerName} compact />}
          action={
            <ApprovalDecision
              approvalId={item.approvalId}
              workerName={item.workerName}
              toolLabel={item.toolLabel}
              payload={item.payload}
              emphasis="quiet"
              disabledReason={blockedReason}
            />
          }
        />
      );
    case "health":
      return (
        <Row
          item={item}
          sentence={`${item.workerName}'s recent work needs a look`}
          meta={
            <>
              <span className="text-warning">
                <Excerpt text={item.reason ?? "Their score has slipped below the healthy range."} />
              </span>
              {item.score !== null ? (
                <>
                  <Sep />
                  <span className="tabular-nums">score {Math.round(item.score)}</span>
                </>
              ) : null}
            </>
          }
          action={
            <Button variant="secondary" className="max-sm:h-11 max-sm:w-full" asChild>
              <Link href={`/workers/${item.workerId}?tab=performance`}>Review</Link>
            </Button>
          }
        />
      );
    case "run_failed":
      return (
        <Row
          item={item}
          sentence={`${item.workerName}'s run stopped before it produced anything`}
          meta={
            <>
              <RelativeTime iso={item.at} />
              {item.error ? (
                <>
                  <Sep />
                  <Excerpt text={item.error} />
                </>
              ) : null}
            </>
          }
          action={
            <Button variant="secondary" className="max-sm:h-11 max-sm:w-full" asChild>
              <Link href={`/runs/${item.runId}`}>See the run</Link>
            </Button>
          }
        />
      );
    case "deliverable_rejected":
      // Told from the worker's side: sending it back is done; what's open is that nothing accepted has come
      // in since (the query drops the row once it has). Rejecting queues no revision run, so no promise of one.
      return (
        <Row
          item={item}
          sentence={`${item.workerName} still owes you a better “${item.title}”`}
          meta={
            <>
              You sent it back <RelativeTime iso={item.at} />
              {item.feedback ? (
                <>
                  <Sep />
                  <Excerpt text={item.feedback} quote />
                </>
              ) : null}
            </>
          }
          action={
            <Button variant="secondary" className="max-sm:h-11 max-sm:w-full" asChild>
              <Link href={`/deliverables/${item.deliverableId}`}>See feedback</Link>
            </Button>
          }
        />
      );
  }
}

export interface NeedsYouProps {
  /** Already ordered by urgency, and already stripped of anything that has been dealt with. */
  items: AttentionItem[];
  /** approvalId → why this viewer can't decide it. Absent means they can. */
  blockedReasons?: Record<string, string>;
}

/** The short list of things only a person can unblock. Rendered only when it isn't empty. */
export function NeedsYou({ items, blockedReasons = {} }: NeedsYouProps) {
  const shown = items.slice(0, MAX_ROWS);
  const hidden = items.slice(MAX_ROWS);
  const overflowHref = hidden.some((item) => item.kind === "approval") ? "/approvals" : "/activity";

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-title-2">
          {items.length === 1 ? "One thing needs you" : `${items.length} things need you`}
        </CardTitle>
        {hidden.length > 0 ? (
          <CardAction>
            <Button variant="link" asChild>
              <Link href={overflowHref}>
                See all <ChevronRight data-icon="inline-end" />
              </Link>
            </Button>
          </CardAction>
        ) : null}
      </CardHeader>
      <CardContent>
        <ul className="divide-y divide-border">
          {shown.map((item) => (
            <AttentionRow
              key={keyOf(item)}
              item={item}
              blockedReason={item.kind === "approval" ? blockedReasons[item.approvalId] : undefined}
            />
          ))}
        </ul>
      </CardContent>
    </Card>
  );
}
