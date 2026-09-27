/**
 * Better Auth, backed by Supabase Postgres.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS FILE CANNOT THROW
 * ---------------------------------------------------------------------------
 *
 * `betterAuth()` runs at module scope, and the root layout pulls this in
 * transitively, so anything that throws here takes down `next build` and every
 * page. The keys arrive after the code does, so a hard failure on a missing
 * env var would mean the site could not be built until Supabase was configured
 * — including by anyone who only wants to work on the editorial pages.
 *
 * So the secret degrades instead of throwing:
 *
 *   BETTER_AUTH_SECRET  falls back to a random value generated per process. Not
 *                       a committed constant, which would be a signing key
 *                       anyone with the repo could forge sessions with. Random
 *                       per process means sessions do not survive a restart and
 *                       do not work across instances, which is a loud,
 *                       self-announcing misconfiguration rather than a subtle
 *                       security hole. Set the variable and it goes away.
 *
 *   DATABASE_URL        no pool is created at all, so Better Auth builds without
 *                       an adapter instead of holding a connection it cannot
 *                       use. See `lib/db.ts`.
 *
 * The app is fully playable either way: progress lives in `localStorage` and
 * cloud sync is opt-in per signed-in user.
 */

import { randomBytes } from "node:crypto";

import { betterAuth } from "better-auth";
import type { BetterAuthOptions } from "better-auth";
import { nextCookies } from "better-auth/next-js";

import { pool } from "./db";

/**
 * The config on its own, without the Next plugin.
 *
 * Exported because `tools/migrate.mjs` has to build the schema from the *same*
 * options the server uses. A migration generated from a hand-written or
 * re-declared config is a schema that quietly disagrees with the library, and
 * the disagreement only shows up as a runtime error on the first sign-in.
 */

function secret(): string {
  const fromEnv = process.env.BETTER_AUTH_SECRET;
  if (fromEnv) return fromEnv;

  console.warn(
    "[auth] BETTER_AUTH_SECRET is unset. Falling back to a per-process random " +
      "value: sessions will not survive a restart and will not work across " +
      "more than one instance. Set BETTER_AUTH_SECRET before deploying.",
  );
  return randomBytes(32).toString("base64");
}

/**
 * Every origin a browser may legitimately present.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS IS NOT JUST `baseURL`
 * ---------------------------------------------------------------------------
 *
 * Better Auth compares the request's `Origin` header against this list and
 * answers `invalid_origin` when they do not match, so this is the whole reason a
 * sign-in that looks correctly configured can still fail. `baseURL` is trusted
 * on its own — but one dev server is reachable at three loopback spellings, plus
 * whatever LAN address the machine has, and each is a *different* origin to a
 * browser even though they are the same server:
 *
 *   http://localhost:4310      the configured one
 *   http://127.0.0.1:4310       typed instead of "localhost"
 *   http://[::1]:4310           the IPv6 loopback
 *   http://192.168.x.x:4310     the Network URL Next prints, or a phone on the
 *                               same wifi
 *
 * The loopback spellings are added here rather than left to configuration because
 * they are the same machine by definition — they cannot be reached from anywhere
 * else, so trusting them grants nothing to an attacker. The LAN address is not
 * knowable statically and is not added, because a pattern wide enough to cover
 * it would also cover a network the app has no business trusting. That one is
 * `AUTH_TRUSTED_ORIGINS`, set to the exact origin.
 *
 * No wildcards anywhere. A wildcard here is a CSRF bypass: the whole point of
 * the check is that only the site's own origins may drive a sign-in.
 */
function trustedOrigins(): string[] {
  const appUrl = process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:4310";
  const origins = new Set<string>([appUrl]);

  try {
    const { protocol, port } = new URL(appUrl);
    for (const host of ["localhost", "127.0.0.1", "[::1]"]) {
      origins.add(`${protocol}//${host}:${port}`);
    }
  } catch {
    // A malformed NEXT_PUBLIC_APP_URL is left to fail loudly at the first request
    // rather than being silently papered over with a guess.
  }

  for (const extra of (process.env.AUTH_TRUSTED_ORIGINS ?? "").split(",")) {
    const trimmed = extra.trim();
    if (trimmed) origins.add(trimmed);
  }

  return [...origins];
}

/**
 * The Google sign-in provider, or nothing.
 *
 * Both halves must be present. A provider with an id and no secret produces an
 * OAuth redirect that Google answers with an error the player cannot act on, and
 * that is worse than the button being absent — so an unconfigured deploy gets no
 * Google provider at all rather than a broken one.
 *
 * The client renders its "Continue with Google" button unconditionally, because
 * `authClient.signIn.social()` exists either way. With no provider behind it the
 * click returns an error, which the dialog shows in plain words.
 *
 * The redirect URI to paste into the Google Cloud console is:
 *   {NEXT_PUBLIC_APP_URL}/api/auth/callback/google
 */
const google =
  process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET
    ? {
        google: {
          clientId: process.env.GOOGLE_CLIENT_ID,
          clientSecret: process.env.GOOGLE_CLIENT_SECRET,
          // Without this Better Auth asks for the bare minimum, and a Google
          // account that has never had a profile picture comes back avatar-less.
          mapProfileToUser: (profile: { picture?: string }) => ({ image: profile.picture }),
        },
      }
    : {};

export const authOptions = {
  // Absent rather than a pool pointed at nothing: an adapter over an unreachable
  // database is a runtime error waiting for a request, and Better Auth logs a
  // schema-validation failure for it on every build.
  ...(pool ? { database: pool } : {}),
  secret: secret(),

  baseURL: process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:4310",
  trustedOrigins: trustedOrigins(),

  socialProviders: google,

  emailAndPassword: {
    enabled: true,
    // No email verification and no reset-password mailer. Both need an SMTP
    // provider and a redirect allowlist, which is real configuration to add when
    // someone actually asks for it; until then a player can sign up and play
    // immediately. See "Accounts and cloud saves" in the README.
    requireEmailVerification: false,
  },

  session: {
    // Long enough that a returning collector is not asked to sign in weekly.
    expiresIn: 60 * 60 * 24 * 30,
    updateAge: 60 * 60 * 24,
  },
} satisfies BetterAuthOptions;

export const auth = betterAuth({
  ...authOptions,
  // Must stay last: it flushes cookies set during a request onto the response.
  plugins: [nextCookies()],
});

export type Session = typeof auth.$Infer.Session;
