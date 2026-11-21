import type { Sector } from "../constraints";
import { hashSeed, seededInt, seededPick, seededShuffle } from "../rng";
import { CATEGORY_GROUPS, COMPANY_FIXTURES, entitiesFrom, SECTOR_OF_GROUP, type CategoryGroup, type CompanyEntity, type CompanyFixture } from "./companies";
import { FINTECH_FIXTURES } from "./fintech";

/**
 * The LONG TAIL of each fixture universe: rounds that never made the hand-written roundups. Generated, CLEARLY
 * FICTIONAL and deterministic (a pure function of the sector and an index; dates resolve against the clock like
 * every other fixture), with investors and headquarters drawn from the hand-written universe of the same sector
 * and dates inside the same window.
 *
 * Nothing in the standard fixture web links to it: only a "full list" search reaches it (search.ts), which the
 * mock collector runs when its usual reading leaves it short of the volume the job asks for (brain/collector.ts).
 * So every job whose target the hand-written universe already covers sees exactly what it saw before.
 */

export const LONG_TAIL_SIZE = 120;

const PREFIXES = [
  "Alder", "Basalt", "Cobalt", "Dovetail", "Ember", "Fathom", "Glint", "Halyard", "Ironwood", "Juniper", "Keel", "Larch",
  "Marlin", "Nimbus", "Onyx", "Pylon", "Quarry", "Rook", "Sable", "Tessel", "Umber", "Vesper", "Wren", "Yarrow",
] as const;

const SUFFIXES: Record<Sector, readonly string[]> = {
  ai_infrastructure: ["stack", "grid", "forge", "base", "works", "scale", "core", "loop", "layer", "mind", "ops", "labs"],
  fintech: ["pay", "ledger", "fund", "bank", "vault", "mint", "coin", "wise", "rail", "trust", "cap", "fi"],
};

/** What a company in each category sells, as the middle of a one-line description. */
const OFFERING: Record<string, string> = {
  "GPU Cloud": "GPU capacity",
  "Training Orchestration": "training-job scheduling",
  "Edge AI": "on-device inference tooling",
  "Inference Platform": "managed model serving",
  "Model Gateway": "a model gateway with routing and spend controls",
  "Fine-Tuning": "fine-tuning and adapter hosting",
  "Vector Database": "vector search",
  "Data Labeling": "data labeling",
  "Synthetic Data": "synthetic training data",
  "Evaluation & Observability": "LLM evaluation and monitoring",
  "Agent Infrastructure": "agent runtimes and tool connectors",
  "AI Security & Governance": "AI security and policy controls",
  "Payments Infrastructure": "payment processing APIs",
  "Embedded Finance": "embedded payments and cards",
  "Treasury & FX": "treasury and FX automation",
  Lending: "lending infrastructure",
  "Banking-as-a-Service": "accounts and card issuing",
  WealthTech: "investing and savings products",
  "RegTech & Compliance": "compliance automation",
  "Fraud Prevention": "fraud detection",
  InsurTech: "embedded insurance",
};

const AUDIENCES: Record<Sector, readonly string[]> = {
  ai_infrastructure: ["AI labs", "enterprise ML teams", "startups shipping LLM features", "regulated industries", "industrial and robotics teams", "developer platforms"],
  fintech: ["marketplaces", "small businesses", "mid-market finance teams", "banks and credit unions", "vertical SaaS platforms", "fintechs expanding across Europe"],
};

const ANGLES: Record<Sector, readonly string[]> = {
  ai_infrastructure: ["priced by usage", "deployed in the customer's own cloud", "with an open-source core", "for teams without a platform group", "with a self-serve tier", "with on-prem options"],
  fintech: ["priced per transaction", "with instant settlement", "on open-banking rails", "with a no-code dashboard", "licensed in several EU markets", "with real-time reporting"],
};

/** Stage mix of a long tail: mostly early rounds. Amounts (USD millions) and team sizes per stage. */
const STAGES: ReadonlyArray<{ stage: CompanyFixture["stage"]; upTo: number; amount: [number, number]; employees: [number, number] }> = [
  { stage: "Seed", upTo: 30, amount: [20, 90], employees: [8, 25] },
  { stage: "Series A", upTo: 70, amount: [100, 350], employees: [25, 80] },
  { stage: "Series B", upTo: 92, amount: [360, 900], employees: [70, 180] },
  { stage: "Series C", upTo: 100, amount: [1000, 2200], employees: [180, 350] },
];

const HAND_WRITTEN: Record<Sector, readonly CompanyFixture[]> = { ai_infrastructure: COMPANY_FIXTURES, fintech: FINTECH_FIXTURES };
const unique = (values: readonly string[]) => [...new Set(values)].sort();

function longTailFixtures(sector: Sector): CompanyFixture[] {
  const universe = HAND_WRITTEN[sector];
  const investors = unique(universe.map((f) => f.lead_investor));
  const places = unique(universe.map((f) => f.hq));
  const window = Math.max(...universe.map((f) => f.daysAgo));
  const categories = (Object.keys(CATEGORY_GROUPS) as CategoryGroup[]).filter((g) => SECTOR_OF_GROUP[g] === sector).flatMap((g) => CATEGORY_GROUPS[g].categories);
  const names = seededShuffle(
    PREFIXES.flatMap((p) => SUFFIXES[sector].map((s) => `${p}${s}`)),
    hashSeed(`long-tail|${sector}|names`),
  ).slice(0, LONG_TAIL_SIZE);
  return names.map((company, i) => {
    const seed = (what: string) => hashSeed(`long-tail|${sector}|${i}|${what}`);
    const category = categories[i % categories.length];
    const roll = seededInt(seed("stage"), 1, 100);
    const band = STAGES.find((s) => roll <= s.upTo) ?? STAGES[STAGES.length - 1];
    const offering = OFFERING[category] ?? category.toLowerCase();
    return {
      company,
      slug: company.toLowerCase(),
      category,
      description: `${offering.charAt(0).toUpperCase()}${offering.slice(1)} for ${seededPick(AUDIENCES[sector], seed("audience"))}, ${seededPick(ANGLES[sector], seed("angle"))}.`,
      stage: band.stage,
      amount_usd: seededInt(seed("amount"), band.amount[0], band.amount[1]) * 100_000,
      daysAgo: seededInt(seed("days"), 1, window),
      lead_investor: seededPick(investors, seed("investor")),
      hq: seededPick(places, seed("hq")),
      employees: seededInt(seed("employees"), band.employees[0], band.employees[1]),
    };
  });
}

const FIXTURES: Record<Sector, readonly CompanyFixture[]> = {
  ai_infrastructure: longTailFixtures("ai_infrastructure"),
  fintech: longTailFixtures("fintech"),
};

/** One sector's long tail, most recent round first. */
export function longTailEntities(sector: Sector, now: Date): CompanyEntity[] {
  return entitiesFrom(FIXTURES[sector], now);
}

/** Both long tails, for resolving pages, mentions and records. */
export function allLongTailEntities(now: Date): CompanyEntity[] {
  return [...longTailEntities("ai_infrastructure", now), ...longTailEntities("fintech", now)];
}
