import { toNextJsHandler } from "better-auth/next-js";

import { auth } from "../../../../lib/auth";

/**
 * Every Better Auth endpoint — sign-up, sign-in, sign-out, session.
 *
 * `toNextJsHandler` is a thin adapter; the security lives in `lib/auth.ts` and
 * in Better Auth's own handlers. The one thing worth knowing is that this route
 * is deliberately the *only* place auth cookies are written, which is why the
 * saves endpoint can treat the session cookie as trustworthy input.
 */
export const { GET, POST } = toNextJsHandler(auth);
