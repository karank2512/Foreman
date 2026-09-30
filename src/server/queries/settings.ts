import type { UserRole } from "@prisma/client";
import { config } from "@/server/config";
import { db } from "@/server/db";
import { llm } from "@/server/models";
import { KNOWN_CREDENTIALS, listCredentials } from "@/server/secrets";
import { tools } from "@/server/tools";
import { permissionSubset, SETTINGS_PERMISSION_KEYS, type SettingsPermissions } from "./permissions";

export interface SettingsWorkspace {
  organizationName: string;
  organizationSlug: string;
  /** ISO */
  createdAt: string;
  memberCount: number;
  members: Array<{ id: string; name: string; email: string; role: "OWNER" | "ADMIN" | "MEMBER" }>;
}

export interface SettingsProvider {
  id: string;
  label: string;
  available: boolean;
  /** null for the built-in simulator, and for everyone but the owner (see `operator`). */
  envVar: string | null;
}

export interface SettingsTierRoute {
  tier: "fast" | "standard" | "reasoning";
  provider: string;
  providerLabel: string;
  model: string;
  simulated: boolean;
  /** Env var that can override this tier's route; null for everyone but the owner (see `operator`). */
  overrideEnvVar: string | null;
}

export interface SettingsProviders {
  mode: "live" | "simulated";
  /** FORCE_SIMULATED is set — keys are ignored on purpose. */
  forceSimulated: boolean;
  /** The demo workspace, which always runs on the simulator whatever keys the server has. */
  demoWorkspace: boolean;
  providers: SettingsProvider[];
  tiers: SettingsTierRoute[];
}

export interface SettingsCredential {
  name: string;
  label: string;
  docsUrl: string;
  /** Tools that switch from Simulated to Live when this key resolves. */
  usedBy: Array<{ name: string; displayName: string }>;
  /** Where the current value comes from: the workspace vault, the server's .env, or nowhere. */
  source: "workspace" | "environment" | null;
  /** What tools will actually do right now: a key only goes live when the platform itself is live. */
  effective: "live" | "simulated";
  /** Vault metadata (never the value). null when the key is not stored in the vault. */
  stored: { last4: string; label: string | null; setAt: string; lastUsedAt: string | null } | null;
}

export interface SettingsExecutor {
  enabled: boolean;
  pollMs: number;
  concurrency: number;
  staleLockMs: number;
  schedulerTickMs: number;
}

export interface SettingsPageData {
  workspace: SettingsWorkspace;
  providers: SettingsProviders;
  credentials: SettingsCredential[];
  /**
   * Platform-operator configuration: executor tuning, the billing markup and the env var names behind the
   * providers. Commercially sensitive and useless to a tenant, so it is OMITTED (null) for anyone below OWNER
   * (audit INF-19). Callers pass `session.role`; without one, nobody sees it.
   */
  operator: { executor: SettingsExecutor; billing: { marginMultiplier: number } } | null;
  permissions: SettingsPermissions;
}

const TIER_OVERRIDE_ENV: Record<SettingsTierRoute["tier"], string> = {
  fast: "MODEL_TIER_FAST",
  standard: "MODEL_TIER_STANDARD",
  reasoning: "MODEL_TIER_REASONING",
};

const ROLE_ORDER: Record<SettingsWorkspace["members"][number]["role"], number> = { OWNER: 0, ADMIN: 1, MEMBER: 2 };

/** Mirrors the vault's env fallback without touching `lastUsedAt` (resolveSecret would). */
function envHasValue(name: string): boolean {
  const value = process.env[name];
  return value !== undefined && value.trim() !== "";
}

export async function getSettingsPage(organizationId: string, opts: { role?: UserRole } = {}): Promise<SettingsPageData> {
  const permissions = permissionSubset(opts.role, SETTINGS_PERMISSION_KEYS);
  const isOperator = permissions["org.manage"];
  const [organization, members, stored] = await Promise.all([
    db.organization.findUniqueOrThrow({ where: { id: organizationId }, select: { name: true, slug: true, createdAt: true, isDemo: true } }),
    db.user.findMany({ where: { organizationId }, select: { id: true, name: true, email: true, role: true }, orderBy: { createdAt: "asc" } }),
    listCredentials(organizationId),
  ]);

  const status = llm.status();
  const providerLabels = new Map(status.providers.map((p) => [p.id as string, p.label]));
  const simulatedMode = status.mode === "simulated" || organization.isDemo;
  const storedByName = new Map(stored.map((c) => [c.name, c]));

  return {
    workspace: {
      organizationName: organization.name,
      organizationSlug: organization.slug,
      createdAt: organization.createdAt.toISOString(),
      memberCount: members.length,
      members: members
        .map((m) => ({ id: m.id, name: m.name, email: m.email, role: m.role }))
        .sort((a, b) => ROLE_ORDER[a.role] - ROLE_ORDER[b.role] || a.name.localeCompare(b.name)),
    },
    providers: {
      mode: status.mode,
      forceSimulated: config.forceSimulated,
      demoWorkspace: organization.isDemo,
      providers: status.providers.map((p) => ({ id: p.id, label: p.label, available: p.available, envVar: isOperator ? p.envVar : null })),
      tiers: (Object.keys(TIER_OVERRIDE_ENV) as SettingsTierRoute["tier"][]).map((tier) => {
        const route = status.tiers[tier];
        return {
          tier,
          provider: route.provider,
          providerLabel: providerLabels.get(route.provider) ?? route.provider,
          model: route.model,
          simulated: route.provider === "mock",
          overrideEnvVar: isOperator ? TIER_OVERRIDE_ENV[tier] : null,
        };
      }),
    },
    credentials: KNOWN_CREDENTIALS.map((known) => {
      const row = storedByName.get(known.name);
      const source: SettingsCredential["source"] = row ? "workspace" : envHasValue(known.name) ? "environment" : null;
      return {
        name: known.name,
        label: known.label,
        docsUrl: known.docsUrl,
        usedBy: known.usedBy.map((name) => ({ name, displayName: tools.get(name)?.displayName ?? name })),
        source,
        effective: source !== null && !simulatedMode ? "live" : "simulated",
        stored: row ? { last4: row.last4, label: row.label, setAt: row.createdAt, lastUsedAt: row.lastUsedAt } : null,
      };
    }),
    operator: isOperator
      ? {
          executor: {
            enabled: !config.executor.disabled,
            pollMs: config.executor.pollMs,
            concurrency: config.executor.concurrency,
            staleLockMs: config.executor.staleLockMs,
            schedulerTickMs: config.executor.schedulerTickMs,
          },
          billing: { marginMultiplier: config.usage.marginMultiplier },
        }
      : null,
    permissions,
  };
}
