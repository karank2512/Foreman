import { describe, expect, it, vi } from "vitest";
import { GENERIC_ACTION_ERROR, runAction } from "@/lib/action-result";
import { AppError } from "@/server/errors";
import { GENERIC_PUBLIC_ERROR, publicErrorMessage, redactAndClip, redactMetadata, redactSecrets } from "@/server/security";

describe("redactSecrets", () => {
  it("removes provider keys, bearer tokens and connection-string passwords", () => {
    const cases: Array<[string, RegExp]> = [
      ["Incorrect API key provided: sk-ant-api03-Zm9vYmFyYmF6cXV4", /\[redacted\]/],
      ["search failed for tvly-dev-abcdef123456", /\[redacted\]/],
      ["google said AIzaSyA1B2C3D4E5F6G7H8I9", /\[redacted\]/],
      ["Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9", /Bearer \[redacted\]/],
      ["postgres://app:hunter2@db.internal:5432/app", /postgres:\/\/app:\[redacted\]@/],
      ["slack token xoxb-1234567890-abcdefghijkl", /\[redacted\]/],
    ];
    for (const [input, expected] of cases) {
      const output = redactSecrets(input);
      expect(output, input).toMatch(expected);
      expect(output, input).not.toContain("hunter2");
    }
    expect(redactSecrets("sk-ant-api03-Zm9vYmFyYmF6cXV4")).not.toContain("Zm9vYmFy");
  });

  it("redacts long opaque tokens but leaves ids, URLs and prose alone", () => {
    expect(redactSecrets("a".repeat(48))).toBe("[redacted]");
    expect(redactSecrets("deadbeef".repeat(6))).toBe("[redacted]");

    const readable = "run cmucasmyb01kwrwpbbgxzffb3 failed at https://news.example/markets/ai-infra-funding-weekly/2026-09";
    expect(redactSecrets(readable)).toBe(readable);
    expect(redactSecrets("Worker Alex could not reach api.example.com (HTTP 503)")).toContain("api.example.com");
  });

  it("is linear on adversarial input", () => {
    const nasty = `${" ".repeat(60_000)}sk-${"a".repeat(60_000)} ${"/".repeat(20_000)}`;
    const started = performance.now();
    redactSecrets(nasty);
    expect(performance.now() - started).toBeLessThan(200);
  });

  it("never throws and clips to the requested length", () => {
    expect(redactSecrets("")).toBe("");
    expect(redactAndClip("the run failed twice in a row today", 10)).toBe("the run fa…");
    expect(redactAndClip("short", 50)).toBe("short");
  });
});

describe("redactMetadata", () => {
  it("drops secret-looking keys, scrubs values and bounds the size", () => {
    const out = redactMetadata({
      name: "TAVILY_API_KEY",
      apiKey: "tvly-dev-abcdef123456",
      password: "hunter2",
      count: 3,
      ok: true,
      nothing: null,
      note: "wrote sk-ant-api03-Zm9vYmFyYmF6cXV4 to the log",
      nested: { deep: { deeper: "value" } },
    });
    expect(out).toMatchObject({ name: "TAVILY_API_KEY", count: 3, ok: true, nothing: null });
    expect(out?.apiKey).toBe("[redacted]");
    expect(out?.password).toBe("[redacted]");
    expect(String(out?.note)).not.toContain("Zm9vYmFy");
    expect(typeof out?.nested).toBe("string");
    expect(redactMetadata(undefined)).toBeUndefined();
  });

  it("keeps at most 20 keys and clips long values", () => {
    const wide = Object.fromEntries(Array.from({ length: 40 }, (_, i) => [`k${i}`, i]));
    expect(Object.keys(redactMetadata(wide) ?? {})).toHaveLength(20);
    expect(String(redactMetadata({ v: "word ".repeat(100) })?.v)).toHaveLength(201);
  });
});

describe("publicErrorMessage", () => {
  it("returns a generic sentence with a reference and logs the internals under it", () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const { message, ref } = publicErrorMessage(new AppError("INTERNAL", "Stored blueprint no longer matches the schema"));

    expect(message).toBe(`${GENERIC_PUBLIC_ERROR} (ref ${ref})`);
    expect(ref).toMatch(/^[0-9a-f]{6}$/);
    expect(message).not.toContain("blueprint");
    expect(String(log.mock.calls[0]?.[0])).toContain(ref);
    log.mockRestore();
  });

  it("has a friendlier line for model and tool failures, and never echoes provider text", () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const model = publicErrorMessage(
      new AppError("MODEL_ERROR", "Anthropic could not complete the request (HTTP 401)", {
        providerMessage: "Incorrect API key provided: sk-ant-api03-Zm9vYmFy",
      }),
    );
    expect(model.message).toMatch(/AI model is unavailable/);
    expect(model.message).not.toContain("sk-ant");
    expect(publicErrorMessage(new AppError("TOOL_ERROR", "tavily said no")).message).toMatch(/tool this worker relies on/);
    log.mockRestore();
  });

  it("shows a provider-setup message of ours verbatim (with its reference), but keeps transient ones generic", () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const fix = "OpenAI says this API key is out of credits or over its spending limit — add credits or raise the limit in your OpenAI account, then try again.";
    for (const kind of ["auth", "permission", "quota", "model_not_found", "rate_limit", "refused"]) {
      const { message, ref } = publicErrorMessage(
        new AppError("MODEL_ERROR", fix, { provider: "openai", kind, providerMessage: "You exceeded your quota: sk-proj-Zm9vYmFy" }),
      );
      expect(message, kind).toBe(`${fix} (ref ${ref})`);
      expect(message, kind).not.toContain("sk-proj");
    }
    for (const kind of ["overloaded", "timeout", "network", "bad_request", "bad_response", "unknown", undefined]) {
      const { message } = publicErrorMessage(new AppError("MODEL_ERROR", "OpenAI is overloaded (HTTP 503)", { kind }));
      expect(message, String(kind)).toMatch(/^The AI model is unavailable right now/);
    }
    // Only MODEL_ERROR carries provider-setup messages: the same details on another code change nothing.
    expect(publicErrorMessage(new AppError("INTERNAL", fix, { kind: "auth" })).message).toMatch(/^Something went wrong/);
    log.mockRestore();
  });

  it("gives each failure its own reference", () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    expect(publicErrorMessage(new Error("a")).ref).not.toBe(publicErrorMessage(new Error("a")).ref);
    log.mockRestore();
  });
});

describe("runAction error policy", () => {
  it("passes AppError messages written for the user straight through", async () => {
    for (const code of ["NOT_FOUND", "FORBIDDEN", "VALIDATION", "CONFLICT", "LIMIT_EXCEEDED", "APPROVAL_REQUIRED"] as const) {
      const result = await runAction(async () => {
        throw new AppError(code, `message for ${code}`);
      });
      expect(result, code).toEqual({ ok: false, error: `message for ${code}` });
    }
  });

  it("hides INTERNAL, MODEL_ERROR and TOOL_ERROR behind a reference", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const internal = await runAction(async () => {
      throw new AppError("INTERNAL", "CREDENTIAL_ENCRYPTION_KEY must be base64 of 32 bytes (got 16)");
    });
    expect(internal).toEqual({ ok: false, error: expect.stringMatching(/^Something went wrong.*\(ref [0-9a-f]{6}\)$/) });
    expect(internal).not.toEqual({ ok: false, error: expect.stringContaining("CREDENTIAL_ENCRYPTION_KEY") });

    const model = await runAction(async () => {
      throw new AppError("MODEL_ERROR", "Anthropic could not complete the request (HTTP 429)");
    });
    expect(model).toEqual({ ok: false, error: expect.stringMatching(/AI model is unavailable.*\(ref [0-9a-f]{6}\)$/) });

    const tool = await runAction(async () => {
      throw new AppError("TOOL_ERROR", "Tavily rejected the key tvly-dev-abcdef123456");
    });
    expect(tool).toEqual({ ok: false, error: expect.stringContaining("tool this worker relies on") });
    expect(JSON.stringify(tool)).not.toContain("tvly-");
    expect(GENERIC_ACTION_ERROR).toBe(GENERIC_PUBLIC_ERROR);
    log.mockRestore();
  });
});
