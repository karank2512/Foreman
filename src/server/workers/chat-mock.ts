import type { MessageClassificationResult } from "@/server/domain";
import { describeCadence } from "@/server/domain";
import { clip, lowerFirst, plural } from "./shared";
import { money, runLine, scheduleSentence, shortDate, type RecentRun, type WorkerChatContext } from "./chat-context";

/**
 * Simulated-mode chat: a keyword classifier and a templated first-person reply built from the worker's real
 * context. Deterministic — the same message against the same facts always produces the same answer.
 */

// ── Classification ──────────────────────────────────────────────────────────

/** Interrogatives: a message that opens with one is a question even when it also contains "always" etc. */
const INTERROGATIVE_START = /^(what|why|how|when|where|who|which|whose|is|are|was|were|does|do|did|have|has|will|would|should|any|anything)\b/i;
const QUESTION_CUES = [/\?\s*$/, /\bstatus\b/i, /\bexplain\b/i, /\btell me\b/i, /\bshow me\b/i, /\bhow('s| is| are| did| many| much)\b/i];
const PERMANENT_MARKERS = [
  /\bfrom now on\b/i,
  /\balways\b/i,
  /\bgoing forward\b/i,
  /\bevery time\b/i,
  /\bevery run\b/i,
  /\bin (the )?future\b/i,
  /\bpermanently\b/i,
  /\bstop doing\b/i,
  /\bnever again\b/i,
  /\bchange (the |your )?(schedule|format|cadence|frequency|deliverable|output)\b/i,
  /\b(run|report|deliver|send)\s+(it\s+)?(hourly|daily|weekly|every (hour|day|week|monday|tuesday|wednesday|thursday|friday|saturday|sunday|morning))\b/i,
  /\bswitch to\b/i,
  /\binstead of\b.*\b(going forward|from now)\b/i,
];
const TEMPORARY_MARKERS = [
  /\bthis time\b/i,
  /\b(for |on )?(the |your )?next run\b/i,
  /\bfor now\b/i,
  /\btoday\b/i,
  /\bjust (this )?once\b/i,
  /\bone[- ]off\b/i,
  /\bone time\b/i,
  /\bthis (week|month|run)\b/i,
  /\btomorrow\b/i,
];
const IMPERATIVE_START =
  /^(please\s+)?(can you\s+|could you\s+|would you\s+|pls\s+)?(focus|include|add|skip|only|ignore|use|make|keep|exclude|prioriti[sz]e|look|find|search|send|limit|don'?t|do not|avoid|drop|remove|cover|check|double[- ]check|verify|highlight|list|rank|sort|filter|pull|grab|get|collect|gather|summari[sz]e|write|start|run|try|stick|go|stay|treat|flag|note|remember|target|aim|expand|narrow|widen|restrict|cap|increase|decrease|bump|lower|raise|set|report|deliver|produce|generate|track|monitor|watch|compare|dig|research|investigate)\b/i;

/**
 * "Can you also include the CEO's LinkedIn?" is a request phrased as a question. It is checked before the
 * question cues (a trailing "?" or an opening "would") so polite requests still change the work.
 */
const REQUEST_CUES = [
  /^(?:please\s+)?(?:can|could|would|will)\s+you\s+(?:please\s+)?(?:also\s+)?(?:please\s+)?(?:include|add|drop|remove|focus|stop|start|skip|exclude|cover|track|use|keep|limit|list|rank|sort|highlight|find|search|check|look|send|pull|grab|mention|note|flag|show|split|separate|group|prioriti[sz]e|double[- ]check|verify)\b/i,
  /\bplease (?:also )?(?:add|include)\b/i,
];
/** "Also include / add …" extends what every deliverable contains — a lasting change, not a one-off. */
const EXTENDS_DELIVERABLE = /\balso\s+(?:please\s+)?(?:include|add|cover|track|list|show)\b/i;

const some = (patterns: readonly RegExp[], text: string) => patterns.some((p) => p.test(text));

export function classifyMessageHeuristically(content: string): MessageClassificationResult["classification"] {
  const text = content.trim();
  if (some(REQUEST_CUES, text)) {
    if (some(TEMPORARY_MARKERS, text)) return "TEMPORARY_INSTRUCTION";
    return some(PERMANENT_MARKERS, text) || EXTENDS_DELIVERABLE.test(text) ? "SPEC_CHANGE" : "TEMPORARY_INSTRUCTION";
  }
  if (INTERROGATIVE_START.test(text)) return "QUESTION";
  if (some(PERMANENT_MARKERS, text)) return "SPEC_CHANGE";
  if (some(QUESTION_CUES, text)) return "QUESTION";
  if (some(TEMPORARY_MARKERS, text) || IMPERATIVE_START.test(text)) return "TEMPORARY_INSTRUCTION";
  return "QUESTION";
}

/** "Please, from now on, can you include the lead investor?" → "Include the lead investor". */
export function normalizeInstruction(content: string): string {
  let text = content.replace(/\s+/g, " ").trim();
  const leading = [
    /^(hey|hi|hello|ok|okay|thanks|thank you)[,!.\s]+/i,
    /^(please|pls)[,\s]+/i,
    /^(from now on|going forward|in (the )?future|permanently|this time|for now|today|just (this )?once|for (the |your )?next run|on (the |your )?next run|next run)[,\s]+/i,
    /^(can|could|would|will) you( please)?\s+/i,
    /^(please|pls)[,\s]+/i,
    /^also\s+/i,
    /^(i('d| would) like you to|i want you to|i need you to|make sure (you|to)|be sure to|try to)\s+/i,
  ];
  let changed = true;
  while (changed) {
    changed = false;
    for (const pattern of leading) {
      const next = text.replace(pattern, "");
      if (next !== text) {
        text = next.trim();
        changed = true;
      }
    }
  }
  text = text.replace(/[,\s]*\b(from now on|going forward|in (the )?future|permanently|this time|for now|just (this )?once|for (the |your )?next run|on (the |your )?next run)\b[,\s]*$/i, "").trim();
  text = text.replace(/[?!.\s]+$/g, "").trim();
  if (text.length === 0) return content.trim();
  return text.charAt(0).toUpperCase() + text.slice(1);
}

export function mockClassify(content: string): MessageClassificationResult {
  const classification = classifyMessageHeuristically(content);
  const reasoning =
    classification === "QUESTION"
      ? "The message asks for information rather than telling the worker to change something."
      : classification === "SPEC_CHANGE"
        ? "The message asks for a lasting change to how the worker does the job."
        : "The message asks for a one-off adjustment that applies to the next run only.";
  return {
    classification,
    confidence: classification === "QUESTION" ? 0.8 : 0.85,
    ...(classification === "QUESTION" ? {} : { normalizedInstruction: normalizeInstruction(content) }),
    reasoning,
  };
}

// ── Question replies ────────────────────────────────────────────────────────

function lastRunSentence(ctx: WorkerChatContext): string {
  const run: RecentRun | undefined = ctx.recentRuns[0];
  if (!run) return `I haven't completed a run yet${ctx.worker.nextRunAt ? " — my first one is on the calendar" : ""}.`;
  const when = shortDate(run.finishedAt ?? run.createdAt);
  switch (run.status) {
    case "SUCCEEDED": {
      const d = run.deliverable;
      if (!d) return `My last run on ${when} succeeded${run.score !== null ? ` and scored ${Math.round(run.score)}/100` : ""}.`;
      const verdict = d.status === "ACCEPTED" ? " — you accepted it" : d.status === "REJECTED" ? " — you sent it back" : "";
      return `My last run on ${when} produced “${d.title}”${run.score !== null ? ` which scored ${Math.round(run.score)}/100` : ""}${verdict}.`;
    }
    case "FAILED":
      return `My last run on ${when} failed${run.error ? ` (${clip(run.error, 90)})` : ""}.`;
    case "CANCELLED":
      return `My last run on ${when} was cancelled before it finished.`;
    case "WAITING_FOR_APPROVAL":
      return `I'm waiting on your approval to finish my current run (started ${when}).`;
    case "RUNNING":
      return `I'm in the middle of a run right now (started ${when}).`;
    case "QUEUED":
      return `I have a run queued and will start it shortly.`;
  }
}

function scoreSentence(ctx: WorkerChatContext): string {
  const m = ctx.metrics;
  if (ctx.score.score === null) return "I don't have a score yet — it appears once my first run has been evaluated.";
  const reviewed = m.accepted + m.rejected;
  const acceptance = reviewed > 0 ? ` and you've accepted ${m.accepted} of the ${plural(reviewed, "deliverable")} you reviewed` : "";
  const health = ctx.worker.health === "NEEDS_ATTENTION" && ctx.worker.healthReason ? ` I'm flagged as needing attention: ${ctx.worker.healthReason}.` : "";
  return `My current score is ${Math.round(ctx.score.score)}/100 over my last ${plural(ctx.score.sampleSize.runs, "run")}${acceptance}.${health}`;
}

function costSentence(ctx: WorkerChatContext): string {
  const m = ctx.metrics;
  const estimate = `my design estimate is ${money(ctx.blueprint.costEstimate.perRunUsd)} per run (about ${money(ctx.blueprint.costEstimate.monthlyUsd)} a month at this schedule)`;
  if (m.runs === 0) return `I haven't spent anything yet; ${estimate}.`;
  return `Over the last ${m.windowDays} days I've cost ${money(m.totalCostUsd)} across ${plural(m.runs, "run")}${m.avgCostPerRunUsd !== null ? ` — about ${money(m.avgCostPerRunUsd)} per run` : ""}; ${estimate}.`;
}

function roleSentence(ctx: WorkerChatContext): string {
  const top = ctx.spec.responsibilities.slice(0, 3).map((r) => r.replace(/\.$/, "").trim());
  return `I'm ${ctx.worker.name}, ${ctx.worker.title} on “${ctx.jobTitle}”. ${ctx.spec.objective.trim().replace(/\.?$/, ".")} Each run I deliver a ${ctx.spec.deliverable.title}; day to day that means ${top.join(", ").replace(/^(.)/, (c) => c.toLowerCase())}.`;
}

function toolsSentence(ctx: WorkerChatContext): string {
  const t = ctx.blueprint.tools;
  if (t.length === 0) return "I don't use any external tools — everything I produce comes from the inputs I'm given.";
  const gated = t.filter((x) => x.requiresApproval).map((x) => x.toolName);
  return `I can use ${t.map((x) => x.toolName).join(", ")}${gated.length > 0 ? `; ${gated.join(" and ")} always ${gated.length === 1 ? "needs" : "need"} your approval first` : ""}.`;
}

function failuresSentence(ctx: WorkerChatContext): string {
  const failed = ctx.recentRuns.filter((r) => r.status === "FAILED");
  if (failed.length === 0) return `None of my last ${plural(ctx.recentRuns.length, "run")} failed.`;
  const errors = [...new Set(failed.map((r) => r.error).filter((e): e is string => !!e))].slice(0, 2);
  return `${failed.length} of my last ${plural(ctx.recentRuns.length, "run")} failed${errors.length > 0 ? ` — ${errors.map((e) => `“${clip(e, 90)}”`).join(" and ")}` : ""}.`;
}

function listed(items: readonly string[]): string {
  return items.length <= 1 ? (items[0] ?? "") : `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}

/** How the worker goes about the job, from its design — the part of "why these sources?" that never changes. */
function approachSentence(ctx: WorkerChatContext): string {
  const collector = ctx.blueprint.components.find((c) => c.type === "agent" && c.outputFormat === "json");
  const toolsUsed = collector?.type === "agent" ? collector.tools : [];
  if (toolsUsed.includes("read_dataset")) return "I work from the records your workspace provides rather than the open web, and I label every item myself instead of sampling.";
  if (toolsUsed.includes("web_search") && toolsUsed.includes("fetch_url")) {
    return "I start from a couple of focused searches and open the most relevant results myself, so every record traces back to a page I actually read — announcements and companies' own pages over aggregators.";
  }
  if (toolsUsed.includes("web_search")) return "I work from web search results for the brief and keep only what the results actually state.";
  return "I work only from the inputs I'm given for each run.";
}

/** What the last finished run actually did: searches, pages and hosts read, and what survived validation. */
function methodSentence(ctx: WorkerChatContext): string {
  const m = ctx.lastRunMethod;
  if (!m) return `${approachSentence(ctx)} I haven't finished a run yet, so there are no sources to show you.`;
  const parts: string[] = [];
  if (m.searches.length > 0) {
    const quoted = m.searches.slice(0, 2).map((q) => `“${clip(q, 60)}”`);
    parts.push(`searched the web ${m.searches.length === 1 ? "once" : m.searches.length === 2 ? "twice" : `${m.searches.length} times`} (${listed(quoted)}${m.searches.length > 2 ? " and more" : ""})`);
  }
  if (m.pagesRead > 0) parts.push(`read ${plural(m.pagesRead, "page")}${m.hosts.length > 0 ? ` on ${listed(m.hosts.slice(0, 3))}` : ""}`);
  if (m.datasets.length > 0) parts.push(`read the ${listed(m.datasets.map((d) => d.replace(/_/g, " ")))} dataset${m.datasets.length === 1 ? "" : "s"}`);
  if (m.extractions > 0) parts.push("pulled structured records out of what I read");
  if (m.collected !== null && m.kept !== null) {
    parts.push(`kept ${m.kept} of ${plural(m.collected, "record")} after validation${m.checks.includes("dedupe") ? " and de-duplication" : ""}`);
  } else if (m.delivered !== null) {
    parts.push(`delivered ${plural(m.delivered, "record")}`);
  }
  const did = parts.length > 0 ? ` On my last run (${shortDate(m.at)}) I ${listed(parts)}.` : "";
  return `${approachSentence(ctx)}${did}`;
}

function instructionsSentence(ctx: WorkerChatContext): string | null {
  if (ctx.activeInstructions.length === 0) return null;
  return `For my next run I'm holding ${plural(ctx.activeInstructions.length, "one-off instruction")}: ${ctx.activeInstructions.map((i) => `“${clip(i, 100)}”`).join("; ")}.`;
}

function recentRunsSentence(ctx: WorkerChatContext): string | null {
  if (ctx.recentRuns.length < 2) return null;
  return `Before that: ${ctx.recentRuns.slice(1, 4).map(runLine).join(" — ")}.`;
}

const METHOD_QUESTION =
  /\b(?:sources?|method|methodology|how did you (?:find|pick|choose|get|decide|research|come up)|how do you (?:find|pick|choose|decide|research|work|go about)|where did (?:you|this|these|that|it|they)|where do (?:you|these|they) come from|why did you (?:pick|choose|use|select|include|go with|rank)|why (?:these|those|this|that) (?:sources?|companies|sites|pages|results|records|leads)|picked|chose)\b/;

/** First-person answer assembled from the facts the question touches; a general status when nothing matches. */
export function mockQuestionReply(ctx: WorkerChatContext, question: string): string {
  const q = question.toLowerCase();
  const parts: string[] = [];
  const add = (s: string | null) => {
    if (s && !parts.includes(s)) parts.push(s);
  };

  if (METHOD_QUESTION.test(q)) add(methodSentence(ctx));
  if (/\b(cost|spend|spent|budget|expensive|price|pricing|bill)\b/.test(q)) add(costSentence(ctx));
  if (/\b(schedule|scheduled|when|next run|cadence|how often|frequency|calendar)\b/.test(q)) add(scheduleSentence(ctx));
  if (/\b(score|quality|performance|performing|how are you doing|health|review|rating|good job|well)\b/.test(q)) add(scoreSentence(ctx));
  if (/\b(what do you do|responsib|your job|your role|what are you|goal|objective|task|describe yourself|who are you|introduce)\b/.test(q)) add(roleSentence(ctx));
  if (/\b(tool|tools|access|permission|permissions|allowed)\b/.test(q)) add(toolsSentence(ctx));
  if (/\b(fail|failed|failure|error|errors|wrong|problem|problems|issue|issues|broke|broken|crash)\b/.test(q)) add(failuresSentence(ctx));
  if (/\b(deliverable|report|output|produce|produced|last run|latest|recent|result|results|find|found)\b/.test(q)) {
    add(lastRunSentence(ctx));
    add(recentRunsSentence(ctx));
  }
  if (/\b(instruction|instructions|remember|told you|asked you)\b/.test(q)) add(instructionsSentence(ctx) ?? "I have no one-off instructions waiting; I'll follow my standing brief on the next run.");

  if (parts.length === 0) {
    add(lastRunSentence(ctx));
    add(scheduleSentence(ctx));
    if (ctx.score.score !== null) add(scoreSentence(ctx));
    add(instructionsSentence(ctx));
  }
  return parts.join(" ");
}

/** Templated acknowledgement for a one-off instruction (both modes — nothing here needs a model). */
export function temporaryInstructionReply(ctx: WorkerChatContext, instruction: string): string {
  const others = ctx.activeInstructions.length;
  const next =
    ctx.worker.status === "PAUSED"
      ? "I'm paused at the moment, so it takes effect on the first run after I'm resumed."
      : ctx.worker.nextRunAt
        ? `My next run is ${lowerFirst(describeCadence(ctx.cadence))} — ${shortDate(ctx.worker.nextRunAt)} — or start one now and I'll use it right away.`
        : "I don't have a scheduled run, so start one with “Run now” whenever you're ready and I'll use it then.";
  const holding = others > 0 ? ` I'm also holding ${plural(others, "other one-off instruction")} for that run.` : "";
  return `Got it — I'll apply this on my next run: “${clip(instruction, 200)}”. ${next}${holding}`;
}

/**
 * Templated reply when a spec change was turned into a proposed version. The link to the proposal travels in the
 * message metadata and renders as a card under the bubble, so the prose never quotes a path or an id.
 */
export function specChangeReply(args: {
  ctx: WorkerChatContext;
  version: number;
  changes: readonly string[];
  perRunBefore: number;
  perRunAfter: number;
}): string {
  const { ctx } = args;
  const cost =
    Math.abs(args.perRunAfter - args.perRunBefore) < 0.0005
      ? `The estimated cost stays around ${money(args.perRunAfter)} per run.`
      : `The estimated cost moves from ${money(args.perRunBefore)} to ${money(args.perRunAfter)} per run.`;
  const changes = args.changes.length > 0 ? ` What changes: ${args.changes.join("; ")}.` : "";
  return `That changes how I work, so rather than changing anything on my own I've drafted version ${args.version} for your approval.${changes} ${cost} Compare the two versions and apply the change when you're ready; until then I keep working as ${ctx.worker.name} v${ctx.versionNumber}.`;
}
