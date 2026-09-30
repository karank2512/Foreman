import type { SettingsProviders, SettingsTierRoute } from "@/server/queries/settings";
import { Mono, OperatorNotes, SettingsGroup, SettingsRow, SettingsValue, StatusLine } from "./settings-list";

const TIER: Record<SettingsTierRoute["tier"], { label: string; hint: string }> = {
  fast: { label: "Fast", hint: "Scoping questions, classification and quick extraction." },
  standard: { label: "Standard", hint: "Collecting, analysis, evaluation and performance reviews." },
  reasoning: { label: "Reasoning", hint: "Replacement plans and the other hard calls." },
};

export interface ProvidersSectionProps {
  providers: SettingsProviders;
  /** OWNER: the operator notes (env var names and the like). False for everyone else (audit INF-19). */
  operator: boolean;
}

/** "ANTHROPIC_API_KEY, OPENAI_API_KEY and GOOGLE_GENERATIVE_AI_API_KEY", as mono spans. */
function MonoList({ names }: { names: string[] }) {
  return (
    <>
      {names.map((name, i) => (
        <span key={name}>
          {i > 0 ? (i === names.length - 1 ? " and " : ", ") : ""}
          <Mono>{name}</Mono>
        </span>
      ))}
    </>
  );
}

/**
 * Which models the workforce thinks with. Read-only everywhere: provider keys live in the server's
 * environment, never in the database, so this page reports rather than configures. The page speaks to the
 * workspace owner; the env-var detail an operator needs is folded into the notes at the end.
 */
export function ProvidersSection({ providers, operator }: ProvidersSectionProps) {
  const live = providers.mode === "live";
  // The demo workspace never spends a key (see isOrgSimulated in @/server/models), so it says so instead of "Live".
  const demoOnKeys = live && providers.demoWorkspace;
  const keyVars = providers.providers.map((p) => p.envVar).filter((v): v is string => v !== null);
  const tierVars = providers.tiers.map((t) => t.overrideEnvVar).filter((v): v is string => v !== null);

  return (
    <div className="space-y-10">
      <SettingsGroup title="Mode">
        {demoOnKeys ? (
          <SettingsRow
            label="The demo workspace always uses the built-in simulator"
            hint="A provider key is set, but the demo never spends it. Create your own workspace to hire workers who think with real models."
          >
            <StatusLine tone="idle">Simulated</StatusLine>
          </SettingsRow>
        ) : (
          <SettingsRow
            label={live ? "Workers think with real models" : "Workers think with the built-in simulator"}
            hint={
              live
                ? "At least one provider has a key, so every run costs real money, billed by that provider."
                : "No provider has a key, so answers come from the deterministic simulator. Everything else — runs, deliverables, reviews, costs — works end to end."
            }
          >
            <StatusLine tone={live ? "success" : "idle"}>{live ? "Live" : "Simulated"}</StatusLine>
          </SettingsRow>
        )}
      </SettingsGroup>

      <SettingsGroup
        title="Providers"
        footer={
          live
            ? "Provider keys live in the .env file of the server running Foreman, not in this workspace. Whoever runs it can add or swap one there."
            : "Add a provider key to go live. Keys go in the .env file of the server running Foreman, not in this workspace, and usage is billed to that key."
        }
      >
        {providers.providers.map((provider) => (
          <SettingsRow key={provider.id} label={provider.label}>
            <StatusLine tone={provider.available ? "success" : "idle"}>
              {provider.available ? (provider.id === "mock" ? "Built in" : "Key set") : "No key"}
            </StatusLine>
          </SettingsRow>
        ))}
      </SettingsGroup>

      <SettingsGroup title="Tier routing" description="Every model call names a tier; this is where each one lands today.">
        {providers.tiers.map((tier) => (
          <SettingsRow key={tier.tier} label={TIER[tier.tier].label} hint={TIER[tier.tier].hint}>
            <span className="flex flex-wrap items-center gap-2">
              <SettingsValue>{tier.providerLabel}</SettingsValue>
              <Mono>{tier.model}</Mono>
            </span>
          </SettingsRow>
        ))}
      </SettingsGroup>

      {providers.forceSimulated && operator ? (
        <p className="text-footnote max-w-[62ch] text-pretty text-muted-foreground px-1">
          This server is set to stay simulated, so any provider keys are ignored on purpose — handy for demos
          and rehearsals. Whoever runs the platform can switch that off.
        </p>
      ) : null}

      {operator ? (
        <OperatorNotes>
          <p>
            Keys are read from <Mono>.env</Mono> when Foreman starts: put one of <MonoList names={keyVars} /> in it,
            then restart (<Mono>docker compose up</Mono>, or <Mono>npm run dev</Mono>). The first available provider
            serves every tier unless a tier override says otherwise.
          </p>
          <p>
            Check a key before a real run with <Mono>npm run smoke:live</Mono>, or on Docker{" "}
            <Mono>docker compose run --rm --no-deps --entrypoint node web dist/smoke-live.cjs</Mono>. It makes one tiny call per
            model the key would serve.
          </p>
          <p>
            Route a single tier with <MonoList names={tierVars} />, for example{" "}
            <Mono>MODEL_TIER_STANDARD=anthropic:claude-sonnet-5</Mono>. Rehearse without spending by setting{" "}
            <Mono>FORCE_SIMULATED=true</Mono> while the keys stay in place
            {providers.forceSimulated ? " — it is set right now; unset it to use the keys." : "."}
          </p>
        </OperatorNotes>
      ) : null}
    </div>
  );
}
