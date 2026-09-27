import { createElement as h, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { SecurityEventType } from "@prisma/client";
import { beforeAll, describe, expect, it } from "vitest";
import { ACTIVITY_ROW_LIMIT, collapseActivity, publicIp } from "@/app/(app)/settings/_lib/activity";
import type { MemberView } from "@/server/account";
import type { SettingsExecutor, SettingsProviders } from "@/server/queries/settings";
import type { SecurityEventView } from "@/server/security";
import { loadForSsr } from "./_ssr";

type MemberControls = typeof import("@/app/(app)/settings/_components/member-controls");
type Members = typeof import("@/app/(app)/settings/_components/members-section");
type Providers = typeof import("@/app/(app)/settings/_components/providers-section");
type Runtime = typeof import("@/app/(app)/settings/_components/runtime-section");
type Security = typeof import("@/app/(app)/settings/_components/security-section");
type Tooltip = typeof import("@/components/ui/tooltip");

/**
 * The Settings sections, rendered the way Next renders them on the server: no router, no DOM, no hydration.
 * That is the markup a person sees first, so it is where the copy and the blank-until-hydrated bugs live.
 * The client leaves (invite form, role menu, password form) only call their actions from event handlers, so
 * inert stubs stand in for the server actions and the app router.
 */

const inert = async () => ({ ok: true as const, data: {} });
const stubs = {
  "next/navigation": {
    useRouter: () => ({ push() {}, replace() {}, refresh() {} }),
    usePathname: () => "/settings",
    useSearchParams: () => new URLSearchParams(),
  },
  "src/app/(app)/settings/account-actions": {
    changeMemberRoleAction: inert,
    changePasswordAction: inert,
    inviteMemberAction: inert,
    removeMemberAction: inert,
    revokeInvitationAction: inert,
    signOutEverywhereAction: inert,
  },
  "src/app/(auth)/actions": { signOutAction: inert },
};

let controls: MemberControls;
let members: Members;
let providers: Providers;
let runtime: Runtime;
let security: Security;
let tooltip: Tooltip;

beforeAll(async () => {
  const dir = "src/app/(app)/settings/_components";
  [controls, members, providers, runtime, security, tooltip] = await Promise.all([
    loadForSsr<MemberControls>(`${dir}/member-controls.tsx`, stubs),
    loadForSsr<Members>(`${dir}/members-section.tsx`, stubs),
    loadForSsr<Providers>(`${dir}/providers-section.tsx`, stubs),
    loadForSsr<Runtime>(`${dir}/runtime-section.tsx`, stubs),
    loadForSsr<Security>(`${dir}/security-section.tsx`, stubs),
    loadForSsr<Tooltip>("src/components/ui/tooltip.tsx"),
  ]);
});

// The app layout provides the tooltip context that CopyButton and friends expect.
const render = (element: ReactElement) => renderToStaticMarkup(h(tooltip.TooltipProvider, null, element));

/** Text before the first operator disclosure, and everything from it on. */
function splitAtOperatorNotes(html: string): { before: string; notes: string | null } {
  const at = html.indexOf("<details");
  return at === -1 ? { before: html, notes: null } : { before: html.slice(0, at), notes: html.slice(at) };
}

describe("settings › members: the role select is readable before hydration (design-public-auth-012)", () => {
  it("server-renders the invite form's Role trigger with its label, not an empty span", () => {
    const html = render(h(controls.InviteForm));
    // Radix fills an empty <SelectValue /> by portal after mount; passing the label as children puts it in the SSR markup.
    expect(html).toMatch(/data-slot="select-value"[^>]*>Member</);
    expect(html).not.toMatch(/data-slot="select-value"[^>]*><\/span>/);
  });

  it("does the same for each teammate's role menu", () => {
    for (const role of ["OWNER", "ADMIN", "MEMBER"] as const) {
      const html = render(h(controls.MemberMenu, { userId: "user_1", name: "Ada", role }));
      const label = role === "OWNER" ? "Owner" : role === "ADMIN" ? "Admin" : "Member";
      expect(html).toMatch(new RegExp(`data-slot="select-value"[^>]*>${label}<`));
    }
  });
});

describe("settings › copy speaks to the workspace owner, not the operator (design-detail-15)", () => {
  const team: MemberView[] = [
    { id: "user_1", name: "Dana Owner", email: "dana@example.test", role: "OWNER", lastSignInAt: null, disabled: false, createdAt: "2026-09-01T00:00:00.000Z" },
    { id: "user_2", name: "Ada Member", email: "ada@example.test", role: "MEMBER", lastSignInAt: null, disabled: false, createdAt: "2026-09-02T00:00:00.000Z" },
  ];

  it("members: describes the team instead of how roles are enforced", () => {
    const owner = render(h(members.MembersSection, { members: team, invitations: [], currentUserId: "user_1", canInvite: true, canManage: true }));
    expect(owner).toContain("on the team, and what each of them can do here");
    expect(owner).not.toContain("enforced on the server");
    expect(owner).not.toContain("courtesy");

    const member = render(h(members.MembersSection, { members: team, invitations: [], currentUserId: "user_2", canInvite: false, canManage: false }));
    expect(member).toContain("Only the workspace owner can change roles or remove people.");
  });

  const tiers = (["fast", "standard", "reasoning"] as const).map((tier) => ({
    tier,
    provider: "mock",
    providerLabel: "Simulated (built-in)",
    model: `mock-${tier}`,
    simulated: true,
    overrideEnvVar: `MODEL_TIER_${tier.toUpperCase()}`,
  }));
  const ownerProviders: SettingsProviders = {
    mode: "simulated",
    forceSimulated: true,
    providers: [
      { id: "anthropic", label: "Anthropic", available: false, envVar: "ANTHROPIC_API_KEY" },
      { id: "openai", label: "OpenAI", available: false, envVar: "OPENAI_API_KEY" },
      { id: "google", label: "Google", available: false, envVar: "GOOGLE_GENERATIVE_AI_API_KEY" },
      { id: "mock", label: "Simulated (built-in)", available: true, envVar: null },
    ],
    tiers,
  };
  // What getSettingsPage hands anyone below OWNER: the same rows with the env var names stripped.
  const memberProviders: SettingsProviders = {
    ...ownerProviders,
    providers: ownerProviders.providers.map((p) => ({ ...p, envVar: null })),
    tiers: tiers.map((t) => ({ ...t, overrideEnvVar: null })),
  };
  const OPS_TOKENS = ["_API_KEY", "MODEL_TIER_", "FORCE_SIMULATED", "EXECUTOR_", "npm run"];

  it("providers: env vars and restart instructions sit behind a 'For operators' disclosure for the owner", () => {
    const html = render(h(providers.ProvidersSection, { providers: ownerProviders, operator: true }));
    const { before, notes } = splitAtOperatorNotes(html);
    expect(notes).not.toBeNull();
    expect(notes).toContain("For operators");
    for (const token of ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GOOGLE_GENERATIVE_AI_API_KEY", "MODEL_TIER_STANDARD", "FORCE_SIMULATED=true"]) {
      expect(notes).toContain(token);
    }
    for (const token of OPS_TOKENS) expect(before).not.toContain(token);
    expect(before).toContain("Add a provider key to go live");
  });

  it("providers: everyone else gets product language and no operator detail at all", () => {
    const html = render(h(providers.ProvidersSection, { providers: memberProviders, operator: false }));
    expect(splitAtOperatorNotes(html).notes).toBeNull();
    for (const token of OPS_TOKENS) expect(html).not.toContain(token);
    expect(html).toContain("Add a provider key to go live");
  });

  const executor: SettingsExecutor = { enabled: true, pollMs: 1000, concurrency: 2, staleLockMs: 600_000, schedulerTickMs: 15_000 };

  it("runtime: the tuning knobs and the seed command live in the operator notes, the page itself does not mention them", () => {
    const html = render(h(runtime.RuntimeSection, { executor, showDemoData: true }));
    const { before, notes } = splitAtOperatorNotes(html);
    expect(notes).not.toBeNull();
    expect(notes).toContain("EXECUTOR_POLL_MS");
    expect(notes).toContain("EXECUTOR_DISABLED=true");
    expect(notes).toContain("npm run db:seed:demo");
    for (const token of OPS_TOKENS) expect(before).not.toContain(token);
    expect(before).toContain("Start the demo over");
    expect(before).not.toContain("terminal");
  });

  it("runtime: a member on a non-demo workspace sees one sentence and no disclosure", () => {
    const html = render(h(runtime.RuntimeSection, { executor: null, showDemoData: false }));
    expect(splitAtOperatorNotes(html).notes).toBeNull();
    expect(html).toContain("set up on the server by whoever runs the platform");
    for (const token of OPS_TOKENS) expect(html).not.toContain(token);
  });
});

describe("settings › security: recent activity folds repeats and hides addresses that say nothing (design-detail-15)", () => {
  it("publicIp keeps routable addresses and drops loopback, private, link-local and unknown ones", () => {
    expect(publicIp("203.0.113.9")).toBe("203.0.113.9");
    expect(publicIp("  203.0.113.9 ")).toBe("203.0.113.9");
    expect(publicIp("172.32.0.1")).toBe("172.32.0.1"); // just outside 172.16/12
    expect(publicIp("2001:db8::1")).toBe("2001:db8::1");
    expect(publicIp("::ffff:203.0.113.9")).toBe("::ffff:203.0.113.9");

    for (const hidden of [null, undefined, "", "unknown", "::1", "::", "127.0.0.1", "::ffff:127.0.0.1", "10.1.2.3", "172.16.0.1", "172.31.255.255", "192.168.1.8", "169.254.1.1", "0.0.0.0", "fe80::1", "fd12::1", "fc00::1"]) {
      expect(publicIp(hidden), String(hidden)).toBeNull();
    }
  });

  const at = (i: number) => new Date(Date.UTC(2026, 8, 24, 12, 0, 0) - i * 60_000).toISOString();
  function event(i: number, type: SecurityEventType, ip: string | null, userId: string | null = "user_1"): SecurityEventView {
    return { id: `evt_${i}`, type, userId, ip, userAgent: null, metadata: null, createdAt: at(i) };
  }
  // Newest first, as listSecurityEvents returns them.
  const events: SecurityEventView[] = [
    ...Array.from({ length: 12 }, (_, i) => event(i, "SIGN_IN_SUCCEEDED", "::1")),
    event(12, "PASSWORD_CHANGED", "::1"),
    event(13, "SIGN_IN_SUCCEEDED", "203.0.113.9"),
    event(14, "SIGN_IN_SUCCEEDED", "203.0.113.9"),
    event(15, "SIGN_IN_SUCCEEDED", "127.0.0.1", "user_2"),
  ];

  it("collapseActivity folds only consecutive identical events and keeps the order", () => {
    const rows = collapseActivity(events);
    expect(rows.map((r) => [r.type, r.userId, r.ip, r.count])).toEqual([
      ["SIGN_IN_SUCCEEDED", "user_1", null, 12],
      ["PASSWORD_CHANGED", "user_1", null, 1],
      ["SIGN_IN_SUCCEEDED", "user_1", "203.0.113.9", 2],
      ["SIGN_IN_SUCCEEDED", "user_2", null, 1],
    ]);
    // The row carries the newest event of its group.
    expect(rows[0]).toMatchObject({ id: "evt_0", latestAt: at(0) });
    expect(rows[2]).toMatchObject({ id: "evt_13", latestAt: at(13) });
  });

  it("collapseActivity stops at the row limit but still folds repeats into the last row", () => {
    const stream = [event(0, "SIGN_UP", null), event(1, "SIGN_UP", null), event(2, "SIGN_OUT", null), event(3, "SIGN_OUT", null), event(4, "SIGN_OUT", null), event(5, "INVITE_CREATED", null)];
    expect(collapseActivity(stream, 2).map((r) => [r.type, r.count])).toEqual([["SIGN_UP", 2], ["SIGN_OUT", 3]]);
    expect(collapseActivity([], 2)).toEqual([]);
    // The default limit is what the section shows.
    const many = Array.from({ length: 40 }, (_, i) => event(i, i % 2 === 0 ? "SIGN_IN_SUCCEEDED" : "SIGN_OUT", null));
    expect(collapseActivity(many)).toHaveLength(ACTIVITY_ROW_LIMIT);
  });

  it("renders 'signed in 12 times' as one row, names a public address, and never prints ::1", () => {
    const html = render(
      h(security.SecuritySection, {
        user: { name: "Dana Owner", email: "dana@example.test", organizationName: "Acme Robotics" },
        passwordMinLength: 12,
        events,
        names: { user_1: "Demo User", user_2: "Ada Member" },
        scopedToYou: false,
      }),
    );
    expect(html).toContain("Demo User</span> signed in 12 times</p>");
    expect(html).toContain("Demo User</span> changed their password</p>");
    expect(html).toContain("Demo User</span> signed in 2 times from 203.0.113.9</p>");
    expect(html).toContain("Ada Member</span> signed in</p>");
    expect(html).not.toContain("::1");
    expect(html).not.toContain("127.0.0.1");
    expect(html).not.toContain("from unknown");
    // Only the folded rows say when the latest one happened.
    expect(html.match(/>latest </g)).toHaveLength(2);
  });
});
