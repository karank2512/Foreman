"use client";

import { useState, useTransition, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";
import type { DeliverableStatus } from "@prisma/client";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetTrigger } from "@/components/ui/sheet";
import { Textarea } from "@/components/ui/textarea";
import { formatDate } from "@/lib/format";
import { cn } from "@/lib/utils";
import { reviewDeliverableAction } from "../actions";

export interface ReviewPanelProps {
  deliverableId: string;
  runId: string;
  workerId: string;
  workerName: string;
  status: DeliverableStatus;
  feedback: string | null;
  reviewedByName: string | null;
  reviewedAt: string | null;
  /** `deliverables.review` — without it the panel reads as a record, not a form. */
  canReview?: boolean;
}

const MAX_FEEDBACK = 4_000;

/**
 * The reader's decision on a deliverable. It reads as a question with two answers rather than a form: on a wide
 * screen it's a quiet card beside the article, and on a phone a bottom bar that opens a sheet. Accepting or
 * sending back calls the same server action as before, with the same arguments.
 */
export function ReviewPanel({
  deliverableId,
  runId,
  workerId,
  workerName,
  status,
  feedback,
  reviewedByName,
  reviewedAt,
  canReview = true,
}: ReviewPanelProps) {
  const router = useRouter();
  const [editing, setEditing] = useState(status === "PENDING_REVIEW");
  const [text, setText] = useState(feedback ?? "");
  const [pending, startTransition] = useTransition();
  const [inFlight, setInFlight] = useState<"accept" | "reject" | null>(null);
  const [sheetOpen, setSheetOpen] = useState(false);

  function decide(decision: "accept" | "reject") {
    if (text.length > MAX_FEEDBACK) {
      toast.error(`Feedback must be at most ${MAX_FEEDBACK.toLocaleString("en-US")} characters`);
      return;
    }
    setInFlight(decision);
    startTransition(async () => {
      const r = await reviewDeliverableAction(deliverableId, decision, text, { runId, workerId });
      setInFlight(null);
      if (!r.ok) {
        toast.error(r.error);
        return;
      }
      toast.success(decision === "accept" ? `Accepted — ${workerName} will take note` : `Sent back to ${workerName} with your notes`);
      setEditing(false);
      setSheetOpen(false);
      router.refresh();
    });
  }

  const decided = status !== "PENDING_REVIEW";
  const accepted = status === "ACCEPTED";
  const verdictLine = decided
    ? `${accepted ? "Accepted" : "Sent back"}${reviewedByName ? ` by ${reviewedByName}` : ""}${reviewedAt ? ` · ${formatDate(reviewedAt)}` : ""}`
    : null;

  function body(idSuffix: string): ReactNode {
    if (!canReview) {
      return (
        <div className="space-y-3">
          {decided ? (
            <p className="flex items-center gap-2 text-[15px]">
              <span aria-hidden="true" className={cn("size-[7px] rounded-full", accepted ? "bg-success" : "bg-danger")} />
              {verdictLine}
            </p>
          ) : (
            <p className="text-[15px] text-muted-foreground">Waiting on a review.</p>
          )}
          {feedback ? (
            <blockquote className="border-l-[3px] border-input pl-4 text-[15px] text-pretty text-muted-foreground">{feedback}</blockquote>
          ) : null}
          <p className="text-footnote text-muted-foreground">Your role can’t review deliverables.</p>
        </div>
      );
    }

    if (decided && !editing) {
      return (
        <div className="space-y-4">
          <p className="flex items-center gap-2 text-[15px]">
            <span aria-hidden="true" className={cn("size-[7px] rounded-full", accepted ? "bg-success" : "bg-danger")} />
            {verdictLine}
          </p>
          {feedback ? (
            <blockquote className="border-l-[3px] border-input pl-4 text-[15px] text-pretty text-muted-foreground">{feedback}</blockquote>
          ) : (
            <p className="text-footnote text-muted-foreground">You didn’t leave any notes.</p>
          )}
          <Button variant="link" onClick={() => setEditing(true)}>
            Change your mind
          </Button>
        </div>
      );
    }

    return (
      <div className="space-y-4">
        <div className="space-y-2">
          <Label htmlFor={`feedback-${idSuffix}`}>Notes for {workerName} — optional</Label>
          <Textarea
            id={`feedback-${idSuffix}`}
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder="What was good, what was missing, what to do differently next time…"
            rows={4}
            maxLength={MAX_FEEDBACK}
            disabled={pending}
          />
          <p className="text-footnote text-muted-foreground">
            Specific notes make the strongest case when it’s time to propose a replacement.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <Button onClick={() => decide("accept")} disabled={pending}>
            {inFlight === "accept" ? <Loader2 className="animate-spin" aria-hidden="true" /> : null}
            Accept
          </Button>
          <Button variant="secondary" onClick={() => decide("reject")} disabled={pending}>
            {inFlight === "reject" ? <Loader2 className="animate-spin" aria-hidden="true" /> : null}
            Send it back
          </Button>
          {decided ? (
            <Button
              variant="link"
              disabled={pending}
              onClick={() => {
                setText(feedback ?? "");
                setEditing(false);
              }}
            >
              Keep my decision
            </Button>
          ) : null}
        </div>
      </div>
    );
  }

  const question = decided ? "Your review" : `How did ${workerName} do?`;

  return (
    <>
      <Card variant="tile" className="hidden lg:flex">
        <CardHeader>
          <CardTitle>{question}</CardTitle>
        </CardHeader>
        <CardContent>{body("desktop")}</CardContent>
      </Card>

      <div className="material-thick fixed inset-x-0 bottom-0 z-30 shadow-bar pb-[env(safe-area-inset-bottom)] lg:hidden">
        <div className="flex items-center gap-3 px-4 py-3">
          {decided ? (
            <p className="flex min-w-0 flex-1 items-center gap-2 text-footnote text-muted-foreground">
              <span aria-hidden="true" className={cn("size-[7px] shrink-0 rounded-full", accepted ? "bg-success" : "bg-danger")} />
              <span className="truncate">{verdictLine}</span>
            </p>
          ) : (
            <p className="min-w-0 flex-1 truncate text-footnote text-muted-foreground">{question}</p>
          )}
          <Sheet open={sheetOpen} onOpenChange={setSheetOpen}>
            <SheetTrigger asChild>
              <Button className="h-11 px-6" variant={decided || !canReview ? "secondary" : "default"}>
                {decided || !canReview ? "See review" : "Review"}
              </Button>
            </SheetTrigger>
            <SheetContent side="bottom" className="pb-8">
              <SheetHeader className="pb-0">
                <SheetTitle>{question}</SheetTitle>
              </SheetHeader>
              <div className="overflow-y-auto px-6">{body("mobile")}</div>
            </SheetContent>
          </Sheet>
        </div>
      </div>
    </>
  );
}
