import { createInterface } from "node:readline/promises";
import { redactSecrets } from "@/server/security/redact";
import type { BenchArgs } from "./args";

/**
 * Spend safety for `scripts/bench-cost.ts` (CLAUDE.md rule 6: never spend the user's money by surprise).
 *
 *  - Without --live the process is put in Simulated mode BEFORE any Foreman module loads: FORCE_SIMULATED=true, and
 *    every provider / search key is set to "" (Foreman treats a blank key as unset). Setting, not deleting, matters:
 *    constructing the Prisma client loads .env again, and like dotenv it fills in variables that are MISSING but
 *    never overwrites one that exists — a deleted key would come back from .env, a blank one stays blank.
 *    `assertSimulatedEnvironment` re-checks both layers after Foreman's modules have loaded and before every run.
 *  - --live needs a --budget-usd cap, a provider key and TAVILY_API_KEY (or an explicit --allow-fixture-web, which
 *    can never produce a launch figure), refuses to fight an explicit FORCE_SIMULATED, refuses a cap that cannot
 *    cover even the first pair, and asks for confirmation (or --yes) before the first live call.
 *  - Before every live pair the next pair's cost is estimated (Foreman's own estimate for the first pair, the most
 *    expensive pair so far after that, each with a safety margin) and the benchmark stops if spend + estimate would
 *    pass the cap. The workspace's own monthly budget is set to the cap too, so Foreman's built-in guard refuses
 *    further model calls even if an estimate is wrong. Overshoot is then at most one in-flight model call plus the
 *    web searches that call's turn already asked for (tool fees are not budget-checked; Tavily is about $0.008 each).
 *
 * Everything here is pure except `confirmLiveSpend` (it reads the terminal).
 */

/** Keys that make Foreman call a paid API: model providers, plus Tavily for web search. */
export const PROVIDER_KEY_VARS = ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GOOGLE_GENERATIVE_AI_API_KEY"] as const;
export const PAID_TOOL_KEY_VARS = ["TAVILY_API_KEY"] as const;

/** The first pair is priced from Foreman's a-priori estimate, which can be low; pad it. */
export const FIRST_RUN_SAFETY_FACTOR = 1.5;
/** Later pairs are priced from the most expensive pair so far, with a smaller margin. */
export const OBSERVED_SAFETY_FACTOR = 1.2;

export type SpendPlan = { mode: "simulated" } | { mode: "live"; budgetUsd: number; providerKeys: string[]; liveWebSearch: boolean };

export class BenchRefusal extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BenchRefusal";
  }
}

const truthy = (v: string | undefined) => v === "1" || v?.trim().toLowerCase() === "true";
const hasValue = (v: string | undefined) => typeof v === "string" && v.trim().length > 0;
const PAID_KEY_VARS = [...PROVIDER_KEY_VARS, ...PAID_TOOL_KEY_VARS];

/**
 * Decide the spend mode and make `env` (process.env) match it. Returns the names — never the values — of the keys
 * a live run would use.
 */
export function enforceSpendMode(args: Pick<BenchArgs, "live" | "budgetUsd" | "allowFixtureWeb">, env: NodeJS.ProcessEnv): SpendPlan {
  if (!args.live) {
    env.FORCE_SIMULATED = "true";
    for (const name of PAID_KEY_VARS) env[name] = "";
    return { mode: "simulated" };
  }
  if (args.budgetUsd === undefined) {
    throw new BenchRefusal("--live spends real money, so it needs a cap: add --budget-usd <amount> (for example --budget-usd 2).");
  }
  if (truthy(env.FORCE_SIMULATED)) {
    throw new BenchRefusal("--live was passed but FORCE_SIMULATED is set in your environment. Unset it if you really mean to spend; nothing was run.");
  }
  const providerKeys = PROVIDER_KEY_VARS.filter((name) => hasValue(env[name]));
  if (providerKeys.length === 0) {
    throw new BenchRefusal(`--live needs a model provider key (${PROVIDER_KEY_VARS.join(", ")}) in the environment or .env. None is set; run without --live for a simulated benchmark.`);
  }
  const liveWebSearch = hasValue(env.TAVILY_API_KEY);
  if (!liveWebSearch && !args.allowFixtureWeb) {
    throw new BenchRefusal(
      "--live needs TAVILY_API_KEY: without it the collector searches Foreman's fixture web, and a run with live models on fixture pages is not a live measurement. Add the key, or pass --allow-fixture-web to run it anyway (it will never print a launch figure).",
    );
  }
  return { mode: "live", budgetUsd: args.budgetUsd, providerKeys, liveWebSearch };
}

/** Throws unless the process is still in the state `enforceSpendMode` left a simulated benchmark in. */
export function assertSimulatedEnvironment(env: NodeJS.ProcessEnv): void {
  const set = PAID_KEY_VARS.filter((name) => hasValue(env[name]));
  if (env.FORCE_SIMULATED !== "true" || set.length > 0) {
    throw new BenchRefusal(
      `the simulated environment was changed after it was set up (FORCE_SIMULATED=${env.FORCE_SIMULATED === "true" ? "true" : "not true"}${set.length > 0 ? `; set again: ${set.join(", ")}` : ""}). Nothing was run.`,
    );
  }
}

/** The benchmark creates and deletes workspaces, so it only ever touches a database whose name ends with this. */
export const BENCH_DATABASE_SUFFIX = "_test";

/**
 * Fail closed before anything opens a database connection: DATABASE_URL must parse and name a database ending in
 * `_test`. There is no override, and it applies to --live runs too. Stricter in practice than tests/setup/global-setup.ts (though it percent-decodes the name, so foo%5Ftest passes here but not there), which
 * only checks that the URL contains "_test" anywhere (and echoes the URL when it refuses). Returns the database name
 * for the caller; a refusal names only the rule that failed, never any part of the URL.
 */
export function assertBenchDatabase(databaseUrl: string | undefined): string {
  if (!hasValue(databaseUrl)) {
    throw new BenchRefusal(`DATABASE_URL is not set; it must name a dedicated database ending in "${BENCH_DATABASE_SUFFIX}". Nothing was run.`);
  }
  let name: string;
  try {
    const url = new URL(databaseUrl!.trim());
    name = decodeURIComponent(url.pathname.replace(/^\/+/, ""));
  } catch {
    throw new BenchRefusal("DATABASE_URL could not be parsed as a connection URL. Nothing was run.");
  }
  if (name.length === 0 || name.includes("/") || !name.endsWith(BENCH_DATABASE_SUFFIX)) {
    throw new BenchRefusal(`DATABASE_URL's path is not a single database name ending in "${BENCH_DATABASE_SUFFIX}"; the benchmark only runs against a dedicated *${BENCH_DATABASE_SUFFIX} database. Nothing was run.`);
  }
  return name;
}

/** What the benchmark says instead of a database error's own text (which can carry host:port, a user or a password). */
export const DATABASE_FAILURE = "database operation failed (details withheld)";

/** A label safeErrorText produced: an error class, an optional Prisma P-code, and DATABASE_FAILURE. */
const SAFE_LABEL = /\b[A-Za-z]*Error(?: P\d{4})?: database operation failed \(details withheld\)/g;

/** Text that reads like a database driver's error, whatever URL is configured. */
const DATABASE_ERROR_TEXT = /prisma|database server|\bP\d{4}\b|postgres(ql)?:\/\/|`[^`\s]+:\d{1,5}`/i;

/**
 * The parts of DATABASE_URL that must never be printed, by how they are matched in text. Every match is case-insensitive
 * and WHOLE-TOKEN (no letter, digit or "_" on either side), so a piece inside an ordinary word ("app" in "approximate")
 * never matches; and scrubDatabaseText replaces only the matched text, never the whole string.
 *  - joined: any run of two or more URL pieces with their separators ("u:12" from a malformed URL, "app:app@localhost:5433",
 *    the whole URL tail). URL punctuation makes these distinctive, so they match wherever they stand.
 *  - word: the host and the database name (and every piece of a URL too malformed to give them roles).
 *  - quoted: the user, the password and the port. These are often ordinary words or numbers ("app", "foreman", 5433), so
 *    they match only directly next to : @ / = (on either side), or wrapped whole in double quotes or backticks on BOTH
 *    sides ("foreman", `foreman`); the word Foreman in a title or a sentence, and a cost such as $0.5433, are left alone.
 *    NOT covered: a user/password/port in bare prose; single-quoted or backslash-escaped forms
 *    ('foreman', \"foreman\"); any part under 3 characters outside a joined run; raw percent-encoded credentials;
 *    Prisma's two-argument log message when that argument alone has no driver keyword; and channels that bypass the
 *    console scrub (process.stdout/stderr.write, console.dirxml, Node's crash printer, native engine output).
 * Pieces shorter than 3 characters are ignored on their own; they still match inside a joined fragment.
 * The query string is left out: its keys ("schema", "options") are ordinary words.
 */
export interface DatabaseUrlFragments {
  joined: string[];
  word: string[];
  quoted: string[];
}

export function databaseUrlFragments(databaseUrl: string | undefined = process.env.DATABASE_URL): DatabaseUrlFragments {
  if (!hasValue(databaseUrl)) return { joined: [], word: [], quoted: [] };
  const trimmed = databaseUrl!.trim();
  const rest = trimmed.replace(/^[a-z][a-z0-9+.-]*:\/\//i, "").split("?")[0];
  const parts = rest.split(/([:/@]+)/); // pieces at even indexes, separators at odd ones
  const pieces = parts.filter((_, i) => i % 2 === 0);
  const joined = new Set<string>();
  for (let i = 0; i < parts.length; i += 2) {
    for (let j = i + 2; j < parts.length; j += 2) {
      const run = parts.slice(i, j + 1).join("");
      if (run.length >= 2) joined.add(run).add(safeDecode(run));
    }
  }
  let roles: { word: string[]; quoted: string[] } | null = null;
  try {
    const url = new URL(trimmed);
    const name = safeDecode(url.pathname.replace(/^\/+/, ""));
    // A well-formed URL: the host and a single database name are words; user, password and port need context.
    if (!/[:/@]/.test(name)) roles = { word: [url.hostname, name], quoted: [safeDecode(url.username), safeDecode(url.password), url.port] };
  } catch {
    // unparseable: no roles
  }
  const long = (xs: string[]) => [...new Set(xs.filter((x) => x.length >= 3))];
  const word = long(roles ? roles.word : pieces.flatMap((p) => [p, safeDecode(p)]));
  const quoted = long(roles ? roles.quoted : []).filter((q) => !word.some((w) => w.toLowerCase() === q.toLowerCase()));
  return { joined: [...joined].sort((a, b) => b.length - a.length), word, quoted };
}

function safeDecode(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const TOKEN = "A-Za-z0-9_";
const URL_PUNCTUATION = ":@/=";

/**
 * One regex that finds every fragment of DATABASE_URL in text, by the rules above (longest fragments first). With
 * `joinedOnly`, only the joined runs (credential- and host:port-shaped, e.g. user:pw@host or u:12) are looked for.
 */
function fragmentPattern(databaseUrl: string | undefined, joinedOnly = false): RegExp | null {
  const fragments = databaseUrlFragments(databaseUrl);
  const { joined } = fragments;
  const word = joinedOnly ? [] : fragments.word;
  const quoted = joinedOnly ? [] : fragments.quoted;
  const anywhere = [...joined, ...word].map(escapeRegExp);
  const alts = anywhere.map((f) => `(?<![${TOKEN}])${f}(?![${TOKEN}])`);
  for (const q of quoted.map(escapeRegExp)) {
    alts.push(`(?<=[${URL_PUNCTUATION}])${q}(?![${TOKEN}])`, `(?<![${TOKEN}])${q}(?=[${URL_PUNCTUATION}])`);
    alts.push(`(?<=")${q}(?=")`, `(?<=\`)${q}(?=\`)`);
  }
  return alts.length > 0 ? new RegExp(alts.join("|"), "gi") : null;
}

/** True when `text` names any part of DATABASE_URL or reads like a database driver's error. */
export function mentionsDatabase(text: string, databaseUrl: string | undefined = process.env.DATABASE_URL): boolean {
  // safeErrorText's own labels ("PrismaClientInitializationError P1001: database operation failed …") are safe to
  // print; take them out first so only the rest of the text is judged.
  text = text.replace(SAFE_LABEL, "");
  if (DATABASE_ERROR_TEXT.test(text)) return true;
  return fragmentPattern(databaseUrl)?.test(text) ?? false;
}

/**
 * An error as the benchmark may print or report it. A Prisma error (or anything carrying a Prisma P-code) becomes
 * its class and code plus DATABASE_FAILURE; any other message that names the database is withheld the same way.
 * Everything else is shown, with the usual secret redaction.
 */
export function safeErrorText(e: unknown, databaseUrl: string | undefined = process.env.DATABASE_URL): string {
  const name = e instanceof Error ? e.name : "Error";
  // Prisma puts its P-code in `code` (request errors) or `errorCode` (initialization errors).
  const raw = e && typeof e === "object" ? ((e as { code?: unknown }).code ?? (e as { errorCode?: unknown }).errorCode) : undefined;
  const code = typeof raw === "string" && /^P\d{4}$/.test(raw) ? raw : null;
  if (name.startsWith("PrismaClient") || code) return `${name}${code ? ` ${code}` : ""}: ${DATABASE_FAILURE}`;
  const text = redactSecrets(e instanceof Error ? e.message : typeof e === "string" ? e : String(e));
  return mentionsDatabase(text, databaseUrl) ? `${name}: ${DATABASE_FAILURE}` : text;
}

/** Replaces each fragment of DATABASE_URL in printed or reported text. */
export const REDACTED_FRAGMENT = "[redacted]";

/**
 * One printed or reported string, made safe: text that reads like a database driver's error is withheld whole; otherwise
 * only the fragments of DATABASE_URL it contains are replaced, so the rest of a legitimate line survives.
 */
export function scrubDatabaseText(text: string, databaseUrl: string | undefined = process.env.DATABASE_URL): string {
  if (DATABASE_ERROR_TEXT.test(text.replace(SAFE_LABEL, ""))) return `[${DATABASE_FAILURE}]`;
  const pattern = fragmentPattern(databaseUrl);
  return pattern ? text.replace(pattern, REDACTED_FRAGMENT) : text;
}

/**
 * A local filesystem path the benchmark prints (its --out report path, resolved against the cwd). Passed to the scrubbed
 * console as `new LocalPath(p)`, it is printed with only the joined DATABASE_URL runs redacted: the single-word user,
 * password, port, host and database-name rules would mangle the user's own directory names (".../foreman/...",
 * "/Users/app/...") and are not applied to it.
 */
export class LocalPath {
  constructor(readonly path: string) {}
  /** Without the console scrub installed, prints as the plain path. */
  [Symbol.for("nodejs.util.inspect.custom")](): string {
    return this.path;
  }
}

/** A LocalPath's text, made safe: only credential- or host:port-shaped joined runs of DATABASE_URL are replaced. */
export function scrubLocalPath(path: string, databaseUrl: string | undefined = process.env.DATABASE_URL): string {
  const pattern = fragmentPattern(databaseUrl, true);
  return pattern ? path.replace(pattern, REDACTED_FRAGMENT) : path;
}

/** Every string in a report (or any JSON-shaped value), scrubbed; the structure is unchanged. */
export function scrubReport<T>(value: T, databaseUrl: string | undefined = process.env.DATABASE_URL): T {
  const walk = (v: unknown): unknown => {
    if (typeof v === "string") return scrubDatabaseText(v, databaseUrl);
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x)]));
    return v;
  };
  return walk(value) as T;
}

/**
 * For this process only: console output is scrubbed as scrubDatabaseText does. Prisma 6.19.3's own `warn` and `error`
 * logs (enabled app-wide in src/server/db.ts as plain levels) print through console.log, and other paths use
 * console.error, so every console method is wrapped; this keeps them from echoing host:port or credentials without
 * changing the app's logging. Returns a function that puts the console back.
 */
export function installConsoleScrub(databaseUrl: string | undefined = process.env.DATABASE_URL): () => void {
  const methods = ["log", "info", "debug", "warn", "error", "dir"] as const;
  const originals = methods.map((m) => [m, console[m]] as const);
  const scrubArg = (a: unknown) =>
    typeof a === "string"
      ? scrubDatabaseText(a, databaseUrl)
      : a instanceof LocalPath
        ? scrubLocalPath(a.path, databaseUrl)
        : a instanceof Error
          ? safeErrorText(a, databaseUrl)
          : scrubReport(a, databaseUrl);
  for (const [m, original] of originals) {
    console[m] = ((...args: unknown[]) => (original as (...a: unknown[]) => void).apply(console, args.map(scrubArg))) as (typeof console)[typeof m];
  }
  return () => {
    for (const [m, original] of originals) (console as unknown as Record<string, unknown>)[m] = original;
  };
}

/** The workspace budget column holds cents; round DOWN so Foreman's guard never allows more than the cap. */
export function workspaceBudgetUsd(budgetUsd: number): number {
  return Math.floor(budgetUsd * 100 + 1e-9) / 100;
}

export function estimateNextRunUsd(args: { observedUsd: readonly number[]; foremanEstimateUsd: number }): number {
  const observed = args.observedUsd.filter((n) => Number.isFinite(n) && n >= 0);
  if (observed.length > 0) return Math.max(...observed) * OBSERVED_SAFETY_FACTOR;
  return Math.max(0, args.foremanEstimateUsd) * FIRST_RUN_SAFETY_FACTOR;
}

export type RunGate = { allowed: true } | { allowed: false; reason: string };

export function gateNextRun(args: { budgetUsd: number; spentUsd: number; nextEstimateUsd: number }): RunGate {
  const after = args.spentUsd + args.nextEstimateUsd;
  if (after <= args.budgetUsd) return { allowed: true };
  return {
    allowed: false,
    reason: `stopped before the next pair: $${args.spentUsd.toFixed(4)} spent + about $${args.nextEstimateUsd.toFixed(4)} for the next pair would pass the $${args.budgetUsd.toFixed(2)} cap`,
  };
}

/** A cap the first pair's padded estimate already passes would stop before any run: refuse it up front instead. */
export function capCoversFirstPair(budgetUsd: number, firstPairEstimateUsd: number): RunGate {
  const needed = estimateNextRunUsd({ observedUsd: [], foremanEstimateUsd: firstPairEstimateUsd });
  if (needed <= budgetUsd) return { allowed: true };
  return {
    allowed: false,
    reason: `the $${budgetUsd.toFixed(2)} cap cannot cover even the first pair (Foreman's estimate $${firstPairEstimateUsd.toFixed(4)} × ${FIRST_RUN_SAFETY_FACTOR} margin = $${needed.toFixed(4)}). Raise --budget-usd; nothing was spent.`,
  };
}

/** The most a plan could cost by Foreman's own estimates, before any margin; the cap is what actually binds. */
export function plannedSpendUsd(pairs: number, perPairEstimateUsd: number): number {
  return pairs * Math.max(0, perPairEstimateUsd);
}

/** --yes, or an interactive "yes". A non-interactive shell without --yes is a refusal, never a silent go-ahead. */
export async function confirmLiveSpend(args: Pick<BenchArgs, "yes">, budgetUsd: number): Promise<boolean> {
  if (args.yes) return true;
  if (!process.stdin.isTTY) {
    console.log("Not starting: this is not an interactive terminal. Re-run with --yes to confirm the live spend.");
    return false;
  }
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await rl.question(`Spend up to $${budgetUsd.toFixed(2)} of your provider credit on this benchmark? Type "yes" to continue: `);
    return answer.trim().toLowerCase() === "yes";
  } finally {
    rl.close();
  }
}
