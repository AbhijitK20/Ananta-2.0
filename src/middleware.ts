/**
 * Security headers and rate limiting.
 *
 * WHY A FILE THIS PROJECT DID NOT HAVE. The deployed site served HSTS and
 * nothing else: no CSP, no `X-Frame-Options`, no `X-Content-Type-Options`, no
 * `Referrer-Policy`, no `Permissions-Policy`, and no rate limit on either API
 * route. On an app whose chat endpoint calls a paid model, an unmetered
 * `/api/chat` is a billable-abuse vector and not a theoretical one.
 *
 * WHY A NONCE RATHER THAN `'unsafe-inline'`. A CSP that allows inline script
 * does not stop XSS, which is the thing people are usually worried about. Next
 * mints a per-request nonce here, propagates it onto its own `<script>` tags
 * from the RSC payload onward, and `script-src` can then drop `'unsafe-inline'`
 * entirely. That is a real policy rather than a decoration.
 *
 * THE COST, STATED. A nonce forces dynamic rendering, so `force-static` is gone
 * from `/provider`. That page is a client component that builds its state on
 * mount, so a prerender was freezing an empty shell into the HTML anyway and
 * removing it costs nothing real.
 *
 * `connect-src` omits `openrouter.ai` and `router.project-osrm.org` on purpose:
 * both are contacted from the server, never from the browser, so allowing them
 * client-side would be granting the page more authority than it uses.
 */
import { NextResponse, type NextRequest } from "next/server";

/** Permitted API routes. The chat route is the expensive one. */
const RATE_LIMITS: Record<string, { limit: number; windowMs: number }> = {
  "/api/chat": { limit: 20, windowMs: 60_000 },
  "/api/discover": { limit: 60, windowMs: 60_000 },
};

type Bucket = { count: number; resetAt: number };

/**
 * Fixed-window counters, in module scope.
 *
 * ponytail: ceiling — per-instance, in memory, so it resets on deploy and is
 * per-region on serverless. That is enough to stop a single script hammering one
 * instance, which is the abuse this is aimed at. It is NOT enough against a
 * distributed flood; that wants a shared store (Upstash, Vercel KV) or a WAF
 * rule. Add it when there is a real bill attached, not before.
 */
const buckets = new Map<string, Bucket>();

function rateLimited(key: string, limit: number, windowMs: number): boolean {
  const now = Date.now();
  const bucket = buckets.get(key);

  if (!bucket || bucket.resetAt <= now) {
    buckets.set(key, { count: 1, resetAt: now + windowMs });
    return false;
  }

  bucket.count += 1;
  return bucket.count > limit;
}

/** Best-effort client identity. Behind Vercel this is a real IP. */
function clientKey(request: NextRequest): string {
  const forwarded = request.headers.get("x-forwarded-for");
  if (forwarded) return forwarded.split(",")[0]!.trim();
  return request.headers.get("x-real-ip") ?? "unknown";
}

export function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;

  const limits = RATE_LIMITS[pathname];
  if (limits && rateLimited(clientKey(request), limits.limit, limits.windowMs)) {
    return NextResponse.json(
      { error: "Too many requests. Give it a minute." },
      {
        status: 429,
        headers: { "retry-after": String(Math.ceil(limits.windowMs / 1000)) },
      },
    );
  }

  const nonce = Buffer.from(crypto.randomUUID()).toString("base64");
  const isDev = process.env.NODE_ENV !== "production";

  // 'unsafe-eval' is a webpack dev-runtime requirement and is a real XSS
  // widening in production, so it is scoped to development rather than shipped.
  const scriptSrc = ["'self'", `'nonce-${nonce}'`, "strict-dynamic"];
  if (isDev) scriptSrc.push("'unsafe-eval'");

  const csp = [
    `default-src 'self'`,
    `script-src ${scriptSrc.join(" ")}`,
    // Tailwind v4 and MapLibre both set inline styles at runtime.
    `style-src 'self' 'unsafe-inline' https://tiles.openfreemap.org`,
    // MapLibre fetches its style and vector tiles, and a data: URL for the
    // sprite. Nothing else is permitted to phone home from the page.
    `img-src 'self' data: blob: https://tiles.openfreemap.org`,
    `font-src 'self' data:`,
    `connect-src 'self' https://tiles.openfreemap.org`,
    `worker-src 'self' blob:`,
    `object-src 'none'`,
    `base-uri 'self'`,
    `form-action 'self'`,
    `frame-ancestors 'none'`,
    ...(isDev ? [] : [`upgrade-insecure-requests`]),
  ].join("; ");

  const headers = new Headers(request.headers);
  headers.set("x-nonce", nonce);

  const response = NextResponse.next({ request: { headers } });
  response.headers.set("Content-Security-Policy", csp);
  // `frame-ancestors` in the CSP is the modern control; these two are for
  // clients that have not caught up, and they cost one line each.
  response.headers.set("X-Frame-Options", "DENY");
  response.headers.set("X-Content-Type-Options", "nosniff");
  response.headers.set("Referrer-Policy", "strict-origin-when-cross-origin");
  response.headers.set("Permissions-Policy", "geolocation=(), microphone=(), camera=()");
  return response;
}

export const config = {
  /*
    Everything except Next's own build assets. Skipping static files keeps the
    nonce off responses that do not need it and stops the middleware adding a
    hop in front of every tile request the browser makes for its own chunks.
  */
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
