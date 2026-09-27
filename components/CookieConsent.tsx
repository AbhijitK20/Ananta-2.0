"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";

import { describeCategories, isCategoryAllowed, readConsent, setConsent } from "../lib/consent";

/**
 * CookieConsent — the notice, and the only thing standing between a first visit
 * and a third-party tile request.
 *
 * WHY IT IS A BAR AND NOT A MODAL. A modal would trap focus and let Esc close
 * it, and both are wrong: a consent prompt dismissible without a choice records
 * no choice, which under DPDP section 6 is not withdrawal, it is no consent at
 * all. A non-modal bar needs no focus trap, and the rest of the site stays usable
 * without a globe.
 *
 * WHY IT RENDERS NOTHING UNTIL MOUNTED. `readConsent` touches `localStorage`, so
 * the first render has to assume "undecided" and correct itself. Returning null
 * until then keeps the banner out of the server HTML, which stops a flash of a
 * prompt for somebody who already answered and stops the page claiming a
 * consent state it has not read yet.
 *
 * WHY THE LABELS ARE SENTENCES. "Accept" and "OK" do not say what is being
 * accepted. Each button names the thing it decides, so the choice is legible
 * from the label alone, without the surrounding paragraph, and reads correctly
 * when a screen reader announces it out of context.
 */
export function CookieConsent() {
  const [state, setState] = useState<"loading" | "undecided" | "answered">("loading");
  const [expanded, setExpanded] = useState(false);

  useEffect(() => {
    setState(readConsent() ? "answered" : "undecided");
  }, []);

  const decide = useCallback((granted: boolean) => {
    setConsent(granted);
    setState("answered");
  }, []);

  if (state !== "undecided") return null;

  const categories = describeCategories();

  return (
    <aside
      /*
       * A named `complementary` landmark. Not a dialog: nothing is modal, the
       * page behind stays usable, and calling it a dialog would promise a focus
       * trap this deliberately does not implement.
       */
      aria-labelledby="cookie-consent-heading"
      className="lal-consent"
    >
      <div className="lal-consent__inner">
        <div className="lal-consent__text">
          <h2 id="cookie-consent-heading" className="lal-consent__title">
            The globe is not loading yet
          </h2>
          <p className="lal-consent__body">
            This site stores nothing that identifies you. The one thing it needs
            from somebody else&apos;s server is the globe&apos;s imagery, and that
            request shows your IP address to the OpenStreetMap Foundation. Nothing
            is requested until you decide, and every page works either way.
          </p>
          {/*
            A real disclosure button rather than a "Learn more" link that
            navigates away. `aria-expanded` and `aria-controls` let a
            screen-reader user find out whether the detail is there before
            spending a tab stop on it.
          */}
          <button
            type="button"
            onClick={() => setExpanded((open) => !open)}
            aria-expanded={expanded}
            aria-controls="cookie-consent-detail"
            className="lal-consent__more"
          >
            {expanded ? "Hide what this covers" : "What this covers"}
          </button>

          <div id="cookie-consent-detail" hidden={!expanded} className="lal-consent__detail">
            <dl>
              {categories.map((row) => (
                <div key={row.category} className="lal-consent__row">
                  <dt className="lal-consent__rowLabel">
                    {row.label}
                    {row.optional ? null : " (always on)"}
                  </dt>
                  <dd className="lal-consent__rowBody">{row.detail}</dd>
                </div>
              ))}
            </dl>
            <p>
              The full text is on the <Link href="/cookies">cookie policy</Link>,
              where you can also change this answer later.
            </p>
          </div>
        </div>

        <div className="lal-consent__actions">
          <button type="button" className="lal-consent__allow" onClick={() => decide(true)}>
            Allow map tiles
          </button>
          <button type="button" className="lal-consent__decline" onClick={() => decide(false)}>
            Continue without the globe
          </button>
        </div>
      </div>
    </aside>
  );
}
