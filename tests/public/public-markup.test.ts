import { createElement as h, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeAll, describe, expect, it } from "vitest";
import { passwordChecklist } from "@/app/(auth)/schema";
import { REPO_URL } from "@/lib/project";
import { DEFAULT_SIGNED_IN_PATH, SIGN_IN_PATH, SIGN_UP_PATH } from "@/server/auth/access";
import { config } from "@/server/config";
import { loadForSsr } from "../pages/_ssr";

type LandingPage = typeof import("@/app/(marketing)/page");
type Footer = typeof import("@/app/(marketing)/_components/site-footer");
type SignUpForm = typeof import("@/app/(auth)/sign-up/sign-up-form");
type PasswordFieldModule = typeof import("@/app/(auth)/_components/password-field");

/**
 * The public pages rendered the way the server first sends them — no hydration, no layout engine. The
 * source-level checks in landing.test.ts / auth-pages.test.ts pin how each fix is written; these pin what a
 * visitor actually receives, so a regression that slips past a regex (a new grid, a new dead link, a
 * reintroduced reveal on the hero) still fails here. Layout-dependent facts (the open menu filling the
 * viewport, no sideways scroll at 390px) were measured in a real browser; the markup rules that produce
 * them are asserted below.
 */

const stubs = {
  // `@/server/auth` pulls in next-auth and Prisma; the public pages only need its path constants and a
  // signed-out session.
  "src/server/auth": { SIGN_IN_PATH, SIGN_UP_PATH, DEFAULT_SIGNED_IN_PATH, getSession: async () => null },
  "src/app/(auth)/actions": { signUpAction: async () => ({ error: null }) },
};

let landingHtml: string;
let footerHtml: string;
let signUpHtml: string;
let passwordField: PasswordFieldModule["PasswordField"];

beforeAll(async () => {
  const [landing, footer, signUp, password] = await Promise.all([
    loadForSsr<LandingPage>("src/app/(marketing)/page.tsx", stubs),
    loadForSsr<Footer>("src/app/(marketing)/_components/site-footer.tsx", stubs),
    loadForSsr<SignUpForm>("src/app/(auth)/sign-up/sign-up-form.tsx", stubs),
    loadForSsr<PasswordFieldModule>("src/app/(auth)/_components/password-field.tsx", stubs),
  ]);
  landingHtml = renderToStaticMarkup((await landing.default()) as ReactElement);
  footerHtml = renderToStaticMarkup(h(footer.SiteFooter, { simulated: true }));
  signUpHtml = renderToStaticMarkup(
    h(signUp.SignUpForm, { inviteCodeRequired: false, passwordMinLength: config.auth.passwordMinLength }),
  );
  passwordField = password.PasswordField;
});

const classLists = (html: string) => [...html.matchAll(/class="([^"]*)"/g)].map((match) => match[1] ?? "");
const hrefs = (html: string) => [...html.matchAll(/<a\b[^>]*\bhref="([^"]*)"/g)].map((match) => match[1] ?? "");
const text = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");

describe("landing page markup", () => {
  it("renders the hero — headline, subhead, calls to action, showcase — without any reveal hold (design-public-auth-011)", () => {
    const hero = landingHtml.slice(0, landingHtml.indexOf("</section>"));
    expect(hero).toContain("<h1");
    expect(hero).toContain("Describe the job. Meet your new hire.");
    expect(hero).toContain(`href="${SIGN_UP_PATH}"`);
    expect(hero).not.toContain("data-reveal");
    expect(hero).toContain("marketing-hero-rise");
  });

  it("gives every breakpoint grid a minmax(0,1fr) phone track (design-public-auth-004)", () => {
    const responsive = classLists(landingHtml).filter((list) => /\b(?:sm|md|lg|xl):grid-cols-\d/.test(list));
    expect(responsive.length).toBeGreaterThanOrEqual(6);
    for (const list of responsive) expect(list, list).toMatch(/(?:^|\s)grid-cols-\d+(?:\s|$)/);
  });

  it("links only to sections that exist on the page, to public routes and to the source (design-public-auth-009)", () => {
    const links = hrefs(landingHtml);
    expect(links.length).toBeGreaterThan(0);
    for (const href of links) {
      if (href.startsWith("#")) expect(landingHtml, href).toContain(`id="${href.slice(1)}"`);
      else expect([SIGN_UP_PATH, SIGN_IN_PATH, REPO_URL], href).toContain(href);
    }
    expect(links).toContain(REPO_URL);
    const copy = text(landingHtml);
    expect(copy).not.toContain("How workers are designed");
    // No "talk to us" promise without a way to talk to anyone.
    expect(copy).not.toMatch(/talk to us/i);
  });
});

describe("marketing footer markup (design-public-auth-005/006)", () => {
  it("renders every item as a real link with a 44px phone row, and no look-alike dead words", () => {
    const anchors = [...footerHtml.matchAll(/<a\b([^>]*)>/g)].map((match) => match[1] ?? "");
    expect(anchors.length).toBeGreaterThan(0);
    for (const attrs of anchors) {
      expect(attrs).toMatch(/\bhref="[^"]+"/);
      expect(attrs).toMatch(/class="[^"]*\bmin-h-11\b/);
    }
    const copy = text(footerHtml);
    for (const word of ["Privacy", "Terms", "About", "Contact", "Help center", "Status"]) {
      expect(copy).not.toContain(word);
    }
  });
});

describe("sign-up form markup (design-public-auth-005)", () => {
  it("has no consent checkbox, an enabled submit button, and says plainly where the data stays", () => {
    expect(signUpHtml).not.toMatch(/role="checkbox"|type="checkbox"/);
    expect(signUpHtml).not.toMatch(/I agree/i);
    const submit = /<button\b[^>]*type="submit"[^>]*>/.exec(signUpHtml)?.[0] ?? "";
    expect(submit).not.toBe("");
    // The attribute, not the `disabled:` variants in its class list.
    expect(submit).not.toMatch(/\sdisabled(?:=|\s|>)/);
    expect(text(signUpHtml)).toContain("stay on the server running this copy of Foreman");
  });
});

describe("password requirement line (design-public-auth-008)", () => {
  const min = config.auth.passwordMinLength;
  const lines = (value: string) => {
    const html = renderToStaticMarkup(
      h(passwordField, { value, onChange: () => {}, minLength: min, context: { name: "Rosa Diaz", email: "rosa@fernwood.test" } }),
    );
    // The visible sentence of each line, without the screen-reader-only "met / not met yet" suffix.
    return [...html.matchAll(/<li\b[^>]*>([\s\S]*?)<\/li>/g)].map((match) =>
      text((match[1] ?? "").replace(/<span class="sr-only">[\s\S]*?<\/span>/g, "")).trim(),
    );
  };

  it("shows exactly one line, 'At least N characters', for an empty or short password", () => {
    expect(lines("")).toEqual([`At least ${min} characters`]);
    expect(lines("short")).toEqual([`At least ${min} characters`]);
  });

  it("stays at one line once a good password meets the length rule", () => {
    expect(lines("Blue-otter-orchard-47")).toEqual([`At least ${min} characters`]);
  });

  it("raises a plain sentence only for the rule actually blocking a long-enough password", () => {
    expect(lines("a".repeat(min + 1))).toEqual([`At least ${min} characters`, "Use a few more different characters."]);
    // 38 two-byte characters plus 8 ASCII: long enough, but over the storage limit.
    const tooManyBytes = "é".repeat(38) + "abcdefgh";
    expect(passwordChecklist(tooManyBytes, min).find((check) => check.id === "bytes")?.ok).toBe(false);
    const bytes = lines(tooManyBytes);
    expect(bytes).toHaveLength(2);
    expect(bytes[1]).toMatch(/too long/i);
    expect(lines("rosadiaz-rosadiaz")).toContain("Leave out your name, email and workspace name.");
  });

  it("never says 'bytes' or 'distinct characters' to the person typing", () => {
    for (const value of ["", "short", "a".repeat(min + 1), "é".repeat(38) + "abcdefgh", "rosadiaz-rosadiaz"]) {
      for (const line of lines(value)) expect(line).not.toMatch(/byte|distinct/i);
    }
  });
});
