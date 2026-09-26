"use client";

import Link from "next/link";

/**
 * Route-level error boundary.
 *
 * There was none, so any throw during a server render produced Next's default
 * error page with no way back into the product. That matters more than usual
 * here: the homepage runs the real engine over 4,982 rows, so a bad catalogue
 * row or a hard constraint set that rejects everything is a reachable failure,
 * not a theoretical one.
 *
 * The reset button is the point. A traveller who hit a bad constraint set should
 * be able to try again without losing the page, rather than being told to
 * reload and land on the same input.
 */
export default function Error({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <main id="main" className="mx-auto max-w-[40rem] px-4 py-16">
      <h1 className="font-display text-2xl text-ink">That did not fit</h1>
      <p className="mt-2 text-sm text-ink-muted">
        Something went wrong while building this plan. Nothing you entered was
        saved, and nothing was sent anywhere.
      </p>
      {error.digest ? (
        <p className="mt-3 font-mono text-xs text-ink-muted">ref {error.digest}</p>
      ) : null}
      <div className="mt-6 flex gap-3">
        <button
          type="button"
          onClick={reset}
          className="rounded-pill bg-ink px-4 py-2 text-sm text-surface"
        >
          Try again
        </button>
        <Link href="/" className="rounded-pill border border-rule px-4 py-2 text-sm text-ink-muted">
          Start over
        </Link>
      </div>
    </main>
  );
}
