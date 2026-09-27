"use client";

import { useState } from "react";
import { toast } from "sonner";
import { PayloadPreview } from "@/app/(app)/approvals/_components/payload-preview";
import { summarizePayload } from "@/app/(app)/approvals/_components/request";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { JsonView } from "@/components/json-view";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { decideApprovalAction } from "../actions";
import { useRunLive } from "./run-live";
import { approveConfirmLabel, recipientsOf } from "./step-meta";

export interface ApprovalDecisionProps {
  runId: string;
  workerId: string;
  workerName: string;
  approval: { id: string; title: string; description: string | null; toolName: string; payload: unknown };
  /** False hides the buttons for a role that may not decide — the runtime enforces the same rule. */
  canDecide?: boolean;
}

/** Same ceiling as the server's NoteSchema for run-page decisions. */
const NOTE_MAX = 1000;

type Decision = "approve" | "reject";

const COPY: Record<Decision, { title: (name: string) => string; body: (name: string) => string; noteLabel: string; placeholder: string }> = {
  approve: {
    title: (name) => `Let ${name} go ahead?`,
    body: (name) => `${name} will do exactly what’s shown here, then carry on with the run.`,
    noteLabel: "Note",
    placeholder: "Looks good — send it.",
  },
  reject: {
    title: (name) => `Tell ${name} not to do this?`,
    body: (name) => `${name} will skip this step and finish the run without it. A short reason helps them adapt.`,
    noteLabel: "Reason",
    placeholder: "Not this week — the numbers need a second look.",
  },
};

/**
 * Inline Approve / Decline for a pending request, rendered inside the APPROVAL step while the run waits.
 * Neither button commits anything: each opens a confirmation that re-shows who it goes to and what it says, so
 * a stray click (or a prompt-injected recipient nobody read) never sends on its own — the same safeguard the
 * Approvals inbox has.
 */
export function ApprovalDecision({ runId, workerId, workerName, approval, canDecide = true }: ApprovalDecisionProps) {
  const { refresh } = useRunLive();
  const [note, setNote] = useState("");
  const [decided, setDecided] = useState<Decision | null>(null);

  async function decide(decision: Decision) {
    const r = await decideApprovalAction(runId, approval.id, decision, note, workerId);
    if (!r.ok) {
      // The request may have expired underneath us — re-render so the row shows its real state.
      refresh();
      throw new Error(r.error);
    }
    setDecided(decision);
    toast.success(decision === "approve" ? `${workerName} can go ahead` : `${workerName} will carry on without it`);
    refresh();
  }

  if (decided) {
    return (
      <p className="text-footnote text-muted-foreground">
        {decided === "approve" ? "Approved" : "Declined"} — {workerName} is picking the run back up.
      </p>
    );
  }

  const recipients = recipientsOf(approval.payload);
  const summary = summarizePayload(approval.payload);
  // A complex payload already carries its raw JSON inside the preview; an empty preview opens the JSON instead.
  const previewEmpty = summary.fields.length === 0 && summary.body === null && !summary.complex;

  function confirmation(decision: Decision) {
    const noteId = `run-note-${approval.id}-${decision}`;
    return (
      <div className="space-y-4">
        <p>{COPY[decision].body(workerName)}</p>
        <PayloadPreview payload={approval.payload} workerName={workerName} compact />
        {/* The preview lists four addresses then "and N more"; the last look before a send names every one. */}
        {recipients.length > 4 ? (
          <p className="text-footnote break-words text-muted-foreground">
            All {recipients.length} recipients: <span className="text-foreground">{recipients.join(", ")}</span>
          </p>
        ) : null}
        <div className="space-y-1.5">
          <Label htmlFor={noteId}>
            {COPY[decision].noteLabel} <span className="font-normal text-muted-foreground">(optional)</span>
          </Label>
          <Textarea
            id={noteId}
            value={note}
            onChange={(e) => setNote(e.target.value.slice(0, NOTE_MAX))}
            placeholder={COPY[decision].placeholder}
            rows={2}
            className="resize-none"
          />
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div>
        <p className="text-title-3 text-pretty">{approval.title}</p>
        {approval.description ? (
          <p className="mt-1 line-clamp-3 text-[15px] text-pretty text-muted-foreground">{approval.description}</p>
        ) : null}
      </div>

      <PayloadPreview payload={approval.payload} workerName={workerName} />

      {summary.complex ? null : (
        <JsonView label="Everything that will be sent" value={approval.payload} defaultOpen={previewEmpty} />
      )}

      {canDecide ? (
        <div className="flex flex-wrap items-center gap-3">
          <ConfirmDialog
            trigger={<Button className="max-sm:h-11 max-sm:flex-1">Approve</Button>}
            title={COPY.approve.title(workerName)}
            description={confirmation("approve")}
            confirmLabel={approveConfirmLabel(approval.payload)}
            onConfirm={() => decide("approve")}
          />
          <ConfirmDialog
            trigger={
              <Button variant="secondary" className="max-sm:h-11 max-sm:flex-1">
                Decline
              </Button>
            }
            title={COPY.reject.title(workerName)}
            description={confirmation("reject")}
            confirmLabel="Decline"
            destructive
            onConfirm={() => decide("reject")}
          />
          <span className="text-footnote text-muted-foreground max-sm:basis-full">
            Declining lets {workerName} finish without this step.
          </span>
        </div>
      ) : (
        <p className="text-footnote text-muted-foreground">
          Your role can’t decide this one. Ask an admin in your workspace to take a look.
        </p>
      )}
    </div>
  );
}
