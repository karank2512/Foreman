import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * F-017: every exported function in a `"use server"` file is a callable endpoint. CSRF is covered by Next's
 * origin check plus SameSite cookies, but nothing stops a helper from being exported by accident — so this
 * test reads the source of every actions file and asserts the shape the codebase relies on:
 *
 *   1. the file opts into `"use server"`;
 *   2. every export is an `async function` (a "use server" file may export nothing else);
 *   3. it authenticates — `requireSession()` (or `getSession()`) — unless it is a deliberately public entry
 *      point listed below;
 *   4. route handlers stay GET-only and read-only (no side-effectful verbs).
 */

const APP_DIR = path.resolve(import.meta.dirname, "../../src/app");

/** Sign-in, sign-up, invite acceptance and password-reset links are reachable before a session exists — that is their job. */
const PUBLIC_ACTIONS = new Set([
  "signInAction",
  "signUpAction",
  "acceptInviteAction",
  "acceptInvitationAction",
  "resetPasswordAction",
]);
/** Sign-out is safe for an anonymous caller: it clears a cookie and redirects. */
const NO_SESSION_NEEDED = new Set(["signOutAction"]);

function walk(dir: string, match: (file: string) => boolean): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...walk(full, match));
    else if (match(entry)) out.push(full);
  }
  return out;
}

const actionFiles = walk(APP_DIR, (f) => f.endsWith("actions.ts"));
const routeFiles = walk(APP_DIR, (f) => f === "route.ts");

/** Source of one exported function: from its `export …` line to the next top-level `}`. */
function exportedFunctions(source: string): Array<{ name: string; body: string }> {
  const out: Array<{ name: string; body: string }> = [];
  const lines = source.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const match = /^export\s+(async\s+)?function\s+(\w+)/.exec(lines[i] as string);
    if (!match) continue;
    const body: string[] = [];
    for (let j = i; j < lines.length; j++) {
      body.push(lines[j] as string);
      if (lines[j] === "}") break;
    }
    out.push({ name: match[2] as string, body: body.join("\n") });
  }
  return out;
}

describe("server actions are closed by default", () => {
  it("finds the actions files (so this test cannot silently pass)", () => {
    expect(actionFiles.length).toBeGreaterThanOrEqual(8);
  });

  for (const file of actionFiles) {
    const relative = path.relative(APP_DIR, file);
    const source = readFileSync(file, "utf8");

    it(`${relative}: is a "use server" module whose exports all authenticate`, () => {
      expect(source.trimStart().startsWith('"use server"')).toBe(true);

      // A "use server" file may export only async functions — no constants, no classes, no types-as-values.
      const valueExports = source.match(/^export\s+(?!type[\s{]|interface\s).*$/gm) ?? [];
      for (const line of valueExports) expect(line, `${relative}: ${line}`).toMatch(/^export\s+async\s+function/);

      const exported = exportedFunctions(source);
      expect(exported.length, relative).toBeGreaterThan(0);
      for (const fn of exported) {
        if (PUBLIC_ACTIONS.has(fn.name) || NO_SESSION_NEEDED.has(fn.name)) continue;
        expect(
          /requireSession\(|getSession\(/.test(fn.body),
          `${relative}: ${fn.name} must start from requireSession() (or be listed as a public action)`,
        ).toBe(true);
      }
    });
  }
});

describe("route handlers", () => {
  it("only implement GET, and never mutate", () => {
    expect(routeFiles.length).toBeGreaterThanOrEqual(2);
    for (const file of routeFiles) {
      const source = readFileSync(file, "utf8");
      const relative = path.relative(APP_DIR, file);
      const verbs = (source.match(/^export\s+(?:async\s+)?(?:function|const)\s+(GET|POST|PUT|PATCH|DELETE)/gm) ?? []).map((m) =>
        m.slice(m.lastIndexOf(" ") + 1),
      );
      // Auth.js owns its own endpoint (it needs POST for sign-in/sign-out and brings its own CSRF token).
      if (relative.includes(path.join("api", "auth"))) continue;
      for (const verb of verbs) expect(verb, `${relative} exports ${verb}`).toBe("GET");
    }
  });
});
