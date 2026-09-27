import type { Metadata } from "next";
import Link from "next/link";
import { PageHeader } from "@/components/page-header";
import { getOrgSettings, listInvitations, listMembers } from "@/server/account";
import { requireSession } from "@/server/auth";
import { config } from "@/server/config";
import { getSettingsPage } from "@/server/queries/settings";
import { listSecurityEvents } from "@/server/security";
import { CredentialsSection } from "./_components/credentials-section";
import { MembersSection } from "./_components/members-section";
import { ProvidersSection } from "./_components/providers-section";
import { RuntimeSection } from "./_components/runtime-section";
import { SecuritySection } from "./_components/security-section";
import { SettingsIndex, SettingsRail } from "./_components/settings-nav";
import { WorkspaceSection } from "./_components/workspace-section";
import { DEFAULT_SETTINGS_SECTION, parseSettingsSection, settingsSection } from "./sections";

export const metadata: Metadata = { title: "Settings" };

// The section folds runs of identical events into one row (a dozen sign-ins from one laptop), so it is
// handed several times the rows it shows.
const AUDIT_EVENT_LIMIT = 60;

/**
 * The account area: one route, six sections, `?section=` deciding which. On a wide screen the rail is always
 * there and a missing section falls back to Workspace; on a phone the same missing section shows the index
 * list instead, so the page reads as a drill-in rather than a wall of settings.
 */
export default async function SettingsPage({ searchParams }: { searchParams: Promise<{ section?: string | string[] }> }) {
  const [s, params] = await Promise.all([requireSession(), searchParams]);
  const requested = parseSettingsSection(params.section);
  const active = requested ?? DEFAULT_SETTINGS_SECTION;

  const settings = await getSettingsPage(s.organizationId, { role: s.role });
  const { permissions } = settings;
  // Workspace-wide sign-in trails name other people and their IPs, so a plain member only sees their own.
  const auditWide = permissions["members.invite"];

  const [org, members, invitations, events] = await Promise.all([
    active === "workspace" || active === "runtime" ? getOrgSettings(s.organizationId) : null,
    active === "members" || active === "security" ? listMembers(s.organizationId) : null,
    active === "members" ? listInvitations(s.organizationId) : null,
    active === "security"
      ? listSecurityEvents(s.organizationId, {
          limit: AUDIT_EVENT_LIMIT,
          ...(auditWide ? {} : { userId: s.userId }),
        })
      : null,
  ]);

  const section = settingsSection(active);
  const simulated = settings.providers.mode === "simulated";

  return (
    <>
      <PageHeader
        title="Settings"
        description={`${settings.workspace.organizationName} — your team, your budget, and what your workers are allowed to reach.`}
      />

      <div className="grid gap-x-10 gap-y-8 lg:grid-cols-[13.75rem_minmax(0,1fr)]">
        <SettingsRail active={active} />

        <div className="min-w-0">
          {requested === null ? <SettingsIndex /> : null}

          <div className={requested === null ? "hidden lg:block" : undefined}>
            <div className="max-w-[45rem] space-y-8">
              <div className="space-y-1">
                <Link href="/settings" className="text-callout text-link lg:hidden">
                  ‹ Settings
                </Link>
                <h2 className="text-title-2 text-foreground">{section.label}</h2>
                <p className="text-[15px] text-pretty text-muted-foreground">{section.blurb}.</p>
              </div>

              {active === "workspace" && org ? (
                <WorkspaceSection org={org} canManage={permissions["org.manage"]} simulated={simulated} />
              ) : null}

              {active === "members" && members && invitations ? (
                <MembersSection
                  members={members}
                  invitations={invitations}
                  currentUserId={s.userId}
                  canInvite={permissions["members.invite"]}
                  canManage={permissions["members.manage"]}
                />
              ) : null}

              {active === "security" && events && members ? (
                <SecuritySection
                  user={{ name: s.name, email: s.email, organizationName: s.organizationName }}
                  passwordMinLength={config.auth.passwordMinLength}
                  events={events}
                  names={Object.fromEntries(members.map((m) => [m.id, m.name]))}
                  scopedToYou={!auditWide}
                />
              ) : null}

              {active === "providers" ? (
                <ProvidersSection providers={settings.providers} operator={settings.operator !== null} />
              ) : null}

              {active === "credentials" ? (
                <CredentialsSection
                  credentials={settings.credentials}
                  simulatedMode={simulated}
                  canManage={permissions["credentials.manage"]}
                />
              ) : null}

              {active === "runtime" ? (
                <RuntimeSection
                  executor={settings.operator?.executor ?? null}
                  showDemoData={!config.isProduction && org?.isDemo === true}
                />
              ) : null}
            </div>
          </div>
        </div>
      </div>
    </>
  );
}
