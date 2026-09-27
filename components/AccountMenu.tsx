"use client";

/**
 * Sign in, sign up, and sign out, in a centred modal.
 *
 * A native `<dialog>` rather than a panel. `showModal()` gives focus trapping, an
 * inert background, Escape-to-close, and focus returned to the trigger, all of
 * which are the parts a hand-rolled overlay gets subtly wrong. It is also one
 * element instead of a dependency, which is the main reason this is not a
 * component library.
 *
 * ---------------------------------------------------------------------------
 * TWO WAYS IN, GOOGLE AND EMAIL
 * ---------------------------------------------------------------------------
 *
 * Google first because on a phone it is one tap and no typing, then the email
 * form for the many people who would rather not hand a Google account to a
 * travel site. The email form is not the fallback for a failed Google button; it
 * is a peer.
 *
 * The Google button renders whether or not a Google provider is configured,
 * because `authClient.signIn.social({ provider: "google" })` exists either way.
 * With no provider behind it the click returns an error and the dialog says so
 * in words, rather than the button silently doing nothing.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS DOES NOT USE `authClient.useSession()`
 * ---------------------------------------------------------------------------
 *
 * Better Auth's `useSession` reads the session through a nanostore bridged into
 * React by `useSyncExternalStore`. That bridge does not survive this app's
 * build: it lands in a different server chunk from the component, gets its own
 * copy of React, and on a prerendered page React's dispatcher is null — so every
 * page fails to export with a minified `Cannot read properties of null (reading
 * 'useRef')` pointing nowhere near the cause.
 *
 * `authClient.getSession()` in an effect is one request and about ten lines, and
 * has no such problem. The session lives in an httpOnly cookie, so the server
 * render could not have known it either without a cookie read this app has no
 * reason to perform on every page.
 */

import { useCallback, useEffect, useId, useRef, useState } from "react";

import { authClient } from "../lib/auth-client";

/**
 * Turn a failure into something a person can act on.
 *
 * Better Auth's own wording is written for whoever wrote Better Auth. "Invalid
 * origin" in particular is the single most confusing message in the whole flow:
 * the configuration looks right, the button is right, and the answer is a
 * two-word refusal. The actual cause is nearly always that the browser reached
 * the server at a different spelling of the same address, so the message names
 * the origin the browser used and the variable that would accept it.
 */
function describe(failure: { message?: string; code?: string } | null | undefined): string {
  const message = failure?.message ?? "";

  if (failure?.code === "invalid_origin" || /invalid origin/i.test(message)) {
    return typeof window === "undefined"
      ? "This site's address is not trusted by the auth server."
      : `This site is being reached as ${window.location.origin}, which the auth ` +
          `server does not trust. Add it to AUTH_TRUSTED_ORIGINS in .env.local.`;
  }

  if (/provider not found|not configured|invalid_provider/i.test(message)) {
    return "Google sign-in is not set up on this deploy. Use your email below.";
  }

  return message || "That did not work.";
}

type Mode = "signin" | "signup";

type Account = { email: string; name?: string | null } | null;

/** Google's mark, per their branding guidelines: the G in its own four colours. */
function GoogleMark() {
  return (
    <svg width="18" height="18" viewBox="0 0 48 48" aria-hidden="true" focusable="false">
      <path
        fill="#4285F4"
        d="M45.12 24.5c0-1.56-.14-3.06-.4-4.5H24v8.51h11.84c-.51 2.75-2.06 5.08-4.39 6.64v5.52h7.11c4.16-3.83 6.56-9.47 6.56-16.17z"
      />
      <path
        fill="#34A853"
        d="M24 46c5.94 0 10.92-1.97 14.56-5.33l-7.11-5.52c-1.97 1.32-4.49 2.1-7.45 2.1-5.73 0-10.58-3.87-12.31-9.07H4.34v5.7C7.96 41.07 15.4 46 24 46z"
      />
      <path
        fill="#FBBC05"
        d="M11.69 28.18A13.2 13.2 0 0 1 11 24c0-1.45.25-2.86.69-4.18v-5.7H4.34A21.99 21.99 0 0 0 2 24c0 3.55.85 6.91 2.34 9.88l7.35-5.7z"
      />
      <path
        fill="#EA4335"
        d="M24 10.75c3.23 0 6.13 1.11 8.41 3.29l6.31-6.31C34.91 4.18 29.93 2 24 2 15.4 2 7.96 6.93 4.34 14.12l7.35 5.7c1.73-5.2 6.58-9.07 12.31-9.07z"
      />
    </svg>
  );
}

export function AccountMenu() {
  const [mode, setMode] = useState<Mode>("signin");
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const [account, setAccount] = useState<Account>(null);
  const [resolved, setResolved] = useState(false);

  const dialogRef = useRef<HTMLDialogElement>(null);
  const emailId = useId();
  const passwordId = useId();
  const nameId = useId();

  const refresh = useCallback(async () => {
    try {
      const { data } = await authClient.getSession();
      setAccount(data?.user ? { email: data.user.email, name: data.user.name } : null);
    } catch {
      // No backend, or none configured. An unreachable auth server is not the
      // reader's problem to read about; the signed-out dialog is the honest thing
      // to render, and submitting will say so plainly.
      setAccount(null);
    } finally {
      setResolved(true);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  function open() {
    setError(null);
    dialogRef.current?.showModal();
  }

  function close() {
    dialogRef.current?.close();
  }

  // The dialog owns Escape and the focus trap, so the only thing left to reset is
  // the form's own state — and doing it on `close` rather than on the click means
  // it happens for Escape and for a backdrop click too.
  function onClosed() {
    setError(null);
    setPassword("");
  }

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
      setError(describe(failure));
      return;
    }

    close();
    await refresh();
  }

  async function signInWithGoogle() {
    if (busy) return;
    setBusy(true);
    setError(null);
    // A redirect, so there is nothing to await and nothing to catch: the browser
    // leaves the page. If the provider is not configured this rejects, and the
    // error is shown in place rather than swallowed.
    const { error: failure } = await authClient.signIn.social({ provider: "google" });
    if (failure) {
      setBusy(false);
      setError(describe(failure));
    }
  }

  async function signOut() {
    setBusy(true);
    await authClient.signOut();
    setBusy(false);
    close();
    await refresh();
  }

  // The trigger renders whatever the session check last said, rather than
  // appearing only once it has resolved. Gating it on `resolved` meant the button
  // was absent from the header for the length of one request and then pushed the
  // nav sideways when it arrived — a visible jump on every page load, which is
  // worse than briefly showing the signed-out label to someone who is signed in.
  // The dialog below is the part that waits, because showing a sign-in form to
  // someone who already has a session is the mistake worth avoiding.
  return (
    <>
      <button type="button" className="lal-account__trigger" onClick={open}>
        {account ? account.email : "Sign in"}
      </button>

      <dialog
        className="lal-dialog"
        ref={dialogRef}
        onClose={onClosed}
        aria-labelledby={`${emailId}-title`}
        /* ::backdrop is not an element, so a click on it is dispatched with the
           dialog as the target. Inside the card the target is the card, which is
           why this closes on the backdrop and not on the form. */
        onClick={(event) => {
          if (event.target === dialogRef.current) close();
        }}
      >
        <div className="lal-dialog__card">
          {!resolved ? (
            <p className="lal-dialog__lede">Checking your session…</p>
          ) : account ? (
            <>
              <h2 className="lal-dialog__title" id={`${emailId}-title`}>
                Your account
              </h2>
              <p className="lal-dialog__lede">
                Signed in as <strong>{account.email}</strong>. Your stamps and your itinerary are
                syncing.
              </p>
              <button type="button" className="lal-btn lal-dialog__wide" onClick={signOut} disabled={busy}>
                {busy ? "Signing out…" : "Sign out"}
              </button>
            </>
          ) : (
            <>
              <h2 className="lal-dialog__title" id={`${emailId}-title`}>
                {mode === "signup" ? "Create your account" : "Sign in"}
              </h2>
              <p className="lal-dialog__lede">
                An account carries your stamps and your itinerary between devices. Without one,
                everything stays on this browser.
              </p>

              <button
                type="button"
                className="lal-btn lal-dialog__wide lal-dialog__google"
                onClick={signInWithGoogle}
                disabled={busy}
              >
                <GoogleMark />
                Continue with Google
              </button>

              <div className="lal-dialog__or" role="separator">
                <span>or use your email</span>
              </div>

              <form className="lal-form lal-dialog__form" onSubmit={submit}>
                {mode === "signup" ? (
                  <div className="lal-field">
                    <label htmlFor={nameId}>Name</label>
                    <input
                      id={nameId}
                      type="text"
                      autoComplete="name"
                      required
                      value={name}
                      onChange={(e) => setName(e.target.value)}
                    />
                  </div>
                ) : null}

                <div className="lal-field">
                  <label htmlFor={emailId}>Email</label>
                  <input
                    id={emailId}
                    type="email"
                    autoComplete="email"
                    required
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                  />
                </div>

                <div className="lal-field">
                  <label htmlFor={passwordId}>Password</label>
                  <input
                    id={passwordId}
                    type="password"
                    autoComplete={mode === "signup" ? "new-password" : "current-password"}
                    required
                    minLength={8}
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                  />
                </div>

                {error ? (
                  <p className="lal-dialog__error" role="alert">
                    {error}
                  </p>
                ) : null}

                <button type="submit" className="lal-btn lal-dialog__wide" disabled={busy}>
                  {busy
                    ? "Working…"
                    : mode === "signup"
                      ? "Create account"
                      : "Sign in"}
                </button>

                <button
                  type="button"
                  className="lal-dialog__switch"
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
            </>
          )}

          <button type="button" className="lal-dialog__close" onClick={close} aria-label="Close">
            <span aria-hidden="true">&times;</span>
          </button>
        </div>
      </dialog>
    </>
  );
}
