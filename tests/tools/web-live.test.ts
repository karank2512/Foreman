import { afterEach, describe, expect, it, vi } from "vitest";
import { transport } from "@/server/tools/guarded-http";
import { fetchUrlLive, fetchUrlTool, htmlToText, MAX_BODY_BYTES, MAX_TEXT_CHARS } from "@/server/tools/impl/fetch-url";
import { TAVILY_ENDPOINT, webSearchTool } from "@/server/tools/impl/web-search";
import type { LookupFn } from "@/server/tools/net-guard";
import { makeCtx } from "./helpers";

/** Live paths never touch the network in tests: fetch is stubbed and DNS is injected. */

const publicLookup: LookupFn = async () => [{ address: "93.184.216.34", family: 4 }];
const liveCtx = (key?: string) => makeCtx({ simulated: false, getSecret: async (name) => (name === "TAVILY_API_KEY" ? key : undefined) });

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" }, ...init });
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("web_search (live via Tavily)", () => {
  it("calls Tavily with the bearer key and maps results to SearchResult", async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse({
        results: [
          { title: "  Acme raises $40M  ", url: "https://www.techpress.com/acme-40m", content: "Acme  Compute\nraised a Series B.", score: 0.9, published_date: "2026-09-10" },
          { title: null, url: "https://blog.acme.com/post", content: null },
          { title: "Third", url: "https://third.com/x", content: "c" },
        ],
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await webSearchTool.execute({ query: "Acme funding", maxResults: 2 }, liveCtx("tvly-secret"));
    expect(result.simulated).toBe(false);
    expect(result.output.results).toEqual([
      { title: "Acme raises $40M", url: "https://www.techpress.com/acme-40m", snippet: "Acme Compute raised a Series B.", source: "techpress.com", publishedAt: "2026-09-10" },
      { title: "https://blog.acme.com/post", url: "https://blog.acme.com/post", snippet: "", source: "blog.acme.com", publishedAt: "" },
    ]);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(TAVILY_ENDPOINT);
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>).authorization).toBe("Bearer tvly-secret");
    expect(JSON.parse(String(init.body))).toMatchObject({ query: "Acme funding", max_results: 2 });
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it("surfaces HTTP failures as errors — never simulated results — when a key is configured", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("nope", { status: 401 })));
    await expect(webSearchTool.execute({ query: "Acme funding" }, liveCtx("tvly-bad"))).rejects.toMatchObject({
      code: "TOOL_ERROR",
      message: expect.stringMatching(/HTTP 401.*Tavily API key/),
    });
  });

  it("tells the owner what to do about Tavily's rate limit and plan-limit statuses", async () => {
    const cases: Array<[number, RegExp]> = [
      [429, /HTTP 429 — Tavily is rate-limiting this key/],
      [432, /HTTP 432 — this Tavily key has used up its plan or spending limit/],
      [433, /HTTP 433 — this Tavily key has used up its plan or spending limit/],
      [502, /HTTP 502 — Tavily is having trouble/],
    ];
    for (const [status, message] of cases) {
      vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status })));
      await expect(webSearchTool.execute({ query: "Acme funding" }, liveCtx("tvly-k"))).rejects.toMatchObject({ code: "TOOL_ERROR", message: expect.stringMatching(message) });
    }
  });

  it("surfaces network errors, invalid JSON and malformed payloads as errors", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Promise.reject(new TypeError("fetch failed"))));
    await expect(webSearchTool.execute({ query: "Acme funding" }, liveCtx("k"))).rejects.toMatchObject({ message: expect.stringContaining("fetch failed") });

    vi.stubGlobal("fetch", vi.fn(async () => new Response("<html>", { status: 200 })));
    await expect(webSearchTool.execute({ query: "Acme funding" }, liveCtx("k"))).rejects.toMatchObject({ message: expect.stringContaining("invalid JSON") });

    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ results: [{ content: "no url" }] })));
    await expect(webSearchTool.execute({ query: "Acme funding" }, liveCtx("k"))).rejects.toMatchObject({ message: expect.stringContaining("unexpected response") });
  });

  it("never calls Tavily when the context is simulated, even with a key", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const result = await webSearchTool.execute({ query: "Acme funding" }, makeCtx({ simulated: true, getSecret: async () => "tvly-secret" }));
    expect(result.simulated).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("fetch_url (live)", () => {
  const html = `<!doctype html><html><head><title>  Acme raises  $40M </title><style>body{}</style><script>alert(1)</script></head>
<body><nav>Home · About</nav><header><h1>Acme raises $40M</h1></header>
<p>Acme   Compute announced a <b>Series B</b> led by
Foo Ventures.</p><div><p>Second paragraph.</p></div>
<table><tr><td>Stage</td><td>Series B</td></tr></table>
<noscript>enable js</noscript><footer>© Acme</footer><script>track()</script></body></html>`;

  const page = (body: string, contentType = "text/html; charset=utf-8", status = 200, headers: Record<string, string> = {}) =>
    new Response(body, { status, headers: { "content-type": contentType, ...headers } });

  it("converts HTML to readable text: title from <title>, chrome removed, whitespace collapsed", async () => {
    const fetchMock = vi.fn(async () => page(html));
    const result = await fetchUrlLive("https://techpress.test/acme", { fetch: fetchMock, lookup: publicLookup });
    expect(result.url).toBe("https://techpress.test/acme");
    expect(result.title).toBe("Acme raises $40M");
    expect(result.text).not.toMatch(/alert|track\(\)|Home · About|enable js|© Acme|body\{\}/);
    expect(result.text).toContain("Acme Compute announced a Series B led by Foo Ventures.");
    expect(result.text).toContain("Second paragraph.");
    expect(result.text).toContain("Stage Series B");
    expect(result.text).not.toMatch(/ {2}|\n{3}/);
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(init.redirect).toBe("manual");
    expect((init.headers as Record<string, string>)["user-agent"]).toContain("Foreman");
  });

  it("falls back to the h1 / host when there is no <title> and works without <body>", () => {
    expect(htmlToText("<h1>Headline</h1><p>x</p>", "host.test").title).toBe("Headline");
    expect(htmlToText("<p>only text</p>", "host.test")).toEqual({ title: "host.test", text: "only text" });
  });

  it("passes plain text and JSON through untouched and rejects other content types", async () => {
    const text = await fetchUrlLive("https://files.test/notes.txt", { fetch: async () => page("line one\n\nline two", "text/plain"), lookup: publicLookup });
    expect(text).toEqual({ url: "https://files.test/notes.txt", title: "files.test/notes.txt", text: "line one\n\nline two" });

    const json = await fetchUrlLive("https://api.test/v1/rounds", { fetch: async () => page('{"rounds":[1,2]}', "application/json"), lookup: publicLookup });
    expect(json.text).toBe('{"rounds":[1,2]}');

    await expect(fetchUrlLive("https://cdn.test/report.pdf", { fetch: async () => page("%PDF", "application/pdf"), lookup: publicLookup })).rejects.toMatchObject({
      code: "TOOL_ERROR",
      message: expect.stringContaining('Unsupported content type "application/pdf"'),
    });
    await expect(fetchUrlLive("https://cdn.test/x", { fetch: async () => page("binary", "application/octet-stream"), lookup: publicLookup })).rejects.toMatchObject({
      message: expect.stringContaining("Unsupported content type"),
    });
    await expect(fetchUrlLive("https://cdn.test/img.png", { fetch: async () => page("png", "image/png"), lookup: publicLookup })).rejects.toMatchObject({
      message: expect.stringContaining('"image/png"'),
    });
  });

  it("reports non-2xx responses", async () => {
    await expect(fetchUrlLive("https://gone.test/x", { fetch: async () => page("missing", "text/html", 404), lookup: publicLookup })).rejects.toMatchObject({
      message: "gone.test responded with HTTP 404",
    });
  });

  it("follows up to 3 redirects, resolving relative Locations and re-validating each hop", async () => {
    const seen: string[] = [];
    const fetchMock = async (input: string | URL | Request): Promise<Response> => {
      const url = String(input);
      seen.push(url);
      if (url === "http://start.test/") return page("", "text/html", 301, { location: "https://start.test/a" });
      if (url === "https://start.test/a") return page("", "text/html", 302, { location: "/b?x=1" });
      if (url === "https://start.test/b?x=1") return page("", "text/html", 307, { location: "https://final.test/page" });
      return page("<title>Final</title><p>done</p>");
    };
    const result = await fetchUrlLive("http://start.test/", { fetch: fetchMock, lookup: publicLookup });
    expect(seen).toEqual(["http://start.test/", "https://start.test/a", "https://start.test/b?x=1", "https://final.test/page"]);
    expect(result).toEqual({ url: "https://final.test/page", title: "Final", text: "done" });
  });

  it("stops after too many redirects", async () => {
    let n = 0;
    const fetchMock = async () => page("", "text/html", 302, { location: `https://loop.test/${++n}` });
    await expect(fetchUrlLive("https://loop.test/0", { fetch: fetchMock, lookup: publicLookup })).rejects.toMatchObject({ message: expect.stringContaining("Too many redirects") });
    expect(n).toBe(4);
  });

  it("blocks redirects into private networks, other schemes and disallowed ports", async () => {
    const redirectTo = (location: string) => async () => page("", "text/html", 302, { location });
    const lookup: LookupFn = async (host) => [{ address: host === "internal.test" ? "10.0.0.8" : "93.184.216.34", family: 4 }];
    for (const location of ["http://169.254.169.254/latest/meta-data/", "http://internal.test/", "ftp://public.test/x", "http://public.test:9200/", "http://localhost/"]) {
      await expect(fetchUrlLive("https://public.test/", { fetch: redirectTo(location), lookup })).rejects.toMatchObject({
        code: "TOOL_ERROR",
        message: expect.stringContaining("Redirect blocked"),
      });
    }
  });

  it("refuses to fetch unsafe URLs before any request is made", async () => {
    const fetchMock = vi.fn();
    for (const url of ["http://127.0.0.1/", "http://[::1]/", "http://10.1.1.1/", "http://192.168.1.1/", "ftp://public.test/", "http://public.test:22/"]) {
      await expect(fetchUrlLive(url, { fetch: fetchMock, lookup: publicLookup })).rejects.toMatchObject({ code: "TOOL_ERROR" });
    }
    await expect(fetchUrlLive("http://internal.test/", { fetch: fetchMock, lookup: async () => [{ address: "172.16.5.5", family: 4 }] })).rejects.toMatchObject({
      message: expect.stringContaining("private or reserved address"),
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("streams the body, stops at 200 KB and caps the text at ~12,000 chars", async () => {
    const chunk = new TextEncoder().encode(`${"lorem ipsum dolor sit amet ".repeat(40)}\n`); // ~1 KB
    let pulled = 0;
    let cancelled = false;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulled++;
        if (pulled > 2000) controller.close();
        else controller.enqueue(chunk);
      },
      cancel() {
        cancelled = true;
      },
    });
    const response = new Response(stream, { status: 200, headers: { "content-type": "text/plain" } });
    const result = await fetchUrlLive("https://big.test/huge.txt", { fetch: async () => response, lookup: publicLookup });
    expect(result.text.length).toBeLessThanOrEqual(MAX_TEXT_CHARS + 20);
    expect(result.text.endsWith("[truncated]")).toBe(true);
    expect(pulled * chunk.byteLength).toBeLessThan(MAX_BODY_BYTES + 4 * chunk.byteLength);
    expect(cancelled).toBe(true);
  });

  it("times out after 10 s", async () => {
    vi.useFakeTimers();
    const hanging = (_input: string | URL | Request, init?: RequestInit) =>
      new Promise<Response>((_, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new DOMException("The operation was aborted", "AbortError")));
      });
    const pending = fetchUrlLive("https://slow.test/", { fetch: hanging, lookup: publicLookup });
    const assertion = expect(pending).rejects.toMatchObject({ message: expect.stringContaining("Timed out after 10 s") });
    await vi.advanceTimersByTimeAsync(10_001);
    await assertion;
  });

  it("refuses a live host with no provenance in this run, and says how to get some", async () => {
    // F-010: in live mode a host must come from this run's own search results or from the job text.
    // The context here points at no real run, so nothing is allowed. (The allowed path is covered in
    // tests/security/tool-provenance.test.ts, which sets up a real run.)
    vi.spyOn(transport, "fetch").mockImplementation(async () => page("<title>Live</title><p>hello</p>"));
    await expect(fetchUrlTool.execute({ url: "http://93.184.216.34/" }, makeCtx({ simulated: false }))).rejects.toMatchObject({
      code: "TOOL_ERROR",
      message: expect.stringContaining("web_search"),
    });
  });

  it("refuses a URL longer than 2,048 characters before touching the network", async () => {
    const fetchSpy = vi.spyOn(transport, "fetch").mockImplementation(async () => page("<title>Live</title>"));
    const long = `https://exfil.test/c?d=${"a".repeat(2_100)}`;
    await expect(fetchUrlTool.execute({ url: long }, makeCtx({ simulated: false }))).rejects.toMatchObject({
      code: "TOOL_ERROR",
      message: expect.stringContaining("too long"),
    });
    await expect(fetchUrlLive(long, { lookup: publicLookup })).rejects.toMatchObject({ code: "TOOL_ERROR" });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("strips the fragment before requesting the page", async () => {
    let requested = "";
    await fetchUrlLive("https://docs.test/page#section-two", {
      fetch: async (url) => {
        requested = String(url);
        return page("<title>Doc</title><p>body</p>");
      },
      lookup: publicLookup,
    });
    expect(requested).toBe("https://docs.test/page");
  });
});
