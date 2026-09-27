"use client";

import { useId, useState, useTransition, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import type { UserRole } from "@prisma/client";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { CopyButton } from "@/components/copy-button";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { formatDate } from "@/lib/format";
import { changeMemberRoleAction, inviteMemberAction, removeMemberAction, revokeInvitationAction } from "../account-actions";

/** The interactive leaves of the Members section. Everything they call is a hardened server action. */

const ROLE_OPTIONS: Array<{ value: UserRole; label: string }> = [
  { value: "OWNER", label: "Owner" },
  { value: "ADMIN", label: "Admin" },
  { value: "MEMBER", label: "Member" },
];

/**
 * Radix's `<SelectValue />` fills itself from the chosen item's text, which only exists after hydration —
 * server markup ships an empty trigger. Passing the label as children makes the server render read what the
 * hydrated page reads.
 */
function roleLabel(role: UserRole): string {
  return ROLE_OPTIONS.find((option) => option.value === role)?.label ?? role;
}

export function MemberMenu({ userId, name, role }: { userId: string; name: string; role: UserRole }) {
  const router = useRouter();
  const [pending, start] = useTransition();

  function change(next: string) {
    if (next === role) return;
    start(async () => {
      const result = await changeMemberRoleAction(userId, next as UserRole);
      if (!result.ok) {
        toast.error(result.error);
        return;
      }
      toast.success(`${name} is now ${next === "OWNER" ? "an owner" : next === "ADMIN" ? "an admin" : "a member"}`);
      router.refresh();
    });
  }

  return (
    <>
      <Select value={role} onValueChange={change} disabled={pending}>
        <SelectTrigger size="sm" aria-label={`Role for ${name}`} className="w-32">
          <SelectValue>{roleLabel(role)}</SelectValue>
        </SelectTrigger>
        <SelectContent>
          {ROLE_OPTIONS.map((option) => (
            <SelectItem key={option.value} value={option.value}>
              {option.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>

      <ConfirmDialog
        trigger={
          <Button variant="ghost" size="sm" className="text-muted-foreground hover:text-foreground">
            Remove
          </Button>
        }
        title={`Remove ${name}?`}
        description={`${name} is signed out everywhere and can't sign back in. Their runs, reviews and decisions stay on file.`}
        confirmLabel="Remove from workspace"
        destructive
        onConfirm={async () => {
          const result = await removeMemberAction(userId);
          if (!result.ok) throw new Error(result.error);
          toast.success(`${name} was removed`);
          router.refresh();
        }}
      />
    </>
  );
}

export function RevokeInviteButton({ invitationId, email }: { invitationId: string; email: string }) {
  const router = useRouter();
  return (
    <ConfirmDialog
      trigger={
        <Button variant="ghost" size="sm" className="text-muted-foreground hover:text-foreground">
          Revoke
        </Button>
      }
      title="Revoke this invite?"
      description={`The link sent to ${email} stops working straight away. You can invite them again any time.`}
      confirmLabel="Revoke invite"
      destructive
      onConfirm={async () => {
        const result = await revokeInvitationAction(invitationId);
        if (!result.ok) throw new Error(result.error);
        toast.success("Invite revoked");
        router.refresh();
      }}
    />
  );
}

interface CreatedInvite {
  email: string;
  role: UserRole;
  inviteUrl: string;
  expiresAt: string;
}

/**
 * Invite by email and role. There is no mail provider yet, so the link is shown once, here, for the admin to
 * pass on — the raw token is never stored, which is also why it can't be shown again later.
 */
export function InviteForm() {
  const router = useRouter();
  const ids = { email: useId(), role: useId() };
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<"MEMBER" | "ADMIN">("MEMBER");
  const [created, setCreated] = useState<CreatedInvite | null>(null);
  const [pending, start] = useTransition();

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending || email.trim() === "") return;
    start(async () => {
      const result = await inviteMemberAction({ email: email.trim(), role });
      if (!result.ok) {
        toast.error(result.error);
        return;
      }
      setCreated({ email: email.trim(), role, inviteUrl: result.data.inviteUrl, expiresAt: result.data.expiresAt });
      setEmail("");
      router.refresh();
    });
  }

  return (
    <section className="space-y-3">
      <div className="space-y-1 px-1">
        <h3 className="eyebrow">Invite a teammate</h3>
        <p className="text-footnote text-pretty text-muted-foreground">
          We&apos;ll make a link for you to send them. They pick their own name and password when they join.
        </p>
      </div>

      <Card className="gap-0 py-2">
        <form onSubmit={submit} className="mx-6 space-y-4 py-5">
          <div className="flex flex-col gap-4 sm:flex-row sm:items-end">
            <div className="min-w-0 flex-1 space-y-2">
              <Label htmlFor={ids.email}>Work email</Label>
              <Input
                id={ids.email}
                type="email"
                autoComplete="off"
                placeholder="dana@company.com"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                disabled={pending}
                required
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor={ids.role}>Role</Label>
              <Select value={role} onValueChange={(next) => setRole(next as "MEMBER" | "ADMIN")} disabled={pending}>
                <SelectTrigger id={ids.role} className="w-full sm:w-36">
                  <SelectValue>{roleLabel(role)}</SelectValue>
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="MEMBER">Member</SelectItem>
                  <SelectItem value="ADMIN">Admin</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
          <Button type="submit" disabled={pending || email.trim() === ""} className="max-sm:w-full">
            {pending ? <Loader2 className="animate-spin" aria-hidden="true" /> : null}
            {pending ? "Creating invite…" : "Create invite link"}
          </Button>
        </form>
      </Card>

      <Dialog
        open={created !== null}
        onOpenChange={(open) => {
          if (!open) setCreated(null);
        }}
      >
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>Send this link to {created?.email}</DialogTitle>
            <DialogDescription>
              Anyone who opens it joins this workspace as {created?.role === "ADMIN" ? "an admin" : "a member"}. It
              works until {created ? formatDate(created.expiresAt) : ""}, and this is the only time we can show it.
            </DialogDescription>
          </DialogHeader>
          <div className="flex items-center gap-2 rounded-lg bg-muted p-2 pl-3.5">
            <span className="min-w-0 flex-1 truncate font-mono text-[13px]">{created?.inviteUrl}</span>
            {created ? <CopyButton value={created.inviteUrl} label="Copy" /> : null}
          </div>
          <DialogFooter>
            <Button variant="secondary" onClick={() => setCreated(null)}>
              Done
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  );
}
