import * as cheerio from "cheerio";
import { AppError, errorMessage } from "@/server/errors";
import { simulation } from "@/server/simulation";
import { defineTool, quote } from "../define";
import { transport, type FetchLike } from "../guarded-http";
import { checkUrl, checkUrlSyntax, type LookupFn } from "../net-guard";
import { assertFetchAllowed } from "../provenance";
import type { ToolOutput } from "../schemas";

export const FETCH_TIMEOUT_MS = 10_000;
export const MAX_BODY_BYTES = 200 * 1024;
export const MAX_TEXT_CHARS = 12_000;
/**
 * A URL is model output, and a long one is a data channel, not an address (F-010). 2,048 is the practical
 * browser/server limit; nothing legitimate the worker reads needs more.
 */
export const MAX_URL_CHARS = 2_048;
const MAX_REDIRECTS = 3;
const USER_AGENT = "Foreman/0.1 (+research worker; reads public pages)";
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

type PageKind = "html" | "text" | "json";

export interface FetchDeps {
  /** Default: the guarded HTTP client (connection-time address check with `lookup`). Tests inject a stub. */
  fetch: FetchLike;
  lookup?: LookupFn;
}

function pageKind(contentType: string | null): PageKind | undefined {
  const mime = (contentType ?? "").split(";")[0].trim().toLowerCase();
  if (mime === "text/html" || mime === "application/xhtml+xml") return "html";
  if (mime === "text/plain" || mime === "text/markdown") return "text";
  if (mime === "application/json" || mime.endsWith("+json")) return "json";
  return undefined;
}

function charsetOf(contentType: string | null): string {
  const match = /charset=["']?([\w.-]+)/i.exec(contentType ?? "");
  return match ? match[1] : "utf-8";
}

function decode(bytes: Uint8Array, charset: string): string {
  try {
    return new TextDecoder(charset).decode(bytes);
  } catch {
    return new TextDecoder("utf-8").decode(bytes);
  }
}

/** Stream the body and stop at the cap — a 50 MB page must not be downloaded, let alone held in memory. */
async function readBody(response: Response): Promise<Uint8Array> {
  const body = response.body;
  if (!body) return new Uint8Array(0);
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done || !value) break;
      const remaining = MAX_BODY_BYTES - total;
      if (value.byteLength >= remaining) {
        chunks.push(value.subarray(0, remaining));
        total += remaining;
        break;
      }
      chunks.push(value);
      total += value.byteLength;
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

export function collapseWhitespace(text: string): string {
  return text
    .replace(/ /g, " ")
    .replace(/[ \t\f\v]+/g, " ")
    .replace(/ ?\r?\n ?/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function capText(text: string): string {
  return text.length > MAX_TEXT_CHARS ? `${text.slice(0, MAX_TEXT_CHARS).trimEnd()}\n[truncated]` : text;
}

/** Readable text from an HTML document: chrome removed, block structure kept as line breaks. */
export function htmlToText(html: string, fallbackTitle: string): { title: string; text: string } {
  const $ = cheerio.load(html);
  $("script, style, noscript, nav, footer, iframe, svg, template, canvas").remove();
  const title = collapseWhitespace($("title").first().text()) || collapseWhitespace($("h1").first().text()) || fallbackTitle;
  // HTML source line breaks are just spaces to a browser; only <pre> keeps them. Structure comes from block tags below.
  $("*")
    .contents()
    .each((_, node) => {
      if (node.type === "text" && "data" in node && $(node).closest("pre").length === 0) node.data = node.data.replace(/\s+/g, " ");
    });
  $("br").replaceWith("\n");
  $("td, th").append(" ");
  $("p, div, h1, h2, h3, h4, h5, h6, li, tr, blockquote, pre, section, article, header, aside, main, dd, dt, figcaption, table, ul, ol").append("\n");
  const text = $("body").length > 0 ? $("body").text() : $.root().text();
  return { title, text: collapseWhitespace(text) };
}

function fallbackTitle(url: URL): string {
  return `${url.hostname}${url.pathname === "/" ? "" : url.pathname}`;
}

function assertUrlLength(raw: string): void {
  if (raw.length > MAX_URL_CHARS) {
    throw new AppError("TOOL_ERROR", `That URL is too long (${raw.length} characters, max ${MAX_URL_CHARS}).`);
  }
}

/** The fragment never reaches the server, so sending it is pointless — and it is one more place to hide data. */
function stripFragment(url: URL): URL {
  if (url.hash === "") return url;
  const clean = new URL(url.toString());
  clean.hash = "";
  return clean;
}

async function request(url: URL, deps: FetchDeps, signal: AbortSignal): Promise<Response> {
  try {
    return await deps.fetch(url.toString(), {
      method: "GET",
      redirect: "manual",
      signal,
      headers: {
        "user-agent": USER_AGENT,
        accept: "text/html,application/xhtml+xml,text/plain;q=0.9,application/json;q=0.8,*/*;q=0.5",
        "accept-language": "en",
      },
    });
  } catch (e) {
    if (signal.aborted) throw new AppError("TOOL_ERROR", `Timed out after ${FETCH_TIMEOUT_MS / 1000} s while fetching ${url.hostname}`);
    const cause = (e as { cause?: unknown } | null)?.cause;
    throw new AppError("TOOL_ERROR", `Could not fetch ${url.hostname}: ${errorMessage(cause ?? e)}`);
  }
}

/**
 * Live path: validate → fetch with manual redirects (each hop re-validated against the network guard, and every
 * connection re-checked at connect time by the guarded client, so DNS rebinding cannot reach a blocked address) →
 * stream the body up to the cap → convert to text by content type. Throws AppError("TOOL_ERROR") on any problem.
 */
export async function fetchUrlLive(raw: string, deps: Partial<FetchDeps> = {}): Promise<ToolOutput<"fetch_url">> {
  assertUrlLength(raw);
  const lookup = deps.lookup;
  const resolved: FetchDeps = { fetch: deps.fetch ?? ((url, init) => transport.fetch(url, init, { lookup })), lookup };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    let check = await checkUrl(raw, { lookup: resolved.lookup });
    if (!check.ok) throw new AppError("TOOL_ERROR", check.reason);
    let url = stripFragment(check.url);
    let response = await request(url, resolved, controller.signal);

    for (let hop = 0; REDIRECT_STATUSES.has(response.status); hop++) {
      await response.body?.cancel().catch(() => undefined);
      if (hop >= MAX_REDIRECTS) throw new AppError("TOOL_ERROR", `Too many redirects (more than ${MAX_REDIRECTS}) from ${url.hostname}`);
      const location = response.headers.get("location");
      if (!location) throw new AppError("TOOL_ERROR", `Redirect from ${url.hostname} had no Location header`);
      let next: string;
      try {
        next = new URL(location, url).toString();
      } catch {
        throw new AppError("TOOL_ERROR", `Redirect from ${url.hostname} points to an invalid URL`);
      }
      check = await checkUrl(next, { lookup: resolved.lookup });
      if (!check.ok) throw new AppError("TOOL_ERROR", `Redirect blocked: ${check.reason}`);
      url = stripFragment(check.url);
      response = await request(url, resolved, controller.signal);
    }

    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      throw new AppError("TOOL_ERROR", `${url.hostname} responded with HTTP ${response.status}`);
    }
    const contentType = response.headers.get("content-type");
    const kind = pageKind(contentType);
    if (!kind) {
      await response.body?.cancel().catch(() => undefined);
      const mime = (contentType ?? "unknown").split(";")[0].trim();
      throw new AppError("TOOL_ERROR", `Unsupported content type "${mime}" — only HTML, plain text and JSON pages can be read`);
    }

    let bytes: Uint8Array;
    try {
      bytes = await readBody(response);
    } catch (e) {
      if (controller.signal.aborted) throw new AppError("TOOL_ERROR", `Timed out after ${FETCH_TIMEOUT_MS / 1000} s while reading ${url.hostname}`);
      throw new AppError("TOOL_ERROR", `Could not read the response from ${url.hostname}: ${errorMessage(e)}`);
    }
    const body = decode(bytes, charsetOf(contentType));
    const finalUrl = url.toString();
    if (kind === "html") {
      const page = htmlToText(body, fallbackTitle(url));
      return { url: finalUrl, title: page.title, text: capText(page.text) };
    }
    return { url: finalUrl, title: fallbackTitle(url), text: capText(body.trim()) };
  } finally {
    clearTimeout(timer);
  }
}

/** Simulated hosts live on the `.example` TLD (RFC 2606) — those pages exist only in the fixture web. */
export function isSimulatedHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/\.$/, "");
  return host === "example" || host.endsWith(".example");
}

export const fetchUrlTool = defineTool("fetch_url", {
  displayName: "Web page reader",
  description:
    "Fetch a public http(s) web page and return its readable text (HTML is converted to plain text; JSON and plain text are returned as-is). Text is capped at about 12,000 characters. Use it on the most promising search results before extracting data.",
  humanDescription: "Opens public web pages and reads their contents.",
  category: "research",
  sideEffect: "external_read",
  defaultRequiresApproval: false,
  costPerCallUsd: 0.0005,
  humanize: (input) => `Read ${quote(input.url, 90)}`,
  describeForApproval: (input) => ({ title: `Read the page at ${quote(input.url, 90)}` }),
  async execute(input, ctx) {
    assertUrlLength(input.url);
    const syntax = checkUrlSyntax(input.url);
    const hostname = syntax.ok ? syntax.url.hostname : undefined;
    if (ctx.simulated || (hostname && isSimulatedHost(hostname))) {
      if (!syntax.ok) throw new AppError("TOOL_ERROR", syntax.reason);
      const page = simulation.fetchPage(input.url);
      return { output: { url: page.url, title: page.title, text: capText(page.text) }, simulated: true };
    }
    // Live mode only: the host must have provenance in this run (F-010).
    if (!syntax.ok) throw new AppError("TOOL_ERROR", syntax.reason);
    await assertFetchAllowed(syntax.url, ctx);
    return { output: await fetchUrlLive(input.url), simulated: false };
  },
});
