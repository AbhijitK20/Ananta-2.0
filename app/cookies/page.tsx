import type { Metadata } from "next";

import { ConsentControls } from "../../components/ConsentControls";
import { LegalNav, LegalPage } from "../../components/LegalPage";
import { describeCategories } from "../../lib/consent";

export const metadata: Metadata = {
  title: "Cookie policy",
  description:
    "Every stored value and every third-party request this site makes, what it is for, and how to switch the globe off.",
};

const CATEGORIES = describeCategories();

export default function CookiesPage() {
  return (
    <>
      <LegalNav current="cookies" />
      <LegalPage
        title="Cookie policy"
        summary="Every stored value and every third-party request this site makes. The list is short because the site does very little. It is generated from the same source as the consent prompt, so the two cannot disagree."
        sections={[
          {
            heading: "In one line",
            body: (
              <p>
                This site sets no cookie that identifies you, and it loads nothing
                from anybody else until you agree to the globe. The full inventory is
                below.
              </p>
            ),
          },
          {
            heading: "What is stored in your browser",
            body: (
              <dl className="lal-legal__store">
                <div>
                  <dt>
                    <code>lal:consent:v1</code> &mdash; localStorage
                  </dt>
                  <dd>
                    Your answer to the consent prompt, and nothing else: a version
                    number and a boolean. No identifier, no timestamp, no IP address,
                    and nothing at all on our side. This is the record that you chose,
                    kept by your browser rather than by us. Deleting it re-opens the
                    prompt.
                  </dd>
                </div>
                <div>
                  <dt>
                    <code>theme</code>, <code>lal-theme</code> &mdash; localStorage
                  </dt>
                  <dd>
                    Your light or dark preference. Never leaves the browser and is not
                    sent to us.
                  </dd>
                </div>
                <div>
                  <dt>Cookies set by this site</dt>
                  <dd>
                    None. There is no session cookie, no analytics cookie, no
                    advertising cookie and no consent cookie, because the consent
                    answer is kept in localStorage rather than in a cookie.
                  </dd>
                </div>
              </dl>
            ),
          },
          {
            heading: "Third-party requests",
            note: "Everything this site asks another server for",
            body: (
              <>
                <p>
                  These are not cookies. They are requests your browser makes to
                  servers we do not run, and they carry your IP address. They are
                  listed separately because that is the thing a cookie policy is
                  usually used to obscure.
                </p>
                <dl className="lal-legal__store">
                  <div>
                    <dt>OpenStreetMap Foundation &mdash; globe imagery</dt>
                    <dd>
                      From <code>tile.openstreetmap.org</code>, and only if you allowed
                      the globe. Sends your IP address, your User-Agent and the tile
                      coordinates. Open Database License; credited on the globe.
                    </dd>
                  </div>
                </dl>
                <p>
                  Nothing else. There is no analytics script, no tag manager, no
                  advertising pixel, no session recorder, no social widget and no font
                  loaded from a CDN at runtime. That is a deliberate constraint, not an
                  oversight.
                </p>
                <p>
                  Images in this site&apos;s content are files served by this site, not
                  requests to a third party. Following a link to a booking provider is
                  described in the privacy policy, because that provider&apos;s own
                  policy applies from the moment you arrive.
                </p>
              </>
            ),
          },
          {
            heading: "The categories, as the consent prompt states them",
            body: (
              <>
                <dl className="lal-legal__store">
                  {CATEGORIES.map((row) => (
                    <div key={row.category}>
                      <dt>
                        {row.label}
                        {row.optional ? "" : " — always on, and not offered as a choice"}
                      </dt>
                      <dd>{row.detail}</dd>
                    </div>
                  ))}
                </dl>
                <p>
                  Only one category here is optional, because the globe is the only
                  thing this site loads from somebody else. A consent dialog with six
                  categories and four empty ones would be describing a tracking system
                  that does not exist.
                </p>
              </>
            ),
          },
          {
            heading: "Changing your answer",
            body: (
              <>
                <p>
                  The control below works on this page permanently, and the globe page
                  also says so if you declined. Withdrawal is as easy as the original
                  choice, which is the only way it satisfies section 6(6) of the
                  Digital Personal Data Protection Act, 2023.
                </p>
                <ConsentControls />
              </>
            ),
          },
          {
            heading: "Clearing everything",
            body: (
              <p>
                Clearing site data in your browser removes the values above. There is
                nothing on our side to delete, because nothing was sent.
              </p>
            ),
          },
        ]}
      />
    </>
  );
}
