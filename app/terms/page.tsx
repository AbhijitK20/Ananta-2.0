import type { Metadata } from "next";

import { LegalNav, LegalPage } from "../../components/LegalPage";

export const metadata: Metadata = {
  title: "Terms of use",
  description:
    "The terms this site is offered on, including what it is not: no bookings, no payments, and no verification that a listed place exists.",
};

export default function TermsPage() {
  return (
    <>
      <LegalNav current="terms" />
      <LegalPage
        title="Terms of use"
        summary="What you can expect from this site, and what you cannot. The section on accuracy is the one that matters most, so it is not at the bottom."
        sections={[
          {
            heading: "What this site is",
            body: (
              <p>
                A collection of city guides: places to eat, drink, see and do,
                organised by city and written up as short notes. It is an editorial
                publication. It is not a travel agency, a booking agent or a tour
                operator, and it does not become one by showing you a link.
              </p>
            ),
          },
          {
            heading: "What we do not do",
            body: (
              <>
                <p>
                  To be unambiguous about the parts a visitor might otherwise
                  assume:
                </p>
                <ul>
                  <li>We do not book anything. We cannot hold a table or a seat.</li>
                  <li>
                    We do not take payment. No card details pass through this site.
                  </li>
                  <li>
                    We are not an intermediary between you and any listed place. A
                    booking you make is a contract with that business, not with us.
                  </li>
                  <li>
                    We have not verified that a listed place exists, is open, or is
                    who it says it is. Listings are written from public information
                    and from our own reading, and some of it ages badly.
                  </li>
                </ul>
              </>
            ),
          },
          {
            heading: "Accuracy, and where it is weakest",
            body: (
              <>
                <p>
                  Opening hours, prices, addresses and phone numbers change without
                  notice and we cannot watch all of them. A guide written about a
                  city is a snapshot, not a live listing.
                </p>
                <p>
                  <strong>
                    Do not rely on this to plan something you cannot afford to get
                    wrong.
                  </strong>{" "}
                  Confirm hours, prices and booking requirements with the place
                  before you travel. A wrong turn is an inconvenience; a closed door
                  is the trip ruined.
                </p>
              </>
            ),
          },
          {
            heading: "How places are chosen",
            body: (
              <p>
                A place appears here because somebody thought it worth writing
                about. Where a listing makes a claim about a place&apos;s character,
                popularity, or the reasons locals go there, that is the
                author&apos;s opinion and not a measured fact. We do not publish
                rankings, scores or review counts, and we do not claim to have
                counted anything, because we have not.
              </p>
            ),
          },
          {
            heading: "Third-party links and booking sites",
            body: (
              <>
                <p>
                  This site links to businesses and booking providers we do not
                  control. Once you follow one, their terms and privacy policy apply
                  instead of ours, and we are not responsible for what they do with
                  your details.
                </p>
                <p>
                  Where a link earns us a referral fee, the page says so in the same
                  sentence as the link. It does not change what the place is or what
                  it costs you, and we do not accept payment to be listed.
                </p>
              </>
            ),
          },
          {
            heading: "Images and attribution",
            body: (
              <p>
                Globe imagery comes from the OpenStreetMap Foundation and is credited
                on the globe itself, as their licence requires. Where third-party
                photography appears, it remains the property of its photographer and
                is used under the licence stated with it. If you believe something
                here is used outside its licence, use the contact page and it will be
                taken down.
              </p>
            ),
          },
          {
            heading: "Acceptable use",
            body: (
              <>
                <p>Do not use this site to:</p>
                <ul>
                  <li>break the law, or infringe anyone else&apos;s rights;</li>
                  <li>
                    send automated requests, scrape the site at a rate that degrades
                    it for others, or attempt to bypass the rate limits;
                  </li>
                  <li>republish substantial parts of it as your own;</li>
                </ul>
              </>
            ),
          },
          {
            heading: "No warranty",
            body: (
              <>
                <p>
                  This site is provided as it is, without warranty of any kind, to
                  the fullest extent the law allows, including any implied warranty
                  of fitness for a particular purpose. We do not warrant that it will
                  be uninterrupted or error-free, and we do not accept liability for
                  indirect or consequential loss.
                </p>
                <p>
                  Nothing here limits liability that cannot lawfully be limited,
                  including for death or personal injury caused by negligence, or for
                  fraud.
                </p>
              </>
            ),
          },
          {
            heading: "Ending your use of it",
            body: (
              <p>
                You can stop using this site at any time. There is no account to
                close, which is also why there is nothing for us to delete on request
                beyond what is in your own browser.
              </p>
            ),
          },
          {
            heading: "Governing law",
            body: (
              <p>
                These terms are governed by the law of the jurisdiction named in the
                operator block at the top of this page, and by the courts there.
                Consumer protections that apply to you regardless of where you live
                are unaffected.
              </p>
            ),
          },
        ]}
      />
    </>
  );
}
