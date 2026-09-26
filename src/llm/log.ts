/**
 * Structured logging for the AI layer. One sink, one shape.
 *
 * Why this exists instead of `src/lib/logging.ts`: that file is Abhijit's and did
 * not exist when this was written. The seam is `setLogSink` — when it lands, the
 * only change needed is one call at app boot:
 *
 *   setLogSink((line, level, event, props) => appLogger.log(level, event, props))
 *
 * Hard rule, from the contract's own header: no secret ever reaches a log line.
 * `redact` runs on every props object and on every rendered value, because the
 * cheapest way to leak an API key is to log the request that carried it.
 */

export type LogLevel = "off" | "error" | "warn" | "info" | "debug";

const RANK: Record<LogLevel, number> = { off: 0, error: 1, warn: 2, info: 3, debug: 4 };

export type LogSink = (
  line: string,
  level: Exclude<LogLevel, "off">,
  event: string,
  props: Record<string, unknown>,
) => void;

const SECRET_KEYS = /^(api[-_]?key|authorization|token|secret|password|cookie)$/i;

/** Values that look like credentials, wherever they appear. */
const SECRET_VALUE = /(sk-or-v1-[A-Za-z0-9_-]{8,}|sk-[A-Za-z0-9]{16,}|Bearer\s+[A-Za-z0-9._-]{8,})/g;

function scrubString(value: string): string {
  return value.length > 500 ? `${value.slice(0, 500)}…` : value.replace(SECRET_VALUE, "[redacted]");
}

export function redact(value: unknown, depth = 0): unknown {
  if (value == null) return value;
  if (typeof value === "string") return scrubString(value);
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (depth > 4) return "[deep]";
  if (Array.isArray(value)) return value.slice(0, 20).map((v) => redact(v, depth + 1));
  if (value instanceof Error) return { name: value.name, message: scrubString(value.message) };
  if (typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = SECRET_KEYS.test(k) ? "[redacted]" : redact(v, depth + 1);
    }
    return out;
  }
  return String(value);
}

let sink: LogSink = (line, level, _event, props) => {
  if (level === "error") console.error(line, props);
  else if (level === "warn") console.warn(line, props);
  else console.log(line, props);
};

/** Swap the sink. Called once at app boot to hand logging to `src/lib`. */
export function setLogSink(next: LogSink): void {
  sink = next;
}

function level(): LogLevel {
  const raw = process.env.ANANTA_LOG?.trim().toLowerCase();
  if (raw && raw in RANK) return raw as LogLevel;
  return process.env.NODE_ENV === "production" ? "info" : "warn";
}

function emit(lvl: Exclude<LogLevel, "off">, event: string, props: Record<string, unknown>): void {
  if (RANK[lvl] > RANK[level()]) return;
  const safe = redact(props) as Record<string, unknown>;
  sink(`[ananta/llm] ${event}`, lvl, event, safe);
}

export const log = {
  error: (event: string, props: Record<string, unknown> = {}) => emit("error", event, props),
  warn: (event: string, props: Record<string, unknown> = {}) => emit("warn", event, props),
  info: (event: string, props: Record<string, unknown> = {}) => emit("info", event, props),
  debug: (event: string, props: Record<string, unknown> = {}) => emit("debug", event, props),
};
