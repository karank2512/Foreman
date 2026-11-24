"use client";

import { useState } from "react";
import { toast } from "sonner";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { CopyButton } from "@/components/copy-button";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { formatDate } from "@/lib/format";
import { createPasswordResetLinkAction } from "../account-actions";

/**
 * "Forgot my password" without an email provider: the owner makes a one-time link and passes it on, like an
 * invite. Making one signs the person out everywhere, which is also what retires any older link.
 */
export function PasswordResetButton({ userId, name }: { userId: string; name: string }) {
  const [created, setCreated] = useState<{ resetUrl: string; expiresAt: string } | null>(null);

  return (
    <>
      <ConfirmDialog
        trigger={
          <Button variant="ghost" size="sm" className="text-muted-foreground hover:text-foreground">
            Reset password
          </Button>
        }
        title={`Make a reset link for ${name}?`}
        description={`${name} is signed out everywhere, and any earlier reset link stops working. The new link lets them choose a password once, within a day.`}
        confirmLabel="Make reset link"
        onConfirm={async () => {
          const result = await createPasswordResetLinkAction(userId);
          if (!result.ok) throw new Error(result.error);
          setCreated(result.data);
          toast.success(`${name} was signed out everywhere`);
        }}
      />

      <Dialog
        open={created !== null}
        onOpenChange={(open) => {
          if (!open) setCreated(null);
        }}
      >
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>Send this link to {name}</DialogTitle>
            <DialogDescription>
              Whoever opens it can set a new password for {name}&apos;s account, so share it only with them. It
              works once, until {created ? formatDate(created.expiresAt) : ""}, and this is the only time we can
              show it.
            </DialogDescription>
          </DialogHeader>
          <div className="flex items-center gap-2 rounded-lg bg-muted p-2 pl-3.5">
            <span className="min-w-0 flex-1 truncate font-mono text-[13px]">{created?.resetUrl}</span>
            {created ? <CopyButton value={created.resetUrl} label="Copy" /> : null}
          </div>
          <DialogFooter>
            <Button variant="secondary" onClick={() => setCreated(null)}>
              Done
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
