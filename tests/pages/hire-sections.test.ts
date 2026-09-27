import { createElement as h } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeAll, describe, expect, it } from "vitest";
import { submitShortcutLabel } from "@/app/(app)/hire/schema";
import type { WorkerProposal } from "@/server/domain";
import { makeBlueprint, makeJobSpec } from "../helpers/fixtures";
import { loadForSsr } from "./_ssr";

type Profile = typeof import("@/app/(app)/hire/_components/proposal-profile");
type Details = typeof import("@/app/(app)/hire/_components/proposal-details");
type SpecBody = typeof import("@/app/(app)/hire/_components/spec-body");
type Describe = typeof import("@/app/(app)/hire/_components/describe-form");

/**
 * The hire flow's leaves, rendered the way Next renders them on the server. Two audit findings live in this
 * markup: the proposal's pipeline scroller (design-core-008) and the spec document's field keys plus the
 * Mac-only shortcut hint (design-core-014). Server markup is what a phone lays out before hydration, so a
 * negative margin or a hard-coded glyph here is exactly what the person sees.
 */

const inert = async () => ({ ok: true as const, data: { questionCount: 0, redirectTo: "/hire" } });
const stubs = {
  "next/navigation": {
    useRouter: () => ({ push() {}, replace() {}, refresh() {} }),
    usePathname: () => "/hire",
    useSearchParams: () => new URLSearchParams(),
  },
  "src/app/(app)/hire/actions": { scopeJobAction: inert },
};

const proposal: WorkerProposal = {
  jobSpecId: "spec_test",
  blueprint: makeBlueprint({ withNotifier: true }),
  rationale: ["A researcher plus a cleanup pass keeps the report honest.", "The analyst only runs on clean records."],
  simulated: true,
  generatedAt: "2026-09-01T09:00:00.000Z",
};

let profile: Profile;
let details: Details;
let specBody: SpecBody;
let describeForm: Describe;

beforeAll(async () => {
  const dir = "src/app/(app)/hire/_components";
  [profile, details, specBody, describeForm] = await Promise.all([
    loadForSsr<Profile>(`${dir}/proposal-profile.tsx`, stubs),
    loadForSsr<Details>(`${dir}/proposal-details.tsx`, stubs),
    loadForSsr<SpecBody>(`${dir}/spec-body.tsx`, stubs),
    loadForSsr<Describe>(`${dir}/describe-form.tsx`, stubs),
  ]);
});

describe("hire › proposal pipeline (design-core-008)", () => {
  let html: string;
  beforeAll(() => {
    html = renderToStaticMarkup(h(profile.ProposalPipeline, { proposal, jobTitle: "Weekly funding tracker" }));
  });

  it("lists every step vertically, numbered, in pipeline order", () => {
    const steps = proposal.blueprint.components;
    expect(html.match(/<li\b/g)).toHaveLength(steps.length);
    // Names appear in order, each preceded by its 1-based number.
    let cursor = 0;
    steps.forEach((step, i) => {
      const number = html.indexOf(`>${i + 1}<`, cursor);
      const name = html.indexOf(step.name, number);
      expect(number, `number for step ${i + 1}`).toBeGreaterThan(-1);
      expect(name, `name for step ${i + 1}`).toBeGreaterThan(number);
      cursor = name;
    });
  });

  it("never scrolls sideways or bleeds past the column with a negative margin", () => {
    // These are what clipped the 4th step on desktop, reserved empty height under it and made the phone
    // document 8px wider than the viewport.
    expect(html).not.toMatch(/overflow-x-(auto|scroll)/);
    expect(html).not.toMatch(/(^|[\s"])-mx-/);
    expect(html).not.toMatch(/snap-x/);
    expect(html).not.toMatch(/min-w-\d/);
  });

  it("says how each step works and what the run ends with", () => {
    expect(html).toContain("Thinks · Standard model");
    expect(html).toContain("Automatic · Check required fields");
    expect(html).not.toMatch(/as code/i);
    expect(html).toContain("Ends with");
    // {{date}} is filled the way the runtime titles deliverables (yyyy-MM-dd), not as "Sep 27, 2026".
    expect(html).toMatch(/Weekly AI Infra Funding Report — \d{4}-\d{2}-\d{2}”/);
  });
});

describe("hire › proposal details fold away (design-core-008)", () => {
  it("collapses the rationale and the review method into closed accordion rows", () => {
    const html = renderToStaticMarkup(h(details.ProposalDetails, { proposal }));
    const triggers = html.match(/data-slot="accordion-trigger"/g) ?? [];
    expect(triggers).toHaveLength(2);
    expect(html).toContain("Why this design");
    expect(html).toContain("How the work gets reviewed");
    expect(html).toMatch(/aria-expanded="false"/);
    expect(html).not.toMatch(/aria-expanded="true"/);
    // Closed rows keep their content out of the server markup, so the page is as short as it looks.
    expect(html).not.toContain(proposal.rationale[0]);
    expect(html).not.toContain("The reviewer looks for");
  });
});

describe("hire › spec document field names (design-core-014)", () => {
  let html: string;
  beforeAll(() => {
    html = renderToStaticMarkup(h(specBody.DeliverableSection, { spec: makeJobSpec() }));
  });

  it("prints each record field as a name, not a snake_case key in mono", () => {
    expect(html).toContain("Amount USD");
    expect(html).toContain("Source URL");
    expect(html).toContain("Lead investor");
    expect(html).not.toContain("font-mono");
    // The key is still there for anyone who needs the exact column, but as a tooltip rather than the label.
    expect(html).toMatch(/title="amount_usd"/);
    expect(html).not.toMatch(/>amount_usd</);
  });

  it("keeps the description and the required marker on the same line", () => {
    expect(html).toMatch(/Amount USD<\/span><span[^>]*> — Round size in USD \(required\)/);
  });
});

describe("hire › describe step shortcut hint (design-core-014)", () => {
  it("names the modifier for the keyboard in front of the person", () => {
    expect(submitShortcutLabel("MacIntel")).toBe("⌘ + Enter");
    expect(submitShortcutLabel("macOS")).toBe("⌘ + Enter");
    expect(submitShortcutLabel("iPad")).toBe("⌘ + Enter");
    expect(submitShortcutLabel("Win32")).toBe("Ctrl + Enter");
    expect(submitShortcutLabel("Windows")).toBe("Ctrl + Enter");
    expect(submitShortcutLabel("Linux x86_64")).toBe("Ctrl + Enter");
    expect(submitShortcutLabel("Android")).toBe("Ctrl + Enter");
    expect(submitShortcutLabel(undefined)).toBe("Ctrl + Enter");
  });

  it("server-renders the note without guessing the platform", () => {
    const html = renderToStaticMarkup(h(describeForm.DescribeForm, {}));
    expect(html).toContain("Scoping takes a few seconds.");
    expect(html).not.toContain("⌘");
    expect(html).not.toContain("Ctrl + Enter");
  });
});
