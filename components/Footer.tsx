import Link from "next/link";

import { NAV } from "../lib/data";

export function Footer() {
  return (
    <footer className="lal-footer">
      <div className="lal-box">
        <div className="lal-footer__inner lal-container">
        <h2 className="lal-footer__title lal-fit">
          <Link href="/">Like A Local Guide</Link>
        </h2>
        <p className="lal-footer__tagline lal-fit">
          Curated, multi-city travel guides with local-recommended picks.
        </p>

        <button type="button" className="lal-footer__nav-toggle" aria-label="Footer menu">
          <span aria-hidden="true">&#9776;</span>
        </button>

        <ul className="lal-footer__nav">
          {NAV.map((item) => (
            <li key={item.href}>
              <Link href={item.href}>{item.label}</Link>
            </li>
          ))}
        </ul>

        <p className="lal-footer__affiliate lal-fit">
          {/* One link wrapping the whole sentence, at weight 600 — the reference
              styles it as a single anchor, not as a sentence with a linked tail,
              which is worth 20px of measured width. */}
          <a href="https://www.likealocaltours.com">From the team behind Like A Local Tours</a>
        </p>

        {/* One centred line, matching the reference: a single paragraph with
            the separators as inline entities rather than a flex list, which is
            what makes it 22px narrower as a list.

            The Contact slot now points at the assistant rather than the contact
            form. A chatbot buried only at /oracle is a chatbot nobody finds, and
            the assistant is the one part of this site that is genuinely ours
            rather than a reconstruction — so it earns the prime footer slot.
            /contact still exists and still routes; nothing 404s, this just stops
            advertising it from here. */}
        <p className="lal-footer__legal">
          <a href="/">Privacy Policy</a> &nbsp;&middot;&nbsp;{" "}
          <a href="/">Terms &amp; Conditions</a> &nbsp;&middot;&nbsp;{" "}
          <a href="/oracle">Ask the AI</a> &nbsp;&middot;&nbsp;{" "}
          <a href="/">Small Business Toolkit</a>
        </p>

        <p className="lal-footer__fine">
          Some links may be affiliate links. We only recommend places we genuinely
          love. &copy; 2026 Like A Local Guide (LAL Guide). Bookings via Hotels.com,
          GetYourGuide &amp; official sites.
        </p>

        <div className="lal-footer__publish-wrap">
          <p className="lal-footer__publish">
            Publish travel content?{" "}
            <a href="https://likealocalguide.com/partners">Monetize it with Stay22.</a>
            We may earn a referral bonus if you join through this link and qualify.
          </p>
        </div>
        </div>
      </div>
    </footer>
  );
}
