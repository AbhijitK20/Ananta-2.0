import Link from "next/link";

/**
 * The 404 page.
 *
 * Not decoration. Both dynamic routes set `dynamicParams = false`, which means
 * Next rejects an unknown slug *before* the page component runs — so the
 * `notFound()` calls in those pages never execute for a bad param, and without
 * a root not-found boundary Next has nothing to serve and logs an internal
 * `NoFallbackError` instead. A scraper hitting `/cities/atlantis` would
 * otherwise fill the server log with stack traces.
 *
 * The copy keeps the game's voice: a city that is not in the album is a place
 * that does not exist, not a broken link.
 */
export default function NotFound() {
  return (
    <div className="lq-page lq-page--narrow">
      <header className="lq-head">
        <p className="lq-head__eyebrow">Not in the album</p>
        <h1 className="lq-head__title">No such page</h1>
        <p className="lq-head__sub">
          The album only holds the places locals actually recommended, so
          anything not in it does not exist here.
        </p>
      </header>

      <p style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
        <Link href="/" className="lq-btn">
          Today&rsquo;s place
        </Link>
        <Link href="/cities" className="lq-btn lq-btn--ghost">
          All 202 cities
        </Link>
        <Link href="/stamps" className="lq-btn lq-btn--quiet">
          My album
        </Link>
      </p>
    </div>
  );
}
