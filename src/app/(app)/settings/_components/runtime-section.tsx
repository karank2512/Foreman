import { CopyButton } from "@/components/copy-button";
import { formatDuration, pluralize } from "@/lib/format";
import type { SettingsExecutor } from "@/server/queries/settings";
import { Mono, OperatorNotes, SettingsGroup, SettingsRow, SettingsValue, StatusLine } from "./settings-list";

const SEED_COMMAND = "npm run db:seed:demo";

export interface RuntimeSectionProps {
  /** Executor tuning is platform-operator config: null for anyone below OWNER (audit INF-19). */
  executor: SettingsExecutor | null;
  /** Only the demo workspace has demo data to put back, and only outside production. */
  showDemoData: boolean;
}

/**
 * The background loop that picks queued runs up, and the one way to put the demo back how it was. Written
 * for the workspace owner; the env vars and the command live in the operator notes.
 */
export function RuntimeSection({ executor, showDemoData }: RuntimeSectionProps) {
  return (
    <div className="space-y-10">
      {executor ? (
        <SettingsGroup
          title="Background worker"
          description="The loop that picks up queued runs and fires scheduled ones."
          footer="Set on the server for the whole platform, so every workspace keeps the same pace."
        >
          <SettingsRow
            label={executor.enabled ? "Picking up work" : "Paused"}
            hint={
              executor.enabled
                ? "Queued runs start on their own, and schedules fire on time."
                : "Runs queue up but nothing claims them until the worker is switched back on."
            }
          >
            <StatusLine tone={executor.enabled ? "success" : "attention"}>
              {executor.enabled ? "Running" : "Paused"}
            </StatusLine>
          </SettingsRow>
          <SettingsRow label="Checks for work">
            <SettingsValue className="metric">every {formatDuration(executor.pollMs)}</SettingsValue>
          </SettingsRow>
          <SettingsRow label="Runs at once">
            <SettingsValue className="metric">{pluralize(executor.concurrency, "run")}</SettingsValue>
          </SettingsRow>
          <SettingsRow label="Checks schedules">
            <SettingsValue className="metric">every {formatDuration(executor.schedulerTickMs)}</SettingsValue>
          </SettingsRow>
          <SettingsRow label="Recovers a stuck run" hint="A run whose worker died is handed back to the queue.">
            <SettingsValue className="metric">
              after {formatDuration(executor.staleLockMs)} of silence
            </SettingsValue>
          </SettingsRow>
        </SettingsGroup>
      ) : (
        <p className="text-footnote max-w-[62ch] text-pretty text-muted-foreground px-1">
          The background worker is set up on the server by whoever runs the platform.
        </p>
      )}

      {showDemoData ? (
        <SettingsGroup
          title="Demo data"
          description="Three workers with three weeks of history, ready to hire, review and replace."
          footer="Starting over removes the runs, deliverables, reviews and usage added since the demo was set up, and any tool keys saved here. Nobody is signed out."
        >
          <SettingsRow
            label="Start the demo over"
            hint="Puts the three workers and their history back the way they began. Whoever runs the server does this from the server."
          />
        </SettingsGroup>
      ) : null}

      {executor || showDemoData ? (
        <OperatorNotes>
          {executor ? (
            <p>
              Tune the worker with <Mono>EXECUTOR_POLL_MS</Mono>, <Mono>EXECUTOR_CONCURRENCY</Mono>,{" "}
              <Mono>SCHEDULER_TICK_MS</Mono> and <Mono>EXECUTOR_STALE_LOCK_MS</Mono>; set{" "}
              <Mono>EXECUTOR_DISABLED=true</Mono> to pause it.
            </p>
          ) : null}
          {showDemoData ? (
            <p className="flex flex-wrap items-center gap-x-2 gap-y-1">
              <span>To start the demo over, run this from a terminal in the project folder:</span>
              <span className="inline-flex items-center gap-1.5 rounded-lg bg-muted py-1 pr-1 pl-2.5">
                <Mono>{SEED_COMMAND}</Mono>
                <CopyButton value={SEED_COMMAND} />
              </span>
            </p>
          ) : null}
        </OperatorNotes>
      ) : null}
    </div>
  );
}
