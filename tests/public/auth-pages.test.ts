import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { passwordChecklist } from "@/app/(auth)/schema";
import { config } from "@/server/config";

/**
 * The signed-out pages' presentation, held to its source (vitest compiles `.ts` only, so the components
 * cannot mount here). The checklist helper itself is `.ts` and is exercised for real.
 */

const root = new URL("../../", import.meta.url);
const read = (path: string) => readFile(new URL(path, root), "utf8");
const AUTH = "src/app/(auth)/";

describe("password requirement line (design-public-auth-008)", () => {
  it("lists only 'At least N characters' up front; the other rules surface as sentences when they block", async () => {
    const field = await read(`${AUTH}_components/password-field.tsx`);
    // The length rule is the one permanent line…
    expect(field).toMatch(/\{length \? <ChecklistLine ok=\{length\.ok\}>\{length\.label\}<\/ChecklistLine> : null\}/);
    // …and the rest appear only while the password is already long enough and that rule fails.
    expect(field).toMatch(
      /const problems = length\?\.ok \? checks\.filter\(\(check\) => check\.id !== "length" && !check\.ok\) : \[\];/,
    );
    expect(field).not.toContain("checks.map(");
  });

  it("has a plain-English sentence for every secondary rule the checklist can raise, and never says 'bytes'", async () => {
    const field = await read(`${AUTH}_components/password-field.tsx`);
    const start = field.indexOf("const PROBLEM_COPY");
    const copy = field.slice(start, field.indexOf("};", start));
    const secondary = passwordChecklist("", config.auth.passwordMinLength).filter((check) => check.id !== "length");
    expect(secondary.length).toBeGreaterThan(0);
    for (const check of secondary) {
      expect(copy, check.id).toMatch(new RegExp(`^\\s*${check.id}: "[^"]+",?$`, "m"));
    }
    for (const [, sentence] of copy.matchAll(/:\s*"([^"]+)"/g)) {
      expect(sentence).not.toMatch(/byte/i);
      expect(sentence).toMatch(/\.$/); // a sentence, not a label
    }
  });
});

describe("touch targets (design-public-auth-006)", () => {
  it("gives the auth bar's one action and the wordmark a 44px hit area", async () => {
    const nav = await read(`${AUTH}_components/auth-nav.tsx`);
    expect(nav).toMatch(/href="\/" className="[^"]*(?:^|\s)min-h-11(?:\s|")/);
    expect(nav).toMatch(/href=\{link\.href\}[\s\S]*?className="[^"]*(?:^|\s)h-11(?:\s|")/);
  });

  it("makes the in-field Show/Hide toggle at least 44px square", async () => {
    const field = await read(`${AUTH}_components/field.tsx`);
    const toggle = field.slice(field.indexOf("export function ShowToggle"));
    expect(toggle).toMatch(/className="[^"]*(?:^|\s)h-11(?:\s|")/);
    expect(toggle).toMatch(/className="[^"]*(?:^|\s)min-w-11(?:\s|")/);
  });

  it("pads the tertiary 'Sign in ›' / 'Create an account ›' links to a 44px row", async () => {
    for (const file of ["sign-in/page.tsx", "sign-up/page.tsx", "invite/[token]/page.tsx"]) {
      const source = await read(`${AUTH}${file}`);
      const links = source.match(/<Link[^>]*>/g) ?? [];
      expect(links.length, file).toBeGreaterThan(0);
      for (const link of links) expect(link, `${file}: ${link}`).toContain("py-[11px]");
    }
  });
});

describe("consent copy (design-public-auth-005)", () => {
  it("no longer asks for agreement to documents that don't exist", async () => {
    const form = await read(`${AUTH}sign-up/sign-up-form.tsx`);
    // No consent control, no gate on the submit button, and a true sentence in their place.
    expect(form).not.toContain("<Checkbox");
    expect(form).not.toContain("Tick the box");
    expect(form).not.toMatch(/<SubmitButton[^>]*disabled=/);
    expect(form).toContain("no published terms or privacy policy yet");
  });

  it("drops the unlinked Privacy · Terms words from the auth footer", async () => {
    const layout = await read(`${AUTH}layout.tsx`);
    const footer = layout.slice(layout.indexOf("<footer"), layout.indexOf("</footer>"));
    expect(footer).toContain("AI Staffing Agency");
    expect(footer).not.toContain("Privacy");
    expect(footer).not.toContain("Terms");
  });
});
