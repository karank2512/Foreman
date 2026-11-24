/**
 * Secret scrubbing for anything that may end up in a log line, a stored error column or a user-visible
 * message (F-009, INF-20). Pure and dependency-free so every layer — including the edge — can use it.
 *
 * Every pattern is linear-time (single character classes with a `+`): this runs on untrusted model and web
 * text, so a backtracking regex here would stall the event loop (INF-17).
 */

const REDACTED = "[redacted]";

const PATTERNS: ReadonlyArray<{ re: RegExp; replacement: string }> = [
  // Provider API keys. sk- covers OpenAI and Anthropic (sk-ant-…), tvly- Tavily, AIza Google.
  { re: /\bsk-[A-Za-z0-9_-]{8,}/g, replacement: REDACTED },
  { re: /\btvly-[A-Za-z0-9_-]{8,}/g, replacement: REDACTED },
  { re: /\bAIza[A-Za-z0-9_-]{10,}/g, replacement: REDACTED },
  { re: /\bxox[abprs]-[A-Za-z0-9-]{8,}/g, replacement: REDACTED },
  { re: /\bghp_[A-Za-z0-9]{10,}/g, replacement: REDACTED },
  // Authorization headers and bearer tokens.
  { re: /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi, replacement: `Bearer ${REDACTED}` },
  // Credentials embedded in a connection string: postgres://user:secret@host
  { re: /:\/\/([^\s:/@]+):[^\s@/]+@/g, replacement: `://$1:${REDACTED}@` },
  // Long opaque tokens (hex digests, base64 secrets). 40+ chars — cuids (25) and ISO dates stay readable.
  // The lookarounds keep URLs intact: a run inside "https://host/a/long/path" is preceded by "/" or ".".
  // Password-reset links (`/reset-password/<userId>.<expiry>.<signature>`): the signature follows a "." so the
  // opaque-token rule below deliberately skips it. A path like this reaches logs via onRequestError.
  { re: /(\/reset-password\/)[A-Za-z0-9_.-]+/g, replacement: `$1${REDACTED}` },
  { re: /\b[A-Fa-f0-9]{40,}\b/g, replacement: REDACTED },
  { re: /(?<![A-Za-z0-9+/_.-])[A-Za-z0-9+/_-]{40,}={0,2}(?![A-Za-z0-9+/_.-])/g, replacement: REDACTED },
];

/** Replace anything that looks like a credential with `[redacted]`. Never throws. */
export function redactSecrets(text: string): string {
  if (typeof text !== "string" || text === "") return "";
  let out = text;
  for (const { re, replacement } of PATTERNS) out = out.replace(re, replacement);
  return out;
}

/** Redact, then clip to `max` characters with an ellipsis — the shape every error column and log field wants. */
export function redactAndClip(text: string, max: number): string {
  const safe = redactSecrets(text);
  return safe.length > max ? `${safe.slice(0, max)}…` : safe;
}

/**
 * Metadata written to SecurityEvent / logs: drop keys whose NAME suggests a secret, redact string values,
 * and bound the size. Only scalars survive — nested objects are JSON-stringified and clipped.
 */
const SECRET_KEY = /(password|passwd|secret|token|api[_-]?key|authorization|cookie|credential|encrypted)/i;
const MAX_METADATA_KEYS = 20;
const MAX_METADATA_VALUE_CHARS = 200;

export function redactMetadata(metadata: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  if (!metadata) return undefined;
  const out: Record<string, unknown> = {};
  let keys = 0;
  for (const [key, value] of Object.entries(metadata)) {
    if (value === undefined) continue;
    if (keys >= MAX_METADATA_KEYS) break;
    keys += 1;
    if (SECRET_KEY.test(key)) {
      out[key] = REDACTED;
      continue;
    }
    if (value === null || typeof value === "number" || typeof value === "boolean") {
      out[key] = value;
      continue;
    }
    if (typeof value === "string") {
      out[key] = redactAndClip(value, MAX_METADATA_VALUE_CHARS);
      continue;
    }
    try {
      out[key] = redactAndClip(JSON.stringify(value) ?? "", MAX_METADATA_VALUE_CHARS);
    } catch {
      out[key] = "[unserializable]";
    }
  }
  return out;
}
