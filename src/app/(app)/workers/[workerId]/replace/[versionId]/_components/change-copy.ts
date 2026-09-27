import { sentenceCase } from "@/lib/format";
import type { BlueprintDiffEntry, ModelTier } from "@/server/domain";
import { exampleTitle, formatLabel, operationLabel } from "../../../_components/labels";
import { TIER_LABELS } from "../../../_tabs/versions-labels";

/**
 * Plain-terms copy for the "Every difference" list. The blueprint diff describes a step the way the runtime sees
 * it (`validate records · {"requiredFields":[…]} · writes records`); a manager deciding on a replacement should
 * read what the step does ("Drops records missing company, stage or source URL"). Entries are recognised by
 * their dot `path`, which is the diff's stable contract; anything unrecognised passes through unchanged. Pure.
 */

export interface ChangeCopyContext {
  /** Tool registry name → display name ("web_search" → "Web search"), from both versions' tool lists. */
  toolNames: Readonly<Record<string, string>>;
}

type Config = Record<string, unknown>;

/** "amount_usd" → "amount USD", "source_url" → "source URL"; acronyms keep their capitals. */
function field(name: string): string {
  const words = sentenceCase(name);
  return /^[A-Z0-9]{2,}\b/.test(words) ? words : words.charAt(0).toLowerCase() + words.slice(1);
}

function joined(items: readonly string[], last: "and" | "or"): string {
  if (items.length <= 1) return items.join("");
  return `${items.slice(0, -1).join(", ")} ${last} ${items[items.length - 1]}`;
}

const strings = (value: unknown): string[] => (Array.isArray(value) ? value.map(String) : []);

const FILTER_OPS: Record<string, string> = {
  eq: "is",
  neq: "is not",
  gt: "is over",
  gte: "is at least",
  lt: "is under",
  lte: "is at most",
  contains: "contains",
};

/** Which deterministic operation a bare config belongs to, from its keys (a `.config` entry carries no operation). */
function inferOperation(config: Config): string | null {
  if ("keyFields" in config) return "dedupe";
  if ("requiredFields" in config) return "validate_records";
  if ("by" in config && "direction" in config) return "rank";
  if ("field" in config && "op" in config) return "filter";
  if ("numericFields" in config) return "compute_stats";
  if ("sections" in config) return "compile_report";
  if ("columns" in config) return "to_csv";
  return null;
}

/** What a deterministic step does with its settings, as one sentence. */
export function describeStepConfig(operation: string | null, config: Config): string {
  const op = operation ?? inferOperation(config);
  switch (op) {
    case "dedupe":
      return `Removes duplicates by ${joined(strings(config.keyFields).map(field), "and")}`;
    case "validate_records": {
      const fields = joined(strings(config.requiredFields).map(field), "or");
      return config.dropInvalid === false ? `Flags records missing ${fields}` : `Drops records missing ${fields}`;
    }
    case "rank": {
      const limit = typeof config.limit === "number" ? `, keeping the top ${config.limit}` : "";
      return `Ranks by ${field(String(config.by))}, ${config.direction === "asc" ? "lowest" : "highest"} first${limit}`;
    }
    case "filter": {
      const name = field(String(config.field));
      if (config.op === "exists") return `Keeps records that have a ${name}`;
      return `Keeps records where ${name} ${FILTER_OPS[String(config.op)] ?? String(config.op)} ${String(config.value)}`;
    }
    case "compute_stats": {
      const numeric = strings(config.numericFields).map(field);
      const group = typeof config.groupBy === "string" ? `Counts by ${field(config.groupBy)}` : null;
      if (numeric.length === 0) return group ?? "Computes statistics";
      return group ? `${group} and summarizes ${joined(numeric, "and")}` : `Summarizes ${joined(numeric, "and")}`;
    }
    case "to_csv": {
      const columns = strings(config.columns).map(field);
      return columns.length > 0 ? `Exports ${joined(columns, "and")} to CSV` : "Exports every field to CSV";
    }
    case "compile_report": {
      const sections = Array.isArray(config.sections) ? config.sections : [];
      const headings = sections
        .map((s) => (s && typeof s === "object" && "heading" in s ? String((s as { heading: unknown }).heading) : null))
        .filter((h): h is string => h !== null);
      const title = typeof config.title === "string" ? `“${exampleTitle(config.title)}”` : "the report";
      return headings.length > 0 ? `Assembles ${title} from ${joined(headings, "and")}` : `Assembles ${title}`;
    }
    default:
      return op ? operationLabel(op) : "Default settings";
  }
}

function parseConfig(text: string): Config | null {
  try {
    const value: unknown = JSON.parse(text);
    return value && typeof value === "object" && !Array.isArray(value) ? (value as Config) : null;
  } catch {
    return null;
  }
}

function tierModel(tier: string): string {
  return tier in TIER_LABELS ? `${TIER_LABELS[tier as ModelTier]} model` : tier;
}

function toolList(text: string, ctx: ChangeCopyContext): string {
  const names = text
    .split(",")
    .map((t) => t.trim())
    .filter((t) => t.length > 0 && t !== "none");
  return names.length === 0 ? "no tools" : joined(names.map((n) => ctx.toolNames[n] ?? sentenceCase(n)), "and");
}

/**
 * A whole step, as the diff summarises it when a step is added or removed:
 *   agent · standard tier · tools: web_search, fetch_url · up to 8 turns · writes records
 *   dedupe · {"keyFields":["company"]} · writes records
 * The `writes <key>` wiring is internal and dropped.
 */
export function describeStepSummary(text: string, ctx: ChangeCopyContext): string {
  if (text.startsWith("agent · ")) {
    const parts = text
      .slice("agent · ".length)
      .split(" · ")
      .filter((p) => !p.startsWith("writes "))
      .map((p) => {
        if (p.endsWith(" tier")) return tierModel(p.slice(0, -" tier".length));
        if (p.startsWith("tools: ")) return `uses ${toolList(p.slice("tools: ".length), ctx)}`;
        return p;
      });
    return parts.join(" · ");
  }
  // The config is the one JSON object in the line; find it by its braces so a " · " inside a value can't split it.
  const open = text.indexOf(" · {");
  const close = text.lastIndexOf("}");
  if (open > 0 && close > open) {
    const operation = text.slice(0, open).trim().replace(/ /g, "_");
    const config = parseConfig(text.slice(open + " · ".length, close + 1));
    if (config) return describeStepConfig(operation, config);
  }
  return text.replace(/ · writes \S+$/, "");
}

/** Drop inline JSON from a check summary ("Every record has the required fields · {…} · weight 0.3"). */
function withoutJson(text: string): string {
  return text
    .split(" · ")
    .filter((part) => !/^[[{].*[\]}]$/.test(part.trim()))
    .join(" · ");
}

export function humanizeDiffEntry(entry: BlueprintDiffEntry, ctx: ChangeCopyContext): BlueprintDiffEntry {
  const map = (fn: (text: string) => string): BlueprintDiffEntry => ({
    ...entry,
    before: entry.before === undefined ? undefined : fn(entry.before),
    after: entry.after === undefined ? undefined : fn(entry.after),
  });
  const label = entry.label.replace(/^Tools · ([a-z0-9_]+)/, (_, name: string) => `Tools · ${ctx.toolNames[name] ?? sentenceCase(name)}`);
  const withLabel = (e: BlueprintDiffEntry): BlueprintDiffEntry => ({ ...e, label });
  const { path } = entry;

  if (/^components\.[^.]+$/.test(path)) return withLabel(map((t) => describeStepSummary(t, ctx)));
  if (/^components\.[^.]+\.config$/.test(path)) {
    return withLabel(map((t) => {
      const config = parseConfig(t);
      return config ? describeStepConfig(null, config) : t;
    }));
  }
  if (/^components\.[^.]+\.modelTier$/.test(path)) return withLabel(map(tierModel));
  if (/^components\.[^.]+\.tools$/.test(path)) {
    return withLabel(map((t) => {
      const list = toolList(t, ctx);
      return list.charAt(0).toUpperCase() + list.slice(1);
    }));
  }
  if (/^components\.[^.]+\.operation$/.test(path)) return withLabel(map((t) => operationLabel(t.replace(/ /g, "_"))));
  if (path.startsWith("evaluation.checks.")) return withLabel(map(withoutJson));
  if (path === "deliverable.titleTemplate") return withLabel(map((t) => exampleTitle(t)));
  if (path === "deliverable.format") return withLabel(map(formatLabel));
  return withLabel(entry);
}
