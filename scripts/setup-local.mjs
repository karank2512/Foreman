#!/usr/bin/env node
/**
 * `npm run setup:local` — prepares .env for running Foreman with Node on your own machine.
 *
 *   - creates .env from .env.example if it does not exist (readable by you only);
 *   - fills AUTH_SECRET and CREDENTIAL_ENCRYPTION_KEY if they are missing or empty: copied from the Docker stack's
 *     secrets volume when you have already run it (so both paths share sessions and stored credentials — .env
 *     wins in Docker too), generated otherwise;
 *   - sets local defaults — DATABASE_URL for a `foreman_dev` database on the Docker Postgres (`docker compose up -d db`,
 *     localhost:5433; kept apart from the Docker app's own `foreman` database), SIGNUP_MODE=open, DEMO_MODE=true —
 *     only where .env has no value yet. AUTH_URL is left alone: `npm run dev` sets it to the port it serves, and a
 *     value in .env would also pin the Docker stack's (docker-compose.yml derives it from WEB_PORT).
 *
 * It never overwrites a value and never prints a secret, so it is safe to run again at any time. Plain Node with
 * no dependencies, so it works on a fresh clone whatever state node_modules is in.
 */
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const envPath = join(root, ".env");
const examplePath = join(root, ".env.example");

const PROVIDER_KEYS = ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GOOGLE_GENERATIVE_AI_API_KEY"];
const ASSIGNMENT = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$/;

/** The value part of `KEY=value` the way dotenv reads it: quoted, or unquoted up to an inline " #" comment. */
function parseValue(raw) {
  const text = raw.trim();
  const quote = text[0];
  if (quote === '"' || quote === "'" || quote === "`") {
    const end = text.indexOf(quote, 1);
    return end === -1 ? text.slice(1) : text.slice(1, end);
  }
  const comment = text.search(/\s#/);
  return (comment === -1 ? text : text.slice(0, comment)).trim();
}

/** Index of the line dotenv would use for `key` (the last active assignment wins), or -1. */
function findAssignment(lines, key) {
  for (let i = lines.length - 1; i >= 0; i--) {
    const match = ASSIGNMENT.exec(lines[i]);
    if (match && match[1] === key) return i;
  }
  return -1;
}

function readValue(lines, key) {
  const index = findAssignment(lines, key);
  return index === -1 ? "" : parseValue(ASSIGNMENT.exec(lines[index])[2]);
}

const secret = () => randomBytes(32).toString("base64");

const SECRET_KEYS = ["AUTH_SECRET", "CREDENTIAL_ENCRYPTION_KEY"];
/** docker-compose.yml's project is `foreman`, so its generated secrets live in this volume. */
const SECRETS_VOLUME = "foreman_secrets";

/**
 * The secrets the Docker stack generated on its first boot, if it has run on this machine. .env wins over them in
 * Docker, so writing NEW secrets here would sign everyone out of the Docker app and make its stored credentials
 * unreadable the next time it starts. Reading them needs a throwaway container: the volume is not a host path.
 * Returns null when there is no such volume (or no Docker), and { values: null } when it exists but can't be read.
 */
function dockerStackSecrets() {
  const docker = (args) => spawnSync("docker", args, { encoding: "utf8", timeout: 30_000, stdio: ["ignore", "pipe", "ignore"] });
  const volume = docker(["volume", "inspect", SECRETS_VOLUME]);
  if (volume.error || volume.status !== 0) return null;
  // postgres:16 is the image the stack's database already uses; --pull never keeps this from downloading anything.
  const read = docker([
    "run", "--rm", "--network", "none", "--pull", "never", "--entrypoint", "cat",
    "-v", `${SECRETS_VOLUME}:/secrets:ro`, "postgres:16", "/secrets/secrets.env",
  ]);
  if (read.error || read.status !== 0) return { values: null };
  const values = {};
  for (const line of read.stdout.split(/\r?\n/)) {
    const eq = line.indexOf("=");
    const key = line.slice(0, eq);
    if (eq > 0 && SECRET_KEYS.includes(key) && line.slice(eq + 1)) values[key] = line.slice(eq + 1);
  }
  return { values: SECRET_KEYS.every((key) => values[key]) ? values : null };
}

// ── .env ──────────────────────────────────────────────────────────────────────────────────────────────────────
const report = [];
let created = false;
if (!existsSync(envPath)) {
  if (!existsSync(examplePath)) {
    console.error("setup:local: .env.example is missing — run this from a Foreman checkout.");
    process.exit(1);
  }
  writeFileSync(envPath, readFileSync(examplePath, "utf8"), { mode: 0o600 });
  created = true;
}

const original = readFileSync(envPath, "utf8");
const eol = original.includes("\r\n") ? "\r\n" : "\n";
const lines = original.split(/\r?\n/);
let appended = false;

/**
 * Sets `key` only when .env has no value for it. An empty assignment is filled in place; otherwise the line goes
 * right under its commented-out template (`# KEY=…`) when there is one, so it lands in the documented section.
 */
function setDefault(key, value, describe) {
  const index = findAssignment(lines, key);
  if (index !== -1 && parseValue(ASSIGNMENT.exec(lines[index])[2]) !== "") {
    report.push(["kept", key, "already set"]);
    return;
  }
  const line = `${key}="${value}"`;
  if (index !== -1) {
    lines[index] = line;
  } else {
    const template = lines.findIndex((l) => new RegExp(`^\\s*#\\s*${key}\\s*=`).test(l));
    if (template !== -1) {
      lines.splice(template + 1, 0, line);
    } else {
      if (!appended) {
        if (lines.at(-1) === "") lines.pop();
        lines.push("", "# Added by `npm run setup:local`");
        appended = true;
      }
      lines.push(line);
    }
  }
  report.push(["set", key, describe]);
}

// Built from the same POSTGRES_* values docker-compose.yml reads from .env, so the two always agree. The database is
// `<POSTGRES_DB>_dev` on that server: `npm run setup:dev` creates it and re-seeds its demo, and `npm run db:reset`
// drops it, so neither touches the Docker app's own data.
const pg = {
  user: readValue(lines, "POSTGRES_USER") || "app",
  password: readValue(lines, "POSTGRES_PASSWORD") || "app",
  port: readValue(lines, "POSTGRES_PORT") || "5433",
  db: `${readValue(lines, "POSTGRES_DB") || "foreman"}_dev`,
};
const databaseUrl =
  `postgresql://${encodeURIComponent(pg.user)}:${encodeURIComponent(pg.password)}@localhost:${pg.port}/${pg.db}` +
  "?schema=public&options=-c%20TimeZone%3DUTC";

let dockerSecretsWarning = false;
const needsSecrets = SECRET_KEYS.some((key) => readValue(lines, key) === "");
const fromDocker = needsSecrets ? dockerStackSecrets() : null;
if (fromDocker?.values) {
  setDefault("AUTH_SECRET", fromDocker.values.AUTH_SECRET, "copied from the Docker stack (shared with it)");
  setDefault("CREDENTIAL_ENCRYPTION_KEY", fromDocker.values.CREDENTIAL_ENCRYPTION_KEY, "copied from the Docker stack (back it up: stored credentials need it)");
} else {
  dockerSecretsWarning = fromDocker !== null;
  setDefault("AUTH_SECRET", secret(), "generated");
  setDefault("CREDENTIAL_ENCRYPTION_KEY", secret(), "generated (back it up: stored credentials need it)");
}
setDefault("DATABASE_URL", databaseUrl, `localhost:${pg.port}/${pg.db} on the Docker Postgres (created by npm run setup:dev)`);
setDefault("SIGNUP_MODE", "open", "open — anyone who can reach the app can sign up");
setDefault("DEMO_MODE", "true", "true — the demo workspace is offered on the sign-in page");

const next = lines.join(eol);
if (next !== original) writeFileSync(envPath, next.endsWith(eol) ? next : next + eol);

// ── report ────────────────────────────────────────────────────────────────────────────────────────────────────
// Next.js and dotenv never override a variable that is already in the environment, so a key exported in your shell
// (common for anyone who uses an AI SDK or CLI) wins over .env. Report what the app will actually see.
const inShell = (key) => (process.env[key] ?? "").trim() !== "";
const effective = (key) => (inShell(key) ? process.env[key].trim() : readValue(lines, key));
const provider = PROVIDER_KEYS.find((key) => effective(key) !== "");
const where = (key) => (inShell(key) ? "in your shell environment (it wins over .env)" : "in .env");
const forced = ["true", "1"].includes(effective("FORCE_SIMULATED").toLowerCase());
const mode = !provider
  ? "Simulated — no provider key in .env or your shell. Everything works on the built-in mock model, at no cost."
  : forced
    ? `Simulated — ${provider} is set ${where(provider)}, but FORCE_SIMULATED=true${inShell("FORCE_SIMULATED") ? " (from your shell)" : ""} keeps real calls off.`
    : `Live — ${provider} is set ${where(provider)}; real model calls are billed to that key.`;

const width = Math.max(...report.map(([, key]) => key.length));
console.log("");
console.log("Foreman local setup");
console.log(created ? "  created .env from .env.example" : "  using the existing .env (nothing is overwritten)");
for (const [action, key, detail] of report) console.log(`  ${action.padEnd(4)}  ${key.padEnd(width)}  ${detail}`);
console.log("");
console.log(`Mode: ${mode}`);
if (dockerSecretsWarning) {
  console.log("");
  console.log(
    "Warning: the Docker stack on this machine has its own generated secrets, and they couldn't be read (is Docker\n" +
      "running?). The new ones in .env replace them the next time you run `docker compose up`: everyone is signed\n" +
      "out of the Docker app and credentials stored there can't be read. To keep them, start Docker, clear\n" +
      "AUTH_SECRET and CREDENTIAL_ENCRYPTION_KEY in .env, and run npm run setup:local again.",
  );
}

const major = Number(process.versions.node.split(".")[0]);
if (major < 22) {
  console.log("");
  console.log(`Warning: Foreman needs Node 22 or newer; this is Node ${process.versions.node}.`);
}

console.log(`
Next steps
  1. Start Postgres         docker compose up -d db      (or point DATABASE_URL in .env at your own Postgres 14+)
  2. Migrate + demo data    npm run setup:dev
  3. Start web + worker     npm run dev                  then open http://localhost:3000
                            (if the Docker app is running, stop it first: docker compose stop web worker)

Optional: to use real models, put ONE key in .env — ANTHROPIC_API_KEY, OPENAI_API_KEY or
GOOGLE_GENERATIVE_AI_API_KEY — and check it with \`npm run smoke:live\` (one tiny call per model it would
serve). Usage is billed to your own account. A key exported in your shell wins over .env.
`);
