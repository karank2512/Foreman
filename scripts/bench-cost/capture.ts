import { db } from "@/server/db";
import type { WorkerBlueprint } from "@/server/domain";
import { llm } from "@/server/models";
import { emptyCheckpoint, type RunCheckpoint } from "@/server/runtime";
import { agentOutput } from "./fidelity";

/**
 * Pairing support: what a run's agents answered, and how a baseline run starts from the AFTER run's collector.
 *
 * The run context overwrites `records` at every record step, and Foreman's traces clip long text, so neither keeps
 * the collector's full answer. The tap below keeps it: it wraps llm.generateText (the one entry point every model
 * call goes through) and copies the answer text of watched runs' agent turns. It only observes — the request,
 * routing, metering and result are untouched — and it works the same live and simulated.
 */

export interface AnswerTap {
  watch(runId: string): void;
  /** The final answer text of every agent component of a watched run (its last successful model turn). */
  finalAnswers(organizationId: string, runId: string): Promise<Map<string, string>>;
  uninstall(): void;
}

export function installAnswerTap(): AnswerTap {
  const watched = new Set<string>();
  const texts = new Map<string, string>();
  const original = llm.generateText;
  llm.generateText = async (req, tracking) => {
    const result = await original.call(llm, req, tracking);
    if (tracking.purpose === "agent.turn" && tracking.runId && tracking.runStepId && watched.has(tracking.runId)) texts.set(tracking.runStepId, result.text);
    return result;
  };
  return {
    watch: (runId) => {
      watched.add(runId);
    },
    async finalAnswers(organizationId, runId) {
      const steps = await db.runStep.findMany({
        where: { runId, run: { organizationId }, kind: "MODEL_CALL", status: "SUCCEEDED", componentId: { not: null } },
        orderBy: { index: "asc" },
        select: { id: true, componentId: true },
      });
      const answers = new Map<string, string>();
      // In index order, so a component's last turn (its answer, or the repaired answer) wins.
      for (const step of steps) {
        const text = texts.get(step.id);
        if (text !== undefined && step.componentId) answers.set(step.componentId, text);
      }
      return answers;
    },
    uninstall: () => {
      llm.generateText = original;
    },
  };
}

const isRecord = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);

/** The run context as the run left it (Run.checkpoint is written at every component boundary and at the end). */
export async function finalContext(organizationId: string, runId: string): Promise<Record<string, unknown> | null> {
  const run = await db.run.findFirst({ where: { id: runId, organizationId }, select: { checkpoint: true } });
  const checkpoint = run?.checkpoint;
  return isRecord(checkpoint) && isRecord(checkpoint.context) ? checkpoint.context : null;
}

/**
 * How many leading components every baseline shares with AFTER: everything before AFTER's first code step (for the
 * funding tracker: the collector). Those run once per pair, in AFTER, and are replayed into the baselines.
 */
export function sharedPrefixLength(after: WorkerBlueprint, baselines: readonly WorkerBlueprint[]): number {
  const firstCode = after.components.findIndex((c) => c.type === "deterministic");
  const length = firstCode < 0 ? 0 : firstCode;
  for (const bp of baselines) {
    for (let i = 0; i < length; i++) {
      if (JSON.stringify(bp.components[i]) !== JSON.stringify(after.components[i])) {
        throw new Error(`Baseline component ${i} (${bp.components[i]?.id ?? "missing"}) differs from Foreman's, so it cannot share the collector.`);
      }
    }
  }
  return length;
}

export type Replay = { ok: true; context: Record<string, unknown> } | { ok: false; note: string };

/** The context the shared components produced in the AFTER run, rebuilt from their answers exactly as the runtime parsed them. */
export function replayContext(after: WorkerBlueprint, prefixLength: number, answers: ReadonlyMap<string, string>): Replay {
  const context: Record<string, unknown> = {};
  for (const component of after.components.slice(0, prefixLength)) {
    if (component.type !== "agent") return { ok: false, note: `shared component ${component.id} is not an agent` };
    const text = answers.get(component.id);
    if (text === undefined) return { ok: false, note: `no answer from ${component.id} was captured (did the AFTER run finish it?)` };
    const output = agentOutput(component, text);
    if (!output.ok) return { ok: false, note: `${component.id}'s answer could not be parsed: ${output.error}` };
    context[component.outputKey] = output.value;
  }
  return { ok: true, context };
}

/** A queued run's checkpoint that starts at `componentIndex` with `context` already in place (the runtime seeds job_brief / instructions). */
export function replayCheckpoint(componentIndex: number, context: Record<string, unknown>): RunCheckpoint {
  const checkpoint = emptyCheckpoint(JSON.parse(JSON.stringify(context)) as Record<string, unknown>);
  checkpoint.componentIndex = componentIndex;
  return checkpoint;
}
