/**
 * Environment access. Every `process.env` read in the codebase goes through
 * here so that "what config exists?" is a single grep, and so a missing key
 * fails with a named error instead of `undefined` leaking downstream.
 *
 * Invariant: a key that is REQUIRED must throw at read time with the variable
 * name in the message. A key that is OPTIONAL returns `undefined`.
 */

export class MissingEnvError extends Error {
  constructor(public readonly key: string, hint?: string) {
    super(
      `Missing required environment variable ${key}.` + (hint ? ` ${hint}` : ""),
    );
    this.name = "MissingEnvError";
  }
}

export function requiredEnv(key: string, hint?: string): string {
  const raw = process.env[key];
  if (raw === undefined || raw === "") {
    throw new MissingEnvError(key, hint);
  }
  return raw;
}

export function optionalEnv(key: string): string | undefined {
  const raw = process.env[key];
  return raw === undefined || raw === "" ? undefined : raw;
}

export function envFlag(key: string, fallback = false): boolean {
  const raw = optionalEnv(key);
  if (raw === undefined) return fallback;
  return raw === "1" || raw.toLowerCase() === "true";
}

export function envInt(key: string, fallback: number): number {
  const raw = optionalEnv(key);
  if (raw === undefined) return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed)) {
    throw new Error(`Environment variable ${key} must be an integer, got ${JSON.stringify(raw)}`);
  }
  return parsed;
}

/** Minutes. Network-dependent modules use this to decide whether to block. */
export function networkTimeoutMs(): number {
  return envInt("NETWORK_TIMEOUT_MS", 15_000);
}
