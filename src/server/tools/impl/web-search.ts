import { z } from "zod";
import { AppError, errorMessage } from "@/server/errors";
import { simulation } from "@/server/simulation";
import { defineTool, plural, quote } from "../define";
import type { SearchResult } from "../schemas";

export const TAVILY_SECRET = "TAVILY_API_KEY";
export const TAVILY_ENDPOINT = "https://api.tavily.com/search";
const TAVILY_TIMEOUT_MS = 10_000;
const DEFAULT_RESULTS = 6;

/** Lenient view of Tavily's response — only what we map; unknown fields are ignored. */
const TavilyResponseSchema = z.object({
  results: z
    .array(
      z.object({
        title: z.string().nullish(),
        url: z.string().min(1),
        content: z.string().nullish(),
        published_date: z.string().nullish(),
      }),
    )
    .default([]),
});

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}

export function mapTavilyResults(raw: unknown, maxResults: number): SearchResult[] {
  const parsed = TavilyResponseSchema.safeParse(raw);
  if (!parsed.success) throw new AppError("TOOL_ERROR", "Tavily returned an unexpected response shape");
  return parsed.data.results.slice(0, maxResults).map((r) => ({
    title: r.title?.trim() || r.url,
    url: r.url,
    snippet: (r.content ?? "").replace(/\s+/g, " ").trim(),
    source: hostOf(r.url),
    publishedAt: r.published_date ?? "",
  }));
}

/** What to do about a Tavily error status (https://docs.tavily.com — 432/433 are Tavily's plan / spend caps). */
export function tavilyHint(status: number): string {
  if (status === 401 || status === 403) return " — check the Tavily API key (TAVILY_API_KEY in Settings → Tool credentials, or your .env)";
  if (status === 429) return " — Tavily is rate-limiting this key; wait a minute and try again";
  if (status === 432 || status === 433) return " — this Tavily key has used up its plan or spending limit; raise it at tavily.com";
  if (status >= 500) return " — Tavily is having trouble; try again in a few minutes";
  return "";
}

/**
 * Live search via Tavily. Any failure (network, timeout, auth, quota, bad JSON) is surfaced as an error — with a
 * real key configured we never quietly substitute simulated results, which would poison a deliverable.
 */
export async function tavilySearch(apiKey: string, query: string, maxResults: number): Promise<SearchResult[]> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TAVILY_TIMEOUT_MS);
  try {
    let response: Response;
    try {
      response = await fetch(TAVILY_ENDPOINT, {
        method: "POST",
        headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify({ query, max_results: maxResults, search_depth: "basic", include_answer: false, include_raw_content: false }),
        signal: controller.signal,
      });
    } catch (e) {
      const reason = controller.signal.aborted ? `timed out after ${TAVILY_TIMEOUT_MS / 1000} s` : errorMessage(e);
      throw new AppError("TOOL_ERROR", `Web search failed: ${reason}`);
    }
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      throw new AppError("TOOL_ERROR", `Web search failed: Tavily responded with HTTP ${response.status}${tavilyHint(response.status)}`);
    }
    let body: unknown;
    try {
      body = await response.json();
    } catch {
      throw new AppError("TOOL_ERROR", "Web search failed: Tavily returned invalid JSON");
    }
    return mapTavilyResults(body, maxResults);
  } finally {
    clearTimeout(timer);
  }
}

export const webSearchTool = defineTool("web_search", {
  displayName: "Web search",
  description:
    "Search the web and get up to 10 results (title, url, snippet, source, publishedAt). Use specific queries; run several searches to widen coverage. Follow up with fetch_url to read a result in full.",
  humanDescription: "Searches the web for recent, relevant sources.",
  category: "research",
  sideEffect: "external_read",
  defaultRequiresApproval: false,
  secretNames: [TAVILY_SECRET],
  costPerCallUsd: 0.008,
  humanize: (input) => `Searched the web for ${quote(input.query)}`,
  describeForApproval: (input) => ({
    title: `Search the web for ${quote(input.query)}`,
    description: `Up to ${plural(input.maxResults ?? DEFAULT_RESULTS, "result")}.`,
  }),
  async execute(input, ctx) {
    const maxResults = input.maxResults ?? DEFAULT_RESULTS;
    if (!ctx.simulated) {
      const apiKey = await ctx.getSecret(TAVILY_SECRET);
      if (apiKey) {
        const results = await tavilySearch(apiKey, input.query, maxResults);
        return { output: { results }, simulated: false };
      }
    }
    return { output: { results: simulation.search(input.query, { maxResults }) }, simulated: true };
  },
});
