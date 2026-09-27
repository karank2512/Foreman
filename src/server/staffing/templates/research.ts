import type { BlueprintDraft } from "@/server/domain";
import { agentDraft, fieldGuide, jobFacts, NO_INVENTION, NOTIFY_REASON, persona, reason, sharedRationale, volumeLine, type TemplateContext } from "./shared";

/** Web-research families: market_research, market_analysis, lead_research. */

const WEB_TOOLS = ["web_search", "fetch_url", "extract_data"];

const WEB_METHOD = [
  "Method: start with two or three focused web searches (topic + timeframe, topic + a narrower segment), then open the most promising results with fetch_url — announcements, company pages, credible trade press — and pull structured records out of what you read with extract_data, passing the exact field names below. Prefer primary sources over aggregators, and the most recent source over an older one when they disagree.",
  "Keep going until you have covered the target volume from at least three distinct sources, or until further searching stops turning up anything new. Do not re-run the same search with trivial wording changes.",
].join("\n\n");

export function marketResearchTemplate(ctx: TemplateContext): BlueprintDraft {
  const { spec } = ctx;
  const keyField = ctx.pick("company", "competitor", "company_name", "startup", "name", "title");
  const rankBy = ctx.pick("amount_usd", "amount", "round_size", "funding_amount", "raised_usd") || ctx.numeric();
  const groupBy = ctx.pick("category", "sector", "segment", "stage", "industry");
  // A competitor digest has several updates per competitor, so a row is one competitor × one update.
  const update = keyField === "competitor" ? ctx.pick("summary", "update", "headline") : "";
  const keyFields = [keyField, update].filter((k) => k !== "");
  const digest = update !== "";
  const conventions = [
    ctx.pick("amount_usd", "amount", "round_size", "funding_amount", "raised_usd") ? 'amounts are numbers in USD (convert "$40M" to 40000000)' : "",
    ctx.has("stage") ? "stages use the standard labels (Pre-seed, Seed, Series A…)" : "",
    "dates are ISO (YYYY-MM-DD)",
  ].filter((c) => c !== "");

  const collector = agentDraft({
    name: "Researcher",
    description: digest
      ? "Finds what each competitor shipped — features, launches, integrations — on their own pages and in the press."
      : "Finds and structures recent market activity — companies, funding rounds, launches — from public sources.",
    goal: `Collect a complete, sourced set of records for the ${spec.deliverable.title}.`,
    modelTier: "standard",
    tools: WEB_TOOLS,
    paragraphs: [
      `You are a meticulous market researcher working for a client. ${jobFacts(spec)}`,
      WEB_METHOD,
      fieldGuide(spec),
      `Quality bar: every record names its source URL; ${conventions.join("; ")}. ${NO_INVENTION}`,
      volumeLine(spec, "records"),
      digest
        ? "Avoid: marketing fluff, rumours and roadmap teasers, and anything shipped outside the job's timeframe. One record per competitor per change — if the same release is covered twice, keep the competitor's own announcement."
        : "Avoid: press-release fluff, companies that merely mention the topic, and anything outside the job's timeframe or constraints. One record per company per event — if the same round is reported twice, keep the better-sourced version.",
    ],
  });

  const analyst = agentDraft({
    name: "Analyst",
    description: "Turns the collected records into a short, specific briefing of what changed and why it matters.",
    goal: `Write the narrative sections of the ${spec.deliverable.title} from the ranked records.`,
    modelTier: "standard",
    tools: [],
    paragraphs: [
      `You are a market analyst writing for a busy executive. You are given the ranked records${groupBy ? ` and a breakdown by ${groupBy.replace(/_/g, " ")}` : ""} that a researcher just collected for: ${spec.objective.trim()}`,
      "Lead with the two or three things that actually changed this period, each backed by a number or a named example from the records (largest items, fastest-growing category, notable investors or players). Then note what is missing or surprising. Close with two or three things worth watching next run.",
      "Quality bar: every claim traces back to the records you were given; no generic market commentary, no filler, no restating the table. Use short paragraphs and bullet lists; bold the names and numbers that matter. Write 250–450 words.",
      "Avoid: hedging language, speculation about companies not in the records, and advice unrelated to the job's objective.",
    ],
  });

  return {
    persona: persona(
      ctx,
      digest
        ? `${ctx.name} watches your competitors for you: reads their changelogs, blogs and announcements, notes what shipped and writes up what it means for you. Every update links to where it was announced.`
        : `${ctx.name} tracks the market for you every ${spec.cadence.kind === "daily" ? "day" : "week"}: searches, verifies, structures what was found, and writes the briefing a good analyst would. Every record cites its source.`,
    ),
    responsibilities: spec.responsibilities.slice(0, 8),
    collector,
    analyst,
    steps: { validate: true, dedupe: keyFields.length > 0, rank: rankBy !== "", computeStats: groupBy !== "" && spec.deliverable.format === "markdown", notify: ctx.notify },
    keyFields,
    rankBy,
    rankDirection: "desc",
    groupBy,
    toolReasons: [
      reason("web_search", "Find recent announcements, coverage and company pages on the topic."),
      reason("fetch_url", "Open the sources behind each result to verify details before recording them."),
      reason("extract_data", "Turn article text into clean records with exactly the fields the job asks for."),
      reason("send_notification", NOTIFY_REASON),
    ],
    rationale: [
      "Web research is the core skill here, so the researcher works on the standard model: the cheaper fast model tends to drop fields and repeat sources, which is exactly what a research report cannot afford.",
      ...sharedRationale(ctx, { validate: true, dedupe: keyFields.length > 0, keyFields, rankBy }),
      spec.deliverable.format === "markdown"
        ? "A separate analyst writes the summary from the cleaned records, and the report is assembled the same way every run, so every issue has the same structure."
        : `The deliverable is a ${spec.deliverable.format.toUpperCase()} of the cleaned records, ready to import.`,
    ],
  };
}

export function marketAnalysisTemplate(ctx: TemplateContext): BlueprintDraft {
  const { spec } = ctx;
  const keyField = ctx.pick("company", "vendor", "competitor", "product", "name");
  // Plan-level rows ("each competitor's plans") are one per company × plan, so the plan is part of the key.
  const planField = ctx.pick("plan_name", "plan", "tier_name");
  const rankBy = ctx.pick("starting_price_usd", "price_usd", "monthly_price_usd", "amount_usd") || ctx.numeric();
  const groupBy = ctx.pick("pricing_model", "category", "segment", "stage", "tier");
  const keyFields = [keyField, planField].filter((f) => f !== "");
  const priceLike = /price|pricing/.test(rankBy);

  const collector = agentDraft({
    name: "Researcher",
    description: "Gathers the comparable facts an analysis needs — pricing, packaging, positioning, traction — from primary sources.",
    goal: `Collect verified, comparable records for the ${spec.deliverable.title}.`,
    modelTier: "standard",
    tools: [...WEB_TOOLS, "calculator"],
    paragraphs: [
      `You are a market analyst's research partner. ${jobFacts(spec)}`,
      "Method: identify the set of companies or products the job is about (from the brief first, then a web search to fill gaps), open each one's own pages with fetch_url — pricing pages, product pages, docs — and record the facts exactly as stated there. Use extract_data to structure long pages, and calculator for any conversion (annual to monthly, per-seat to per-100-seats) so numbers are never estimated in your head.",
      fieldGuide(spec),
      `Quality bar: comparable is the whole point — normalize prices to one currency and one billing period, spell out plan names as the vendor writes them, and record the URL you took each fact from. ${NO_INVENTION}`,
      volumeLine(spec, "records"),
      "Avoid: third-party review sites when the vendor's own page is available, outdated cached pricing, and mixing list prices with negotiated ones. If a vendor hides pricing, say so in the record rather than guessing.",
    ],
  });

  const analyst = agentDraft({
    name: "Analyst",
    description: "Compares the collected records and turns them into positioning insights and clear recommendations.",
    goal: `Write the analysis and recommendations for the ${spec.deliverable.title}.`,
    modelTier: "reasoning",
    tools: [],
    paragraphs: [
      `You are a senior market analyst. You are given comparable records${groupBy ? ` plus a breakdown by ${groupBy.replace(/_/g, " ")}` : ""} for: ${spec.objective.trim()}`,
      `Structure your thinking: (1) where the market clusters — ${priceLike ? "price points, packaging patterns, who anchors high and who anchors low" : "the patterns that separate the leaders from the rest"}; (2) the outliers and what explains them; (3) what this implies for the client — two or three concrete, defensible recommendations with the trade-offs stated.`,
      "Quality bar: every insight cites a specific record (name and number). Recommendations are actionable this quarter, not generic strategy. Say what you are uncertain about and what data would settle it. Write 350–600 words with bold key figures and short bullet lists.",
      "Avoid: repeating the table in prose, praising or criticising companies without evidence, and recommendations that ignore the job's constraints.",
    ],
  });

  return {
    persona: persona(ctx, `${ctx.name} does the comparison work a strategy team never has time for: gathers comparable facts from primary sources, normalizes them, and writes a clear-eyed analysis with recommendations you can act on.`),
    responsibilities: spec.responsibilities.slice(0, 8),
    collector,
    analyst,
    steps: { validate: true, dedupe: keyFields.length > 0, rank: rankBy !== "", computeStats: groupBy !== "" && spec.deliverable.format === "markdown", notify: ctx.notify },
    keyFields,
    rankBy,
    rankDirection: priceLike ? "asc" : "desc",
    groupBy,
    toolReasons: [
      reason("web_search", "Locate the companies, products and pages the analysis needs."),
      reason("fetch_url", "Read vendors' own pricing and product pages so facts are first-hand."),
      reason("extract_data", "Structure long pages into comparable records."),
      reason("calculator", "Normalize prices and compute comparisons exactly instead of estimating."),
      reason("send_notification", NOTIFY_REASON),
    ],
    rationale: [
      "Analysis is where judgment matters, so the analyst works on the reasoning model while the researcher gathering the facts stays on the cheaper standard model — you pay for thinking only where it changes the answer.",
      ...sharedRationale(ctx, { validate: true, dedupe: keyFields.length > 0, keyFields, rankBy }),
      "Conversions and comparisons go through the calculator, so the numbers in the recommendations are arithmetic, not intuition.",
    ],
  };
}

export function leadResearchTemplate(ctx: TemplateContext): BlueprintDraft {
  const { spec } = ctx;
  const company = ctx.pick("company", "account", "company_name", "name");
  const contact = ctx.pick("contact_name", "contact", "decision_maker", "full_name");
  // Only a score says which lead is best; ranking a lead list by headcount or funding would just reorder it.
  const rankBy = ctx.pick("fit_score", "score", "icp_score", "lead_score") || (ctx.fields.find((f) => /(?:score|rating)$/i.test(f)) ?? "");
  const groupBy = ctx.pick("segment", "industry", "category", "region", "country");
  const keyFields = [company, contact].filter((f) => f !== "");

  const collector = agentDraft({
    name: "Lead researcher",
    description: "Builds a list of accounts that match the ideal customer profile, with a named contact and a reason to reach out.",
    goal: `Produce a fresh, qualified lead list for the ${spec.deliverable.title}.`,
    modelTier: "standard",
    tools: WEB_TOOLS,
    paragraphs: [
      `You are an outbound researcher supporting a sales team. ${jobFacts(spec)}`,
      "Method: search for companies showing the buying signals the brief describes (recent funding, hiring for the relevant role, a product launch, a new market), open each company's site and the announcement with fetch_url to confirm the fit, then use extract_data with the exact field names below to structure what you learned. Identify the most relevant decision-maker by title, and record their details only when they are published on the company's own pages or in the announcement.",
      fieldGuide(spec),
      `Quality bar: every lead has a concrete fit reason in one sentence ("raised a $12M Series A in August and is hiring two data engineers"), a working company website, and a contact title that matches the buyer persona. ${NO_INVENTION} Never fabricate or guess an email address — leave it null unless it is published.`,
      volumeLine(spec, "leads"),
      "Avoid: companies outside the profile that merely rank well in search, stale news older than the job's window, and duplicate accounts under different spellings. One lead per company per run.",
    ],
  });

  const analyst = agentDraft({
    name: "Analyst",
    description: "Summarizes the batch of leads: which segments and signals dominated, and where to start.",
    goal: "Write a short cover note for the lead list.",
    modelTier: "fast",
    tools: [],
    paragraphs: [
      `You are a sales operations analyst. You are given a batch of qualified leads for: ${spec.objective.trim()}`,
      "Write a short cover note: how many leads, which segments and signals dominated, the five best-fit accounts and why, and any segment that came up dry. Every statement references the records; keep it under 250 words.",
      "Avoid: generic sales advice and restating the whole list.",
    ],
  });

  return {
    persona: persona(ctx, `${ctx.name} builds your prospect list the way a good SDR researcher would: finds accounts that match the profile, confirms the fit on the company's own pages, names the right contact, and hands you a clean list every run.`),
    responsibilities: spec.responsibilities.slice(0, 8),
    collector,
    analyst,
    steps: { validate: true, dedupe: keyFields.length > 0, rank: rankBy !== "", computeStats: groupBy !== "" && spec.deliverable.format === "markdown", notify: ctx.notify },
    keyFields,
    rankBy,
    rankDirection: "desc",
    groupBy,
    toolReasons: [
      reason("web_search", "Find companies showing the buying signals in the brief."),
      reason("fetch_url", "Confirm fit and contact titles on the company's own pages."),
      reason("extract_data", "Structure findings into the lead fields the CRM expects."),
      reason("send_notification", NOTIFY_REASON),
    ],
    rationale: [
      "Lead quality depends on confirming fit on primary sources, so the researcher works on the standard model and is told to leave unknown contact details empty rather than guess.",
      ...sharedRationale(ctx, { validate: true, dedupe: keyFields.length > 0, keyFields, rankBy }),
      spec.deliverable.format === "csv"
        ? "The list is delivered as CSV so it drops straight into your CRM or a spreadsheet."
        : `The list is delivered as ${spec.deliverable.format} as the spec asks.`,
    ],
  };
}
