/**
 * Who the current request belongs to.
 *
 * The app has no accounts. `better-auth` is a dependency but nothing in `src/`
 * mounts it, and inventing an auth system for a chat feature would be both a
 * large unrequested change and a worse product than the one that exists: this
 * app's own metadata says "the map tiles are keyless public endpoints and the
 * whole point is that nothing here needs an account".
 *
 * So ownership is a capability token, which is the same primitive a session is:
 *
 *   - a 128-bit random secret in an `httpOnly`, `SameSite=Lax`, `Secure`-in-
 *     production cookie;
 *   - the stored `owner_id` is `sha256(secret)`, never the secret;
 *   - a database dump therefore cannot be replayed as a live session, and a
 *     leaked owner id identifies nobody.
 *
 * There is no signing secret to configure and no session table, which is why this
 * is a module rather than an auth framework. The consequence to be honest about:
 * clearing cookies starts a new conversation history. That is the cost of not
 * having accounts, and it is stated in the docs rather than hidden.
 */
import { createHash, randomBytes } from "node:crypto";

export const OWNER_COOKIE = "tb_owner";
/** Matches the ~1-year max age of a session cookie; a year is plenty for a demo. */
export const OWNER_COOKIE_MAX_AGE = 60 * 60 * 24 * 365;

/**
 * The stored owner id for a secret. Hashed, so the database never holds a
 * credential — only an identifier derived from one.
 */
export function ownerIdFor(secret: string): string {
  return createHash("sha256").update(secret).digest("hex");
}

export function newOwnerSecret(): string {
  return randomBytes(16).toString("hex");
}

/** Parse our own cookie header. Enough for one cookie; not a general parser. */
export function readCookie(header: string | null, name: string): string | null {
  if (!header) return null;
  for (const part of header.split(";")) {
    const at = part.indexOf("=");
    if (at < 0) continue;
    if (part.slice(0, at).trim() === name) return decodeURIComponent(part.slice(at + 1).trim());
  }
  return null;
}

/**
 * The owner id for a request, and the `Set-Cookie` to send if one was minted.
 *
 * Returned as a pair because a cookie cannot be set from a helper: Next only
 * writes `Set-Cookie` on the response object, so the route has to carry the
 * header through. Making the function return it is what keeps that from being
 * forgotten on the one route that mints it.
 */
export function resolveOwner(cookieHeader: string | null, secure: boolean): {
  ownerId: string;
  setCookie: string | null;
} {
  const existing = readCookie(cookieHeader, OWNER_COOKIE);
  if (existing && /^[0-9a-f]{32}$/.test(existing)) {
    return { ownerId: ownerIdFor(existing), setCookie: null };
  }
  const secret = newOwnerSecret();
  return {
    ownerId: ownerIdFor(secret),
    setCookie: `${OWNER_COOKIE}=${secret}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${OWNER_COOKIE_MAX_AGE}${
      secure ? "; Secure" : ""
    }`,
  };
}

/**
 * A stable pseudonymous id for logs and rate limits.
 *
 * A truncated hash, so a log line can be correlated with a conversation without
 * carrying anything that identifies a person or a whole session.
 */
export function ownerFingerprint(ownerId: string): string {
  return ownerId.slice(0, 12);
}
