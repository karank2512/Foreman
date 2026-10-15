#!/usr/bin/env node
/**
 * A dependency-free OTLP/HTTP receiver for the receipt run in docs/OTEL.md ("Web to worker through a real OTLP
 * receiver"). It stands in for a collector: it accepts `POST /v1/traces` with the JSON encoding that
 * `@opentelemetry/exporter-trace-otlp-http` sends (`Content-Type: application/json`, hex ids), appends every
 * request body to a capture file as one JSON line, and prints a one-line summary of what arrived so you can watch
 * the web decision and the worker's slices land. `scripts/otel-check.mjs` then reads the capture.
 *
 *   OTEL_RECEIVER_OUT=/path/to/receipt.ndjson node scripts/otel-receiver.mjs
 *
 *   OTEL_RECEIVER_OUT   capture file, appended to (default: ./otel-receipt.ndjson)
 *   OTEL_RECEIVER_PORT  default 4318, the OTLP/HTTP port the exporter defaults to
 *   OTEL_RECEIVER_HOST  default 127.0.0.1; nothing is reachable from the network unless you ask
 *
 * Capture line format: {"receivedAt": ISO-8601, "contentType": string, "body": ExportTraceServiceRequest}.
 *
 * Protobuf (`application/x-protobuf`, the `exporter-trace-otlp-proto` package) is answered with 415 and a hint:
 * decoding it would need the proto definitions, and Foreman's exporter never sends it.
 */
import { appendFileSync, mkdirSync } from "node:fs";
import { createServer } from "node:http";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { gunzipSync, inflateSync } from "node:zlib";

/** A real export of a whole run is a few hundred kilobytes; anything near this is not Foreman. */
const MAX_BODY_BYTES = 16 * 1024 * 1024;

/**
 * Decode one request body into the OTLP JSON object, or explain why it cannot be.
 * @param {{ contentType?: string; contentEncoding?: string; raw: Buffer }} req
 * @returns {{ ok: true; body: unknown } | { ok: false; status: number; message: string }}
 */
export function decodeBody({ contentType = "", contentEncoding = "", raw }) {
  const type = contentType.split(";")[0].trim().toLowerCase();
  if (type === "application/x-protobuf") {
    return {
      ok: false,
      status: 415,
      message: "protobuf is not supported here: Foreman's exporter (@opentelemetry/exporter-trace-otlp-http) sends application/json; this receiver only decodes that",
    };
  }
  if (type !== "application/json") {
    return { ok: false, status: 415, message: `unsupported Content-Type "${contentType || "(none)"}"; expected application/json` };
  }
  let bytes = raw;
  const encoding = contentEncoding.trim().toLowerCase();
  try {
    if (encoding === "gzip") bytes = gunzipSync(raw);
    else if (encoding === "deflate") bytes = inflateSync(raw);
    else if (encoding !== "" && encoding !== "identity") return { ok: false, status: 415, message: `unsupported Content-Encoding "${contentEncoding}"` };
  } catch (e) {
    return { ok: false, status: 400, message: `could not decompress the body: ${e instanceof Error ? e.message : String(e)}` };
  }
  try {
    return { ok: true, body: JSON.parse(bytes.toString("utf8")) };
  } catch (e) {
    return { ok: false, status: 400, message: `body is not JSON: ${e instanceof Error ? e.message : String(e)}` };
  }
}

/** The `service.name` resource attribute of one ResourceSpans entry, if it has one. */
function serviceName(resourceSpans) {
  const attributes = resourceSpans?.resource?.attributes ?? [];
  for (const kv of attributes) if (kv?.key === "service.name") return kv.value?.stringValue ?? "?";
  return "?";
}

/**
 * What one export request contained, for the console: per service, how many spans, and which decision outcomes
 * (the events the receipt is about) were among them. Ids and attributes are not printed.
 * @param {unknown} body
 * @returns {{ services: string[]; spans: number; outcomes: string[]; names: string[] }}
 */
export function summarizeBody(body) {
  const services = new Set();
  const outcomes = [];
  const names = new Set();
  let spans = 0;
  const resourceSpans = Array.isArray(body?.resourceSpans) ? body.resourceSpans : [];
  for (const rs of resourceSpans) {
    services.add(serviceName(rs));
    for (const ss of rs?.scopeSpans ?? []) {
      for (const span of ss?.spans ?? []) {
        spans += 1;
        if (typeof span?.name === "string") names.add(span.name);
        for (const event of span?.events ?? []) {
          if (event?.name !== "gen_ai.tool.call.decision") continue;
          for (const kv of event?.attributes ?? []) {
            if (kv?.key === "gen_ai.tool.call.decision.outcome" && typeof kv.value?.stringValue === "string") outcomes.push(kv.value.stringValue);
          }
        }
      }
    }
  }
  return { services: [...services], spans, outcomes, names: [...names] };
}

function readBody(req) {
  return new Promise((resolveBody, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error("body too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolveBody(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function send(res, status, payload, contentType = "application/json") {
  const text = typeof payload === "string" ? payload : JSON.stringify(payload);
  res.writeHead(status, { "Content-Type": contentType, "Content-Length": Buffer.byteLength(text) });
  res.end(text);
}

function startReceiver() {
  const port = Number(process.env.OTEL_RECEIVER_PORT ?? 4318);
  const host = process.env.OTEL_RECEIVER_HOST ?? "127.0.0.1";
  const out = resolve(process.env.OTEL_RECEIVER_OUT ?? "otel-receipt.ndjson");
  mkdirSync(dirname(out), { recursive: true });

  let received = 0;
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
    if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/healthz")) {
      return send(res, 200, `otel-receiver: ${received} export request(s) written to ${out}\n`, "text/plain; charset=utf-8");
    }
    if (url.pathname !== "/v1/traces") return send(res, 404, { error: "only POST /v1/traces is served" });
    if (req.method !== "POST") return send(res, 405, { error: "use POST" });

    let raw;
    try {
      raw = await readBody(req);
    } catch (e) {
      return send(res, 413, { error: e instanceof Error ? e.message : String(e) });
    }
    const contentType = String(req.headers["content-type"] ?? "");
    const decoded = decodeBody({ contentType, contentEncoding: String(req.headers["content-encoding"] ?? ""), raw });
    if (!decoded.ok) {
      process.stderr.write(`[otel-receiver] rejected (${decoded.status}): ${decoded.message}\n`);
      return send(res, decoded.status, { error: decoded.message });
    }

    const receivedAt = new Date().toISOString();
    appendFileSync(out, `${JSON.stringify({ receivedAt, contentType, body: decoded.body })}\n`);
    received += 1;
    const summary = summarizeBody(decoded.body);
    const outcomes = summary.outcomes.length > 0 ? `  decisions: ${summary.outcomes.join(", ")}` : "";
    process.stdout.write(`[otel-receiver] ${receivedAt}  ${summary.services.join("+")}  ${summary.spans} span(s): ${summary.names.join(", ")}${outcomes}\n`);
    // An OTLP/HTTP success is an empty ExportTraceServiceResponse.
    return send(res, 200, {});
  });

  server.on("error", (e) => {
    process.stderr.write(`[otel-receiver] cannot listen on ${host}:${port}: ${e instanceof Error ? e.message : String(e)}\n`);
    process.exit(1);
  });
  server.listen(port, host, () => {
    process.stdout.write(`[otel-receiver] listening on http://${host}:${port}/v1/traces (application/json), appending to ${out}\n`);
    process.stdout.write(`[otel-receiver] point Foreman at it with OTEL_ENABLED=true OTEL_EXPORTER_OTLP_ENDPOINT=http://${host}:${port}\n`);
  });

  const stop = () => {
    process.stdout.write(`\n[otel-receiver] ${received} export request(s) written to ${out}\n`);
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 1000).unref();
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
}

const isMain = process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (isMain) startReceiver();
