import type { Metadata } from "next";

import { CountryFilmstrip } from "../../components/CountryFilmstrip";

import "../globals.css";
import "../interior.css";

export const metadata: Metadata = {
  title: "Partner with us",
  description: "Put your tours in front of travelers already planning their trip.",
};

const TIERS = [
  {
    name: "City slot",
    desc: "Own the tour module on your city’s guide and its venue pages. Flat annual fee, sized to your city’s audience.",
  },
  {
    name: "Featured Listing",
    desc: "Pin a hotel, attraction, restaurant or shop to the top of its category page.",
  },
  {
    name: "Stay22",
    desc: "Turn travel content you are already publishing into a second revenue stream.",
  },
  {
    name: "FareHarbor Distribution Network",
    desc: "Bookings are tracked through FareHarbor — you keep the commission, we just send you the traveller.",
  },
];

export default function PartnersPage() {
  return (
    <div className="g-edit g-edit--partners lal-page">
      <div className="g-edit__inner">
        <h1 className="g-edit__title g-edit__title--partners">
          Put your tours in front of travelers already planning their trip
        </h1>
        <p className="g-edit__sub" style={{ maxWidth: 760 }}>
          Like A Local Guide reaches trip-planners searching for the best things to do
          in 100+ cities every month, and we are the layer between “I might go” and
          “I booked it” — the one page a traveller lands on before they decide who to
          book with.
        </p>

        <p>
          When travelers land on your city’s guide — and its dozens of venue pages —
          you are the tour company they see first.
        </p>
        <p className="g-edit__note">
          See it live: the Like A Local Tours module on our New York City page — NYC
          is ours, and it is the single biggest reason this page exists.
        </p>

        {/* 100 famous places on a rotating strip. It lives here rather than on the
            home page because the sub-headline above claims "100+ cities", and
            this is the proof of that claim. The reference site has no equivalent
            block, so on the home page — which exists to be pixel-identical to
            the reference — the strip could only cost fidelity. tools/verify.mjs
            measured it at 26 of that page's 56 verified elements. */}
        <section className="lal-world" aria-labelledby="lal-world-title">
          <h2 className="lal-sr" id="lal-world-title">
            Around the world
          </h2>
          <CountryFilmstrip />
        </section>

        <h2>Own your city’s tour slot</h2>
        <p>
          Every city has exactly one Like A Local partner for tours. That is the
          whole proposition: no auction, no rotating ad slots, no race to the bottom
          on commission.
        </p>

        <div className="g-pricing">
          <p className="g-pricing__label">Pricing</p>
          <p className="g-pricing__body">
            Flat annual fee, sized to your city’s audience. $500/yr for major cities
            (Paris, Rome, Kraków, Lisbon, Berlin…) &middot; $250/yr mid-size
            (Amsterdam, Vienna, Athens…). The fee only buys placement — bookings are
            tracked through the FareHarbor Distribution Network.
          </p>
          <p className="g-edit__note" style={{ marginTop: 8 }}>
            We’re upfront about the fine print: featured links carry
            <code> rel=&quot;sponsored&quot;</code> per Google’s guidelines.
          </p>
        </div>

        <ul className="g-tiers">
          {TIERS.map((t) => (
            <li key={t.name} className="g-tier">
              <span className="g-tier__name">{t.name}</span>
              <span className="g-tier__desc">{t.desc}</span>
            </li>
          ))}
        </ul>

        <h2>Already listed with us — or should be?</h2>
        <p>
          A Featured Listing pins your venue to the top of its category page, where
          the highest-intent traffic on the whole site already is.
        </p>

        <h2>Already publishing destination guides?</h2>
        <p>
          Stay22 helps creators turn hotel and travel recommendations into
          commission. Travel Referral Program: earn a $100 bonus once you reach 100
          confirmed travel bookings.
        </p>

        <h2>The tools we use — and recommend to other businesses</h2>
        <p>
          FareHarbor for distribution tracking, Stay22 for monetising content, and a
          media kit you can hand straight to your accountant.
        </p>

        <h2>Request the media kit</h2>
        <p>
          It has the audience numbers, the current city list, and what a slot on
          your city’s guide actually looks like.
        </p>

        <a href="#" className="g-submit" style={{ display: "inline-block" }}>
          Request the media kit
        </a>
      </div>
    </div>
  );
}
