import { MAX_FOLLOW_UP_QUESTIONS, type FollowUpQuestion, type JobFamily } from "@/server/domain";
import { jobObject, readFacets, type DescriptionFacets } from "./describe";
import { profileFor } from "./digest";

/**
 * Simulated follow-up questions that respect what the customer already said. Each family's question set is
 * filtered against the description: a dimension the customer covered is not asked again, a half-covered one is
 * narrowed to what is missing, and quick-pick chips reuse the customer's own words. When nothing is left to ask
 * the scoper asks at most one genuinely open question — or none. PURE and deterministic.
 */

type Decision = { keep: false } | { keep: true; question: FollowUpQuestion };

const drop: Decision = { keep: false };
const keep = (question: FollowUpQuestion): Decision => ({ keep: true, question });

const has = (re: RegExp, text: string) => re.test(text);
const listOf = (items: readonly string[]) => (items.length <= 1 ? (items[0] ?? "") : `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`);

const FEEDBACK_SOURCES = /\b(?:support tickets?|tickets|nps|surveys?|app store|app reviews|play store|g2|capterra|trustpilot|reviews|sales calls?|call notes|intercom|zendesk|chat|community|forums?|reddit|social)\b/i;
const FEEDBACK_EMPHASIS = /\b(?:fix first|what to fix|prioriti[sz]|churn|feature requests?|top themes?|by volume|severity|urgent|roadmap|what to do first|most common)\b/i;
const MARKET_DIMENSIONS = /\b(?:pric(?:e|es|ing)|packaging|plans?|positioning|messaging|features?|integrations?|go-to-market|gtm|market share|traction)\b/i;
const TICKET_CATEGORIES = /\b(?:billing|bugs?|how-?to|access|log-?in|integrations?|feature requests?|outages?|data exports?|refunds?|shipping|account)\b/gi;
const EXISTING_CATEGORIES = /\b(?:our|existing|current|helpdesk|zendesk|intercom)\s+(?:\w+\s+)?(?:categories|queues|teams)\b/i;
const PRIORITY_RULES = /\b(?:urgent|high|low)\b[^.]{0,40}\b(?:if|when|means|for|are|is)\b|\bsla\b|\bpriority (?:by|based on|rules?)\b|\b(?:outages?|lost access|enterprise|paying)\b[^.]{0,40}\b(?:urgent|first|high)\b|\boldest first\b/i;
const FINANCE_RECORDS = /\b(?:invoices?|expenses?|transactions?|receipts?|statements?|bank|card|ledger|bills?|payables?|purchase orders?)\b/i;
const FINANCE_RULES = /\$\s?\d|\bover \d|\bthresholds?\b|\bchart of accounts\b|\bpurchase orders?\b|\bduplicates?\b|\bout-of-period\b|\bpolicy\b|\brules?\b/i;
const AUDIENCE = /\b(?:audience|readers|developers|engineers|executives|founders|marketers|buyers|customers|ctos?|cfos?|leaders|leadership|investors)\b/i;
const CONTENT_FORMAT = /\b(?:linkedin|twitter|x) (?:posts?|threads?)\b|\bnewsletters?\b|\bblog(?: posts?)?\b|\barticles?\b|\bemails?\b|\b\d+\s*words\b|\bthreads?\b|\bposts?\b/i;
const TONE = /\b(?:tone|voice|formal|casual|friendly|plain|witty|punchy|conversational|authoritative)\b/i;
const GENERAL_SOURCES = /\b(?:web|internet|online|public sources|our (?:own )?(?:data|records|crm|database|spreadsheets?)|dataset)\b/i;
const SLACK = /\bslack\b|#[a-z][\w-]*/i;

/** "the product team" in "email the summary to the product team". */
function sendTarget(text: string): string | null {
  const m = /\b(?:send|email|e-mail|share|deliver|post|forward|circulate)\b[^.]{0,60}?\bto (?:the |our |my )?([a-z][\w-]*(?: [a-z][\w-]*)?) team\b/i.exec(text);
  return m ? m[1].toLowerCase() : null;
}

function recipients(family: JobFamily, q: FollowUpQuestion, text: string, f: DescriptionFacets): Decision {
  if (f.emails.length > 0 || f.keepInWorkspace || (f.sending && SLACK.test(text))) return drop;
  if (!f.sending) return keep(q);
  // They asked for it to be sent; only the address is missing.
  const team = sendTarget(text);
  const handle = team ? team.replace(/\s+/g, "-") : family === "lead_research" ? "sales" : "team";
  return keep({
    id: q.id,
    question: team ? `Which address should reach the ${team} team?` : "Where should it be sent?",
    why: "Sending gives the worker a notification tool, and every send waits for your approval.",
    suggestions: [`Email ${handle}@company.com`, `Post it in Slack #${handle}`, "Just me, in the workspace for now"],
    placeholder: `e.g. ${handle}@company.com`,
  });
}

function marketFocus(q: FollowUpQuestion, f: DescriptionFacets): Decision {
  const geo = f.geos[0]?.label;
  const stage = listOf(f.stages);
  const segment = f.segments[0];
  const known = [geo, f.stages.length > 0 ? stage : undefined, segment].filter((x): x is string => !!x);
  if (known.length >= 2) return drop;
  if (known.length === 0) return keep(q);
  if (segment) {
    return keep({
      ...q,
      question: `Any geographies or funding stages to focus on within ${segment}?`,
      suggestions: [`${segment}, seed to Series B`, `${segment} in North America and Europe`, `All of ${segment} — any stage or region`],
    });
  }
  if (geo) {
    return keep({
      ...q,
      question: `Which segments or funding stages matter most in ${geo}?`,
      suggestions: [`AI infrastructure in ${geo}`, `${geo}, seed to Series B`, `Anything in ${geo}, any stage`],
    });
  }
  return keep({
    ...q,
    question: `Which segments or geographies matter most for ${stage} companies?`,
    suggestions: [`${stage} AI infrastructure`, `${stage}, North America and Europe`, `Any ${stage} company, anywhere`],
  });
}

function leadProfile(q: FollowUpQuestion, f: DescriptionFacets): Decision {
  const qualifiers = [f.stages.length, f.geos.length, f.signals.length, f.sizes.length, f.roles.length].filter((n) => n > 0).length;
  if (f.segments.length > 0 && qualifiers >= 1) return drop;
  if (f.segments.length === 0 && qualifiers >= 3) return drop;
  const segment = f.segments[0];
  if (!segment) return keep(q);
  return keep({
    ...q,
    question: `Which ${segment} companies are the best fit: size, roles and buying signals?`,
    suggestions: [`${segment}, 50–500 employees, VP Engineering`, `Recently funded ${segment} startups hiring engineers`, `Mid-market ${segment}, Head of Operations`],
  });
}

function competitors(q: FollowUpQuestion, f: DescriptionFacets): Decision {
  if (f.namedCompanies.length >= 2) return drop;
  if (!f.count) return keep(q);
  return keep({
    ...q,
    question: `Which ${f.count} competitors should it cover?`,
    suggestions: [`Let the worker pick the ${f.count} most relevant`, "Our direct competitors — I'll list them", "Everyone in the category, up to 10"],
  });
}

function decide(family: JobFamily, q: FollowUpQuestion, text: string, f: DescriptionFacets): Decision {
  switch (q.id) {
    case "recipients":
      return recipients(family, q, text, f);
    case "volume":
      return f.count ? drop : keep(q);
    case "cadence":
      return f.cadenceMentioned ? drop : keep(q);
    case "focus":
      return marketFocus(q, f);
    case "icp":
      return leadProfile(q, f);
    case "competitors":
      return competitors(q, f);
    case "dimensions":
      return has(MARKET_DIMENSIONS, text) ? drop : keep(q);
    case "sources":
      if (family === "feedback_analysis") return has(FEEDBACK_SOURCES, text) ? drop : keep(q);
      if (family === "finance_ops") return has(FINANCE_RECORDS, text) ? drop : keep(q);
      return has(GENERAL_SOURCES, text) ? drop : keep(q);
    case "priorities":
      return has(FEEDBACK_EMPHASIS, text) ? drop : keep(q);
    case "categories":
      return (text.match(TICKET_CATEGORIES)?.length ?? 0) >= 2 || EXISTING_CATEGORIES.test(text) ? drop : keep(q);
    case "priority":
      return has(PRIORITY_RULES, text) ? drop : keep(q);
    case "rules":
      return has(FINANCE_RULES, text) ? drop : keep(q);
    case "audience":
      return has(AUDIENCE, text) ? drop : keep(q);
    case "format":
      return has(CONTENT_FORMAT, text) ? drop : keep(q);
    default:
      return keep(q);
  }
}

/** When the description answered everything, the one question still worth asking (or none). */
const OPEN_QUESTION: Partial<Record<JobFamily, FollowUpQuestion>> = {
  content: {
    id: "tone",
    question: "What tone should the writing take?",
    why: "Everything else is in your description; tone is what makes a draft sound like you.",
    suggestions: ["Plain and direct", "Friendly and specific", "Concise and strategic"],
  },
  lead_research: {
    id: "disqualifiers",
    question: "Anything that rules a company out?",
    why: "The worker already has your profile; exclusions keep the list clean.",
    suggestions: ["Existing customers", "Fewer than 20 employees", "No exclusions"],
  },
};

export function scopingQuestionsFor(family: JobFamily, description: string): FollowUpQuestion[] {
  const facets = readFacets(description);
  const kept: FollowUpQuestion[] = [];
  for (const q of profileFor(family, description).questions) {
    const decision = decide(family, q, description, facets);
    if (decision.keep) kept.push(decision.question);
  }
  const open = OPEN_QUESTION[family];
  // Tone is only worth asking when the description did not already set it.
  if (kept.length === 0 && open && !(family === "content" && TONE.test(description))) kept.push(open);
  return kept.slice(0, MAX_FOLLOW_UP_QUESTIONS);
}

/** How many targeting facets (segment, stage, region, signal, size, role) a phrase carries. */
function facetHits(phrase: string): number {
  const f = readFacets(phrase);
  return [f.segments, f.stages, f.geos, f.signals, f.sizes, f.roles].filter((list) => list.length > 0).length;
}

/**
 * The phrase that says who or what to target: the job's object when it carries the qualifiers ("Series A
 * fintech companies in Europe that are hiring engineers"), otherwise the clause that does ("…per week:
 * Series A–B fintechs hiring a Head of Data").
 */
function targetPhrase(description: string): string | null {
  const object = jobObject(description);
  const candidates = [
    ...(object ? [object.full] : []),
    ...description
      .split(/[.:;!?\n]|\s[—–]\s|,\s*(?=with\b)/)
      .map((c) => c.trim())
      .filter((c) => c.length >= 8 && c.length <= 160),
  ];
  let best: string | null = null;
  let bestHits = 0;
  for (const c of candidates) {
    const hits = facetHits(c);
    if (hits > bestHits) {
      best = c;
      bestHits = hits;
    }
  }
  return best ?? object?.full ?? null;
}

/**
 * What the description already answered, keyed like the questions it replaced — so a skipped question still
 * shapes the spec (a "Focus: …" constraint, the competitor list as an input).
 */
export function impliedAnswers(family: JobFamily, description: string, asked: readonly string[]): Record<string, string> {
  const f = readFacets(description);
  const out: Record<string, string> = {};
  const questions = profileFor(family, description).questions;
  const skipped = (id: string) => questions.some((q) => q.id === id) && !asked.includes(id);
  const profile = targetPhrase(description);
  if (skipped("focus") && profile) out.focus = profile;
  if (skipped("icp") && profile) out.icp = profile;
  if (skipped("competitors") && f.namedCompanies.length >= 2) out.competitors = f.namedCompanies.join(", ");
  return out;
}
