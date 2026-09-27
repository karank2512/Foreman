import type { JobFamily } from "@/server/domain";
import { namedCompanies } from "./describe";
import { FAMILY_PROFILES, RECIPIENTS_Q, f, q, type FamilyProfile } from "./families";

/**
 * The competitor digest — "Every Monday, summarize what our three main competitors shipped last week". The frozen
 * keyword detector reads that as market research, whose profile is a funding tracker (stage, amount, lead
 * investor), so the brief used to be scoped as funding rounds. The digest keeps the research family (web tools,
 * a researcher and an analyst) but swaps the deliverable for what shipped, when, and why it matters. PURE.
 */

const RELEASES =
  /\b(?:ship(?:s|ped|ping)?|releas(?:e|es|ed|ing)|release notes|changelogs?|launch(?:es|ed|ing)?|product (?:updates?|news|announcements?)|new features?|feature (?:launches|releases|updates))\b/i;
const RIVALS = /\b(?:competitors?|competition|competitive|rivals?)\b/i;
/** A brief about rounds is a funding tracker even when it mentions launches ("…raised and launched"). */
const FUNDING = /\b(?:fund(?:s|ed|ing|rais(?:e|es|ed|ing))?|raised|raises|raising|rounds?|investors?|investments?|valuations?|series [a-e])\b/i;

/** A brief about what competitors (or several named companies) shipped, not about their funding. */
export function isReleaseDigest(text: string): boolean {
  if (!RELEASES.test(text) || FUNDING.test(text)) return false;
  return RIVALS.test(text) || namedCompanies(text).length >= 2;
}

/** A notable update or two per competitor per week is typical; a quiet week has fewer, a launch week more. */
const UPDATES_PER_COMPETITOR = 2;

export const COMPETITOR_DIGEST: FamilyProfile = {
  deliverableNoun: "Competitor Digest",
  deliverableDescription: "What each competitor shipped in the period — features, launches, integrations — each linked to where it was announced, with a summary of what it means for you.",
  // Names the simulated tools can answer (see simulation/fields.ts): "competitor" is the company, "summary" the
  // one-liner. What it means for you lives in the analyst's summary, where it can weigh the updates together.
  fields: [
    f("competitor", "Competitor name", true),
    f("summary", "What shipped, in one sentence", true),
    f("category", "Product area it touches"),
    f("announced_on", "When it shipped or was announced (YYYY-MM-DD)"),
    f("source_url", "Changelog, release note or announcement", true),
  ],
  sections: ["Summary", "Notable releases", "Updates by category"],
  targetCount: 6,
  recordNoun: "updates",
  responsibilities: [
    "Check each competitor's changelog, blog, docs and announcements for what shipped in the period",
    "Capture what shipped and when, with a link to where it was announced",
    "Summarize the changes that matter most, what they mean for you and what to watch next",
  ],
  inputs: [
    { name: "Competitor list", description: "The competitors to watch", source: "user_instruction", required: false },
    { name: "Public web", description: "Competitors' changelogs, blogs, docs and announcements", source: "web", required: true },
  ],
  successCriteria: [
    { id: "coverage", description: "Every notable change the competitors shipped in the period is captured", metric: "Records per run", target: "meets the target" },
    { id: "sourcing", description: "Every update links to where it was announced", metric: "Field completeness", target: "100%" },
    { id: "relevance", description: "The summary says what the changes mean for us, not just what they are", metric: "Quality score", target: ">= 80%" },
  ],
  constraints: ["Only changes shipped or announced since the previous digest", "Prefer the competitor's own changelog or blog over third-party coverage"],
  outOfScope: ["Contacting competitors", "Speculating about unannounced roadmap items"],
  tools: ["web_search", "fetch_url", "extract_data"],
  assumptions: ["Competitors announce what they ship on a changelog, blog, docs page or social account", "English-language sources are sufficient"],
  questions: [
    q(
      "competitors",
      "Which competitors should it cover?",
      "The digest is only as useful as the companies it watches.",
      ["Let the worker pick the most relevant", "Our direct competitors only", "Everyone in the category, up to 10"],
      "e.g. Vectorloom, Lattice Cloud, …",
    ),
    q("dimensions", "What kinds of changes matter most?", "Decides what the worker looks for and what the summary leads with.", [
      "New features and launches",
      "Integrations and partnerships",
      "Pricing and packaging changes",
    ]),
    RECIPIENTS_Q,
  ],
  methodSuffix: " from their changelogs, blogs and announcements",
  recordsPerCompany: UPDATES_PER_COMPETITOR,
};

/** The profile the simulated scoper works from: the family's, or the digest when the brief is about releases. */
export function profileFor(family: JobFamily, description: string): FamilyProfile {
  return family === "market_research" && isReleaseDigest(description) ? COMPETITOR_DIGEST : FAMILY_PROFILES[family];
}
