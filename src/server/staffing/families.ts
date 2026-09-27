import type { FollowUpQuestion, JobFamily, SpecField, SpecInput, SuccessCriterion } from "@/server/domain";

/**
 * What the simulated scoper knows about each job family: the follow-up questions worth asking, the deliverable
 * shape a good staffing manager would propose, and sensible defaults. Field names are snake_case and chosen so
 * the simulated tools can answer them (see simulation/fields.ts) — which is also what real sources tend to use.
 */

export interface FamilyProfile {
  deliverableNoun: string;
  deliverableDescription: string;
  fields: SpecField[];
  /** Markdown section headings; the first is narrative, one reads like a table, one like a breakdown. */
  sections: string[];
  targetCount: number;
  recordNoun: string;
  responsibilities: string[];
  inputs: SpecInput[];
  successCriteria: SuccessCriterion[];
  constraints: string[];
  outOfScope: string[];
  tools: string[];
  assumptions: string[];
  questions: FollowUpQuestion[];
  /** How the first responsibility says where the work is done; the family's default when unset. */
  methodSuffix?: string;
  /**
   * When set, a count in the description counts companies ("our three main competitors"), each good for about
   * this many records — so "three competitors" is a target of about 3 × N rows, not 3.
   */
  recordsPerCompany?: number;
}

export const f = (name: string, description: string, required = false): SpecField => ({ name, description, required });
export const q = (id: string, question: string, why: string, suggestions: string[], placeholder?: string): FollowUpQuestion => ({
  id,
  question,
  why,
  suggestions,
  ...(placeholder ? { placeholder } : {}),
});

export const RECIPIENTS_Q = q(
  "recipients",
  "Who should receive the deliverable, and how?",
  "If it should go to someone by email or Slack, the worker gets a notification tool that always waits for your approval.",
  ["Just me, in the workspace", "Email it to leadership@company.com", "Post it in Slack #market-intel"],
  "e.g. email it to sales@company.com every Monday",
);
const VOLUME_Q = (noun: string, options: string[]) =>
  q("volume", `How many ${noun} per run is ideal?`, "Sets the target the worker is measured against and how much it searches.", options, `e.g. about ${options[1]}`);

export const FAMILY_PROFILES: Record<JobFamily, FamilyProfile> = {
  market_research: {
    deliverableNoun: "Market Research Report",
    deliverableDescription: "Ranked, sourced records of the companies and rounds that matter, with a short briefing on what changed.",
    fields: [
      f("company", "Company name", true),
      f("category", "Sub-category or segment", true),
      f("stage", "Funding stage (Seed, Series A…)", true),
      f("amount_usd", "Round size in USD", true),
      f("announced_on", "Announcement date (YYYY-MM-DD)"),
      f("lead_investor", "Lead investor"),
      f("hq", "Headquarters city"),
      f("source_url", "Where the round was reported", true),
    ],
    sections: ["Summary", "Top rounds", "Category breakdown"],
    targetCount: 15,
    recordNoun: "records",
    responsibilities: [
      "Search public sources for recent announcements that match the brief",
      "Capture company, stage, amount, investors and category for each item, with a source",
      "Rank what was found and summarize the trends that matter",
    ],
    inputs: [{ name: "Public web", description: "News, announcements and company sites", source: "web", required: true }],
    successCriteria: [
      { id: "coverage", description: "Every relevant announcement in the period is captured", metric: "Records per run", target: "meets the target" },
      { id: "sourcing", description: "Every record cites a source URL", metric: "Field completeness", target: "100%" },
      { id: "freshness", description: "Only announcements from the agreed window", metric: "Acceptance rate", target: ">= 85%" },
    ],
    constraints: ["Only announcements from the last 30 days", "Amounts in USD"],
    outOfScope: ["Contacting companies or investors", "Investment recommendations"],
    tools: ["web_search", "fetch_url", "extract_data"],
    assumptions: ["English-language sources are sufficient", "Public announcements are the source of truth for round details"],
    questions: [
      q("focus", "Which geographies, segments or stages matter most?", "Keeps the search focused on what you would actually act on.", ["AI infrastructure, seed to Series B", "North America and Europe", "Enterprise SaaS, any stage"], "e.g. developer tools in Europe, seed to Series B"),
      VOLUME_Q("records", ["10", "15", "25"]),
      RECIPIENTS_Q,
    ],
  },
  market_analysis: {
    deliverableNoun: "Market Analysis Brief",
    deliverableDescription: "Comparable facts on each competitor or product, normalized, with an analysis and recommendations.",
    fields: [
      f("company", "Company or product", true),
      f("pricing_model", "How it is priced (per seat, usage, flat…)", true),
      f("starting_price_usd", "Lowest published price per month in USD", true),
      f("free_tier", "Whether a free plan exists"),
      f("plans", "Plan names as the vendor lists them"),
      f("positioning", "How the vendor positions the product"),
      f("pricing_url", "Pricing page URL", true),
      f("source_url", "Source of the record", true),
    ],
    sections: ["Summary", "Pricing comparison", "Pricing model breakdown"],
    targetCount: 10,
    recordNoun: "records",
    responsibilities: [
      "Identify the competitors or products in scope",
      "Collect comparable facts from each vendor's own pages",
      "Normalize prices and packaging so they can be compared",
      "Write an analysis with concrete recommendations",
    ],
    inputs: [
      { name: "Competitor list", description: "The companies or products to cover", source: "user_instruction", required: false },
      { name: "Vendor websites", description: "Pricing and product pages", source: "web", required: true },
    ],
    successCriteria: [
      { id: "comparability", description: "Prices are normalized to one currency and billing period", metric: "Field completeness", target: "100%" },
      { id: "sourcing", description: "Every fact comes from the vendor's own page", metric: "Acceptance rate", target: ">= 85%" },
      { id: "actionable", description: "Recommendations are specific and defensible", metric: "Quality score", target: ">= 80%" },
    ],
    constraints: ["Use list prices from vendor pages, not negotiated quotes"],
    outOfScope: ["Contacting vendors", "Legal or procurement advice"],
    tools: ["web_search", "fetch_url", "extract_data", "calculator"],
    assumptions: ["Vendors publish enough on their sites to compare"],
    questions: [
      q("competitors", "Which competitors or products should be covered?", "The analysis is only as good as the set it compares.", ["Our top 5 direct competitors", "Everyone in the category, up to 10", "Let the worker pick the most relevant"], "e.g. Vectorloom, Lattice Cloud, …"),
      q("dimensions", "Which dimensions matter most?", "Decides what the worker collects and what the analysis focuses on.", ["Pricing and packaging", "Positioning and messaging", "Features and integrations"]),
      RECIPIENTS_Q,
    ],
  },
  lead_research: {
    deliverableNoun: "Lead List",
    deliverableDescription: "Qualified accounts matching the profile, each with a named contact, a fit reason and a score.",
    fields: [
      f("company", "Account name", true),
      f("website", "Company website"),
      f("contact_name", "Most relevant decision-maker", true),
      f("contact_title", "Their title", true),
      f("contact_email", "Published work email, if any"),
      f("linkedin_url", "Contact's LinkedIn profile, if published"),
      f("fit_reason", "One-sentence reason this account fits now", true),
      f("fit_score", "Fit score 1–100", true),
    ],
    sections: ["Summary", "Top leads"],
    targetCount: 25,
    recordNoun: "leads",
    responsibilities: [
      "Find companies showing the buying signals in the profile",
      "Confirm fit on the company's own pages and identify the right contact",
      "Score and de-duplicate leads before delivery",
    ],
    inputs: [
      { name: "Ideal customer profile", description: "Industry, size, roles and signals to look for", source: "user_instruction", required: true },
      { name: "Public web", description: "Company sites, announcements, job posts", source: "web", required: true },
    ],
    successCriteria: [
      { id: "fit", description: "Leads match the profile and have a concrete fit reason", metric: "Acceptance rate", target: ">= 85%" },
      { id: "volume", description: "The agreed number of new leads per run", metric: "Records per run", target: "meets the target" },
      { id: "no_dupes", description: "No account appears twice", metric: "Duplicates", target: "0" },
    ],
    constraints: ["Only published contact details — never guessed emails"],
    outOfScope: ["Sending outreach", "Buying contact data"],
    tools: ["web_search", "fetch_url", "extract_data"],
    assumptions: ["Company websites and announcements are enough to qualify most accounts"],
    questions: [
      q("icp", "Describe the ideal customer: industry, size, roles and buying signals.", "This is the profile every lead is scored against.", ["B2B SaaS, 50–500 employees, VP Sales", "Recently funded startups hiring engineers", "Mid-market e-commerce, Head of Ops"], "e.g. Series A–B fintechs in Europe hiring a Head of Data"),
      VOLUME_Q("leads", ["15", "25", "50"]),
      q("recipients", "Where should the list go?", "A CSV drops straight into a CRM; email or Slack delivery adds an approval step.", ["CSV in the workspace, I'll import it", "Email the CSV to sales@company.com", "Post in Slack #outbound"]),
    ],
  },
  feedback_analysis: {
    deliverableNoun: "Customer Feedback Report",
    deliverableDescription: "Every feedback item categorized by theme, sentiment and severity, with the themes, priorities and recommended actions.",
    fields: [
      f("id", "Feedback item id", true),
      f("customer", "Customer or account", true),
      f("plan", "Customer's plan"),
      f("channel", "Where the feedback came from"),
      f("text", "The feedback itself", true),
      f("category", "Primary theme", true),
      f("sentiment", "positive / neutral / negative", true),
      f("severity", "low / medium / high business impact", true),
      f("summary", "One-line summary"),
      f("suggested_action", "What the team should do about it"),
    ],
    sections: ["Summary", "Themes by volume", "Notable feedback"],
    targetCount: 40,
    recordNoun: "feedback items",
    responsibilities: [
      "Read every new feedback item from the connected sources",
      "Label each item with a consistent theme, sentiment and severity",
      "Report the top themes with counts, verbatims and recommended actions",
    ],
    inputs: [{ name: "Customer feedback", description: "Support, NPS, reviews and sales notes from connected sources", source: "provided_data", required: true }],
    successCriteria: [
      { id: "coverage", description: "Every item in the period is categorized", metric: "Records per run", target: "meets the target" },
      { id: "consistency", description: "The same complaint always gets the same theme", metric: "Acceptance rate", target: ">= 85%" },
      { id: "actionable", description: "Recommendations name the affected area and a next step", metric: "Quality score", target: ">= 80%" },
    ],
    constraints: ["Keep the customer's original wording in the record"],
    outOfScope: ["Replying to customers", "Changing tickets or CRM records"],
    tools: ["read_dataset"],
    assumptions: ["Feedback arrives through the connected sources without manual export"],
    questions: [
      q("sources", "Where does the feedback come from?", "Tells the worker which sources to read each run.", ["Support tickets and NPS surveys", "App store and G2 reviews", "Sales call notes"]),
      q("priorities", "What should the analysis emphasize?", "Shapes the themes and the recommendations section.", ["Top themes by volume", "Churn risks and severity", "Feature requests for the roadmap"]),
      RECIPIENTS_Q,
    ],
  },
  support_triage: {
    deliverableNoun: "Support Triage Sheet",
    deliverableDescription: "Every new ticket classified, prioritized and routed to a team with a suggested next step.",
    fields: [
      f("id", "Ticket id", true),
      f("subject", "Ticket subject", true),
      f("customer", "Customer or account"),
      f("category", "Ticket category", true),
      f("priority", "low / normal / high / urgent", true),
      f("team", "Team that should own it", true),
      f("suggested_action", "One-sentence next step for the agent", true),
      f("sla_hours", "Response SLA in hours"),
    ],
    sections: ["Summary", "Volume by team", "Urgent tickets"],
    targetCount: 30,
    recordNoun: "tickets",
    responsibilities: [
      "Read every new ticket from the helpdesk",
      "Classify it, set a priority by impact and route it to the owning team",
      "Suggest the first action for whoever picks it up",
    ],
    inputs: [{ name: "Support tickets", description: "New tickets from the connected helpdesk", source: "provided_data", required: true }],
    successCriteria: [
      { id: "coverage", description: "Every new ticket is triaged", metric: "Records per run", target: "meets the target" },
      { id: "routing", description: "Tickets reach the right team without re-routing", metric: "Acceptance rate", target: ">= 90%" },
      { id: "priority", description: "Urgent tickets are never marked normal or low", metric: "Quality score", target: ">= 85%" },
    ],
    constraints: ["Never reply to customers", "Keep the original ticket id and subject"],
    outOfScope: ["Resolving tickets", "Editing the helpdesk"],
    tools: ["read_dataset"],
    assumptions: ["Category and team names follow the helpdesk's existing conventions"],
    questions: [
      q("categories", "Which categories and teams should tickets be routed to?", "The worker reuses your names so routing matches your helpdesk.", ["Billing, Bugs, How-to, Access, Integrations", "Use our existing helpdesk categories", "Let the worker propose a set"]),
      q("priority", "How should priority be decided?", "Turns your rules into consistent triage.", ["Outages and lost access are urgent; paying customers blocked are high", "By plan: enterprise first", "By age: oldest first"]),
      q("cadence", "How often should triage run?", "Fresh tickets need frequent runs; a daily digest needs one.", ["Every hour", "Every morning", "On demand"]),
    ],
  },
  finance_ops: {
    deliverableNoun: "Finance Ops Review",
    deliverableDescription: "Every record for the period categorized and checked, with totals and the exceptions that need a decision.",
    fields: [
      f("transaction_id", "Transaction or invoice id", true),
      f("vendor", "Vendor or counterparty", true),
      f("amount_usd", "Amount in USD", true),
      f("date", "Transaction date (YYYY-MM-DD)"),
      f("category", "Spend category", true),
      f("status", "ok / flagged", true),
      f("flag_reason", "Why it was flagged, if it was"),
      f("notes", "Anything the reviewer should know"),
    ],
    sections: ["Summary", "Spend by category", "Flagged transactions"],
    targetCount: 50,
    recordNoun: "records",
    responsibilities: [
      "Process every record for the period from the sources provided",
      "Categorize each line consistently and check it against the rules",
      "Flag exceptions with a reason and report totals",
    ],
    inputs: [
      { name: "Financial records", description: "Invoices, statements or exports for the period", source: "provided_data", required: true },
      { name: "Categorization rules", description: "Chart of accounts and thresholds", source: "user_instruction", required: false },
    ],
    successCriteria: [
      { id: "accuracy", description: "Totals reconcile to the source records", metric: "Acceptance rate", target: ">= 90%" },
      { id: "coverage", description: "Every record in the period is processed", metric: "Records per run", target: "meets the target" },
      { id: "exceptions", description: "Exceptions are flagged with a clear reason, never silently changed", metric: "Quality score", target: ">= 85%" },
    ],
    constraints: ["Never modify source records", "All arithmetic goes through the calculator"],
    outOfScope: ["Approving payments", "Tax or accounting advice"],
    tools: ["extract_data", "calculator", "web_search", "fetch_url"],
    assumptions: ["Records are provided or linked at run time in a readable format"],
    questions: [
      q("sources", "Which records should be processed?", "Defines what a run covers.", ["Vendor invoices", "Card and expense transactions", "Bank statement lines"]),
      q("rules", "What categorization or reconciliation rules apply?", "The worker applies these exactly and flags anything outside them.", ["Our chart of accounts; flag anything over $5,000", "Match invoices to purchase orders", "Flag duplicates and out-of-period dates"]),
      RECIPIENTS_Q,
    ],
  },
  content: {
    deliverableNoun: "Content Drafts",
    deliverableDescription: "Drafted pieces written to the brief, with the researched sources behind them.",
    fields: [
      f("title", "Source title", true),
      f("summary", "One-line summary of the source", true),
      f("source_url", "Source URL", true),
      f("published_on", "Publication date (YYYY-MM-DD)"),
      f("takeaway", "The specific point worth citing"),
    ],
    sections: ["Drafts", "Sources"],
    targetCount: 6,
    recordNoun: "sources",
    responsibilities: [
      "Research recent, credible sources on the brief's topics",
      "Draft the pieces the brief asks for, in the audience's voice",
      "Cite sources inline so every claim can be checked",
    ],
    inputs: [
      { name: "Content brief", description: "Audience, tone, topics and format", source: "user_instruction", required: true },
      { name: "Public web", description: "Sources to research", source: "web", required: true },
    ],
    successCriteria: [
      { id: "on_brief", description: "Drafts match the audience, tone and format", metric: "Acceptance rate", target: ">= 80%" },
      { id: "sourced", description: "Every factual claim cites a source", metric: "Quality score", target: ">= 85%" },
    ],
    constraints: ["No fabricated quotes or statistics"],
    outOfScope: ["Publishing", "Design and imagery"],
    tools: ["web_search", "fetch_url", "extract_data"],
    assumptions: ["The brief's tone and format can be described in a few sentences"],
    questions: [
      q("audience", "Who is the audience, and in what tone?", "Voice and depth follow from this.", ["Technical buyers, plain and direct", "Executives, concise and strategic", "Developers, friendly and specific"]),
      q("format", "What format and length?", "Sets the structure of each piece.", ["LinkedIn posts, ~150 words", "Newsletter section, ~400 words", "Blog post, ~900 words"]),
      VOLUME_Q("pieces", ["1", "3", "5"]),
    ],
  },
  general: {
    deliverableNoun: "Operations Report",
    deliverableDescription: "What was found or produced this run, as structured items with a summary of what matters.",
    fields: [
      f("title", "Item title", true),
      f("summary", "One-line summary", true),
      f("source_url", "Where it came from", true),
      f("published_on", "Date, if applicable"),
      f("relevance", "Why it matters for the objective"),
    ],
    sections: ["Summary", "Items reviewed"],
    targetCount: 12,
    recordNoun: "items",
    responsibilities: [
      "Gather what the objective needs from the agreed sources",
      "Structure the findings consistently",
      "Summarize what matters and what to do next",
    ],
    inputs: [{ name: "Public web", description: "Sources to research", source: "web", required: false }],
    successCriteria: [
      { id: "useful", description: "The deliverable can be acted on without re-doing the work", metric: "Acceptance rate", target: ">= 80%" },
      { id: "traceable", description: "Every item says where it came from", metric: "Quality score", target: ">= 80%" },
    ],
    constraints: [],
    outOfScope: ["Actions outside the workspace without approval"],
    tools: ["web_search", "fetch_url", "extract_data", "read_dataset", "calculator"],
    assumptions: ["The objective can be met with public sources and the workspace's data"],
    questions: [
      q("outcome", "What does a great result look like?", "Becomes the success criteria the worker is reviewed against.", ["A short summary I can forward", "A structured list I can filter", "Both"]),
      q("sources", "What sources or data should it use?", "Decides which tools the worker gets.", ["Public web", "Our own records", "Both"]),
      RECIPIENTS_Q,
    ],
  },
};
