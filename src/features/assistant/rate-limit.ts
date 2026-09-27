/**
 * Rate limiting for the chat endpoint.
 *
 * In-memory and per-process, which is a real limitation and stated rather than
 * hidden: with more than one server instance the effective limit is the limit
 * times the instance count. A shared store (Redis) is the correct answer for a
 * multi-region deploy and is one file's change when that day comes — the
 * interface is `consume` and `peek`, and both are synchronous and side-effect
 * free apart from the counter.
 *
 * Why in-memory is nonetheless the right thing *now*: the thing being limited is
 * spend on a paid inference API, and the app has exactly one process in every
 * way it is actually deployed today. Adding Redis to defend against a topology
 * that does not exist would be the dependency this repo's own docs warn about.
 *
 * ## Two limits, because they stop different things
 *
 * `chat` (messages per window) bounds spend. `burst` (messages in a short
 * window) stops a loop — a client retrying on a 502 can burn a paid call per
 * attempt in seconds, which is the failure mode a single slow window misses
 * entirely. Streaming regenerations count against both, because a regenerate is
 * a full paid call.
 *
 * Counters are swept on read rather than on a timer, so there is no interval to
 * keep alive and no timer to leak in a serverless function.
 */
export type LimitVerdict = { allowed: true; remaining: number; resetAt: number } | {
  allowed: false;
  remaining: 0;
  resetAt: number;
  /** Seconds the caller should wait. Sent as `Retry-After`. */
  retryAfterSec: number;
};

type Counter = { count: number; resetAt: number };

/** Default: 20 messages a minute, 5 in 10 seconds. */
export const CHAT_LIMIT = { windowMs: 60_000, max: Number(process.env.ASSISTANT_RPM ?? 20) };
export const BURST_LIMIT = { windowMs: 10_000, max: Number(process.env.ASSISTANT_BURST ?? 5) };

const counters = new Map<string, Counter>();

function sweep(now: number): void {
  for (const [key, counter] of counters) {
    if (counter.resetAt <= now) counters.delete(key);
  }
}

function check(key: string, windowMs: number, max: number, now: number): LimitVerdict {
  const existing = counters.get(key);
  if (!existing || existing.resetAt <= now) {
    counters.set(key, { count: 1, resetAt: now + windowMs });
    return { allowed: true, remaining: max - 1, resetAt: now + windowMs };
  }
  if (existing.count >= max) {
    return {
      allowed: false,
      remaining: 0,
      resetAt: existing.resetAt,
      retryAfterSec: Math.max(1, Math.ceil((existing.resetAt - now) / 1000)),
    };
  }
  existing.count += 1;
  return { allowed: true, remaining: max - existing.count, resetAt: existing.resetAt };
}

/**
 * Consume one chat turn for an owner.
 *
 * Checks the burst window first, so a client in a retry loop is stopped by the
 * limit that actually describes it rather than by the slower one.
 */
export function consumeChat(ownerId: string, now = Date.now()): LimitVerdict {
  sweep(now);
  const burst = check(`burst:${ownerId}`, BURST_LIMIT.windowMs, BURST_LIMIT.max, now);
  if (!burst.allowed) return burst;
  return check(`chat:${ownerId}`, CHAT_LIMIT.windowMs, CHAT_LIMIT.max, now);
}

/** Read the counters without consuming. Used by the UI's rate-limit notice. */
export function peekChat(ownerId: string, now = Date.now()): LimitVerdict {
  const burst = counters.get(`burst:${ownerId}`);
  const chat = counters.get(`chat:${ownerId}`);
  if (burst && burst.resetAt > now && burst.count >= BURST_LIMIT.max) {
    return { allowed: false, remaining: 0, resetAt: burst.resetAt, retryAfterSec: Math.max(1, Math.ceil((burst.resetAt - now) / 1000)) };
  }
  if (chat && chat.resetAt > now && chat.count >= CHAT_LIMIT.max) {
    return { allowed: false, remaining: 0, resetAt: chat.resetAt, retryAfterSec: Math.max(1, Math.ceil((chat.resetAt - now) / 1000)) };
  }
  return {
    allowed: true,
    remaining: Math.max(
      0,
      Math.min(
        (chat ? CHAT_LIMIT.max - chat.count : CHAT_LIMIT.max),
        burst ? BURST_LIMIT.max - burst.count : BURST_LIMIT.max,
      ),
    ),
    resetAt: chat?.resetAt ?? now + CHAT_LIMIT.windowMs,
  };
}

/** Test seam, and the only way to reset state without waiting for a window. */
export function resetLimits(): void {
  counters.clear();
}
