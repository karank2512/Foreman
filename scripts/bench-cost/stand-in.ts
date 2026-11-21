import type { DeterministicComponent, WorkerBlueprint } from "@/server/domain";
import type { MockTextResponse } from "@/server/models";
import { buildInitialMessage } from "@/server/runtime";
import { simulation, type MockAgentTurnInput } from "@/server/simulation";
import { runChain } from "./fidelity";

/**
 * SIMULATED MODE ONLY. Foreman's mock brain picks a role from a component's shape: a JSON agent with no tools is
 * played as a collector (it would re-invent fixture records) and a Markdown agent as an analyst. Neither does what
 * a converted mechanical step is asked to do, so a baseline would be measured on the wrong output.
 *
 * This stand-in answers those steps instead, from the exact message a real model would receive: it reads the inputs
 * back out of that message and returns what the deterministic code returns for them (for a merged agent, its steps
 * run in order). In other words it plays a model that performs the step perfectly, in one turn, with no reasoning
 * tokens. Foreman's mock provider still counts the tokens (prompt in, answer out) and Foreman's pricing and metering
 * still price and record them — the stand-in only decides the answer text.
 *
 * It never runs live: the mock producer is only consulted when a call routes to the mock provider.
 */

const INTRO = "Here is everything you need for this run.";
const MISSING = "(not available for this run)";
const EMPTY = "(empty)";
const JSON_OPEN = "```json\n";
const JSON_CLOSE = "\n```";

interface StandIn {
  /** The Foreman steps this converted agent performs, in order (one, or a merged chain). */
  originals: DeterministicComponent[];
  personaName: string;
  pipeline: string[];
}

/** A baseline worker and, per converted agent id, the deterministic steps of Foreman's worker it replaces. */
export interface StandInBaseline {
  blueprint: WorkerBlueprint;
  converted: ReadonlyMap<string, readonly DeterministicComponent[]>;
}

export interface StandInStats {
  answered: number;
  fellBack: number;
}

type Decoded = { ok: true; value: unknown } | { ok: false };

function decode(body: string): Decoded {
  if (body === MISSING) return { ok: true, value: undefined };
  if (body === EMPTY) return { ok: true, value: "" };
  // Something that opens like a JSON block but is not exactly one is ambiguous: refuse rather than guess.
  if (body.startsWith(JSON_OPEN)) {
    if (!body.endsWith(JSON_CLOSE)) return { ok: false };
    try {
      return { ok: true, value: JSON.parse(body.slice(JSON_OPEN.length, -JSON_CLOSE.length)) };
    } catch {
      return { ok: false };
    }
  }
  return { ok: true, value: body };
}

/**
 * Inverse of runtime's buildInitialMessage: `## <key>` sections in inputKeys order. Accepted only when rendering the
 * parsed values again reproduces the message byte for byte.
 */
export function parseInitialMessage(message: string, inputKeys: readonly string[]): Record<string, unknown> | null {
  if (!message.startsWith(INTRO)) return null;
  const context: Record<string, unknown> = {};
  let cursor = INTRO.length;
  for (let i = 0; i < inputKeys.length; i++) {
    const header = `\n\n## ${inputKeys[i]}\n`;
    if (message.indexOf(header, cursor) !== cursor) return null;
    const bodyStart = cursor + header.length;
    const end = i + 1 < inputKeys.length ? message.indexOf(`\n\n## ${inputKeys[i + 1]}\n`, bodyStart) : message.length;
    if (end < 0) return null;
    const decoded = decode(message.slice(bodyStart, end));
    if (!decoded.ok) return null;
    context[inputKeys[i]] = decoded.value;
    cursor = end;
  }
  if (cursor !== message.length) return null;
  return buildInitialMessage({ inputKeys: [...inputKeys] }, context) === message ? context : null;
}

function answer(entry: StandIn, input: MockAgentTurnInput): string | null {
  // One turn, like the code it replaces. A repair turn (or anything unexpected) goes to the regular mock brain.
  const first = input.messages[0];
  if (input.messages.length !== 1 || first?.role !== "user") return null;
  const context = parseInitialMessage(first.content, input.component.inputKeys);
  if (!context) return null;
  const value = runChain(entry.originals, context, {
    personaName: entry.personaName,
    now: new Date(),
    pipeline: entry.pipeline,
    // A model is not told which tools ran or how many records each cleaning step dropped.
    toolUsage: [],
    recordTrail: [],
  });
  // Compact JSON: the cheapest answer a model could give, so the baseline's cost stays a floor.
  return typeof value === "string" ? value : JSON.stringify(value);
}

/**
 * Install the stand-in for the converted agents of every baseline. Returns the counters and an uninstall function;
 * always uninstall in a finally.
 */
export function installStandIns(baselines: readonly StandInBaseline[]): { stats: StandInStats; uninstall: () => void } {
  // Keyed by id AND instructions: only a component that is exactly a converted step is ever answered.
  const entries = new Map<string, StandIn>();
  const key = (id: string, instructions: string) => `${id}\n${instructions}`;
  for (const { blueprint, converted } of baselines) {
    const pipeline = blueprint.components.map((c) => c.name);
    for (const component of blueprint.components) {
      const originals = converted.get(component.id);
      if (component.type !== "agent" || !originals) continue;
      entries.set(key(component.id, component.instructions), { originals: [...originals], personaName: blueprint.persona.name, pipeline });
    }
  }

  const stats: StandInStats = { answered: 0, fellBack: 0 };
  const regular = simulation.agentTurn;
  simulation.agentTurn = (input: MockAgentTurnInput): MockTextResponse => {
    const entry = entries.get(key(input.component.id, input.component.instructions));
    if (!entry) return regular(input);
    const text = answer(entry, input);
    if (text === null) {
      stats.fellBack += 1;
      return regular(input);
    }
    stats.answered += 1;
    return { text };
  };
  return {
    stats,
    uninstall: () => {
      simulation.agentTurn = regular;
    },
  };
}
