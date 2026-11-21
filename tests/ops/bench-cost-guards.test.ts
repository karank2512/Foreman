import { readFileSync } from "node:fs";
import { join } from "node:path";
import { inspect } from "node:util";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Guards around scripts/bench-cost.ts that keep it from writing anywhere it should not:
 *  - the git label it puts in a report never refreshes .git/index;
 *  - its report output is ignored by git;
 *  - it refuses any database not named *_test before Foreman's modules (and so the db module) load — no override,
 *    and a refusal never prints any part of DATABASE_URL.
 */

const trip = vi.hoisted(() => ({
  /** Every execSync call (command, options); `git` decides what the fake returns or throws. */
  gitCalls: [] as Array<[string, { env?: NodeJS.ProcessEnv }]>,
  git: (_cmd: string): Buffer => Buffer.from(""),
  /** How many times the db module was evaluated in the current case (registered per case with vi.doMock). */
  dbLoads: 0,
  dbCalls: [] as string[],
  /** Likewise for the benchmark's run and markdown modules (the script imports them only after the guard). */
  runLoads: 0,
  markdownLoads: 0,
  runBenchmark: vi.fn(),
}));

vi.mock("node:child_process", () => ({
  execSync: (cmd: string, opts: { env?: NodeJS.ProcessEnv }) => {
    trip.gitCalls.push([cmd, opts]);
    return trip.git(cmd);
  },
}));

/**
 * Tripwire for the db module, registered afresh for every case (after vi.resetModules), so each case counts its own
 * loads: a load in one case can never hide or stand in for a load in another.
 */
function armDbTripwire(): void {
  vi.doMock("@/server/db", () => {
    trip.dbLoads += 1;
    const db = new Proxy(
      {},
      {
        get: (_t, prop) => {
          trip.dbCalls.push(String(prop));
          return prop === "$disconnect" ? async () => undefined : () => Promise.reject(new Error(`tripwire: db.${String(prop)}`));
        },
      },
    );
    return { db, toJson: (v: unknown) => v };
  });
}
/** Per-case tripwires for the run and markdown modules, registered the same way as armDbTripwire. */
function armScriptModuleTripwires(): void {
  vi.doMock("../../scripts/bench-cost/run", () => {
    trip.runLoads += 1;
    return { runBenchmark: trip.runBenchmark, withCleanup: (r: unknown) => r };
  });
  vi.doMock("../../scripts/bench-cost/markdown", () => {
    trip.markdownLoads += 1;
    return { renderMarkdown: () => "" };
  });
}

/** Records everything printed through console (log/info/debug/dir to `output`, error/warn to `errors`) or the streams. */
function captureOutput(): { errors: string[]; output: string[] } {
  const errors: string[] = [];
  const output: string[] = [];
  const text = (a: unknown[]) => a.map((x) => (typeof x === "string" ? x : inspect(x, { depth: 20 }))).join(" ");
  for (const m of ["error", "warn"] as const) vi.spyOn(console, m).mockImplementation((...a: unknown[]) => void errors.push(text(a)));
  for (const m of ["log", "info", "debug", "dir"] as const) vi.spyOn(console, m).mockImplementation((...a: unknown[]) => void output.push(text(a)));
  // Anything written straight to the streams is recorded too (and still passed through).
  for (const [stream, sink] of [[process.stdout, output], [process.stderr, errors]] as const) {
    const write = stream.write.bind(stream);
    vi.spyOn(stream, "write").mockImplementation(((chunk: unknown, ...rest: unknown[]) => {
      sink.push(String(chunk));
      return (write as (...a: unknown[]) => boolean)(chunk, ...rest);
    }) as typeof stream.write);
  }
  return { errors, output };
}

const ROOT = join(import.meta.dirname, "..", "..");

describe("ops: bench-cost git label is read-only", () => {
  beforeEach(() => {
    trip.gitCalls.length = 0;
  });

  it("runs git status with --no-optional-locks and GIT_OPTIONAL_LOCKS=0, so it can never write .git/index", async () => {
    trip.git = (cmd) => Buffer.from(cmd.includes("rev-parse") ? "abc1234\n" : " M file.ts\n");
    const { gitDescription } = await import("../../scripts/bench-cost/git");
    expect(gitDescription()).toBe("abc1234 (with uncommitted changes)");

    const calls = trip.gitCalls;
    expect(calls.map(([cmd]) => cmd)).toEqual(["git rev-parse --short HEAD", "git --no-optional-locks status --porcelain"]);
    for (const [cmd, opts] of calls) {
      expect(opts.env?.GIT_OPTIONAL_LOCKS, cmd).toBe("0");
      // Only read-only git subcommands.
      expect(cmd).toMatch(/^git (rev-parse|--no-optional-locks status) /);
    }
    const status = calls.find(([cmd]) => cmd.includes(" status"))!;
    expect(status[0]).toContain("--no-optional-locks");
  });

  it("falls back to APP_VERSION outside a git checkout", async () => {
    trip.git = () => {
      throw new Error("not a git repository");
    };
    vi.stubEnv("APP_VERSION", "v-test");
    const { gitDescription } = await import("../../scripts/bench-cost/git");
    expect(gitDescription()).toBe("v-test");
    expect(trip.gitCalls).toHaveLength(1);
    vi.unstubAllEnvs();
  });

  it("run.ts no longer calls execSync itself", () => {
    const run = readFileSync(join(ROOT, "scripts/bench-cost/run.ts"), "utf8");
    expect(run).not.toMatch(/child_process|execSync/);
    expect(run).toMatch(/from "\.\/git"/);
  });
});

describe("ops: bench-cost report output is git-ignored", () => {
  it("lists bench-cost-report* in .gitignore", () => {
    const lines = readFileSync(join(ROOT, ".gitignore"), "utf8").split(/\r?\n/).map((l) => l.trim());
    expect(lines).toContain("bench-cost-report*");
  });
});

describe("ops: bench-cost refuses any database not named *_test", () => {
  it("assertBenchDatabase accepts only a parseable URL whose database name ends with _test", async () => {
    const { assertBenchDatabase, BenchRefusal } = await import("../../scripts/bench-cost/safety");
    expect(assertBenchDatabase("postgresql://u:p@127.0.0.1:5433/foreman_test?schema=public&options=-c%20TimeZone%3DUTC")).toBe("foreman_test");
    expect(assertBenchDatabase("postgres://localhost/app_test")).toBe("app_test");
    for (const bad of [
      undefined,
      "",
      "   ",
      "not a url",
      "postgresql://u:p@db.example.com:5432/foreman",
      "postgresql://u:p@localhost:5432/foreman_test_prod",
      "postgresql://u:p@localhost:5432/foreman_testing",
      "postgresql://u:p@localhost:5432/",
      "postgresql://u:p@localhost:5432/prod/foreman_test",
      "postgresql://u:p@localhost:5432/foreman?dbname=foreman_test",
    ]) {
      expect(() => assertBenchDatabase(bad), String(bad)).toThrow(BenchRefusal);
    }
  });

  it.each([
    ["missing", undefined, /DATABASE_URL is not set/],
    ["unparseable", "SECRETMARKER not a url", /could not be parsed/],
    ["wrong name", "postgresql://someuser:SECRETMARKER@db.example.com:5432/foremanSECRETMARKER", /is not a single database name ending in "_test"/],
    ["nested path", "postgresql://u:p@SECRETMARKER.example/prod/SECRETMARKER_test", /is not a single database name ending in "_test"/],
    ["unencoded / in the password", "postgresql://u:12/SECRETMARKER@h/prod", /is not a single database name ending in "_test"/],
  ])("a %s DATABASE_URL is refused naming only the rule, never any part of the URL", async (_label, url, rule) => {
    const { assertBenchDatabase, BenchRefusal } = await import("../../scripts/bench-cost/safety");
    let message = "";
    try {
      assertBenchDatabase(url);
    } catch (e) {
      expect(e).toBeInstanceOf(BenchRefusal);
      message = (e as Error).message;
    }
    expect(message).not.toMatch(/SECRETMARKER|someuser|example|prod|12\/|postgresql:/i);
    expect(message).toMatch(rule);
  });

  let argv: string[];
  let env: NodeJS.ProcessEnv;
  let listeners: { SIGINT: NodeJS.SignalsListener[]; SIGTERM: NodeJS.SignalsListener[] };

  beforeEach(() => {
    vi.resetModules();
    trip.dbLoads = 0;
    trip.dbCalls.length = 0;
    trip.runLoads = 0;
    trip.markdownLoads = 0;
    armDbTripwire();
    armScriptModuleTripwires();
    trip.runBenchmark.mockReset();
    trip.runBenchmark.mockResolvedValue({ kind: "declined", cleanup: { workspaceDeleted: true, leftoverRows: 0, note: "declined (test)" } });
    argv = process.argv;
    env = { ...process.env };
    listeners = { SIGINT: process.listeners("SIGINT"), SIGTERM: process.listeners("SIGTERM") };
  });

  afterEach(() => {
    process.argv = argv;
    for (const k of Object.keys(process.env)) if (!(k in env)) delete process.env[k];
    Object.assign(process.env, env);
    for (const sig of ["SIGINT", "SIGTERM"] as const) for (const l of process.listeners(sig)) if (!listeners[sig].includes(l)) process.off(sig, l);
    vi.restoreAllMocks();
  });

  /** Runs scripts/bench-cost.ts's main() (it runs on import) and resolves with the exit code it asks for. */
  async function runScript(databaseUrl: string | undefined): Promise<{ code: number; errors: string; output: string }> {
    process.argv = ["node", "scripts/bench-cost.ts"];
    if (databaseUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = databaseUrl;
    const { errors, output } = captureOutput();
    const code = await new Promise<number>((resolve) => {
      vi.spyOn(process, "exit").mockImplementation(((c?: number) => {
        resolve(c ?? 0);
      }) as typeof process.exit);
      void import("../../scripts/bench-cost");
    });
    return { code, errors: errors.join("\n"), output: output.join("\n") };
  }

  it.each([
    ["a non-_test database", "postgresql://u:p@127.0.0.1:1/foremanSECRETMARKER"],
    ["a database whose name only contains _test", "postgresql://u:p@127.0.0.1:1/SECRETMARKER_test_prod"],
    ["no DATABASE_URL", undefined],
    ["an unparseable DATABASE_URL", "SECRETMARKER not a url"],
    ["a malformed URL with an unencoded / in the password", "postgresql://u:12/SECRETMARKER@h/prod"],
  ])("refuses %s with exit 2 before the db module loads, printing no part of the URL", async (_label, url) => {
    const { code, errors, output } = await runScript(url);
    expect(code).toBe(2);
    expect(errors).toMatch(/Refusing to run: [\s\S]*Nothing was run\./);
    for (const printed of [errors, output]) {
      expect(printed).not.toMatch(/SECRETMARKER|u:p@|u:12|127\.0\.0\.1|foreman_test_prod|\/foreman\b|\/prod\b/);
    }
    expect(trip.dbLoads).toBe(0);
    expect(trip.runLoads).toBe(0);
    expect(trip.markdownLoads).toBe(0);
    expect(trip.dbCalls).toEqual([]);
    expect(trip.runBenchmark).not.toHaveBeenCalled();
  });

  it("lets a *_test database through to the (stubbed) benchmark", async () => {
    const { code, errors } = await runScript("postgresql://u:p@127.0.0.1:1/foreman_test?schema=public");
    expect(errors).not.toMatch(/Refusing/);
    expect(trip.runBenchmark).toHaveBeenCalledTimes(1);
    expect(code).toBe(0);
    // Positive control: this case's own tripwires fire once each (the modules load after the guard)…
    expect(trip.dbLoads).toBe(1);
    expect(trip.runLoads).toBe(1);
    expect(trip.markdownLoads).toBe(1);
    // …and the stubbed db only saw the final disconnect, never a query or write.
    expect(trip.dbCalls.filter((c) => c !== "$disconnect" && c !== "then")).toEqual([]);
  });
});

describe("ops: bench-cost report metadata never carries DATABASE_URL", () => {
  /** Malformed or credentialed URLs the *_test guard still ACCEPTS, with markers in the user, password and host positions. */
  const ACCEPTED = [
    "postgresql://u:12/SECRETPW@SECRETHOST_test", // unencoded "/" in the password: host "u", database "SECRETPW@SECRETHOST_test"
    "postgresql://SECRETUSER:12/SECRETPW@SECRETHOST_test", // the user lands in the host
    "postgresql://SECRETUSER:SECRETPW@SECRETHOST:5432/foreman_test", // well formed, credentials and host in place
    "postgresql://u:12/SECRETPW%40SECRETHOST_test", // percent-encoded variant
  ];
  const MARKERS = /SECRET(USER|PW|HOST)/i;

  let env: NodeJS.ProcessEnv;
  beforeEach(() => {
    vi.resetModules();
    trip.dbLoads = 0;
    trip.dbCalls.length = 0;
    armDbTripwire(); // run.ts imports the db module; never the real one here
    env = { ...process.env };
  });
  afterEach(() => {
    for (const k of Object.keys(process.env)) if (!(k in env)) delete process.env[k];
    Object.assign(process.env, env);
    vi.restoreAllMocks();
  });

  it("run.ts's console line and report environment take the database label only from databaseLabel(), never from DATABASE_URL", () => {
    // Code only: block comments and whole-line // comments removed (run.ts's doc comment explains the rule).
    const run = readFileSync(join(ROOT, "scripts/bench-cost/run.ts"), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^\s*\/\/.*$/gm, "");
    expect(run).not.toMatch(/DATABASE_URL|new URL\(/);
    expect(run).toMatch(/created in \$\{databaseLabel\(\)\}/);
    expect(run).toMatch(/Database: databaseLabel\(\),/);
  });

  it.each(ACCEPTED)("an accepted URL (%#) leaves no marker in the report object, the markdown, stdout or stderr", async (url) => {
    const { assertBenchDatabase } = await import("../../scripts/bench-cost/safety");
    expect(() => assertBenchDatabase(url)).not.toThrow(); // the guard accepts it
    process.env.DATABASE_URL = url;
    const { errors, output } = captureOutput();

    const { databaseLabel } = await vi.importActual<typeof import("../../scripts/bench-cost/run")>("../../scripts/bench-cost/run");
    const { renderMarkdown } = await vi.importActual<typeof import("../../scripts/bench-cost/markdown")>("../../scripts/bench-cost/markdown");
    const label = databaseLabel();
    console.log(`Temporary workspace bench-x created in ${label}.`); // the line runBenchmark prints
    const report = {
      schemaVersion: 2,
      generatedAt: "2026-11-21T00:00:00.000Z",
      mode: "SIMULATED",
      modeLabel: "SIMULATED",
      job: { description: "d", title: "t", jobFamily: "f", deliverable: "x" },
      settings: { pairsRequested: 1, baselines: [], beforeTier: "fast", budgetUsd: null, design: "paired", volume: { answer: null, requested: null, target: null } },
      environment: { "Foreman commit": "abc1234", Database: label },
      arms: {},
      sharedComponents: [],
      comparisons: {},
      headline: "h",
      headlines: {},
      wording: { mayQuote: [], liveTemplate: "" },
      pairs: [],
      standIn: null,
      stoppedEarly: null,
      cleanup: null,
      caveats: [],
    } as unknown as Parameters<typeof renderMarkdown>[0];
    const markdown = renderMarkdown(report);
    console.dir(report, { depth: 20 });

    for (const [where, text] of [["report", JSON.stringify(report)], ["markdown", markdown], ["stdout", output.join("\n")], ["stderr", errors.join("\n")]] as const) {
      expect(text, where).not.toMatch(MARKERS);
      expect(text, where).not.toContain("postgresql:");
    }
    expect(label).toBe("dedicated *_test database");
    expect(markdown).toContain(`- Database: ${label}`);
    expect(output.join("\n")).toContain("created in dedicated *_test database.");
    expect(trip.dbCalls).toEqual([]);
  });
});

describe("ops: bench-cost never prints or reports database error text (Prisma leak)", () => {
  /** Accepted by the *_test guard, with markers in the user, password and host positions. */
  const URLS = [
    "postgresql://SECRETUSER:12/SECRETPW@SECRETHOST_test", // malformed: Prisma would report host "secretuser", port 12
    "postgresql://SECRETUSER:SECRETPW@SECRETHOST:5432/foreman_test", // well formed
  ];
  const MARKERS = /SECRET(USER|PW|HOST)|secretuser:12/i;
  /** What a real mid-run failure looks like: Prisma's own message names the server and credentials. */
  const prismaMessage = "Can't reach database server at `SECRETHOST:5432` (user `SECRETUSER`, prefix SECRETUSER:12/SECRETPW)";
  const prismaLogLine = `prisma:error \nInvalid \`prisma.organization.deleteMany()\` invocation:\n\n${prismaMessage}`;

  let argv: string[];
  let env: NodeJS.ProcessEnv;
  let tmp: string;
  beforeEach(async () => {
    vi.resetModules();
    trip.dbLoads = 0;
    trip.dbCalls.length = 0;
    trip.runLoads = 0;
    trip.markdownLoads = 0;
    argv = process.argv;
    env = { ...process.env };
    const { mkdtempSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    tmp = mkdtempSync(join(tmpdir(), "bench-cost-v5-"));
  });
  afterEach(async () => {
    process.argv = argv;
    for (const k of Object.keys(process.env)) if (!(k in env)) delete process.env[k];
    Object.assign(process.env, env);
    vi.restoreAllMocks();
    const { rmSync } = await import("node:fs");
    rmSync(tmp, { recursive: true, force: true });
  });

  async function prismaInitError() {
    const { Prisma } = await vi.importActual<typeof import("@prisma/client")>("@prisma/client");
    return new Prisma.PrismaClientInitializationError(prismaMessage, "6.19.3", "P1001");
  }

  /** The db module fails every call the way Prisma does when the server goes away mid-run. */
  function armFailingDb(error: Error): void {
    vi.doMock("@/server/db", () => {
      trip.dbLoads += 1;
      const fail = new Proxy(() => undefined, { get: () => fail, apply: () => Promise.reject(error) });
      const db = new Proxy({}, { get: (_t, prop) => (prop === "$disconnect" ? async () => undefined : fail) });
      return { db, toJson: (v: unknown) => v };
    });
  }

  it.each(URLS)("the safe label keeps the error class and Prisma code but no part of %s", async (url) => {
    const { safeErrorText, scrubReport, databaseUrlFragments, DATABASE_FAILURE, assertBenchDatabase } = await import("../../scripts/bench-cost/safety");
    expect(() => assertBenchDatabase(url)).not.toThrow();
    expect(Object.values(databaseUrlFragments(url)).flat().some((f) => /SECRETHOST/.test(f))).toBe(true);

    const label = safeErrorText(await prismaInitError(), url);
    expect(label).not.toMatch(MARKERS);
    expect(label).toBe(`PrismaClientInitializationError P1001: ${DATABASE_FAILURE}`);
    // A non-Prisma error that still names the database is withheld too; an ordinary one is kept as it is.
    expect(safeErrorText(new Error(`connect failed for ${url.replace("postgresql://", "")}`), url)).toBe(`Error: ${DATABASE_FAILURE}`);
    expect(safeErrorText(new Error('The "funding-tracker" example job is missing from the hire flow.'), url)).toBe('The "funding-tracker" example job is missing from the hire flow.');

    // A run whose stored error is Prisma's text (markdown.ts prints run.error) is scrubbed; other strings are untouched.
    const report = scrubReport({ pairs: [{ after: { status: "FAILED", error: prismaMessage } }], headline: "ordinary text, $0.054321 per run" }, url);
    expect(JSON.stringify(report)).not.toMatch(MARKERS);
    expect(report.pairs[0].after.error).toBe(`[${DATABASE_FAILURE}]`);
    expect(report.headline).toBe("ordinary text, $0.054321 per run");
  });

  it.each(URLS)("a mid-run database failure (%s) prints only the safe label: Prisma's own log, the failure and the cleanup note", async (url) => {
    const error = await prismaInitError();
    armFailingDb(error);
    vi.doMock("../../scripts/bench-cost/markdown", () => ({ renderMarkdown: () => "" }));
    const { deleteBenchWorkspace } = await vi.importActual<typeof import("../../scripts/bench-cost/workspace")>("../../scripts/bench-cost/workspace");
    vi.doMock("../../scripts/bench-cost/run", () => ({
      withCleanup: (r: unknown) => r,
      runBenchmark: async (_a: unknown, _p: unknown, control: { onCleanup?: () => Promise<unknown> }) => {
        control.onCleanup = () => deleteBenchWorkspace({ organizationId: "org_1", slug: "bench-x" });
        // Prisma 6.19.3 prints its own warn/error log (src/server/db.ts) through console.log; other paths use console.error.
        console.log(prismaLogLine);
        console.error(prismaLogLine);
        throw error;
      },
    }));
    process.argv = ["node", "scripts/bench-cost.ts", "--out", join(tmp, "report")];
    process.env.DATABASE_URL = url;
    const { errors, output } = captureOutput();
    const code = await new Promise<number>((resolve) => {
      vi.spyOn(process, "exit").mockImplementation(((c?: number) => resolve(c ?? 0)) as typeof process.exit);
      void import("../../scripts/bench-cost");
    });
    const printed = [...errors, ...output].join("\n");
    expect(code).toBe(1);
    expect(printed).not.toMatch(MARKERS);
    expect(printed).not.toMatch(/database server|postgresql:/i);
    expect(printed).toContain("Benchmark failed: PrismaClientInitializationError P1001: database operation failed (details withheld)");
    expect(printed).toMatch(/Could not delete temporary workspace bench-x \(organization id org_1\): PrismaClientInitializationError P1001: database operation failed/);
  });

  it.each(URLS)("a report carrying database error text (%s) is written and printed without it", async (url) => {
    armDbTripwire();
    const { renderMarkdown } = await vi.importActual<typeof import("../../scripts/bench-cost/markdown")>("../../scripts/bench-cost/markdown");
    vi.doMock("../../scripts/bench-cost/markdown", () => ({ renderMarkdown }));
    const report = {
      schemaVersion: 2,
      generatedAt: "2026-11-21T00:00:00.000Z",
      mode: "SIMULATED",
      modeLabel: "SIMULATED",
      job: { description: "d", title: "t", jobFamily: "f", deliverable: "x" },
      settings: { pairsRequested: 1, baselines: [], beforeTier: "fast", budgetUsd: null, design: "paired", volume: { answer: null, requested: null, target: null } },
      environment: { "Foreman commit": "abc1234", Database: "dedicated *_test database", "Last error": prismaMessage },
      arms: {},
      sharedComponents: [],
      comparisons: {},
      headline: "h",
      headlines: {},
      wording: { mayQuote: [], liveTemplate: "" },
      pairs: [],
      standIn: null,
      stoppedEarly: `pair 2 failed: ${prismaMessage}`,
      cleanup: null,
      caveats: [prismaLogLine],
    };
    vi.doMock("../../scripts/bench-cost/run", () => ({
      withCleanup: (r: object, c: unknown) => ({ ...r, cleanup: c }),
      runBenchmark: async (_a: unknown, _p: unknown, control: { onCleanup?: () => Promise<unknown> }) => {
        control.onCleanup = async () => ({ workspaceDeleted: true, leftoverRows: 0, note: `Temporary workspace bench-x deleted (${prismaMessage}).` });
        return { kind: "report", report };
      },
    }));
    process.argv = ["node", "scripts/bench-cost.ts", "--out", join(tmp, "report")];
    process.env.DATABASE_URL = url;
    const { errors, output } = captureOutput();
    const code = await new Promise<number>((resolve) => {
      vi.spyOn(process, "exit").mockImplementation(((c?: number) => resolve(c ?? 0)) as typeof process.exit);
      void import("../../scripts/bench-cost");
    });
    expect(code).toBe(0);
    const json = readFileSync(join(tmp, "report.json"), "utf8");
    const md = readFileSync(join(tmp, "report.md"), "utf8");
    for (const [where, text] of [["report.json", json], ["report.md", md], ["stdout", output.join("\n")], ["stderr", errors.join("\n")]] as const) {
      expect(text, where).not.toMatch(MARKERS);
    }
    expect(md).toContain("- Database: dedicated *_test database");
    expect(md).toContain("[database operation failed (details withheld)]");
    expect(JSON.parse(json).headline).toBe("h");
  });
});

describe("ops: bench-cost keeps legitimate text (no over-scrub) while hiding the database", () => {
  /** .env.test.example:10 / CONTRIBUTING.md — the documented test URL (user and password "app", port 5433). */
  const DOC_URL = "postgresql://app:app@localhost:5433/foreman_test?schema=public&options=-c%20TimeZone%3DUTC";
  /** A database user (and password) named like the product. */
  const FOREMAN_URL = "postgresql://foreman:foreman@localhost:5433/foreman_test?schema=public";

  let argv: string[];
  let env: NodeJS.ProcessEnv;
  let tmp: string;
  beforeEach(async () => {
    vi.resetModules();
    trip.dbLoads = 0;
    trip.dbCalls.length = 0;
    argv = process.argv;
    env = { ...process.env };
    const { mkdtempSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    tmp = mkdtempSync(join(tmpdir(), "bench-cost-v6-"));
  });
  afterEach(async () => {
    process.argv = argv;
    for (const k of Object.keys(process.env)) if (!(k in env)) delete process.env[k];
    Object.assign(process.env, env);
    vi.restoreAllMocks();
    const { rmSync } = await import("node:fs");
    rmSync(tmp, { recursive: true, force: true });
  });

  const summary = {
    runs: 1, succeeded: 1, meanTotalUsd: 0.5433, medianTotalUsd: 0.5433, minTotalUsd: 0.5433, maxTotalUsd: 0.5433, meanWorkUsd: 0.5, meanModelOnlyUsd: 0.4,
    meanConvertedUsd: null, meanInputTokens: 5433, meanOutputTokens: 120, meanModelCalls: 3, meanToolCalls: 7, meanChecksScore: null, meanJudgeScore: null,
    meanRunScore: null, meanRecords: 25, breakdownMeanUsd: {}, totalSpentUsd: 0.5433, costPerSuccessUsd: 0.5433,
  };

  it.each([
    ["the documented test URL (user app)", DOC_URL, "app"],
    ["a database user named foreman", FOREMAN_URL, "foreman"],
  ])("a successful run with %s keeps its title, caveats, arm labels and spend line; exit 0", async (_label, url, user) => {
    armDbTripwire();
    const { caveats } = await vi.importActual<typeof import("../../scripts/bench-cost/wording")>("../../scripts/bench-cost/wording");
    const { renderMarkdown } = await vi.importActual<typeof import("../../scripts/bench-cost/markdown")>("../../scripts/bench-cost/markdown");
    const { ARM_LABELS } = await vi.importActual<typeof import("../../scripts/bench-cost/run")>("../../scripts/bench-cost/run");
    vi.doMock("../../scripts/bench-cost/markdown", () => ({ renderMarkdown }));
    const volume = { answer: "25 per run", requested: null, target: 25 };
    const realCaveats = caveats("SIMULATED", "fast", "2026-10-01", volume, { searches: 2, pages: 4 });
    const arm = (id: "after" | "per_step" | "merged") => ({
      label: ARM_LABELS[id], workerName: `Foreman ${id}`, pipeline: ["collector (model, standard)", "rank (code)"], modelSteps: 1, codeSteps: 1,
      codeOperations: ["rank"], converted: {}, foremanEstimatePerRunUsd: 0.5433, summary,
    });
    const report = {
      schemaVersion: 2, generatedAt: "2026-11-21T00:00:00.000Z", mode: "SIMULATED", modeLabel: "SIMULATED — no provider was called",
      job: { description: "Track AI infrastructure funding rounds", title: "Funding tracker", jobFamily: "research", deliverable: "table (csv)" },
      settings: { pairsRequested: 1, baselines: ["per_step", "merged"], beforeTier: "fast", budgetUsd: null, design: "paired", volume },
      environment: { "Foreman commit": "abc1234", Database: "dedicated *_test database" },
      arms: { after: arm("after"), per_step: arm("per_step"), merged: arm("merged") },
      sharedComponents: ["collector"], comparisons: {}, headline: "Foreman's design costs $0.5433 per run", headlines: {},
      wording: { mayQuote: [], liveTemplate: "" }, pairs: [], standIn: null, stoppedEarly: null, cleanup: null, caveats: realCaveats,
    };
    const spendLine = "  Foreman's estimate: about $0.5433 per pair → about $1.6299 for the plan.";
    // A driver-style line that DOES name the database: only its fragments are redacted, the line itself survives.
    const driverLine = `authentication failed for user "${user}" at ${user}:${user}@localhost:5433`;
    vi.doMock("../../scripts/bench-cost/run", () => ({
      withCleanup: (r: object, c: unknown) => ({ ...r, cleanup: c }),
      runBenchmark: async (_a: unknown, _p: unknown, control: { onCleanup?: () => Promise<unknown> }) => {
        console.log(spendLine); // the --live spend line's shape (run.ts), printed through the scrubbed console
        console.warn(driverLine);
        control.onCleanup = async () => ({ workspaceDeleted: true, leftoverRows: 0, note: "Temporary workspace bench-cost-1a2b3c4d deleted; 0 rows left behind." });
        return { kind: "report", report };
      },
    }));
    process.argv = ["node", "scripts/bench-cost.ts", "--out", join(tmp, "report")];
    process.env.DATABASE_URL = url;
    const { errors, output } = captureOutput();
    const code = await new Promise<number>((resolve) => {
      vi.spyOn(process, "exit").mockImplementation(((c?: number) => resolve(c ?? 0)) as typeof process.exit);
      void import("../../scripts/bench-cost");
    });
    const json = JSON.parse(readFileSync(join(tmp, "report.json"), "utf8"));
    const md = readFileSync(join(tmp, "report.md"), "utf8");
    const stdout = output.join("\n");
    const stderr = errors.join("\n");

    expect(code).toBe(0);
    expect(json.caveats).toEqual(realCaveats);
    expect(realCaveats.some((c: string) => c.startsWith("Token counts are approximate"))).toBe(true);
    for (const c of realCaveats) expect(md).toContain(c);
    expect(md).toContain("# Foreman cost per run: mechanical steps in code vs by a model");
    for (const label of Object.values(ARM_LABELS)) expect(md).toContain(label);
    expect(json.headline).toBe("Foreman's design costs $0.5433 per run");
    expect(stdout).toContain(spendLine);
    for (const [where, text] of [["report.json", JSON.stringify(json)], ["report.md", md], ["stdout", stdout]] as const) {
      expect(text, where).not.toContain("details withheld");
      expect(text, where).not.toContain("[redacted]");
    }
    // The leak stays closed: the driver line keeps its words but loses the user and the authority.
    expect(stderr).toContain("authentication failed for user");
    expect(stderr).not.toContain(`"${user}"`);
    expect(stderr).not.toContain(`${user}:${user}@localhost:5433`);
    expect(stderr).not.toMatch(/localhost:5433/);
  });

  it("whole-token, fragment-only: ordinary words survive, every URL fragment is replaced, a malformed prefix never appears", async () => {
    const { scrubDatabaseText, mentionsDatabase } = await import("../../scripts/bench-cost/safety");
    expect(scrubDatabaseText("Token counts are approximate; the app runs fine", DOC_URL)).toBe("Token counts are approximate; the app runs fine");
    expect(scrubDatabaseText("Foreman's design (mechanical steps in code) costs $0.5433", FOREMAN_URL)).toBe("Foreman's design (mechanical steps in code) costs $0.5433");
    expect(mentionsDatabase("Foreman cost per run", FOREMAN_URL)).toBe(false);
    // A quote on one side only is prose, not a driver quoting a name (wording.ts caveat).
    expect(scrubDatabaseText('Do not phrase a result as "Foreman cut cost per run X%"', FOREMAN_URL)).toBe('Do not phrase a result as "Foreman cut cost per run X%"');
    expect(scrubDatabaseText("user=foreman password `foreman`", FOREMAN_URL)).toBe("user=[redacted] password `[redacted]`");
    expect(scrubDatabaseText('role "foreman" does not exist on localhost', FOREMAN_URL)).toBe('role "[redacted]" does not exist on [redacted]');
    const malformed = "postgresql://u:12/SECRETPW@SECRETHOST_test";
    for (const leak of ["connect u:12 refused", "at u:12/SECRETPW@SECRETHOST_test", "user SECRETPW host SECRETHOST_test"]) {
      const out = scrubDatabaseText(leak, malformed);
      expect(out, leak).not.toMatch(/u:12|SECRETPW|SECRETHOST/i);
      expect(out, leak).toContain("[redacted]");
    }
    expect(scrubDatabaseText("menu:123 and u:120 are not the prefix", malformed)).toBe("menu:123 and u:120 are not the prefix");
  });
});

describe("ops: bench-cost prints its report path exactly (F1: no false [redacted] from cwd or --out)", () => {
  const DOC_URL = "postgresql://app:app@localhost:5433/foreman_test?schema=public&options=-c%20TimeZone%3DUTC";
  const FOREMAN_URL = "postgresql://foreman:foreman@localhost:5433/foreman_test?schema=public";

  let argv: string[];
  let env: NodeJS.ProcessEnv;
  let tmp: string;
  beforeEach(async () => {
    vi.resetModules();
    trip.dbLoads = 0;
    trip.dbCalls.length = 0;
    argv = process.argv;
    env = { ...process.env };
    const { mkdtempSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    tmp = mkdtempSync(join(tmpdir(), "bench-cost-v7-"));
  });
  afterEach(async () => {
    process.argv = argv;
    for (const k of Object.keys(process.env)) if (!(k in env)) delete process.env[k];
    Object.assign(process.env, env);
    vi.restoreAllMocks();
    const { rmSync } = await import("node:fs");
    rmSync(tmp, { recursive: true, force: true });
  });

  it.each([
    ["the documented URL (user app)", DOC_URL],
    ["a database user named foreman", FOREMAN_URL],
  ])("with %s and --out under /foreman-…/app-…/foreman/app/, the report path line is printed exactly", async (_label, url) => {
    armDbTripwire();
    vi.doMock("../../scripts/bench-cost/markdown", () => ({ renderMarkdown: () => "# report\n" }));
    vi.doMock("../../scripts/bench-cost/run", () => ({
      withCleanup: (r: object, c: unknown) => ({ ...r, cleanup: c }),
      runBenchmark: async (_a: unknown, _p: unknown, control: { onCleanup?: () => Promise<unknown> }) => {
        control.onCleanup = async () => ({ workspaceDeleted: true, leftoverRows: 0, note: "Temporary workspace bench-x deleted; 0 rows left behind." });
        return { kind: "report", report: { caveats: [], headline: "h" } };
      },
    }));
    // Directory names equal to (or starting/ending with) the database user, password and port, independent of TMPDIR.
    const base = join(tmp, "foreman-run", "app-x", "foreman", "app", "5433", "report");
    process.argv = ["node", "scripts/bench-cost.ts", "--out", base];
    process.env.DATABASE_URL = url;
    const { errors, output } = captureOutput();
    const code = await new Promise<number>((resolve) => {
      vi.spyOn(process, "exit").mockImplementation(((c?: number) => resolve(c ?? 0)) as typeof process.exit);
      void import("../../scripts/bench-cost");
    });
    const stdout = output.join("\n");
    expect(code).toBe(0);
    expect(stdout).toContain(`Report written to ${base}.json and ${base}.md`);
    expect(stdout).not.toContain("[redacted]");
    expect(errors.join("\n")).toBe("");
    expect(readFileSync(`${base}.json`, "utf8")).toContain('"headline": "h"');
  });

  it("a LocalPath keeps directory names but still redacts credential- and host:port-shaped runs", async () => {
    const { LocalPath, scrubLocalPath } = await import("../../scripts/bench-cost/safety");
    for (const p of ["/Users/app/foreman/app-1/foreman-2/report.json", "/tmp/foreman_test/localhost/5433/x.md"]) {
      expect(scrubLocalPath(p, DOC_URL), p).toBe(p);
      expect(scrubLocalPath(p, FOREMAN_URL), p).toBe(p);
    }
    expect(scrubLocalPath("/tmp/app:app@localhost:5433/x.md", DOC_URL)).toBe("/tmp/[redacted]/x.md");
    expect(scrubLocalPath("/tmp/u:12/x.md", "postgresql://u:12/SECRETPW@SECRETHOST_test")).not.toContain("u:12");
    // Without the console scrub a LocalPath prints as its plain path.
    const { inspect } = await import("node:util");
    expect(inspect(new LocalPath("/a/b"))).toBe("/a/b");
  });
});
