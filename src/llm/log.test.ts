import { describe, expect, it } from "vitest";
import { log, redact, setLogSink } from "./log";

describe("the no-secrets guarantee", () => {
  it("redacts a credential that sits in the first 500 characters of a long value", () => {
    const key = "sk-or-v1-abcdefgh12345678";
    const scrubbed = redact(`${key} ${"x".repeat(2000)}`) as string;
    expect(scrubbed).not.toContain(key);
    expect(scrubbed).toContain("[redacted]");
  });

  it("still caps the value after redacting", () => {
    expect((redact("y".repeat(2000)) as string).length).toBeLessThanOrEqual(501);
  });

  it("catches credentials under compound key names", () => {
    const out = redact({
      "x-api-key": "anything",
      OPENROUTER_API_KEY: "anything",
      sessionToken: "anything",
      travellerName: "Imran Shaikh",
    }) as Record<string, unknown>;
    expect(out).toEqual({
      "x-api-key": "[redacted]",
      OPENROUTER_API_KEY: "[redacted]",
      sessionToken: "[redacted]",
      travellerName: "Imran Shaikh",
    });
  });

  it("scrubs the props object handed to the sink", () => {
    const seen: Record<string, unknown>[] = [];
    setLogSink((_line, _level, _event, props) => seen.push(props));
    process.env.ANANTA_LOG = "debug";
    try {
      log.error("llm.request", { apiKey: "sk-or-v1-abcdefgh12345678", party: 2 });
    } finally {
      delete process.env.ANANTA_LOG;
      setLogSink(() => {});
    }
    expect(seen[0]).toEqual({ apiKey: "[redacted]", party: 2 });
  });
});
