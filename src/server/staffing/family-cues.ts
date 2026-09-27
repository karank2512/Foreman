import { detectJobFamily, type JobFamily } from "@/server/domain";
import { namedCompanies } from "./describe";
import { isReleaseDigest } from "./digest";

/**
 * Job-family detection for staffing. The frozen domain heuristic counts keywords and breaks ties in favour of
 * whichever family is listed first, so two phrasings trip it up in predictable ways:
 * - prospecting ("a reason each is a good fit for our developer tools") reads as market research, because
 *   "research" and "find companies" are research keywords and fit/ICP language is not;
 * - a competitor pricing monitor ties "competitors" (research) with "pricing" (analysis) and lands on funding;
 * - a digest of what competitors shipped can land on analysis (pricing comparisons) or general; it is research.
 * These cue overrides sit on top of `detectJobFamily` and only redirect research-shaped results. PURE.
 */

const PROSPECTING =
  /\b(?:good fit|great fit|best fit|fits? (?:our|my|the) (?:icp|ideal|profile|product|tools?|platform|offering)|fit for (?:our|my)|target accounts?|ideal customers?|ideal customer profile|icp|prospect(?:s|ing)?|who to sell to|outreach|outbound|decision[- ]makers?|buying signals?|sales pipeline|pipeline for (?:our|my) (?:sales|sdr)s?)\b/i;
const PRICING = /\b(?:pric(?:e|es|ed|ing)|plans?|packaging|tiers?|per[- ]seat|seat minimums?|list prices?)\b/i;
const COMPETITION = /\b(?:competitors?|competition|competitive|rivals?|vendors?|alternatives)\b/i;

const RESEARCH_SHAPED = new Set<JobFamily>(["market_research", "market_analysis", "general"]);

export function detectFamily(text: string): JobFamily {
  const detected = detectJobFamily(text);
  if (!RESEARCH_SHAPED.has(detected)) return detected;
  if (PROSPECTING.test(text)) return "lead_research";
  if (detected !== "market_analysis" && PRICING.test(text) && (COMPETITION.test(text) || namedCompanies(text).length >= 2)) return "market_analysis";
  if (isReleaseDigest(text) && !PRICING.test(text)) return "market_research";
  return detected;
}
