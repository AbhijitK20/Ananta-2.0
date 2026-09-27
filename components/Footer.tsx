import Link from "next/link";

import { NAV } from "../lib/data";
import { BUSINESS, copyrightLine, isFilled, missingOperatorDetails } from "../lib/business";

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

            The three legal links used to all point at href="/", so a visitor who
            clicked "Privacy Policy" or "Terms & Conditions" landed back on the
            page they came from. A link labelled with a document's name has to go
            to that document; a legal link that silently goes nowhere is worse
            than no link, because it advertises a disclosure that does not exist.
            They now go to real pages, the cookie policy is named too because the
            globe needs one, and Small Business Toolkit points at the page that
            actually covers it. */}
        <p className="lal-footer__legal">
          <Link href="/privacy">Privacy Policy</Link> &nbsp;&middot;&nbsp;{" "}
          <Link href="/terms">Terms &amp; Conditions</Link> &nbsp;&middot;&nbsp;{" "}
          <Link href="/cookies">Cookie Policy</Link> &nbsp;&middot;&nbsp;{" "}
          <Link href="/contact">Contact</Link> &nbsp;&middot;&nbsp;{" "}
          <Link href="/partners">Small Business Toolkit</Link>
        </p>

        <p className="lal-footer__fine">
          Some links may be affiliate links. We only recommend places we genuinely
          love. {copyrightLine(BUSINESS)}. Bookings via Hotels.com,
          GetYourGuide &amp; official sites.
        </p>

        <div className="lal-footer__publish-wrap">
          <p className="lal-footer__publish">
            Publish travel content?{" "}
            <a href="https://likealocalguide.com/partners">Monetize it with Stay22.</a>
            We may earn a referral bonus if you join through this link and qualify.
          </p>
        </div>

        {/*
          The operator block. DPDP Act 2023 section 5(1) requires a Data Fiduciary
          to publish its name and the contact details of its Data Fiduciary and
          Data Processor, and section 5(4) makes that a condition of processing.
          This site fetches a third-party tile server, so it is inside the Act and
          needs this.

          It renders a visible draft marker while `lib/business.ts` still has null
          fields, rather than a line of em-dashes that looks finished. An operator
          that cannot be named is a real compliance gap, and hiding it behind a
          tidy layout would make this footer part of the problem.
        */}
        <div className="lal-footer__operator">
          <dl>
            <div>
              <dt>Operator</dt>
              <dd>
                {isFilled(BUSINESS.legalName) ? BUSINESS.legalName : <em>Not yet stated</em>}
              </dd>
            </div>
            {BUSINESS.registeredAddress ? (
              <div>
                <dt>Address</dt>
                <dd>
                  <address>
                    {BUSINESS.registeredAddress.map((line) => (
                      <span key={line}>{line}</span>
                    ))}
                  </address>
                </dd>
              </div>
            ) : null}
            <div>
              <dt>Privacy contact</dt>
              <dd>
                {isFilled(BUSINESS.privacyEmail) ? (
                  <a href={`mailto:${BUSINESS.privacyEmail}`}>{BUSINESS.privacyEmail}</a>
                ) : (
                  <em>Not yet published</em>
                )}
              </dd>
            </div>
          </dl>
          {missingOperatorDetails().length > 0 ? (
            <p className="lal-footer__draft">
              The operator details required by section 5(1) of the Digital Personal
              Data Protection Act, 2023 have not been filled in. The legal documents
              say which fields are missing.
            </p>
          ) : null}
        </div>
        </div>
      </div>
    </footer>
  );
}
