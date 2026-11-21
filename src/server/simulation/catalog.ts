import type { JobConstraints, Region, Sector } from "./constraints";
import { CATEGORY_GROUPS, SECTOR_OF_GROUP, type CategoryGroup, type CompanyEntity } from "./fixtures/companies";
import { FEEDBACK_CATEGORIES } from "./fixtures/feedback";

/**
 * The simulated web's site map — shared by `search` (which links to these URLs) and `fetchPage` (which
 * serves them), so every search result is guaranteed to be fetchable.
 *
 *   news.example/funding/<slug>                 one funding article per company (= SimCompany.source_url)
 *   news.example/roundups/<id>                  roundups; every company appears in exactly two
 *   <slug>.example[/about]  ·  /pricing         company site + pricing page
 *   compare.example/pricing/<group>             pricing comparison per category group
 *   directory.example/<sector>/<group>          company directory with leadership contacts (lead research)
 *   directory.example/<sector>/search?stage=…   directory search filtered by stage / region / country
 *   reviews.example/acme[/<category>]           customer feedback about the fictional "Acme" product
 *   finance.example/acme/<ledger>               Acme's spend ledger, SaaS subscriptions and vendor invoices
 *   anything else                               a plausible generic article
 *
 * <sector> is "ai-infrastructure" (the default universe) or "fintech".
 */

export const NEWS_HOST = "news.example";
export const COMPARE_HOST = "compare.example";
export const DIRECTORY_HOST = "directory.example";
export const REVIEWS_HOST = "reviews.example";
export const FINANCE_HOST = "finance.example";

export const SECTOR_SLUG: Record<Sector, string> = { ai_infrastructure: "ai-infrastructure", fintech: "fintech" };

export function sectorFromSlug(slug: string): Sector | undefined {
  return (Object.keys(SECTOR_SLUG) as Sector[]).find((s) => SECTOR_SLUG[s] === slug);
}

const slugOf = (value: string) => value.toLowerCase().replace(/[^a-z0-9]+/g, "-");

export const urls = {
  article: (slug: string) => `https://${NEWS_HOST}/funding/${slug}`,
  roundup: (id: string) => `https://${NEWS_HOST}/roundups/${id}`,
  about: (slug: string) => `https://${slug}.example/about`,
  pricing: (slug: string) => `https://${slug}.example/pricing`,
  compare: (group: CategoryGroup) => `https://${COMPARE_HOST}/pricing/${group.replace("_", "-")}`,
  directory: (group: CategoryGroup) => `https://${DIRECTORY_HOST}/${SECTOR_SLUG[SECTOR_OF_GROUP[group]]}/${group.replace("_", "-")}`,
  /** A directory search: every company of the sector that matches the stage / place filters. */
  directorySearch: (sector: Sector, c: Pick<JobConstraints, "stages" | "regions" | "countries">) => {
    const params = [
      ...c.stages.map((s) => `stage=${slugOf(s)}`),
      ...c.regions.map((r) => `region=${slugOf(r)}`),
      ...c.countries.map((x) => `country=${slugOf(x)}`),
    ];
    return `https://${DIRECTORY_HOST}/${SECTOR_SLUG[sector]}/search${params.length > 0 ? `?${params.join("&")}` : ""}`;
  },
  reviews: (category?: string) => `https://${REVIEWS_HOST}/acme${category ? `/${category}` : ""}`,
  finance: (ledger: string) => `https://${FINANCE_HOST}/acme/${ledger}`,
};

/** The filters of a directory-search URL, back in constraint vocabulary. */
export function parseDirectorySearch(params: URLSearchParams, stageNames: readonly string[], regionNames: readonly Region[], countryNames: readonly string[]) {
  const pick = <T extends string>(key: string, names: readonly T[]) =>
    params
      .getAll(key)
      .map((v) => names.find((n) => slugOf(n) === v.toLowerCase()))
      .filter((n): n is T => n !== undefined);
  return { stages: pick("stage", stageNames), regions: pick("region", regionNames), countries: pick("country", countryNames) };
}

export const GROUPS = Object.keys(CATEGORY_GROUPS) as CategoryGroup[];

export function groupFromSlug(slug: string): CategoryGroup | undefined {
  return GROUPS.find((g) => g.replace("_", "-") === slug);
}

export interface Roundup {
  id: string;
  url: string;
  title: string;
  intro: string;
  members: CompanyEntity[];
  /** Published the day its most recent round was announced. */
  publishedDaysAgo: number;
}

const CHRONO_TITLES: Record<Sector, ReadonlyArray<(n: number) => string>> = {
  ai_infrastructure: [
    (n) => `${n} AI infrastructure startups that raised this month`,
    (n) => `AI infra funding roundup: ${n} more rounds you may have missed`,
    (n) => `${n} AI infrastructure rounds from last month, ranked`,
    (n) => `Looking back: ${n} AI infrastructure raises from earlier this quarter`,
  ],
  fintech: [
    (n) => `${n} fintech startups that raised this month`,
    (n) => `Fintech funding roundup: ${n} more rounds you may have missed`,
    (n) => `${n} fintech rounds from last month, ranked`,
  ],
};

const CHRONO_INTRO: Record<Sector, (n: number) => string> = {
  ai_infrastructure: (n) => `Capital keeps flowing into the picks and shovels of AI. Here are ${n} infrastructure rounds our newsroom tracked, newest first.`,
  fintech: (n) => `Payments, lending and compliance infrastructure keep attracting capital. Here are ${n} fintech rounds our newsroom tracked, newest first.`,
};

const CHRONO_ID: Record<Sector, string> = { ai_infrastructure: "ai-infrastructure-raises", fintech: "fintech-raises" };

const GROUP_TITLES: Record<CategoryGroup, (n: number) => string> = {
  compute: (n) => `GPU clouds, training and edge: the ${n} compute startups investors just backed`,
  serving: (n) => `Inference, routing and fine-tuning: ${n} model-serving startups with fresh funding`,
  data: (n) => `Vector databases, labeling and synthetic data: ${n} AI data startups that raised recently`,
  trust_agents: (n) => `Agents, evals and AI security: ${n} startups that closed rounds this quarter`,
  payments: (n) => `Payments, embedded finance and treasury: ${n} fintechs with fresh funding`,
  lending_banking: (n) => `Lending, banking-as-a-service and wealth: ${n} fintechs that raised recently`,
  risk_compliance: (n) => `Compliance, fraud and insurance: ${n} fintechs that closed rounds this quarter`,
};

export const ROUNDUP_SIZE = 12;

/**
 * Two complementary sets, so each company is in exactly one chronological roundup and one thematic roundup:
 * a broad query tends to surface the former, a category-focused query the latter. One universe at a time.
 */
export function buildRoundups(companies: readonly CompanyEntity[], sector: Sector = "ai_infrastructure"): Roundup[] {
  const out: Roundup[] = [];
  const byRecency = companies.slice().sort((a, b) => a.daysAgo - b.daysAgo);
  const titles = CHRONO_TITLES[sector];
  for (let i = 0, n = 0; i < byRecency.length; i += ROUNDUP_SIZE, n++) {
    const members = byRecency.slice(i, i + ROUNDUP_SIZE);
    const id = `${CHRONO_ID[sector]}-${n + 1}`;
    const title = (titles[n] ?? titles[titles.length - 1])(members.length);
    out.push({
      id,
      url: urls.roundup(id),
      title,
      intro: CHRONO_INTRO[sector](members.length),
      members,
      publishedDaysAgo: Math.min(...members.map((m) => m.daysAgo)),
    });
  }
  for (const group of GROUPS) {
    const members = companies.filter((c) => c.group === group).sort((a, b) => b.amount_usd - a.amount_usd);
    if (members.length === 0) continue;
    const id = `${group.replace("_", "-")}-funding`;
    out.push({
      id,
      url: urls.roundup(id),
      title: GROUP_TITLES[group](members.length),
      intro: `${CATEGORY_GROUPS[group].label} is one of the busiest corners of ${sector === "fintech" ? "fintech" : "AI infrastructure"}. These ${members.length} companies announced rounds in the last two months, largest first.`,
      members,
      publishedDaysAgo: Math.min(...members.map((m) => m.daysAgo)),
    });
  }
  return out;
}

const SECTOR_NOUN: Record<Sector, string> = { ai_infrastructure: "AI infrastructure", fintech: "fintech" };

/**
 * The newsroom's "full list": a sector's long tail (fixtures/long-tail.ts), newest first, in parts of the roundup
 * size. Reached only through a "full list" search, never linked from the standard pages.
 */
export function buildFullList(longTail: readonly CompanyEntity[], sector: Sector): Roundup[] {
  const byRecency = longTail.slice().sort((a, b) => a.daysAgo - b.daysAgo);
  const parts = Math.ceil(byRecency.length / ROUNDUP_SIZE);
  return Array.from({ length: parts }, (_, k) => {
    const members = byRecency.slice(k * ROUNDUP_SIZE, (k + 1) * ROUNDUP_SIZE);
    const id = `${CHRONO_ID[sector].replace(/-raises$/, "")}-full-list-${k + 1}`;
    return {
      id,
      url: urls.roundup(id),
      title: `${SECTOR_NOUN[sector]} funding, the full list (part ${k + 1} of ${parts}): ${members.length} more rounds`,
      intro: `Not every round makes our roundups. Part ${k + 1} of ${parts} of the full list: ${members.length} more ${SECTOR_NOUN[sector]} rounds our newsroom logged, newest first.`,
      members,
      publishedDaysAgo: Math.min(...members.map((m) => m.daysAgo)),
    };
  });
}

export function isFeedbackCategory(value: string): boolean {
  return (FEEDBACK_CATEGORIES as readonly string[]).includes(value);
}
