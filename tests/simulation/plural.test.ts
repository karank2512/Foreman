import { describe, expect, it } from "vitest";
import { plural, pluralNoun } from "@/server/simulation/text";
import { makeJobSpec } from "../helpers/fixtures";
import { componentOf, driveAgent } from "./helpers";

describe("simulation text: pluralNoun", () => {
  it.each([
    // The record nouns the analyst's templates use.
    ["company", "companies"],
    ["ticket", "tickets"],
    ["feedback item", "feedback items"],
    ["lead", "leads"],
    ["line item", "line items"],
    ["pricing record", "pricing records"],
    ["funding round", "funding rounds"],
    ["record", "records"],
    // The general rules.
    ["analysis", "analyses"],
    ["basis", "bases"],
    ["category", "categories"],
    ["day", "days"],
    ["key", "keys"],
    ["address", "addresses"],
    ["status", "statuses"],
    ["tax", "taxes"],
    ["search", "searches"],
    ["wish", "wishes"],
    ["person", "people"],
    ["Person", "People"],
    ["Company", "Companies"],
    ["API", "APIs"],
    ["research", "research"],
    ["customer feedback", "customer feedback"],
    ["category value", "category values"],
    // Never resolves through Object.prototype.
    ["constructor", "constructors"],
    ["1099", "1099s"],
  ])("%s → %s", (one, many) => {
    expect(pluralNoun(one)).toBe(many);
  });

  it("plural() uses it by default and still honours an explicit plural", () => {
    expect(plural(1, "company")).toBe("1 company");
    expect(plural(0, "company")).toBe("0 companies");
    expect(plural(3, "analysis")).toBe("3 analyses");
    expect(plural(2, "reply", "replies")).toBe("2 replies");
  });
});

describe("analyst brain: record nouns are pluralized properly", () => {
  it("writes “companies”, never “companys” or “companie”, across every section", () => {
    const spec = makeJobSpec({
      title: "Vendor Risk Review",
      deliverable: {
        title: "Vendor Risk Digest",
        description: "Vendors by risk area.",
        format: "markdown",
        fields: [
          { name: "company", description: "Company", required: true },
          { name: "category", description: "Risk area", required: true },
          { name: "severity", description: "low / medium / high", required: true },
          { name: "summary", description: "What was found", required: true },
          { name: "employees", description: "Headcount", required: false },
        ],
        sections: [],
        targetCount: 10,
      },
    });
    const plan: Array<[string, number, number]> = [
      ["security", 4, 2],
      ["compliance", 3, 1],
      ["financial", 2, 0],
    ];
    const records = plan.flatMap(([category, n, high], k) =>
      Array.from({ length: n }, (_, j) => ({
        company: `Vendor ${k}${j}`,
        category,
        severity: j < high ? "high" : "low",
        summary: `Finding ${k}${j} in ${category}.`,
        employees: 100 + k * 10 + j,
      })),
    );
    const text = driveAgent({ component: componentOf("analyst"), spec, context: { records } }).final ?? "";

    expect(text).toContain("**9 companies** across **3 category values**");
    expect(text).toMatch(/averaging [\d.]+ per company[;,]/);
    // "What to fix first" counts each category's records.
    expect(text).toContain("**security** — 2 high-severity of 4 companies.");
    expect(text).toContain("**financial** — only 2 companies so far");
    expect(text).not.toMatch(/companys|companie\b/);
  });
});
