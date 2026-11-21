import { execSync } from "node:child_process";

/**
 * The checkout the report was produced from: short HEAD, plus whether the tree has uncommitted changes.
 * Read-only: `git status` would otherwise refresh .git/index, so it runs with --no-optional-locks and
 * GIT_OPTIONAL_LOCKS=0. Falls back to APP_VERSION outside a git checkout.
 */
export function gitDescription(): string {
  const opts = { stdio: ["ignore", "pipe", "ignore"] as ["ignore", "pipe", "ignore"], env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" } };
  try {
    const sha = execSync("git rev-parse --short HEAD", opts).toString().trim();
    const dirty = execSync("git --no-optional-locks status --porcelain", opts).toString().trim().length > 0;
    return `${sha}${dirty ? " (with uncommitted changes)" : ""}`;
  } catch {
    return process.env.APP_VERSION ?? "unknown";
  }
}
