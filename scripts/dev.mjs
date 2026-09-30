#!/usr/bin/env node
/**
 * Local development runner: starts the Next.js web server AND the run worker, the same two processes that run
 * in production. Runs are executed by the worker, never inside the web server — that keeps the web bundle free
 * of Node-only modules (the Edge runtime compiles instrumentation.ts too) and makes local behaviour match a
 * real deployment.
 *
 *   npm run dev                  → web + worker on http://localhost:3000
 *   npm run dev -- -p 3001       → another port (AUTH_URL follows it for this session)
 *   npm run dev -- -H 0.0.0.0    → reachable from other machines (off by default, see below)
 *   EXECUTOR_MODE=off npm run dev → web only (no runs are executed)
 *   npm run dev:web / npm run worker → either half on its own
 *
 * The web server listens on localhost only unless you pass -H/--hostname: `next dev` would otherwise listen on every
 * interface, and a local install with open sign-up, the public demo account and your provider key must not be
 * reachable from the rest of the Wi-Fi.
 */
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import net from "node:net";

const withWorker = process.env.EXECUTOR_MODE !== "off" && process.env.EXECUTOR_DISABLED !== "true";
const children = [];
let shuttingDown = false;

function start(name, command, args, color, env = process.env) {
  const child = spawn(command, args, { stdio: ["inherit", "pipe", "pipe"], env });
  const tag = `\x1b[${color}m[${name}]\x1b[0m `;
  const pipe = (stream, out) => {
    let buffer = "";
    stream.on("data", (chunk) => {
      buffer += chunk.toString();
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) out.write(line.length > 0 ? `${tag}${line}\n` : "\n");
    });
  };
  pipe(child.stdout, process.stdout);
  pipe(child.stderr, process.stderr);
  child.on("exit", (code, signal) => {
    if (shuttingDown) return;
    process.stdout.write(`${tag}exited (${signal ?? code}) — stopping everything\n`);
    shutdown(typeof code === "number" ? code : 1);
  });
  children.push(child);
  return child;
}

function shutdown(code) {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const child of children) child.kill("SIGTERM");
  // Give the worker its graceful-shutdown window before forcing the issue.
  setTimeout(() => {
    for (const child of children) child.kill("SIGKILL");
    process.exit(code);
  }, 5000).unref();
  let remaining = children.length;
  for (const child of children) child.on("exit", () => --remaining === 0 && process.exit(code));
}

/** The value of `-p 3001` / `--port=3001` style flags in the args passed through to `next dev`. */
function flagValue(args, short, long) {
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === short || arg === long) return args[i + 1];
    if (arg.startsWith(`${long}=`)) return arg.slice(long.length + 1);
  }
  return undefined;
}

/** Something already accepting connections on this port (the Docker stack's web container, another dev server). */
function portTaken(port, host) {
  return new Promise((resolve) => {
    const socket = net.connect({ port, host });
    socket.setTimeout(1000);
    socket.once("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.once("timeout", () => {
      socket.destroy();
      resolve(false);
    });
    socket.once("error", () => resolve(false));
  });
}

/** AUTH_URL as Next.js will see it: the shell wins over .env, as with dotenv. Only this one value is read. */
function configuredAuthUrl() {
  if (process.env.AUTH_URL) return process.env.AUTH_URL;
  if (!existsSync(".env")) return undefined;
  let value;
  for (const line of readFileSync(".env", "utf8").split(/\r?\n/)) {
    const match = /^\s*(?:export\s+)?AUTH_URL\s*=\s*(.*)$/.exec(line);
    if (match) value = match[1].trim().replace(/\s+#.*$/, "").replace(/^(["'])(.*)\1$/, "$2");
  }
  return value || undefined;
}

const LOOPBACK_AUTH_URL = /^http:\/\/(localhost|127\.0\.0\.1|\[::1\])(?::(\d+))?\/?$/;

async function main() {
  const args = process.argv.slice(2);
  const port = Number(flagValue(args, "-p", "--port") ?? process.env.PORT ?? 3000);
  if (!flagValue(args, "-H", "--hostname")) args.push("--hostname", "localhost");

  // Two servers on one port answer different requests (IPv4 vs IPv6) and nothing says so. Say so, and stop.
  if ((await portTaken(port, "127.0.0.1")) || (await portTaken(port, "::1"))) {
    process.stderr.write(
      `[dev] Port ${port} is already in use — is the Docker stack running? Stop its app with \`docker compose stop web worker\` ` +
        `(the database can keep running), or pick another port: npm run dev -- -p ${port + 1}\n`,
    );
    process.exit(1);
  }

  // AUTH_URL is the origin sign-in redirects to, and a plain-http one also turns on the loopback Host check in
  // src/middleware.ts. Unset, it follows the port served; a local one on another port would bounce every sign-in.
  const env = { ...process.env };
  const authUrl = configuredAuthUrl();
  const local = authUrl ? LOOPBACK_AUTH_URL.exec(authUrl) : null;
  if (!authUrl) {
    env.AUTH_URL = `http://localhost:${port}`;
  } else if (local && Number(local[2] ?? 80) !== port) {
    env.AUTH_URL = `http://${local[1]}:${port}`;
    process.stdout.write(`\x1b[90m[dev] AUTH_URL is ${authUrl}; using ${env.AUTH_URL} for this session\x1b[0m\n`);
  }

  start("web", "npx", ["next", "dev", ...args], "36", env);
  if (withWorker) start("worker", "npx", ["tsx", "src/worker.ts"], "35", env);
  else process.stdout.write("\x1b[90m[dev] worker disabled (EXECUTOR_MODE=off) — queued runs will not execute\x1b[0m\n");
}

process.on("SIGINT", () => shutdown(0));
process.on("SIGTERM", () => shutdown(0));

main();
