import type { BlueprintDraft } from "@/server/domain";
import { fieldList } from "../labels";
import { agentDraft, fieldGuide, jobFacts, NO_INVENTION, NOTIFY_REASON, persona, reason, sharedRationale, volumeLine, type TemplateContext } from "./shared";

/** Operations families that work from the workspace's own records: feedback_analysis, support_triage, finance_ops. */

export function feedbackAnalysisTemplate(ctx: TemplateContext): BlueprintDraft {
  const { spec } = ctx;
  const id = ctx.pick("id", "feedback_id", "item_id", "ref");
  const groupBy = ctx.pick("category", "theme", "topic", "product_area", "sentiment");
  const rankBy = ctx.pick("severity_score", "sentiment_score", "score") || ctx.numeric();
  const keyFields = id ? [id] : [];

  const collector = agentDraft({
    name: "Categorizer",
    description: "Reads the feedback that came in, labels each item by theme, sentiment and severity, and summarizes it in one line.",
    goal: `Categorize every feedback item for the ${spec.deliverable.title}.`,
    modelTier: "standard",
    tools: ["read_dataset"],
    paragraphs: [
      `You are a customer-insights analyst. ${jobFacts(spec)}`,
      "Method: read the customer_feedback dataset with read_dataset, then label EVERY item yourself — do not skip the long or ambiguous ones. Assign one primary category from a small, consistent set (reuse labels across items; never invent a new category for a single item), a sentiment (positive / neutral / negative), a severity that reflects business impact (a churn threat is high even when the tone is polite), and a one-line summary in the customer's own words where possible.",
      fieldGuide(spec),
      `Quality bar: labels are consistent — the same complaint gets the same category every time — and every record keeps the original id and customer so a product manager can trace it back. ${NO_INVENTION}`,
      volumeLine(spec, "items"),
      "Avoid: collapsing distinct problems into a vague category like 'other', sentiment that mirrors politeness instead of substance, and paraphrases that change what the customer meant.",
    ],
  });

  const analyst = agentDraft({
    name: "Insights writer",
    description: "Turns the categorized feedback into themes, priorities and recommended actions.",
    goal: `Write the themes and recommendations for the ${spec.deliverable.title}.`,
    modelTier: "standard",
    tools: [],
    paragraphs: [
      `You are a product-insights lead reporting to the leadership team. You are given categorized feedback records${groupBy ? ` plus counts by ${groupBy.replace(/_/g, " ")}` : ""} for: ${spec.objective.trim()}`,
      "Open with the headline: the top three themes by volume with their counts and share, and how negative sentiment concentrates. Then, for each major theme, one short paragraph: what customers are saying (quote one or two verbatims briefly), who is affected (plan, channel), and how severe it is. Close with prioritized recommendations — the two or three things that would remove the most pain — and anything positive worth amplifying.",
      "Quality bar: numbers come from the records you were given; every theme has at least one concrete example; recommendations name the affected area, not just 'improve X'. Write 300–500 words with bold counts and short bullets.",
      "Avoid: generic advice, sentiment averages without context, and speculation about causes the feedback does not support.",
    ],
  });

  return {
    persona: persona(ctx, `${ctx.name} reads every piece of customer feedback so your team does not have to: consistent categories, honest severity, and a weekly view of what to fix first — with the verbatims to back it up.`),
    responsibilities: spec.responsibilities.slice(0, 8),
    collector,
    analyst,
    steps: { validate: true, dedupe: keyFields.length > 0, rank: rankBy !== "", computeStats: groupBy !== "" && spec.deliverable.format === "markdown", notify: ctx.notify },
    keyFields,
    rankBy,
    rankDirection: "desc",
    groupBy,
    toolReasons: [
      reason("read_dataset", "Read the feedback that arrived from your connected sources (sample datasets in this phase)."),
      reason("send_notification", NOTIFY_REASON),
    ],
    rationale: [
      "Categorization is a judgment task, so it runs on the standard model: consistent labels are what make the counts trustworthy week over week.",
      ...sharedRationale(ctx, { validate: true, dedupe: keyFields.length > 0, keyFields, rankBy }),
      groupBy
        ? `Counts by ${fieldList([groupBy])} are calculated by a fixed step rather than estimated, so the numbers in the report are exact and the analyst only interprets them.`
        : "The analyst works from the cleaned records so the narrative always matches the data.",
    ],
  };
}

export function supportTriageTemplate(ctx: TemplateContext): BlueprintDraft {
  const { spec } = ctx;
  const id = ctx.pick("id", "ticket_id", "ref", "ticket");
  const groupBy = ctx.pick("team", "category", "priority", "queue");
  const rankBy = ctx.pick("priority_score", "sla_hours", "score") || ctx.numeric();
  // Time-to-deadline fields rank the other way round: the ticket with the least time left is the most urgent.
  const lowerIsUrgent = /(?:sla|hours|minutes|days|deadline|due|time_to)/i.test(rankBy);
  const keyFields = id ? [id] : [];

  const collector = agentDraft({
    name: "Triage specialist",
    description: "Reads new support tickets, classifies each one, sets its priority and routes it to the right team with a suggested next step.",
    goal: `Triage every new ticket for the ${spec.deliverable.title}.`,
    modelTier: "standard",
    tools: ["read_dataset"],
    paragraphs: [
      `You are an experienced support lead doing first-line triage. ${jobFacts(spec)}`,
      "Method: read the support_tickets dataset with read_dataset and classify EVERY ticket: a category from a small, consistent set (billing, bug, how-to, account access, integration, feature request, outage, data export — or the categories the brief specifies), a priority that follows the impact rules (outages and lost access are urgent; anything blocking a paying customer is high; questions are normal; nice-to-haves are low), the owning team, and a one-sentence suggested action the agent picking it up can follow.",
      fieldGuide(spec),
      `Quality bar: priorities are consistent across similar tickets; routing matches the category (billing → Billing, outages → on-call); the suggested action is specific to the ticket, not a template. Keep the ticket id and subject exactly as they appear. ${NO_INVENTION}`,
      volumeLine(spec, "tickets"),
      "Avoid: marking everything high, inventing categories for single tickets, and answering the customer — your job is routing and prioritisation, not replies.",
    ],
  });

  const analyst = agentDraft({
    name: "Queue analyst",
    description: "Summarizes the triaged queue: volume by team, what is urgent, and emerging patterns.",
    goal: "Write the queue summary for the support leads.",
    modelTier: "fast",
    tools: [],
    paragraphs: [
      `You are a support operations analyst. You are given the triaged tickets${groupBy ? ` and counts by ${groupBy.replace(/_/g, " ")}` : ""} for: ${spec.objective.trim()}`,
      "Report: how many tickets came in, how they split across teams and priorities, the urgent ones by id and subject, and any cluster that looks like a single underlying incident. Keep it under 250 words; every number from the records.",
      "Avoid: speculation about root causes and anything a support lead cannot act on today.",
    ],
  });

  return {
    persona: persona(ctx, `${ctx.name} works the front of your support queue: reads every new ticket, classifies it consistently, sets a sensible priority and routes it to the right team with a suggested next step — so your agents start on the right thing.`),
    responsibilities: spec.responsibilities.slice(0, 8),
    collector,
    analyst,
    steps: { validate: true, dedupe: keyFields.length > 0, rank: rankBy !== "", computeStats: groupBy !== "" && spec.deliverable.format === "markdown", notify: ctx.notify },
    keyFields,
    rankBy,
    rankDirection: lowerIsUrgent ? "asc" : "desc",
    groupBy,
    toolReasons: [
      reason("read_dataset", "Read the tickets that arrived in your helpdesk (sample datasets in this phase)."),
      reason("send_notification", NOTIFY_REASON),
    ],
    rationale: [
      "Triage decisions have to be consistent to be useful, so the specialist works on the standard model and follows explicit priority and routing rules written into its instructions.",
      ...sharedRationale(ctx, { validate: true, dedupe: keyFields.length > 0, keyFields, rankBy }),
      spec.deliverable.format === "csv"
        ? "The triaged queue is delivered as CSV, ready to bulk-update your helpdesk or share with team leads."
        : "The triaged queue is delivered with a short summary for the support leads.",
    ],
  };
}

export function financeOpsTemplate(ctx: TemplateContext): BlueprintDraft {
  const { spec } = ctx;
  const id = ctx.pick("transaction_id", "invoice_id", "id", "reference", "ref");
  const rankBy = ctx.pick("amount_usd", "amount", "total_usd", "total") || ctx.numeric();
  const groupBy = ctx.pick("category", "spend_category", "vendor", "status", "cost_center");
  const keyFields = id ? [id] : [];

  const collector = agentDraft({
    name: "Ledger associate",
    description: "Works through the period's financial records: categorizes each line, checks it against the rules, and flags anything that needs a human.",
    goal: `Process every record for the ${spec.deliverable.title} and flag exceptions.`,
    modelTier: "standard",
    tools: ["extract_data", "calculator", "web_search", "fetch_url"],
    paragraphs: [
      `You are a careful finance operations associate. ${jobFacts(spec)}`,
      "Method: work from the records and documents named in the run's instructions and inputs. Open any document or URL you are pointed at with fetch_url, pull line items out of text with extract_data using the exact field names below, and use calculator for every total, difference or percentage — never do arithmetic in your head. Use web_search only to identify an unfamiliar vendor or confirm a rate.",
      fieldGuide(spec),
      `Quality bar: amounts are numbers with a consistent currency and sign convention; each line gets one category from the client's chart of accounts; anything that breaks a rule (duplicate invoice numbers, amounts over a threshold, missing vendor, out-of-period dates) is flagged with a one-line reason rather than silently fixed. ${NO_INVENTION}`,
      volumeLine(spec, "records"),
      "Avoid: guessing categories for ambiguous vendors (flag them), rounding that changes totals, and reconciling by assumption — if two records do not match, say so.",
    ],
  });

  const analyst = agentDraft({
    name: "Controller's summary",
    description: "Summarizes the period: totals by category, exceptions to review, and anything unusual versus expectations.",
    goal: "Write the summary and exception list for the finance lead.",
    modelTier: "standard",
    tools: [],
    paragraphs: [
      `You write the summary a finance lead reads before approving the period's books. You are given the processed records${groupBy ? ` and totals by ${groupBy.replace(/_/g, " ")}` : ""} for: ${spec.objective.trim()}`,
      "Report: total volume and amount, the split by category, the exceptions that need a decision (id, vendor, amount, reason), and anything unusual — a vendor that doubled, a category that vanished. Keep it factual and under 300 words; every number from the records.",
      "Avoid: commentary on business strategy and any figure you cannot trace to a record.",
    ],
  });

  return {
    persona: persona(ctx, `${ctx.name} handles the repetitive part of finance operations: categorizes every line consistently, checks the rules you set, does the arithmetic exactly, and hands your finance lead a clean file with the exceptions called out.`),
    responsibilities: spec.responsibilities.slice(0, 8),
    collector,
    analyst,
    steps: { validate: true, dedupe: keyFields.length > 0, rank: rankBy !== "", computeStats: groupBy !== "" && spec.deliverable.format === "markdown", notify: ctx.notify },
    keyFields,
    rankBy,
    rankDirection: "desc",
    groupBy,
    toolReasons: [
      reason("extract_data", "Pull line items out of invoices, statements and exports as structured records."),
      reason("calculator", "Exact totals, differences and percentages — never mental arithmetic."),
      reason("web_search", "Identify unfamiliar vendors or confirm a published rate."),
      reason("fetch_url", "Open documents and pages you point it at."),
      reason("send_notification", NOTIFY_REASON),
    ],
    rationale: [
      "Financial records need consistency more than creativity, so the associate works on the standard model with explicit categorization and exception rules, and does every calculation through the calculator.",
      ...sharedRationale(ctx, { validate: true, dedupe: keyFields.length > 0, keyFields, rankBy }),
      "Exceptions are flagged for a human rather than auto-corrected, which keeps the worker useful without letting it change your books.",
    ],
  };
}
