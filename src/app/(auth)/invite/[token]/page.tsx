import type { Metadata } from "next";
import Link from "next/link";
import { getInvitationByToken } from "@/server/account";
import { SIGN_IN_PATH } from "@/server/auth";
import { config } from "@/server/config";
import { AuthHeader } from "../../_components/form-ui";
import { AcceptInviteForm } from "./accept-invite-form";

export const metadata: Metadata = {
  title: "Join a workspace",
  description: "Accept your invitation and join your team's AI Staffing Agency workspace.",
  robots: { index: false, follow: false },
};

const ROLE_COPY: Record<string, string> = {
  MEMBER: "You'll be able to run workers, review their work and decide approvals.",
  ADMIN: "You'll be able to scope jobs, hire and manage workers, and invite teammates.",
  OWNER: "You'll be able to manage the workspace, its members and its budget.",
};

/**
 * Invite acceptance. Unknown, expired, revoked and already-used links are indistinguishable here — the
 * lookup returns null for all four, so a stranger cannot probe for live invitations.
 */
export default async function InvitePage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const invitation = await getInvitationByToken(token);

  if (!invitation) {
    return (
      <>
        <AuthHeader
          title="This invite has expired"
          description="Invite links run out after a while, and each one works only once. Ask whoever invited you to send a fresh link from their workspace settings."
        />
        <p className="text-[15px] leading-[22px] text-muted-foreground">
          Already have an account?{" "}
          <Link href={SIGN_IN_PATH} className="-my-[11px] inline-block py-[11px] font-medium text-link hover:underline">
            Sign in <span aria-hidden>›</span>
          </Link>
        </p>
      </>
    );
  }

  return (
    <>
      <AuthHeader
        title={`Join ${invitation.organizationName}`}
        description={ROLE_COPY[invitation.role] ?? "You'll be able to work alongside the rest of the team."}
      />

      <AcceptInviteForm
        token={token}
        email={invitation.email}
        organizationName={invitation.organizationName}
        passwordMinLength={config.auth.passwordMinLength}
      />

      <p className="mt-10 border-t border-border pt-6 text-[15px] leading-[22px] text-muted-foreground">
        Already have an account?{" "}
        <Link href={SIGN_IN_PATH} className="-my-[11px] inline-block py-[11px] font-medium text-link hover:underline">
          Sign in <span aria-hidden>›</span>
        </Link>
      </p>
    </>
  );
}
