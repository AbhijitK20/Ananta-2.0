"use client";

import { useEffect, useState } from "react";

import { isCategoryAllowed, setConsent } from "../lib/consent";

/**
 * The "change your mind" control on the cookie page.
 *
 * This is the half of the consent flow that has to exist for the other half to be
 * honest. DPDP section 6(6) gives a Data Principal the right to withdraw consent
 * as easily as they gave it, and a banner that can only be answered once, on a
 * first visit, does not meet that. So the same `setConsent` call the banner makes
 * is available here, permanently.
 *
 * It re-reads the stored choice on mount rather than taking it as a prop, because
 * this renders on the server where the stored value is not yet known.
 */
export function ConsentControls() {
  const [granted, setGranted] = useState<boolean | null>(null);

  useEffect(() => {
    setGranted(isCategoryAllowed("map"));
  }, []);

  if (granted === null) {
    // Reserves the row so the page does not jump when the answer arrives.
    return <div aria-hidden className="lal-legal__consentSpacer" />;
  }

  return (
    <div className="lal-legal__consent">
      <h3>Change your choice</h3>
      <p>
        {granted
          ? "Map tiles are allowed in this browser. Turning them off stops the requests immediately, and every page keeps working."
          : "Map tiles are blocked in this browser. Nothing has been requested from a third party. Turning them on loads the globe's imagery from the server named above."}
      </p>
      <div className="lal-legal__consentActions">
        {granted ? (
          <button
            type="button"
            onClick={() => {
              setConsent(false);
              setGranted(false);
            }}
          >
            Turn map tiles off
          </button>
        ) : (
          <button
            type="button"
            onClick={() => {
              setConsent(true);
              setGranted(true);
            }}
          >
            Allow map tiles
          </button>
        )}
      </div>
    </div>
  );
}
