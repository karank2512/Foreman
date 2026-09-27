"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import type { ToolGrantView } from "@/server/queries/worker-manage";
import { Row, RowList, RowMeta, RowTitle, Sep } from "../_components/rows";
import { updateToolGrantAction } from "../manage-actions";

/** Side effects in a manager's words; nothing is colour-coded — the words carry the weight. */
const SIDE_EFFECT_LABELS: Record<string, string> = {
  none: "Stays inside the workspace",
  external_read: "Reads from the public web",
  external_write: "Sends things outside the workspace",
};

type Access = "allowed" | "asks" | "off";

const OPTIONS: Array<{ value: Access; label: string }> = [
  { value: "allowed", label: "Allowed" },
  { value: "asks", label: "Asks first" },
  { value: "off", label: "Off" },
];

function accessOf(grant: ToolGrantView): Access {
  if (grant.revoked) return "off";
  return grant.requiresApproval ? "asks" : "allowed";
}

export interface PermissionsGrantsTableProps {
  workerId: string;
  workerName: string;
  grants: ToolGrantView[];
  /** Retired workers, and roles that can't manage, see the state as words instead of controls. */
  readOnly: boolean;
}

export function PermissionsGrantsTable({ workerId, workerName, grants, readOnly }: PermissionsGrantsTableProps) {
  return (
    <RowList>
      {grants.map((grant) => (
        <GrantRow key={grant.toolName} workerId={workerId} workerName={workerName} grant={grant} readOnly={readOnly} />
      ))}
    </RowList>
  );
}

function GrantRow({
  workerId,
  workerName,
  grant,
  readOnly,
}: {
  workerId: string;
  workerName: string;
  grant: ToolGrantView;
  readOnly: boolean;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  // Optimistic: the control moves immediately and snaps back if the server refuses.
  const [access, setAccess] = useState<Access>(accessOf(grant));
  const [confirmOff, setConfirmOff] = useState(false);
  const alwaysAsks = grant.defaultRequiresApproval;
  const sideEffect = grant.sideEffect ? SIDE_EFFECT_LABELS[grant.sideEffect] : null;

  function apply(next: Access) {
    if (next === access || pending || readOnly) return;
    if (next === "off") {
      setConfirmOff(true);
      return;
    }
    commit(next);
  }

  function commit(next: Access) {
    const previous = access;
    setAccess(next);
    startTransition(async () => {
      const patch = next === "off" ? { revoked: true } : { revoked: false, requiresApproval: next === "asks" };
      const r = await updateToolGrantAction(workerId, grant.toolName, patch);
      if (!r.ok) {
        setAccess(previous);
        toast.error(r.error);
        return;
      }
      toast.success(
        next === "off"
          ? `${workerName} can no longer use ${grant.displayName}`
          : next === "asks"
            ? `${workerName} will ask before using ${grant.displayName}`
            : `${workerName} can use ${grant.displayName} without asking`,
      );
      router.refresh();
    });
  }

  return (
    // Stacked on a phone (text, then the control under it); side by side from 640px. The text block takes the
    // row's full width and wraps — nothing in it is single-line, so no sentence runs past the card edge.
    <Row className="flex-col items-stretch gap-3 sm:flex-row sm:items-center sm:gap-6">
      <div className="w-full min-w-0 flex-1 break-words">
        <RowTitle className={cn(access === "off" && "text-muted-foreground")}>{grant.displayName}</RowTitle>
        {grant.humanDescription ? (
          <p className="text-footnote mt-1 max-w-[60ch] text-pretty text-muted-foreground">{grant.humanDescription}</p>
        ) : null}
        {/* Why this worker has the tool, in full: it is the one line that is about this job, not the tool. */}
        {grant.reason ? (
          <p className="text-footnote mt-1 max-w-[60ch] text-pretty text-muted-foreground">{grant.reason}</p>
        ) : null}
        {sideEffect || grant.maxCallsPerRun !== null || (!grant.reason && !grant.inBlueprint) ? (
          <RowMeta>
            {sideEffect ? <span>{sideEffect}</span> : null}
            {grant.maxCallsPerRun !== null ? (
              <>
                {sideEffect ? <Sep /> : null}
                <span>at most {grant.maxCallsPerRun} calls a run</span>
              </>
            ) : null}
            {!grant.reason && !grant.inBlueprint ? (
              <>
                {sideEffect || grant.maxCallsPerRun !== null ? <Sep /> : null}
                <span>Not part of the current design</span>
              </>
            ) : null}
          </RowMeta>
        ) : null}
      </div>

      {readOnly ? (
        <span className="text-footnote shrink-0 self-start text-muted-foreground sm:self-auto">
          {access === "off" ? "Off" : access === "asks" ? "Asks first" : "Allowed"}
        </span>
      ) : (
        <div
          role="radiogroup"
          aria-label={`What ${workerName} may do with ${grant.displayName}`}
          className="flex h-8 shrink-0 items-center gap-0.5 self-start rounded-full bg-secondary p-0.5 sm:self-auto"
        >
          {OPTIONS.map((option) => {
            const selected = access === option.value;
            const locked = alwaysAsks && option.value === "allowed";
            const button = (
              <button
                key={option.value}
                type="button"
                role="radio"
                aria-checked={selected}
                disabled={pending || locked}
                onClick={() => apply(option.value)}
                className={cn(
                  "h-7 rounded-full px-3 text-[13px] font-medium transition-colors duration-200 ease-standard outline-none focus-visible:ring-4 focus-visible:ring-primary/30 disabled:cursor-default",
                  selected ? "bg-card text-foreground shadow-[var(--elev-thumb)]" : "text-foreground/70 hover:text-foreground",
                  locked && !selected && "opacity-40",
                )}
              >
                {option.label}
              </button>
            );
            return locked ? (
              <Tooltip key={option.value}>
                <TooltipTrigger asChild>
                  <span className="inline-flex">{button}</span>
                </TooltipTrigger>
                <TooltipContent side="bottom">{grant.displayName} always asks for your approval.</TooltipContent>
              </Tooltip>
            ) : (
              button
            );
          })}
        </div>
      )}

      <Dialog open={confirmOff} onOpenChange={setConfirmOff}>
        <DialogContent showCloseButton={false} className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Turn off {grant.displayName}?</DialogTitle>
            <DialogDescription>
              Every future call is refused. {workerName} will try to finish the job without it, which may mean
              thinner deliverables. You can switch it back on any time.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button type="button" variant="secondary" onClick={() => setConfirmOff(false)}>
              Cancel
            </Button>
            <Button
              type="button"
              className="bg-destructive text-white hover:bg-destructive/90 focus-visible:ring-destructive/30"
              onClick={() => {
                setConfirmOff(false);
                commit("off");
              }}
            >
              Turn it off
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Row>
  );
}
