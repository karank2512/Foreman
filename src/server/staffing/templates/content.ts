import type { BlueprintDraft } from "@/server/domain";
import { agentDraft, fieldGuide, jobFacts, NO_INVENTION, NOTIFY_REASON, persona, reason, sharedRationale, volumeLine, type TemplateContext } from "./shared";

/** Writing and general knowledge-work families: content, general. */

const WEB_TOOLS = ["web_search", "fetch_url", "extract_data"];

export function contentTemplate(ctx: TemplateContext): BlueprintDraft {
  const { spec } = ctx;
  const keyField = ctx.pick("source_url", "url", "title", "topic");
  const groupBy = ctx.pick("category", "topic", "theme", "channel", "format");
  const keyFields = keyField ? [keyField] : [];

  const collector = agentDraft({
    name: "Researcher",
    description: "Gathers the source material a writer needs: recent, credible pieces on the brief's topics with the key facts pulled out.",
    goal: `Collect the sources and talking points behind the ${spec.deliverable.title}.`,
    modelTier: "standard",
    tools: WEB_TOOLS,
    paragraphs: [
      `You are a research assistant to a content team. ${jobFacts(spec)}`,
      "Method: run two or three searches on the brief's topics, open the most credible and recent results with fetch_url, and record one item per source with the facts, figures and quotes a writer could use — with extract_data to structure long pages using the exact field names below. Prefer primary sources (company announcements, reports, original reporting) over commentary about them.",
      fieldGuide(spec),
      `Quality bar: every item has a working URL, a one-line summary in plain language, and the specific takeaway that makes it worth citing. ${NO_INVENTION} Attribute quotes exactly.`,
      volumeLine(spec, "sources"),
      "Avoid: thin listicles, content older than the brief's window, and several items that say the same thing — pick the best one.",
    ],
  });

  const analyst = agentDraft({
    name: "Writer",
    description: "Writes the content itself — to the brief's audience, tone and format — from the collected sources.",
    goal: `Write the ${spec.deliverable.title} from the collected sources.`,
    modelTier: "standard",
    tools: [],
    paragraphs: [
      `You are a professional writer. You are given researched source items for: ${spec.objective.trim()}`,
      `Write the pieces the brief asks for, in the audience's language and the tone the brief describes. Lead with the point, keep sentences short, and use concrete facts from the sources — cite them inline as [source title](url). ${spec.deliverable.targetCount ? `Produce ${spec.deliverable.targetCount} distinct pieces or sections.` : "Produce as many distinct pieces as the brief asks for."}`,
      "Quality bar: nothing generic — every paragraph should be impossible to write without the sources; headlines are specific; calls to action are explicit. Match the length and format the brief specifies; when it does not, default to 150–300 words per piece.",
      "Avoid: clichés, unverifiable claims, and paraphrasing a source so loosely that its meaning changes. Never fabricate quotes or statistics.",
    ],
  });

  return {
    persona: persona(ctx, `${ctx.name} is the content specialist who does the reading first: gathers credible, recent sources on your topics, then writes to your brief — specific, sourced, in your voice — every ${spec.cadence.kind === "daily" ? "day" : "week"}.`),
    responsibilities: spec.responsibilities.slice(0, 8),
    collector,
    analyst,
    steps: { validate: true, dedupe: keyFields.length > 0, rank: false, computeStats: groupBy !== "" && spec.deliverable.format === "markdown", notify: ctx.notify },
    keyFields,
    rankBy: "",
    rankDirection: "desc",
    groupBy,
    toolReasons: [
      reason("web_search", "Find recent, credible material on the brief's topics."),
      reason("fetch_url", "Read sources in full so facts and quotes are accurate."),
      reason("extract_data", "Pull the facts and takeaways out of long pages."),
      reason("send_notification", NOTIFY_REASON),
    ],
    rationale: [
      "Good writing starts with good sources, so a researcher gathers and structures the material before a separate writer drafts — the writer never has to invent facts.",
      ...sharedRationale(ctx, { validate: true, dedupe: keyFields.length > 0, keyFields, rankBy: "" }),
      "The researcher and the writer both work on the standard model: drafts need judgment about tone and structure that the fast model does not deliver reliably.",
    ],
  };
}

export function generalTemplate(ctx: TemplateContext): BlueprintDraft {
  const { spec } = ctx;
  const keyField = ctx.pick("title", "name", "id", "source_url", "url");
  const rankBy = ctx.numeric();
  const groupBy = ctx.pick("category", "type", "status", "source", "owner");
  const keyFields = keyField ? [keyField] : [];

  const collector = agentDraft({
    name: "Associate",
    description: "Works through the task the brief describes and records what was found or produced as structured items.",
    goal: `Produce the records the ${spec.deliverable.title} is built from.`,
    modelTier: "standard",
    tools: [...WEB_TOOLS, "read_dataset", "calculator"],
    paragraphs: [
      `You are a capable operations associate. ${jobFacts(spec)}`,
      "Method: read the brief and any one-off instructions first and decide what evidence the deliverable needs. Use web_search and fetch_url for anything public, read_dataset for the workspace's own records, extract_data to structure long text using the exact field names below, and calculator for any arithmetic. Work in small steps, checking each result before moving on.",
      fieldGuide(spec),
      `Quality bar: each item is specific, current and traceable — include where it came from. ${NO_INVENTION}`,
      volumeLine(spec, "items"),
      "Avoid: padding the list with marginal items, repeating the same finding from several sources, and drifting outside the objective.",
    ],
  });

  const analyst = agentDraft({
    name: "Analyst",
    description: "Summarizes what was found and what it means for the objective.",
    goal: `Write the summary for the ${spec.deliverable.title}.`,
    modelTier: "standard",
    tools: [],
    paragraphs: [
      `You are an operations analyst. You are given the collected items${groupBy ? ` and counts by ${groupBy.replace(/_/g, " ")}` : ""} for: ${spec.objective.trim()}`,
      "Summarize what was found, what changed or stands out, and what the reader should do next — each point tied to a specific item. 200–400 words, short paragraphs, bold the names and numbers that matter.",
      "Avoid: generalities, hedging, and anything not supported by the records.",
    ],
  });

  return {
    persona: persona(ctx, `${ctx.name} takes on the recurring knowledge work you describe in plain English: gathers what is needed, structures it, and reports back with a clear summary — reliably, on schedule.`),
    responsibilities: spec.responsibilities.slice(0, 8),
    collector,
    analyst,
    steps: { validate: true, dedupe: keyFields.length > 0, rank: rankBy !== "", computeStats: groupBy !== "" && spec.deliverable.format === "markdown", notify: ctx.notify },
    keyFields,
    rankBy,
    rankDirection: "desc",
    groupBy,
    toolReasons: [
      reason("web_search", "Find public information the task needs."),
      reason("fetch_url", "Read pages in full instead of relying on snippets."),
      reason("extract_data", "Structure text into the fields the deliverable needs."),
      reason("read_dataset", "Use the workspace's own records when the task calls for them."),
      reason("calculator", "Exact arithmetic for any totals or comparisons."),
      reason("send_notification", NOTIFY_REASON),
    ],
    rationale: [
      "This job does not match one of our specialist designs, so the associate gets the full research toolkit and works on the standard model, with instructions to work in small verified steps.",
      ...sharedRationale(ctx, { validate: true, dedupe: keyFields.length > 0, keyFields, rankBy }),
      "As the job settles, replace this worker with a more specialised design: once the work is predictable, more of it can become fixed steps that cost nothing.",
    ],
  };
}
