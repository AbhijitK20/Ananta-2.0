import type { Metadata } from "next";

import { LegalNav, LegalPage } from "../../components/LegalPage";

export const metadata: Metadata = {
  title: "Privacy policy",
  description:
    "What this site stores, who it is shared with, how long it keeps it, and how to have it deleted. Written for the Digital Personal Data Protection Act, 2023.",
};

export default function PrivacyPage() {
  return (
    <>
      <LegalNav current="privacy" />
      <LegalPage
        title="Privacy policy"
        summary="What this site stores, who it hands it to, how long it keeps it, and how to make it stop. Written to be read, and to meet the Digital Personal Data Protection Act, 2023."
        sections={[
          {
            heading: "The short version",
            body: (
              <>
                <p>
                  Reading this site does not require an account and there is nowhere
                  to create one. We do not run analytics, we do not run advertising,
                  and there is no third-party tracking script anywhere in this
                  codebase.
                </p>
                <p>
                  The one thing that leaves your device is the globe. Its imagery is
                  fetched from the OpenStreetMap Foundation, and that request
                  necessarily shows them your IP address. It does not happen until
                  you agree to it, and every page works without it.
                </p>
              </>
            ),
          },
          {
            heading: "What we collect",
            note: "Digital Personal Data Protection Act, 2023, section 5 and the Second Schedule",
            body: (
              <>
                <p>
                  All of it is stored in your own browser, and none of it reaches
                  us:
                </p>
                <ul>
                  <li>
                    Your consent answer, a version number and a boolean. No
                    identifier, no timestamp, no IP address.
                  </li>
                  <li>
                    Your theme and display preferences, if you change them. Never
                    sent to us.
                  </li>
                </ul>
                <p>
                  We hold no server-side record of who visited, because there is no
                  server-side record of who visited. There is no account system, no
                  contact database and no mailing list. The contact form on this site
                  posts nowhere. It is a static page with no backend, so a message
                  typed into it goes no further than your browser.
                </p>
              </>
            ),
          },
          {
            heading: "Who it is shared with",
            body: (
              <>
                <p>
                  One party, listed in full rather than summarised, because the
                  point of this section is to be checkable.
                </p>
                <p>
                  <strong>The OpenStreetMap Foundation.</strong> When you allow the
                  globe, your browser requests map imagery from{" "}
                  <code>tile.openstreetmap.org</code>. Those requests carry your IP
                  address, your browser&apos;s User-Agent, and the part of the globe
                  you are looking at. OpenStreetMap is a volunteer-run, non-profit
                  public project. We do not receive your IP address from them and we
                  do not ask them for it, but they receive it from your browser. The
                  imagery is licensed under the Open Database License and is credited
                  on the globe.
                </p>
                <p>
                  We do not sell data, share it for anyone else&apos;s advertising,
                  or use it for profiling. We have not received any request to.
                </p>
              </>
            ),
          },
          {
            heading: "Why we are allowed to process it",
            note: "Digital Personal Data Protection Act, 2023, section 6",
            body: (
              <p>
                On consent, for the globe. Where we rely on consent you can withdraw
                it, and withdrawing it does not make earlier processing unlawful or
                affect processing carried out before the withdrawal. How to withdraw
                it is on the cookie page, and it is the same number of clicks as
                giving it.
              </p>
            ),
          },
          {
            heading: "How long it is kept",
            body: (
              <p>
                Until you clear your browser storage. There is no server-side copy
                and therefore no retention period to state. Clearing site data for
                this site removes the consent answer and the display preferences,
                and the consent prompt will ask again on your next visit.
              </p>
            ),
          },
          {
            heading: "Your rights",
            note: "Digital Personal Data Protection Act, 2023, sections 11 to 17",
            body: (
              <>
                <p>You can ask us to:</p>
                <ul>
                  <li>give you a copy of the personal data we hold about you;</li>
                  <li>correct anything inaccurate in it;</li>
                  <li>complete something you left out;</li>
                  <li>erase it, where we are not required to keep it;</li>
                  <li>withdraw the consent you gave, at any time;</li>
                </ul>
                <p>
                  Because we hold almost nothing, most of these are satisfied by
                  clearing your browser storage, which you can do without asking us.
                  Where you do want a written answer, use the contact page. We
                  respond within the period the Act allows.
                </p>
                <p>
                  If you are unhappy with how we handled it, you can complain to the
                  Data Protection Board of India.
                </p>
              </>
            ),
          },
          {
            heading: "This site is not a booking service",
            body: (
              <p>
                Some links on this site lead to third-party booking sites. If you
                follow one, that site has its own privacy policy and its own
                operator, and it applies from the moment you arrive there. We do not
                receive your booking, your payment or your personal details from
                them, and we have no affiliate or referral relationship with the
                booking providers named in this site&apos;s footer unless the footer
                says so in the same sentence as the link.
              </p>
            ),
          },
          {
            heading: "Children",
            body: (
              <p>
                This is not directed at anyone under 18 and we do not knowingly
                collect data from a child. There is no account to create and no
                personal detail to enter anywhere on this site.
              </p>
            ),
          },
          {
            heading: "Changes to this policy",
            body: (
              <p>
                The date at the top changes when this text does. A material change to
                what we collect or who receives it also changes the consent prompt,
                because the prompt describes this document and cannot be accurate if
                this document is stale.
              </p>
            ),
          },
        ]}
      />
    </>
  );
}
