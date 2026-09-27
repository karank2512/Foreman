import type { JobFamily } from "@/server/domain";
import { CADENCE_ADJECTIVE, FAMILY_DEFAULT_CADENCE, detectCadence } from "./cues";
import { GEOS, firstSentence, jobObject, startsWithWorkVerb } from "./describe";
import { isReleaseDigest, profileFor } from "./digest";

/**
 * Working titles for simulated scoping. A title is a short noun phrase (≤ 60 chars, never an ellipsis) that
 * names the job the way a manager would: the customer's own first sentence when it already reads like a title
 * ("Weekly competitor pricing check"), otherwise a synthesis of what the worker works on plus the family's
 * deliverable noun ("European Series A Fintech Lead List", "AI Infrastructure Funding Tracker"). PURE.
 */

export const MAX_TITLE_CHARS = 60;

const NOUN_PHRASE_END = /\s+(?:with|for|to|that|which|who|including|every|each|so that|delivered|using|via|from|based on|and (?:send|email|post|share|tell|give))\b|\s*[—–:;,(]|\s-\s/i;
const SMALL_WORDS = new Set(["a", "an", "the", "of", "in", "on", "for", "and", "or", "to", "with", "by", "at", "vs", "from"]);
const HEAD_NOUNS = /^(?:companies|company|startups?|accounts?|businesses|business|firms?|organi[sz]ations?|orgs?|brands?|players?|prospects?|leads?|vendors?)$/i;
const GENERIC_NOUNS = /^(?:pages?|sites?|websites?|data|information|info|details|records?|results?|responses?|items?|entries|stuff|things|updates|news|announcements?|activity)$/i;
const CONTENT_NOUNS = /^(?:posts?|articles?|newsletters?|drafts?|copy|emails?|threads?|blogs?|scripts?|summaries|captions?|updates)$/i;
const TRACK_VERBS = /^(?:track|monitor|watch|check|scan|keep an eye on|keep track of|keep tabs on)$/i;
const COMPANY_FAMILIES = new Set<JobFamily>(["lead_research", "market_research", "market_analysis"]);
/** "what our competitors shipped", "who raised this week": a clause, not a noun phrase a title can be built on. */
const CLAUSE_OBJECT = /^(?:what|who|whom|whose|which|how|why|when|where|whether|if)\b/i;

const cap = (s: string) => (s.length > 0 ? s.charAt(0).toUpperCase() + s.slice(1) : s);

function singular(word: string): string {
  if (/ies$/i.test(word)) return `${word.slice(0, -3)}y`;
  if (/(?:ss|us)$/i.test(word)) return word;
  if (/(?:xes|ches|shes)$/i.test(word)) return word.slice(0, -2);
  return /s$/i.test(word) ? word.slice(0, -1) : word;
}

/** Title Case that keeps acronyms and brand casing ("AI", "SaaS", "ClickUp") and "Series A". */
export function titleCase(text: string): string {
  const words = text.split(/\s+/).filter((w) => w.length > 0);
  return words
    .map((word, i) => {
      const prev = words[i - 1]?.toLowerCase();
      if (prev === "series" && /^[a-e](?:[–-][a-e])?$/i.test(word)) return word.toUpperCase();
      if (/\d/.test(word) || /[A-Z]/.test(word.slice(1)) || (word.length > 1 && word === word.toUpperCase() && /[A-Z]/.test(word))) return word;
      const lower = word.toLowerCase();
      if (i > 0 && SMALL_WORDS.has(lower)) return lower;
      return word
        .split("-")
        .map((part) => cap(part))
        .join("-");
    })
    .join(" ");
}

function familyNoun(family: JobFamily, args: { verb: string; funding: boolean; phrase: string }): string {
  const tracking = TRACK_VERBS.test(args.verb);
  switch (family) {
    case "lead_research":
      return "Lead List";
    case "market_research":
      return args.funding ? "Funding Tracker" : tracking ? "Tracker" : "Research";
    case "market_analysis":
      return tracking ? "Tracker" : "Analysis";
    case "feedback_analysis":
      return /\b(?:feedback|reviews?|surveys?|nps|complaints?|comments?)\b/i.test(args.phrase) ? "Analysis" : "Feedback Analysis";
    case "support_triage":
      return /\b(?:tickets?|requests?|queue|inbox|cases?|emails?)\b/i.test(args.phrase) ? "Triage" : "Ticket Triage";
    case "finance_ops":
      return /^reconcile$/i.test(args.verb) ? "Reconciliation" : "Review";
    case "content":
      return "";
    case "general":
      return tracking ? "Tracker" : "Report";
  }
}

/** Keep the title under the cap by dropping the least informative words first; never add an ellipsis. */
function fit(geo: string, words: string[], suffix: string[]): string {
  const render = (w: string[]) => titleCase([geo, ...w, ...suffix].filter((x) => x.length > 0).join(" "));
  let phrase = [...words];
  if (render(phrase).length > MAX_TITLE_CHARS) {
    const and = phrase.findIndex((w) => /^(?:and|or|&)$/i.test(w));
    if (and > 0) phrase = phrase.slice(0, and);
  }
  while (render(phrase).length > MAX_TITLE_CHARS && phrase.length > 1) phrase = phrase.slice(1);
  let title = render(phrase);
  while (title.length > MAX_TITLE_CHARS && title.includes(" ")) title = title.slice(0, title.lastIndexOf(" "));
  return title.replace(/\s+(?:and|or|of|for|the|a|an|in|on|to|with)$/i, "");
}

function synthesize(description: string, family: JobFamily): string | null {
  const object = jobObject(description);
  if (!object || CLAUSE_OBJECT.test(object.core)) return null;
  let phrase = object.core.replace(/['’]s\b/g, "").replace(/['’]/g, "");
  let funding = false;

  // "funding in AI infrastructure", "newly funded AI startups" → the topic, plus a funding flag for the noun.
  phrase = phrase.replace(/^(?:funding|investments?|funding rounds|rounds|deals)\s+(?:in|into|for|across|of|to)\s+/i, () => {
    funding = true;
    return "";
  });
  phrase = phrase.replace(/^(?:(?:newly|recently|just)\s+)?(?:funded|raised)\s+/i, () => {
    funding = true;
    return "";
  });
  if (/\b(?:funding|funded|raised|rounds?)\b/i.test(firstSentence(description))) funding = true;

  // Pull a region out of the phrase so it can lead as an adjective: "companies in Europe" → "European …".
  let geo = "";
  for (const g of GEOS) {
    const flags = g.re.flags.replace("g", "");
    const within = new RegExp(`\\s+(?:in|across|from|based in|headquartered in|out of|throughout|within)\\s+(?:the\\s+)?(?:${g.re.source})`, flags);
    if (within.test(phrase)) {
      geo = g.adjective === "Global" ? "" : g.adjective;
      phrase = phrase.replace(within, "");
      break;
    }
  }

  // "pricing pages of our five main competitors" → "competitor pricing pages".
  const ofCompetitors = /^(.*?)\s+(?:of|for|from|across|at|on)\s+(?:(?:our|the|my|their)\s+)?(?:[\w-]+\s+){0,2}?(competitors?|rivals?)$/i.exec(phrase);
  if (ofCompetitors && ofCompetitors[1].length > 0) phrase = `${singular(ofCompetitors[2]).toLowerCase()} ${ofCompetitors[1]}`;
  phrase = phrase.replace(/^(?:our|my|the|their)\s+(competitors?|rivals?)\s+/i, (_, c: string) => `${singular(c).toLowerCase()} `);
  phrase = phrase.replace(/^(?:the|our|my|their|all|any|some|new|latest)\s+/i, "");

  const words = phrase.split(/\s+/).filter((w) => w.length > 0);
  while (words.length > 1 && GENERIC_NOUNS.test(words[words.length - 1])) words.pop();
  let head = "";
  if (COMPANY_FAMILIES.has(family) && words.length > 0 && HEAD_NOUNS.test(words[words.length - 1])) head = words.pop() ?? "";
  const suffix = familyNoun(family, { verb: object.verb, funding, phrase: words.join(" ") || head });
  if (words.length === 0 || words.every((w) => GENERIC_NOUNS.test(w))) {
    // Only the head noun is left ("track startups" → "Startup Tracker"), unless the noun already says it ("Lead List").
    if (!head || suffix.toLowerCase().includes(singular(head).toLowerCase())) return null;
    words.splice(0, words.length, cap(singular(head)));
  }

  const suffixWords = suffix.length > 0 ? suffix.split(" ") : [];
  if (family === "content") {
    // A content job reads best as "LinkedIn Posts on Vector Databases".
    const topic = /\b(?:about|covering|on the topic of)\s+([^,.;:—–()]+)/i.exec(description)?.[1]?.replace(/\s+(?:and|with|for|every|each|in)\b.*$/i, "").trim();
    if (!CONTENT_NOUNS.test(words[words.length - 1] ?? "")) suffixWords.push("Content");
    if (topic && topic.split(/\s+/).length <= 4) suffixWords.push("on", ...topic.split(/\s+/));
  } else if (suffixWords.length > 0 && words.length > 0 && !words.some((w) => /^(?:and|or|&)$/i.test(w))) {
    // "support tickets" + "Triage" → "Support Ticket Triage".
    const last = words.length - 1;
    if (/[a-z]s$/i.test(words[last]) && !/(?:ss|us|ics)$/i.test(words[last])) words[last] = singular(words[last]);
  }
  const title = fit(geo, words, suffixWords);
  return title.length >= 3 ? title : null;
}

function fallback(description: string, family: JobFamily): string {
  const cadence = detectCadence(description, FAMILY_DEFAULT_CADENCE[family]);
  return `${CADENCE_ADJECTIVE[cadence.kind]} ${profileFor(family, description).deliverableNoun}`;
}

/** A working title for the job: the customer's first sentence when it already reads like one, else a synthesis. */
export function draftTitleFrom(description: string, family: JobFamily): string {
  const first = firstSentence(description);
  if (first.length > 0 && !startsWithWorkVerb(first)) {
    const nounPhrase = first.replace(NOUN_PHRASE_END, " ").split(" ")[0].trim();
    const words = nounPhrase.split(/\s+/).filter((w) => w.length > 0);
    if (words.length >= 2 && words.length <= 8 && nounPhrase.length <= MAX_TITLE_CHARS) return cap(nounPhrase);
  }
  // A digest is named for what it is ("Weekly Competitor Digest"), not for the clause it summarizes.
  if (family === "market_research" && isReleaseDigest(description)) return fallback(description, family);
  return synthesize(description, family) ?? fallback(description, family);
}
