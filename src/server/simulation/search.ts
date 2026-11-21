import type { SimSearchResult } from "@/server/simulation/types";
import { COMPARE_HOST, DIRECTORY_HOST, GROUPS, NEWS_HOST, REVIEWS_HOST, buildFullList, buildRoundups, urls, type Roundup } from "./catalog";
import { constraintMisses, countryOfLocation, parseConstraints, regionOfCountry, type JobConstraints, type Sector } from "./constraints";
import { isoDaysAgo, isoNoon } from "./dates";
import { CATEGORY_GROUPS, type CategoryGroup, type CompanyEntity } from "./fixtures/companies";
import { FEEDBACK_CATEGORIES, feedbackItems } from "./fixtures/feedback";
import { financeResults, FINANCE_TERMS } from "./finance-web";
import { allCompanyEntities, sectorEntities } from "./fixtures/fintech";
import { longTailEntities } from "./fixtures/long-tail";
import { pricingFor } from "./fixtures/pricing";
import { hashSeed, seededInt, seededShuffle } from "./rng";
import { clip, formatUsdShort, keywords, sentenceCase, slugify, stem, titleCase, tokenize } from "./text";
import { extractVendorNames, fixtureSlugOf, syntheticVendor, type SyntheticVendor } from "./vendors";

/**
 * `search` — keyword-routed, deterministic web search over the fixture "web" (see catalog.ts).
 * Same query → same results; different queries → different (seeded) orderings, so a worker that runs two
 * searches genuinely widens its coverage.
 */

export type SearchRoute = "companies" | "pricing" | "feedback" | "finance" | "generic";

const DEFAULT_RESULTS = 6;
const MAX_RESULTS = 10;

const ROUTE_TERMS: Record<Exclude<SearchRoute, "generic">, ReadonlySet<string>> = {
  pricing: new Set(["pricing", "price", "priced", "plan", "competitor", "competitive", "comparison", "compare", "versus", "vs", "cost", "tier", "discount", "packaging"]),
  // "review" alone is usually the verb ("review our SaaS spend"); the plural and "customer reviews" count (routeQuery).
  feedback: new Set(["feedback", "complaint", "nps", "churn", "testimonial", "sentiment", "satisfaction", "csat", "voice"]),
  companies: new Set([
    "funding", "funded", "raise", "raised", "startup", "series", "seed", "venture", "investor", "investment", "round", "infrastructure",
    "infra", "gpu", "vector", "inference", "llm", "mlops", "labeling", "annotation", "agent", "tuning", "edge", "ai", "ml", "model",
    "company", "lead", "prospect", "icp", "account", "observability", "evaluation", "eval", "synthetic", "gateway", "training",
    "fintech", "neobank", "insurtech", "wealthtech", "regtech",
  ]),
  finance: FINANCE_TERMS,
};

/** "customer reviews", "app reviews", "G2 reviews" — the noun, not the verb. */
const REVIEW_NOUN = /\b(customer|user|app|product|store|g2|capterra|trustpilot|online)\s+reviews?\b|\breviews\s+(from|of|by)\s+(customers|users)\b/i;

const LEAD_TERMS = new Set(["lead", "prospect", "icp", "contact", "decision", "buyer", "outbound", "account", "sdr", "email"]);

/** Words that appear in almost every company query and therefore say nothing about WHICH companies. */
const NON_DISCRIMINATING = new Set([
  "ai", "infrastructure", "infra", "startup", "funding", "funded", "raise", "raised", "round", "recent", "recently", "latest", "new",
  "company", "announcement", "announced", "news", "week", "weekly", "month", "monthly", "year", "list", "top", "best", "tracker",
  "report", "artificial", "intelligence", "market", "research", "platform", "data", "lead", "prospect", "pricing", "price", "plan",
  "comparison", "compare", "competitor", "find", "track", "2024", "2025", "2026", "2027",
]);

export function routeQuery(query: string): SearchRoute {
  const terms = tokenize(query).map(stem);
  const score = (route: Exclude<SearchRoute, "generic">) => terms.filter((t) => ROUTE_TERMS[route].has(t)).length;
  // Pricing/feedback/finance vocabulary is specific; company vocabulary is broad — so the specific routes count double.
  const scores: Array<[SearchRoute, number]> = [
    ["companies", score("companies")],
    ["pricing", score("pricing") * 2],
    ["feedback", (score("feedback") + (REVIEW_NOUN.test(query) || /\breviews\b/i.test(query) ? 1 : 0)) * 2],
    ["finance", score("finance") * 2],
  ];
  const [best, bestScore] = scores.reduce((a, b) => (b[1] > a[1] ? b : a));
  return bestScore > 0 ? best : "generic";
}

function relevance(c: CompanyEntity, terms: readonly string[], queryLower: string): number {
  if (terms.length === 0 && !queryLower.includes(c.stage.toLowerCase())) return 0;
  const bag = (s: string) => new Set(tokenize(s).map(stem));
  const name = bag(c.company);
  const category = bag(`${c.category} ${CATEGORY_GROUPS[c.group].label}`);
  const place = bag(`${c.hq} ${c.lead_investor} ${placeWords(c.hq)}`);
  const description = bag(c.description);
  let score = 0;
  for (const t of terms) {
    if (name.has(t)) score += 6;
    if (category.has(t)) score += 4;
    if (place.has(t)) score += 2;
    if (description.has(t)) score += 1;
  }
  if (new RegExp(`\\b${c.stage.toLowerCase()}\\b`).test(queryLower)) score += 4;
  return score;
}

const REGION_WORDS: Record<string, string> = {
  Europe: "europe european eu emea",
  "North America": "america american usa",
  "Asia-Pacific": "asia apac",
  "Middle East": "mena",
};

/** Region words for an HQ, so "startups in Europe" can match "Berlin, Germany". */
function placeWords(hq: string): string {
  const country = countryOfLocation(hq);
  const region = regionOfCountry(country);
  return [country ?? "", region ? REGION_WORDS[region] : ""].join(" ");
}

/** How strongly a company matches a query's discriminating words (0 = not at all). Pure; no tie-breaking. */
export function companyRelevance(query: string): (c: CompanyEntity) => number {
  const queryLower = query.toLowerCase();
  const terms = keywords(query, NON_DISCRIMINATING);
  return (c) => relevance(c, terms, queryLower);
}

/** Most relevant first; ties broken by a shuffle seeded from the query (stable, but different per query). */
export function rankCompanies(query: string, companies: readonly CompanyEntity[]): CompanyEntity[] {
  const score = companyRelevance(query);
  const shuffled = seededShuffle(companies, hashSeed(tokenize(query).join(" ")));
  const order = new Map(shuffled.map((c, i) => [c.slug, i]));
  return companies
    .map((c) => ({ c, score: score(c) }))
    .sort((a, b) => b.score - a.score || (order.get(a.c.slug) ?? 0) - (order.get(b.c.slug) ?? 0))
    .map((x) => x.c);
}

function articleResult(c: CompanyEntity): SimSearchResult {
  const amount = formatUsdShort(c.amount_usd);
  return {
    title: `${c.company} raises ${amount} ${c.stage} to scale its ${c.category.toLowerCase()} business`,
    url: c.source_url,
    snippet: clip(`${c.company} has raised ${amount} in ${c.stage} funding led by ${c.lead_investor}. ${c.description}`, 260),
    source: NEWS_HOST,
    publishedAt: isoNoon(c.announced_on),
  };
}

function aboutResult(c: CompanyEntity, now: Date): SimSearchResult {
  return {
    title: `About ${c.company} — ${c.category}`,
    url: urls.about(c.slug),
    snippet: clip(`${c.company} is headquartered in ${c.hq} with a team of about ${c.employees}. ${c.description} Meet the leadership team.`, 260),
    source: `${c.slug}.example`,
    publishedAt: isoNoon(isoDaysAgo(c.daysAgo + 20, now)),
  };
}

function pricingResult(c: CompanyEntity, now: Date): SimSearchResult {
  const pricing = pricingFor(c);
  return {
    title: `Pricing — ${c.company}`,
    url: pricing.pricing_url,
    snippet: clip(`${c.company} pricing: ${pricing.pricing_model.toLowerCase()}. Plans: ${pricing.plans.map((p) => p.name).join(", ")}. ${c.description}`, 260),
    source: `${c.slug}.example`,
    publishedAt: isoNoon(isoDaysAgo(seededInt(hashSeed(`${c.slug}|pricing-page`), 5, 50), now)),
  };
}

function vendorPricingResult(v: SyntheticVendor, now: Date): SimSearchResult {
  return {
    title: `Pricing — ${v.company}`,
    url: v.pricing.pricing_url,
    snippet: clip(`${v.company} pricing: ${v.pricing.pricing_model.toLowerCase()}. Plans: ${v.pricing.plans.map((p) => p.name).join(", ")}. Illustrative prices (simulated).`, 260),
    source: `${v.slug}.example`,
    publishedAt: isoNoon(isoDaysAgo(seededInt(hashSeed(`${v.slug}|pricing-page`), 3, 40), now)),
  };
}

/** Pricing pages of the vendors a query names ("compare Notion, Coda and Airtable pricing"), in the query's order. */
function namedPricingResults(query: string, now: Date): SimSearchResult[] {
  const all = allCompanyEntities(now);
  return extractVendorNames(query).map((name) => {
    const slug = fixtureSlugOf(name);
    const fixture = slug ? all.find((c) => c.slug === slug) : undefined;
    return fixture ? pricingResult(fixture, now) : vendorPricingResult(syntheticVendor(name), now);
  });
}

function roundupResult(r: Roundup, now: Date): SimSearchResult {
  const names = r.members.slice(0, 5).map((c) => `${c.company} (${formatUsdShort(c.amount_usd)} ${c.stage})`);
  return {
    title: r.title,
    url: r.url,
    snippet: clip(`${r.intro} Including ${names.join(", ")} and more.`, 300),
    source: NEWS_HOST,
    publishedAt: isoNoon(isoDaysAgo(r.publishedDaysAgo, now)),
  };
}

function groupPageResult(kind: "compare" | "directory", group: CategoryGroup, companies: readonly CompanyEntity[], now: Date): SimSearchResult {
  const members = companies.filter((c) => c.group === group);
  const names = members.slice(0, 5).map((c) => c.company).join(", ");
  const label = CATEGORY_GROUPS[group].label;
  return kind === "compare"
    ? {
        title: `Pricing compared: ${label}`,
        url: urls.compare(group),
        snippet: `How ${members.length} vendors price their products — list prices and plan details for ${names} and others.`,
        source: COMPARE_HOST,
        publishedAt: isoNoon(isoDaysAgo(9, now)),
      }
    : {
        title: `${label} — company directory`,
        url: urls.directory(group),
        snippet: `Directory of ${members.length} recently funded companies with headquarters, team size and leadership contacts: ${names} and others.`,
        source: DIRECTORY_HOST,
        publishedAt: isoNoon(isoDaysAgo(4, now)),
      };
}

/** Groups ordered by how many of the top-ranked companies they contain. */
function bestGroups(ranked: readonly CompanyEntity[]): CategoryGroup[] {
  const top = ranked.slice(0, 8);
  return GROUPS.slice().sort((a, b) => top.filter((c) => c.group === b).length - top.filter((c) => c.group === a).length);
}

const SECTOR_NOUN: Record<Sector, string> = { ai_infrastructure: "AI infrastructure", fintech: "fintech" };

/**
 * A query that names a stage or a place ("Series A fintech companies in Europe") gets a directory search that
 * lists exactly the matching companies — the page a researcher would actually find first.
 */
function directorySearchResult(sector: Sector, c: JobConstraints, companies: readonly CompanyEntity[], now: Date): SimSearchResult | null {
  if (c.stages.length === 0 && c.regions.length === 0) return null;
  const matching = companies.filter((co) => constraintMisses({ stage: co.stage, location: co.hq }, c).length === 0);
  if (matching.length === 0) return null;
  const stage = c.stages.length > 0 ? `${c.stages.join(" / ")} ` : "";
  const place = c.countries.length > 0 ? ` in ${c.countries.join(" / ")}` : c.regions.length > 0 ? ` in ${c.regions.join(" / ")}` : "";
  const names = matching.slice(0, 5).map((co) => co.company).join(", ");
  return {
    title: `${stage}${SECTOR_NOUN[sector]} companies${place} — ${matching.length} results`,
    url: urls.directorySearch(sector, c),
    snippet: clip(`Directory search: ${matching.length} ${SECTOR_NOUN[sector]} companies${stage ? ` at ${stage.trim()}` : ""}${place}, with HQ, team size, latest round and a key contact: ${names} and others.`, 300),
    source: DIRECTORY_HOST,
    publishedAt: isoNoon(isoDaysAgo(2, now)),
  };
}

function companyResults(query: string, limit: number, now: Date): SimSearchResult[] {
  const constraints = parseConstraints(query);
  const sector = constraints.sector ?? "ai_infrastructure";
  const companies = sectorEntities(sector, now);
  const ranked = rankCompanies(query, companies);
  const leadFlavor = tokenize(query).map(stem).some((t) => LEAD_TERMS.has(t));
  // A query that names nothing specific ("recent AI infra funding") is about recency: its hub pages are the
  // newest roundups, while a specific query ("vector database series A") gets the roundups its companies are in.
  const score = companyRelevance(query);
  const specific = ranked.some((c) => score(c) > 0);
  const top = new Set((specific ? ranked : companies).slice(0, 8).map((c) => c.slug));
  const roundups = buildRoundups(companies, sector)
    .map((r, i) => ({ r, i, hits: r.members.filter((m) => top.has(m.slug)).length }))
    .sort((a, b) => b.hits - a.hits || a.i - b.i)
    .map((x) => x.r);

  // Hub pages (many companies per page) lead; single-company pages fill the rest.
  const standardHubs: SimSearchResult[] = leadFlavor
    ? [groupPageResult("directory", bestGroups(ranked)[0], companies, now), roundupResult(roundups[0], now)]
    : [roundupResult(roundups[0], now), roundupResult(roundups[1], now)];
  const filtered = directorySearchResult(sector, constraints, companies, now);
  const hubs = filtered ? [filtered, standardHubs[0]] : standardHubs;
  const singles = ranked.map((c, i) => (leadFlavor && i % 2 === 0 ? aboutResult(c, now) : articleResult(c)));

  const out: SimSearchResult[] = [];
  let s = 0;
  for (let i = 0; i < limit; i++) {
    if (i === 0) out.push(hubs[0]);
    else if (i === 3 && limit >= 5) out.push(hubs[1]);
    else if (s < singles.length) out.push(singles[s++]);
  }
  return out;
}

/**
 * "… full list of rounds": the parts of the sector's full list (its long tail), in order. The mock collector asks for
 * it when its first read falls short (brain/collector.ts); "of" never survives the stopwords of a job's own queries.
 */
const FULL_LIST = /\bfull list of rounds\b/i;

function fullListResults(query: string, limit: number, now: Date): SimSearchResult[] {
  const sector = parseConstraints(query).sector ?? "ai_infrastructure";
  return buildFullList(longTailEntities(sector, now), sector)
    .slice(0, limit)
    .map((r) => roundupResult(r, now));
}

function pricingResults(query: string, limit: number, now: Date): SimSearchResult[] {
  const companies = sectorEntities(parseConstraints(query).sector, now);
  const ranked = rankCompanies(query, companies);
  const groups = bestGroups(ranked);
  const out: SimSearchResult[] = [];
  let s = 0;
  for (let i = 0; i < limit; i++) {
    if (i === 0) out.push(groupPageResult("compare", groups[0], companies, now));
    else if (i === 3 && limit >= 5) out.push(groupPageResult("compare", groups[1], companies, now));
    else if (s < ranked.length) out.push(pricingResult(ranked[s++], now));
  }
  // Vendors the query names come first — that is who the customer asked about — then the usual comparison pages.
  const named = namedPricingResults(query, now);
  if (named.length === 0) return out;
  const namedUrls = new Set(named.map((r) => r.url));
  return [...named, ...out.filter((r) => !namedUrls.has(r.url))].slice(0, limit);
}

function feedbackResults(query: string, limit: number, now: Date): SimSearchResult[] {
  const items = feedbackItems(now);
  const terms = new Set(tokenize(query).map(stem));
  const categories = FEEDBACK_CATEGORIES.map((category, i) => ({ category, i, hit: terms.has(stem(category)) ? 1 : 0 }))
    .sort((a, b) => b.hit - a.hit || a.i - b.i)
    .map((x) => x.category);
  const overview: SimSearchResult = {
    title: "Acme customer feedback — latest reviews",
    url: urls.reviews(),
    snippet: `Recent customer feedback about Acme across ${FEEDBACK_CATEGORIES.length} themes, from support conversations, NPS surveys, app reviews and sales calls.`,
    source: REVIEWS_HOST,
    publishedAt: isoNoon(items[0]?.received_on ?? isoDaysAgo(1, now)),
  };
  const pages = categories.map((category): SimSearchResult => {
    const inCategory = items.filter((f) => f.category === category);
    const sample = inCategory[0];
    return {
      title: `Acme customer feedback — ${titleCase(category)}`,
      url: urls.reviews(category),
      snippet: clip(`${inCategory.length} recent comments about ${category}. ${sample ? `Review ${sample.id} from ${sample.customer}: "${sample.text}"` : ""}`, 280),
      source: REVIEWS_HOST,
      publishedAt: isoNoon(sample?.received_on ?? isoDaysAgo(2, now)),
    };
  });
  // A category named in the query outranks the overview page.
  const ordered = categories.length > 0 && terms.has(stem(categories[0])) ? [pages[0], overview, ...pages.slice(1)] : [overview, ...pages];
  return ordered.slice(0, limit);
}

const GENERIC_SITES: ReadonlyArray<{ host: string; path: string; title: (t: string) => string; snippet: (t: string) => string }> = [
  { host: "insights.example", path: "articles", title: (t) => `A practical guide to ${t}`, snippet: (t) => `What good looks like for ${t}: the questions to ask, the sources to trust and the mistakes to avoid.` },
  { host: "handbook.example", path: "guides", title: (t) => `${sentenceCase(t)}: a step-by-step playbook`, snippet: (t) => `A repeatable process for ${t}, from defining the brief to reviewing the results each week.` },
  { host: "forum.example", path: "threads", title: (t) => `How does your team handle ${t}?`, snippet: (t) => `Community discussion: practitioners compare notes on ${t}, including tooling, cadence and ownership.` },
  { host: "insights.example", path: "reports", title: (t) => `${sentenceCase(t)} — what changed this year`, snippet: (t) => `An overview of how approaches to ${t} have shifted, and what leading teams are doing differently.` },
  { host: "journal.example", path: "analysis", title: (t) => `Benchmarks and pitfalls: ${t}`, snippet: (t) => `Common failure modes in ${t} and the lightweight checks that catch them early.` },
  { host: "handbook.example", path: "checklists", title: (t) => `Checklist: getting ${t} right`, snippet: (t) => `A one-page checklist for ${t} that you can adapt to your own team.` },
  { host: "weekly.example", path: "issues", title: (t) => `This week in ${t}`, snippet: (t) => `A short digest of the most useful recent writing on ${t}.` },
  { host: "academy.example", path: "lessons", title: (t) => `${sentenceCase(t)} explained in ten minutes`, snippet: (t) => `A primer on ${t} for people who are new to the subject and need to get productive quickly.` },
  { host: "forum.example", path: "questions", title: (t) => `What tools do you use for ${t}?`, snippet: (t) => `Answers from operators on the tools and templates they rely on for ${t}.` },
  { host: "journal.example", path: "opinion", title: (t) => `The case for taking ${t} seriously`, snippet: (t) => `Why ${t} deserves a named owner and a regular cadence rather than ad-hoc effort.` },
];

function genericResults(query: string, limit: number, now: Date): SimSearchResult[] {
  const topic = clip(tokenize(query).join(" "), 80) || "this topic";
  const slug = slugify(topic) || "topic";
  const seed = hashSeed(topic);
  return seededShuffle(GENERIC_SITES, seed)
    .slice(0, limit)
    .map((site, i) => ({
      title: site.title(topic),
      url: `https://${site.host}/${site.path}/${slug}-${i + 1}`,
      snippet: site.snippet(topic),
      source: site.host,
      publishedAt: isoNoon(isoDaysAgo(seededInt(seed + i, 1, 45), now)),
    }));
}

export function search(query: string, opts: { maxResults?: number } | undefined, now: Date): SimSearchResult[] {
  const requested = opts?.maxResults;
  const limit = Math.min(MAX_RESULTS, Math.max(1, Math.floor(Number.isFinite(requested) ? (requested as number) : DEFAULT_RESULTS)));
  const route = routeQuery(query);
  if (route === "companies") return FULL_LIST.test(query) ? fullListResults(query, limit, now) : companyResults(query, limit, now);
  if (route === "pricing") return pricingResults(query, limit, now);
  if (route === "feedback") return feedbackResults(query, limit, now);
  if (route === "finance") return financeResults(query, limit, now);
  return genericResults(query, limit, now);
}
