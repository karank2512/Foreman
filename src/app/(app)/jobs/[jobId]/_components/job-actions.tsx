"use client";

import { useState, type ReactNode } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Loader2, MoreHorizontal } from "lucide-react";
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
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import type { JobDetailView } from "@/server/queries/jobs";
import { closeJobAction, discardJobAction } from "../../actions";

export interface JobActionsProps {
  jobId: string;
  title: string;
  /** Decides how "discard" reads: a DRAFT job loses a draft spec, a SPEC_APPROVED one loses an approved spec. */
  status: JobDetailView["job"]["status"];
  can: JobDetailView["can"];
  /** What this viewer's role is allowed to do — the server enforces the same rules. */
  permissions: JobDetailView["permissions"];
  /** The worker holding the seat, for the "View worker" shortcut. */
  currentWorker: { id: string; name: string } | null;
}

type Pending = "close" | "discard" | null;

/**
 * A controlled confirm step. `ConfirmDialog` owns its own trigger, which cannot survive a dropdown closing
 * underneath it — so the overflow menu sets state and this dialog opens on its own.
 */
function ConfirmAction({
  open,
  onOpenChange,
  title,
  description,
  confirmLabel,
  destructive,
  onConfirm,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description: ReactNode;
  confirmLabel: string;
  destructive?: boolean;
  onConfirm: () => Promise<void>;
}) {
  const [pending, setPending] = useState(false);

  async function confirm() {
    if (pending) return;
    setPending(true);
    try {
      await onConfirm();
      onOpenChange(false);
    } catch (e) {
      toast.error(e instanceof Error && e.message ? e.message : "Something went wrong. Please try again.");
    } finally {
      setPending(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={(next) => (pending ? undefined : onOpenChange(next))}>
      <DialogContent showCloseButton={false} className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription asChild>
            <div className="text-[15px] text-pretty text-muted-foreground">{description}</div>
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button type="button" variant="secondary" disabled={pending} onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            type="button"
            disabled={pending}
            onClick={confirm}
            className={destructive ? "bg-danger text-white hover:bg-danger/90 focus-visible:ring-danger/25" : undefined}
          >
            {pending ? <Loader2 className="animate-spin" aria-hidden="true" /> : null}
            {confirmLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/**
 * Gray pills beside a "…" menu for everything consequential — on a phone the hire action moves to a bar pinned
 * at the bottom of the viewport as the page's one primary.
 */
export function JobActions({ jobId, title, status, can, permissions, currentWorker }: JobActionsProps) {
  const router = useRouter();
  const [pending, setPending] = useState<Pending>(null);
  const hireHref = `/hire?jobId=${encodeURIComponent(jobId)}`;
  const isDraft = status === "DRAFT";

  const mayManage = permissions["jobs.manage"];
  const showContinue = can.continueSetup && mayManage;
  const showHire = can.hire && permissions["workers.hire"];
  const showClose = can.close && mayManage;
  const showDiscard = can.discard && mayManage;
  const hasOverflow = showClose || showDiscard;

  // On desktop the global nav's blue "Hire" pill is already this view's one primary, and both lead into the hire
  // flow — so the header's own hire action is a gray pill there. The phone bar (no nav pill) keeps it blue.
  const primary = showContinue ? (
    <Button variant="secondary" asChild>
      <Link href={hireHref}>Continue setup</Link>
    </Button>
  ) : showHire ? (
    <Button variant="secondary" asChild>
      <Link href={hireHref}>Hire a worker</Link>
    </Button>
  ) : null;

  const overflow = hasOverflow ? (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="secondary" size="icon-lg" aria-label="More job actions">
          <MoreHorizontal aria-hidden="true" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        {showClose ? <DropdownMenuItem onSelect={() => setPending("close")}>Close this job</DropdownMenuItem> : null}
        {showDiscard ? (
          <DropdownMenuItem variant="destructive" onSelect={() => setPending("discard")}>
            {isDraft ? "Discard draft" : "Discard job"}
          </DropdownMenuItem>
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
  ) : null;

  return (
    <>
      <div className="hidden items-center gap-2.5 sm:flex">
        {currentWorker ? (
          <Button variant="secondary" asChild>
            <Link href={`/workers/${currentWorker.id}`}>View {currentWorker.name}</Link>
          </Button>
        ) : null}
        {primary}
        {overflow}
      </div>

      {primary || currentWorker || overflow ? (
        <div className="material-thick fixed inset-x-0 bottom-0 z-30 shadow-bar pb-[env(safe-area-inset-bottom)] sm:hidden">
          <div className="flex items-center gap-3 px-4 py-3">
            {primary ? (
              <Button className="h-11 flex-1" asChild>
                <Link href={hireHref}>{showContinue ? "Continue setup" : "Hire a worker"}</Link>
              </Button>
            ) : currentWorker ? (
              <Button variant="secondary" className="h-11 flex-1" asChild>
                <Link href={`/workers/${currentWorker.id}`}>View {currentWorker.name}</Link>
              </Button>
            ) : (
              <span className="flex-1" />
            )}
            {overflow}
          </div>
        </div>
      ) : null}

      <ConfirmAction
        open={pending === "close"}
        onOpenChange={(open) => setPending(open ? "close" : null)}
        title={`Close “${title}”?`}
        description="Nobody can be hired for it afterwards. Runs, deliverables and evaluations stay in your records."
        confirmLabel="Close job"
        onConfirm={async () => {
          const r = await closeJobAction(jobId);
          if (!r.ok) throw new Error(r.error);
          toast.success(`“${r.data.title}” is closed`);
          router.refresh();
        }}
      />

      <ConfirmAction
        open={pending === "discard"}
        onOpenChange={(open) => setPending(open ? "discard" : null)}
        title={`Discard “${title}”?`}
        description={`The job and its ${isDraft ? "draft" : "approved"} spec are deleted. Nothing has been hired, so there is no history to keep.`}
        confirmLabel="Discard job"
        destructive
        onConfirm={async () => {
          const r = await discardJobAction(jobId);
          if (!r.ok) throw new Error(r.error);
          toast.success(isDraft ? "Draft discarded" : "Job discarded");
          router.push(r.data.redirectTo);
        }}
      />
    </>
  );
}
