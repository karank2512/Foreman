import { RelativeTime } from "@/components/relative-time";
import { formatDate } from "@/lib/format";
import type { InvitationView, MemberView } from "@/server/account";
import { SettingsGroup, SettingsRow, SettingsValue, StatusLine } from "./settings-list";
import { InviteForm, MemberMenu, RevokeInviteButton } from "./member-controls";

export const ROLE_LABEL = { OWNER: "Owner", ADMIN: "Admin", MEMBER: "Member" } as const;

/** One sentence per role, so nobody has to guess what "Admin" buys. */
const ROLE_BLURB = {
  OWNER: "Runs the workspace: settings, budget and who's on the team.",
  ADMIN: "Hires, manages and replaces workers, and holds the tool keys.",
  MEMBER: "Starts runs, reviews deliverables and decides approvals.",
} as const;

export interface MembersSectionProps {
  members: MemberView[];
  invitations: InvitationView[];
  currentUserId: string;
  /** `members.invite` — ADMIN and up. */
  canInvite: boolean;
  /** `members.manage` — OWNER only. */
  canManage: boolean;
}

const INVITE_TONE = {
  pending: "attention",
  accepted: "success",
  revoked: "idle",
  expired: "idle",
} as const;

const INVITE_LABEL = { pending: "Waiting", accepted: "Joined", revoked: "Revoked", expired: "Expired" } as const;

/** Who is in the workspace, what they may do, and who has been asked to join. */
export function MembersSection({ members, invitations, currentUserId, canInvite, canManage }: MembersSectionProps) {
  const active = members.filter((m) => !m.disabled);
  const removed = members.filter((m) => m.disabled);
  const pending = invitations.filter((i) => i.status === "pending");
  const decided = invitations.filter((i) => i.status !== "pending").slice(0, 5);

  return (
    <div className="space-y-10">
      <SettingsGroup
        title="People"
        description="Who's on the team, and what each of them can do here."
        footer={
          canManage
            ? "A workspace always keeps at least one owner. Removing someone keeps their runs and reviews on file, but signs them out everywhere."
            : "Only the workspace owner can change roles or remove people."
        }
      >
        {active.map((member) => {
          const you = member.id === currentUserId;
          return (
            <SettingsRow
              key={member.id}
              align="start"
              label={
                <>
                  {member.name}
                  {you ? <span className="font-normal text-muted-foreground"> (you)</span> : null}
                </>
              }
              hint={
                <>
                  {member.email} · {ROLE_BLURB[member.role]}
                  {member.lastSignInAt ? (
                    <>
                      {" "}
                      Last signed in <RelativeTime iso={member.lastSignInAt} />.
                    </>
                  ) : (
                    " Hasn't signed in yet."
                  )}
                </>
              }
            >
              <SettingsValue>{ROLE_LABEL[member.role]}</SettingsValue>
              {canManage && !you ? (
                <MemberMenu userId={member.id} name={member.name} role={member.role} />
              ) : null}
            </SettingsRow>
          );
        })}

        {removed.map((member) => (
          <SettingsRow key={member.id} label={member.name} hint={member.email}>
            <StatusLine tone="idle">Removed</StatusLine>
          </SettingsRow>
        ))}
      </SettingsGroup>

      {canInvite ? <InviteForm /> : null}

      {pending.length > 0 || decided.length > 0 ? (
        <SettingsGroup
          title="Invites"
          footer={
            canInvite
              ? "An invite link is shown once, when you create it. Lost it? Revoke the invite and send a new one."
              : undefined
          }
        >
          {[...pending, ...decided].map((invite) => (
            <SettingsRow
              key={invite.id}
              align="start"
              label={invite.email}
              hint={
                <>
                  {ROLE_LABEL[invite.role]} · invited by {invite.invitedByName}
                  {invite.status === "pending" ? (
                    <> · expires {formatDate(invite.expiresAt)}</>
                  ) : invite.acceptedAt ? (
                    <>
                      {" "}
                      · joined <RelativeTime iso={invite.acceptedAt} />
                    </>
                  ) : null}
                </>
              }
            >
              <StatusLine tone={INVITE_TONE[invite.status]}>{INVITE_LABEL[invite.status]}</StatusLine>
              {canInvite && invite.status === "pending" ? (
                <RevokeInviteButton invitationId={invite.id} email={invite.email} />
              ) : null}
            </SettingsRow>
          ))}
        </SettingsGroup>
      ) : canInvite ? null : (
        <p className="text-footnote px-1 text-muted-foreground">
          Only owners and admins can invite teammates.
        </p>
      )}
    </div>
  );
}
