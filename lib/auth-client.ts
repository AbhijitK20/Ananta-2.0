/**
 * The browser half of auth.
 *
 * Kept in its own file because the server instance in `lib/auth.ts` pulls in
 * `pg` and reads server-only environment variables — neither of which may end
 * up in a client bundle. This module is the only auth code a client component
 * is allowed to import.
 *
 * ---------------------------------------------------------------------------
 * DO NOT DESTRUCTURE OFF `authClient` AT MODULE SCOPE
 * ---------------------------------------------------------------------------
 *
 * `authClient.signIn` and friends are real properties. `authClient.useSession`
 * is not: it is a getter on a proxy that builds a React hook on access, and the
 * hook calls `useRef`. Destructuring it here — the obvious-looking
 * `export const { useSession } = authClient` — therefore calls a hook outside a
 * component render, where React's dispatcher is null. The symptom is a build
 * failure on every prerendered page with a null-dispatcher `useRef` error
 * pointing at a minified chunk, and nothing in this file's name to explain it.
 *
 * Call it as `authClient.useSession()` from inside a component instead.
 */

import { createAuthClient } from "better-auth/react";

export const authClient = createAuthClient();
