import type { SimFeedbackItem } from "@/server/simulation/types";
import { countryOfLocation, regionOfCountry, type Sector } from "./constraints";
import { type CompanyEntity } from "./fixtures/companies";
import { FEEDBACK_ACTIONS, feedbackItems, type FeedbackCategory } from "./fixtures/feedback";
import { expenseItems, type SimExpense } from "./fixtures/finance";
import { allCompanyEntities } from "./fixtures/fintech";
import { allLongTailEntities } from "./fixtures/long-tail";
import { companyPeople } from "./fixtures/people";
import { pricingFor, type PricingPlan } from "./fixtures/pricing";
import { TICKET_ROUTING, ticketItems, type SimTicket, type TicketCategory } from "./fixtures/tickets";
import type { EntityKind } from "./fields";
import { companyPricingFacts, openRoles, planPricingFacts } from "./pricing-facts";
import { hashSeed, seededInt } from "./rng";
import { clip, escapeRegExp, formatUsdShort } from "./text";
import { fixtureSlugOf, mentionedVendorSlugs, syntheticVendor, vendorDisplayName, vendorSlug, type SyntheticVendor } from "./vendors";

/**
 * "Facts" = everything the simulation knows about one fixture entity, keyed by the canonical names in
 * fields.ts. Extraction and the mock brain build records by resolving requested field names against these.
 */

export type Facts = Record<string, unknown>;

export interface EntityRef {
  kind: EntityKind;
  /** Stable identity: company name / feedback id / ticket id (lower-cased). */
  key: string;
  facts: Facts;
}

function countryOf(hq: string): string {
  return countryOfLocation(hq) ?? (hq.split(",").pop()?.trim() || hq);
}

const STAGE_FIT_BONUS: Record<string, number> = { Seed: 0, "Series A": 8, "Series B": 12, "Series C": 6 };

export function companyFacts(c: CompanyEntity): Facts {
  const people = companyPeople(c.slug, c.group);
  const pricing = pricingFor(c);
  const amountLabel = formatUsdShort(c.amount_usd);
  const country = countryOf(c.hq);
  const categoryLower = c.category.toLowerCase();
  // Recently funded, mid-sized teams score highest: they have budget and are still choosing vendors.
  const fitScore = Math.min(98, 58 + seededInt(hashSeed(`${c.slug}|fit`), 0, 22) + (STAGE_FIT_BONUS[c.stage] ?? 0) + (c.daysAgo <= 21 ? 6 : 0));
  return {
    company: c.company,
    website: c.website,
    source_url: c.source_url,
    category: c.category,
    description: c.description,
    stage: c.stage,
    amount_usd: c.amount_usd,
    amount_label: amountLabel,
    announced_on: c.announced_on,
    lead_investor: c.lead_investor,
    hq: c.hq,
    country,
    region: regionOfCountry(country) ?? "Other",
    employees: c.employees,
    founded_year: 2019 + seededInt(hashSeed(`${c.slug}|founded`), 0, 4),
    notes: `${amountLabel} ${c.stage} led by ${c.lead_investor} — a signal of investor appetite for ${categoryLower}; ${c.company} now has about ${c.employees} people.`,
    fit_reason: `Raised a ${amountLabel} ${c.stage} ${c.daysAgo} days ago (led by ${c.lead_investor}) and is scaling a ~${c.employees}-person ${categoryLower} team — likely buying tooling now.`,
    contact_name: people.buyer.name,
    contact_title: people.buyer.title,
    contact_email: people.buyer.email,
    linkedin_url: people.buyer.linkedin_url,
    fit_score: fitScore,
    open_roles: openRoles(c.slug, c.employees),
    ...companyPricingFacts(c.slug, pricing),
  };
}

/** Per-plan variant used when a spec asks for plan-level pricing rows (one record per company × plan). */
export function planFacts(c: CompanyEntity, plan: PricingPlan): Facts {
  return {
    ...companyFacts(c),
    source_url: pricingFor(c).pricing_url,
    monthly_price_note: null,
    ...planPricingFacts(c.slug, plan),
  };
}

/**
 * A vendor the customer named that the fixture universe does not have: only what its (simulated) pricing page
 * says. No funding, headcount or people are invented for it — those fields stay null.
 */
export function vendorFacts(v: SyntheticVendor): Facts {
  return {
    company: v.company,
    website: v.website,
    source_url: v.pricing.pricing_url,
    category: v.category,
    description: `${v.company} sells ${v.pricing.pricing_model.toLowerCase()} plans (illustrative prices in Simulated mode).`,
    notes: `${v.company}: ${v.pricing.plans.length} published plans, ${v.pricing.free_tier ? "including a free tier" : "no free tier"}.`,
    open_roles: openRoles(v.slug, null),
    ...companyPricingFacts(v.slug, v.pricing),
  };
}

export function vendorPlanFacts(v: SyntheticVendor, plan: PricingPlan): Facts {
  return { ...vendorFacts(v), monthly_price_note: null, ...planPricingFacts(v.slug, plan) };
}

const SENTIMENT_SCORE: Record<SimFeedbackItem["sentiment"], number> = { positive: 0.8, neutral: 0, negative: -0.7 };

function firstSentence(text: string, max = 110): string {
  const m = text.match(/^.*?[.!?](?=\s|$)/);
  return clip((m ? m[0] : text).trim(), max);
}

export function feedbackFacts(f: SimFeedbackItem): Facts {
  const routing = FEEDBACK_ACTIONS[f.category as FeedbackCategory];
  return {
    id: f.id,
    customer: f.customer,
    plan: f.plan,
    channel: f.channel,
    text: f.text,
    received_on: f.received_on,
    category: f.category,
    sentiment: f.sentiment,
    sentiment_score: SENTIMENT_SCORE[f.sentiment],
    severity: f.severity,
    summary: firstSentence(f.text),
    suggested_action: routing?.action ?? null,
    owner_team: routing?.team ?? null,
  };
}

export function expenseFacts(e: SimExpense): Facts {
  const utilization = e.seats && e.active_seats !== null ? Math.round((e.active_seats / e.seats) * 100) / 100 : null;
  return {
    id: e.id,
    invoice_number: e.invoice_number ?? e.id,
    date: e.date,
    vendor: e.vendor,
    product: e.product,
    category: e.category,
    amount_usd: e.amount_usd,
    billing_cycle: e.billing_cycle,
    owner: e.owner,
    team: e.team,
    seats: e.seats,
    active_seats: e.active_seats,
    seat_utilization: utilization,
    renewal_date: e.renewal_date,
    payment_method: e.payment_method,
    status: e.status,
    flag_reason: e.flag_reason,
    notes: e.notes,
    source_url: e.group === "software" ? "https://finance.example/acme/saas" : "https://finance.example/acme/spend",
    group: e.group,
    kind: e.kind,
  };
}

const SLA_HOURS: Record<SimTicket["priority"], number> = { urgent: 1, high: 4, normal: 24, low: 72 };

export function ticketFacts(t: SimTicket): Facts {
  return {
    id: t.id,
    subject: t.subject,
    body: t.body,
    customer: t.customer,
    plan: t.plan,
    channel: t.channel,
    created_on: t.created_on,
    status: t.status,
    category: t.category,
    priority: t.priority,
    sentiment: t.sentiment,
    team: t.team,
    suggested_action: TICKET_ROUTING[t.category as TicketCategory]?.action ?? null,
    sla_hours: SLA_HOURS[t.priority],
  };
}

interface Mention<T> {
  item: T;
  at: number;
}

function companyMentions(text: string, companies: readonly CompanyEntity[]): Array<Mention<CompanyEntity>> {
  const lower = text.toLowerCase();
  const hits: Array<Mention<CompanyEntity>> = [];
  for (const c of companies) {
    const byName = lower.search(new RegExp(`\\b${escapeRegExp(c.company.toLowerCase())}\\b`));
    const byHost = lower.indexOf(`${c.slug}.example`);
    const positions = [byName, byHost].filter((p) => p >= 0);
    if (positions.length > 0) hits.push({ item: c, at: Math.min(...positions) });
  }
  return hits.sort((a, b) => a.at - b.at);
}

/** Companies named in `text` (by name or by their `.example` host), in order of first mention. */
export function mentionedCompanies(text: string, companies: readonly CompanyEntity[]): CompanyEntity[] {
  return companyMentions(text, companies).map((h) => h.item);
}

export const FEEDBACK_ID_RE = /\bFB-\d{4}\b/gi;
export const TICKET_ID_RE = /\bTCK-\d{4}\b/gi;
export const EXPENSE_ID_RE = /\bTXN-\d{4}\b/gi;

const ID_RE: Record<Exclude<EntityKind, "company">, RegExp> = { feedback: FEEDBACK_ID_RE, ticket: TICKET_ID_RE, expense: EXPENSE_ID_RE };

/** Distinct ids matching `pattern`, lower-cased, in order of first mention. */
export function mentionedIds(text: string, pattern: RegExp): string[] {
  const seen = new Set<string>();
  for (const m of text.matchAll(pattern)) seen.add(m[0].toLowerCase());
  return [...seen];
}

/** Everything the simulation "knows", resolved against one clock reading. Build once per call. */
export class EntityIndex {
  /** Every hand-written simulated company, whatever its sector — the universe a brief is about. */
  readonly companies: CompanyEntity[];
  /**
   * Plus the long tail (fixtures/long-tail.ts): mentions and records resolve against all of these, but nothing picks
   * from the long tail unprompted — a worker has to have read about a long-tail company to report it.
   */
  private readonly known: CompanyEntity[];
  readonly feedback: SimFeedbackItem[];
  readonly tickets: SimTicket[];
  readonly expenses: SimExpense[];
  /** Vendors the spec names, in the customer's spelling (used for display names of synthetic vendors). */
  readonly vendorNames: readonly string[];
  private readonly byKey = new Map<string, EntityRef>();
  private readonly byName = new Map<string, CompanyEntity>();
  /** Synthetic vendors seen so far, by slug. */
  private readonly vendors = new Map<string, SyntheticVendor>();

  constructor(now: Date, opts: { vendorNames?: readonly string[] } = {}) {
    this.companies = allCompanyEntities(now);
    this.known = [...this.companies, ...allLongTailEntities(now)];
    this.feedback = feedbackItems(now);
    this.tickets = ticketItems(now);
    this.expenses = expenseItems(now);
    this.vendorNames = opts.vendorNames ?? [];
  }

  /** The company (hand-written or long tail) behind a company ref's key. */
  companyByKey(key: string): CompanyEntity | undefined {
    if (this.byName.size === 0) for (const c of this.known) if (!this.byName.has(c.company.toLowerCase())) this.byName.set(c.company.toLowerCase(), c);
    return this.byName.get(key);
  }

  /** The companies of one universe, newest round first. */
  companiesIn(sector: Sector): CompanyEntity[] {
    return this.companies.filter((c) => c.sector === sector);
  }

  refs(kind: EntityKind): EntityRef[] {
    if (kind === "company") return this.companies.map((c) => this.companyRef(c));
    if (kind === "feedback") return this.feedback.map((f) => this.memo(`feedback:${f.id}`, () => ({ kind: "feedback", key: f.id.toLowerCase(), facts: feedbackFacts(f) })));
    if (kind === "expense") return this.expenses.map((e) => this.memo(`expense:${e.id}`, () => ({ kind: "expense", key: e.id.toLowerCase(), facts: expenseFacts(e) })));
    return this.tickets.map((t) => this.memo(`ticket:${t.id}`, () => ({ kind: "ticket", key: t.id.toLowerCase(), facts: ticketFacts(t) })));
  }

  companyRef(c: CompanyEntity): EntityRef {
    return this.memo(`company:${c.slug}`, () => ({ kind: "company", key: c.company.toLowerCase(), facts: companyFacts(c) }));
  }

  /** The synthetic vendor behind `slug`, named by the spec's spelling, the text's own casing, or the slug. */
  vendor(slug: string, text?: string): SyntheticVendor {
    let v = this.vendors.get(slug);
    if (!v) {
      v = syntheticVendor(vendorDisplayName(slug, { known: this.vendorNames, text }));
      this.vendors.set(slug, v);
    }
    return v;
  }

  vendorRef(v: SyntheticVendor): EntityRef {
    return this.memo(`vendor:${v.slug}`, () => ({ kind: "company", key: v.company.toLowerCase(), facts: vendorFacts(v) }));
  }

  /** The spec's named vendors as refs, in the spec's order: fixture companies as themselves, the rest synthetic. */
  namedRefs(): EntityRef[] {
    return this.vendorNames.map((name) => {
      const slug = fixtureSlugOf(name);
      const fixture = slug ? this.companies.find((c) => c.slug === slug) : undefined;
      return fixture ? this.companyRef(fixture) : this.vendorRef(this.vendor(vendorSlug(name)));
    });
  }

  /** One facts object per published plan (company × plan rows), or null for entities without a price list. */
  planFactsFor(ref: EntityRef): Facts[] | null {
    if (ref.kind !== "company") return null;
    const company = this.known.find((c) => c.company.toLowerCase() === ref.key);
    if (company) return pricingFor(company).plans.map((plan) => planFacts(company, plan));
    const v = [...this.vendors.values()].find((x) => x.company.toLowerCase() === ref.key);
    return v ? v.pricing.plans.map((plan) => vendorPlanFacts(v, plan)) : null;
  }

  /** Entities of `kind` mentioned in free text (page bodies, search snippets), in order of first mention. */
  mentioned(text: string, kind: EntityKind): EntityRef[] {
    if (kind === "company") {
      const lower = text.toLowerCase();
      const hits: Array<Mention<EntityRef>> = companyMentions(text, this.known).map((h) => ({ item: this.companyRef(h.item), at: h.at }));
      // Named vendors outside the fixtures are recognised by their (simulated) pricing page URL.
      for (const slug of mentionedVendorSlugs(text)) hits.push({ item: this.vendorRef(this.vendor(slug, text)), at: lower.indexOf(`${slug}.example/pricing`) });
      return hits.sort((a, b) => a.at - b.at).map((h) => h.item);
    }
    const ids = mentionedIds(text, ID_RE[kind]);
    const byKey = new Map(this.refs(kind).map((r) => [r.key, r]));
    return ids.flatMap((id) => {
      const ref = byKey.get(id);
      return ref ? [ref] : [];
    });
  }

  /** Which fixture entity does this (tool-produced) record describe? Matches ids first, then company names. */
  identify(record: Record<string, unknown>): EntityRef | null {
    const strings = Object.values(record).filter((v): v is string => typeof v === "string");
    for (const s of strings) {
      const id = s.trim().toUpperCase();
      if (/^FB-\d+$/.test(id)) return this.refs("feedback").find((r) => r.key === id.toLowerCase()) ?? null;
      if (/^TCK-\d+$/.test(id)) return this.refs("ticket").find((r) => r.key === id.toLowerCase()) ?? null;
      if (/^TXN-\d+$/.test(id)) return this.refs("expense").find((r) => r.key === id.toLowerCase()) ?? null;
    }
    for (const s of strings) {
      const name = s.trim().toLowerCase();
      const hit = this.known.find((c) => c.company.toLowerCase() === name);
      if (hit) return this.companyRef(hit);
    }
    // A synthetic vendor only when it is already known (seen on the web or named in the spec) — never invented here.
    for (const s of strings) {
      const bySlug = mentionedVendorSlugs(s)[0];
      if (bySlug) return this.vendorRef(this.vendor(bySlug));
      const slug = vendorSlug(s.trim());
      if (slug && (this.vendors.has(slug) || this.vendorNames.some((n) => vendorSlug(n) === slug)) && !fixtureSlugOf(s)) return this.vendorRef(this.vendor(slug));
    }
    return null;
  }

  private memo(key: string, make: () => EntityRef): EntityRef {
    let ref = this.byKey.get(key);
    if (!ref) {
      ref = make();
      this.byKey.set(key, ref);
    }
    return ref;
  }
}
