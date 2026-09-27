import type { SecurityEventType } from "@prisma/client";
import { RelativeTime } from "@/components/relative-time";
import { Card } from "@/components/ui/card";
import type { SecurityEventView } from "@/server/security";
import { collapseActivity } from "../_lib/activity";
import { SettingsGroup, SettingsRow } from "./settings-list";
import { PasswordForm, SignOutEverywhere } from "./security-controls";

/** Third-person verb phrase per event, so the trail reads as sentences instead of enum names. */
const EVENT_PHRASE: Record<SecurityEventType, string> = {
  SIGN_UP: "created this workspace",
  SIGN_IN_SUCCEEDED: "signed in",
  SIGN_IN_FAILED: "tried to sign in and got the password wrong",
  SIGN_IN_THROTTLED: "was asked to wait after too many sign-in attempts",
  ACCOUNT_LOCKED: "was locked out after repeated failed sign-ins",
  SIGN_OUT: "signed out",
  SESSIONS_REVOKED: "signed out of every device",
  PASSWORD_CHANGED: "changed their password",
  PASSWORD_REHASHED: "had their stored password re-secured",
  CREDENTIAL_SET: "saved a tool key",
  CREDENTIAL_DELETED: "removed a tool key",
  INVITE_CREATED: "invited a teammate",
  INVITE_ACCEPTED: "accepted an invite",
  INVITE_REVOKED: "revoked an invite",
  ROLE_CHANGED: "changed a teammate's role",
  MEMBER_REMOVED: "removed a teammate",
  ORG_SETTINGS_CHANGED: "changed the workspace settings",
  RATE_LIMITED: "was asked to slow down",
  BUDGET_EXCEEDED: "hit the monthly spend cap",
};

export interface SecuritySectionProps {
  /** The signed-in user, for the password policy's "don't echo your own details" rule. */
  user: { name: string; email: string; organizationName: string };
  passwordMinLength: number;
  /** Newest first. Runs of the same event fold into one row here, so pass more than the rows you want shown. */
  events: SecurityEventView[];
  /** userId → display name, for the audit sentences. */
  names: Record<string, string>;
  /** Admins and owners see the whole workspace; everyone else sees only their own trail. */
  scopedToYou: boolean;
}

/** Password, sessions, and the audit trail — the three things a compromised account needs. */
export function SecuritySection({ user, passwordMinLength, events, names, scopedToYou }: SecuritySectionProps) {
  const rows = collapseActivity(events);
  return (
    <div className="space-y-10">
      <PasswordForm minLength={passwordMinLength} name={user.name} email={user.email} organizationName={user.organizationName} />

      <SettingsGroup
        title="Sessions"
        footer="Sessions last 12 hours of activity, and at most 7 days. Changing your password ends them all too."
      >
        <SettingsRow
          label="Sign out everywhere"
          hint="Ends every session on every device, including this one. Use it if you've lost a laptop or shared a password."
        >
          <SignOutEverywhere />
        </SettingsRow>
      </SettingsGroup>

      <section className="space-y-3">
        <div className="space-y-1 px-1">
          <h3 className="eyebrow">Recent activity</h3>
          <p className="text-footnote text-pretty text-muted-foreground">
            {scopedToYou
              ? "Sign-ins and account changes on your own account."
              : "Sign-ins, invites, role changes and key changes across the workspace."}
          </p>
        </div>
        <Card className="gap-0 py-2">
          {rows.length === 0 ? (
            <p className="mx-6 py-6 text-[15px] text-muted-foreground">
              Nothing recorded yet. Sign-ins and account changes show up here as they happen.
            </p>
          ) : (
            rows.map((row) => {
              const who = row.userId ? (names[row.userId] ?? "A former teammate") : "Someone";
              // "signed in 12 times from 203.0.113.9": the count sits inside the sentence, the place at the end.
              const times = row.count > 1 ? ` ${row.count} times` : "";
              const where = row.ip ? ` from ${row.ip}` : "";
              return (
                <div
                  key={row.id}
                  className="mx-6 flex flex-col gap-1 border-b border-border py-3.5 last:border-0 sm:flex-row sm:items-baseline sm:justify-between sm:gap-6"
                >
                  <p className="text-[15px] text-pretty text-foreground">
                    <span className="font-medium">{who}</span> {EVENT_PHRASE[row.type]}
                    {times}
                    {where}
                  </p>
                  <p className="text-footnote shrink-0 text-muted-foreground">
                    {row.count > 1 ? "latest " : null}
                    <RelativeTime iso={row.latestAt} />
                  </p>
                </div>
              );
            })
          )}
        </Card>
      </section>
    </div>
  );
}
