"use client";

/**
 * Sign in, sign up, sign out, and one line explaining what an account is for.
 *
 * Deliberately a disclosure rather than a separate `/login` page: the only thing
 * an account does here is switch on cloud sync, so making it a destination would
 * mean a route that exists to be left again. The panel is closed by default and
 * its trigger is in the header, so the editorial pages stay exactly as they were
 * for a reader who never signs in.
 *
 * A signed-out reader sees this and nothing else changes. The quest book and the
 * planner keep working on `localStorage`, which is the state the whole app was
 * built around.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS DOES NOT USE `authClient.useSession()`
 * ---------------------------------------------------------------------------
 *
 * Better Auth's `useSession` reads the session through a nanostore, bridged into
 * React by `useSyncExternalStore`. That bridge does not survive this app's build:
 * the bridge lands in a different server chunk from the component, gets its own
 * copy of React, and on a prerendered page React's dispatcher is null — so every
 * page fails to export with a minified `Cannot read properties of null (reading
 * 'useRef')` that points nowhere near the cause.
 *
 * `authClient.getSession()` in an effect is one request and about ten lines, and
 * it has no such problem. The trade is that the session is read on the client
 * rather than during the server render, which is fine: the session lives in an
 * httpOnly cookie, so the server render could not have known it either without a
 * cookie read this app has no reason to do on every page.
 */

import { useCallback, useEffect, useId, useRef, useState } from "react";

import { authClient } from "../lib/auth-client";

type Mode = "signin" | "signup";

type Account = { email: string } | null;

export function AccountMenu() {
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState<Mode>("signin");
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const [account, setAccount] = useState<Account>(null);
  const [resolved, setResolved] = useState(false);

  const panelId = useId();
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  const refresh = useCallback(async () => {
    try {
      const { data } = await authClient.getSession();
      setAccount(data?.user ? { email: data.user.email } : null);
    } catch {
      // No backend, or none configured. An unreachable auth server is not the
      // reader's problem to read about, and the signed-out control below is the
      // honest thing to render. Submitting will say so plainly.
      setAccount(null);
    } finally {
      setResolved(true);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // Close on Escape and return focus to the trigger, so a keyboard user is not
  // dropped at the top of the document.
  useEffect(() => {
    if (!open) return;
    function onKey(event: KeyboardEvent) {
      if (event.key !== "Escape") return;
      setOpen(false);
      triggerRef.current?.focus();
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open]);

  // Focus the first field on open, so the panel is usable without a mouse.
  useEffect(() => {
    if (!open) return;
    panelRef.current?.querySelector<HTMLInputElement>("input")?.focus();
  }, [open, mode]);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);

    const { error: failure } =
      mode === "signup"
        ? await authClient.signUp.email({ name, email, password })
        : await authClient.signIn.email({ email, password });

    setBusy(false);
    if (failure) {
      // Better Auth's messages are written for exactly this case; passing them
      // through beats inventing a second vocabulary for the same error.
      setError(failure.message ?? "That did not work.");
      return;
    }

    setPassword("");
    setOpen(false);
    await refresh();
  }

  async function signOut() {
    await authClient.signOut();
    setOpen(false);
    await refresh();
  }

  // Until the session has been read there is nothing truthful to render, and a
  // placeholder would only reserve width the reader may not need.
  if (!resolved) return null;

  if (account) {
    return (
      <span className="lal-account">
        <button
          type="button"
          className="lal-account__trigger"
          ref={triggerRef}
          aria-expanded={open}
          aria-controls={panelId}
          onClick={() => setOpen((v) => !v)}
        >
          {account.email}
        </button>
        {open ? (
          <div className="lal-account__panel" id={panelId} ref={panelRef}>
            <p className="lal-account__note">
              Signed in. Your stamps and your itinerary are syncing.
            </p>
            <button type="button" className="lal-btn" onClick={signOut}>
              Sign out
            </button>
          </div>
        ) : null}
      </span>
    );
  }

  return (
    <span className="lal-account">
      <button
        type="button"
        className="lal-account__trigger"
        ref={triggerRef}
        aria-expanded={open}
        aria-controls={panelId}
        onClick={() => setOpen((v) => !v)}
      >
        Sign in
      </button>

      {open ? (
        <div className="lal-account__panel" id={panelId} ref={panelRef}>
          <form className="lal-form lal-account__form" onSubmit={submit}>
            <p className="lal-account__note">
              An account carries your stamps and your itinerary between devices. Without one,
              everything stays on this browser.
            </p>

            {mode === "signup" ? (
              <div className="lal-field">
                <label htmlFor={`${panelId}-name`}>Name</label>
                <input
                  id={`${panelId}-name`}
                  type="text"
                  autoComplete="name"
                  required
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                />
              </div>
            ) : null}

            <div className="lal-field">
              <label htmlFor={`${panelId}-email`}>Email</label>
              <input
                id={`${panelId}-email`}
                type="email"
                autoComplete="email"
                required
                value={email}
                onChange={(e) => setEmail(e.target.value)}
              />
            </div>

            <div className="lal-field">
              <label htmlFor={`${panelId}-password`}>Password</label>
              <input
                id={`${panelId}-password`}
                type="password"
                autoComplete={mode === "signup" ? "new-password" : "current-password"}
                required
                minLength={8}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
              />
            </div>

            {error ? (
              <p className="lal-account__error" role="alert">
                {error}
              </p>
            ) : null}

            <button type="submit" className="lal-btn" disabled={busy}>
              {busy ? "Working…" : mode === "signup" ? "Create account" : "Sign in"}
            </button>

            <button
              type="button"
              className="lal-account__switch"
              onClick={() => {
                setMode(mode === "signin" ? "signup" : "signin");
                setError(null);
              }}
            >
              {mode === "signin"
                ? "No account yet? Create one"
                : "Already have an account? Sign in"}
            </button>
          </form>
        </div>
      ) : null}
    </span>
  );
}
