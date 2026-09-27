import type { Metadata } from "next";
import Link from "next/link";

import { CITIES, cities } from "../../lib/content";
import "../globals.css";
import "../interior.css";

export const metadata: Metadata = {
  title: "About",
  description: "Recommendations you can trust, from people who actually know the place.",
};

const PROMISES = [
  "Every pick is filtered through real, on-the-ground knowledge of the neighbourhood.",
  "We only feature places we’d happily recommend to a friend — no pay-to-play listings.",
  "We spotlight places with a social mission, and a planner that turns them into an itinerary.",
];

export default function AboutPage() {
  return (
    <div className="g-edit g-edit--about lal-page">
      <div className="g-edit__inner">
        <p className="g-edit__eyebrow">Our story</p>
        <h1 className="g-edit__title g-edit__title--about">
          Recommendations you can trust, from people who actually know the place
        </h1>

        <p className="g-edit__sub">
          We believe the best trips come from local knowledge — not endless lists or
          paid placements. Like A Local Guide exists to fix that.
        </p>

        <h2 style={{ textAlign: "center" }}>Built by Like A Local Tours</h2>

        <p>
          Like A Local Guide is built by the team behind Like A Local Tours. We use
          the same local experience that powers our group walking tours to curate
          every city guide here.
        </p>
        <p>
          For years, our guides have walked travelers through these cities in
          person — learning which counters are worth the queue, which museums earn
          their ticket price, and which neighbourhoods are still worth a look.
        </p>
        <p>
          <a href="#">Read the story behind our relaunch</a>
        </p>

        <ul className="g-promise__list">
          {PROMISES.map((line) => (
            <li key={line}>{line}</li>
          ))}
        </ul>

        <p className="g-edit__eyebrow" style={{ margin: "32px 0 12px" }}>
          A few of the cities we cover — tap any to open its guide
        </p>

        <div className="g-citycards">
          {cities.slice(0, 9).map((city) => (
            <Link key={city.slug} href={`/${city.slug}`} className="g-citycard">
              <span className="g-citycard__name">{city.name}</span>
              {city.picks != null && (
                <span className="g-citycard__count">{city.picks} local picks</span>
              )}
            </Link>
          ))}
        </div>

        <h2>From award-winning local tours to a global guide</h2>
        <p>
          Like A Local Tours runs award-winning tours in{" "}
          {CITIES.length > 0 ? cities.slice(0, 5).map((c) => c.name).join(", ") : "our"}{" "}
          and counting. The same guides write these guides, which means the advice
          here is the advice we give on the ground, in person, every single week.
        </p>

        <h2>What you’ll find here</h2>
        <p>
          Honest, local, free guides for the places we know best — and a{" "}
          <Link href="/plan">trip planner</Link> that turns them into an itinerary,
          with every distance either routed or labelled an estimate.
        </p>

        <h2>Local, honest and free</h2>
        <p>
          No ads dressed up as recommendations, no ranking bought by a bigger
          advertiser. The order you see is the order a local would tell you.
        </p>
      </div>
    </div>
  );
}
