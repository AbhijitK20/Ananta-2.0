import type { Metadata } from "next";
import Link from "next/link";

import "./hub.css";

/**
 * The way in to Local Legends.
 *
 * The game is mounted as a route group inside this app, which is the only way
 * it can exist without disturbing the pages `tools/verify.mjs` measures -- but
 * the cost of that is that nothing on the site points at it. Every destination
 * is listed here explicitly instead, so each one is one click rather than typed.
 *
 * The routes are the ones the game actually owns. `/` and `/cities` belong to
 * the brochure, which is why the game's own index pages are `/today` and
 * `/atlas`; `/cities/<slug>` and `/pick/<city>/<slug>` are the game's, because
 * this app never had them.
 *
 * The paths are printed on the cards rather than hidden behind the labels,
 * because these are the game's own URLs and being able to see them is most of
 * what the page is for.
 */

export const metadata: Metadata = {
  title: "Local Legends",
  description:
    "The gamified album: stamp the places locals recommended, clear the quests, keep the streak.",
};

const DESTINATIONS: { path: string; label: string; blurb: string }[] = [
  {
    path: "/today",
    label: "Today",
    blurb:
      "The daily challenge, your week strip, and the quests closest to done. This is where the streak is kept alive.",
  },
  {
    path: "/quests",
    label: "The quest board",
    blurb:
      "Every quest in the album, grouped by tier. City quests are generated from the data, so a city you have collected in is on the board.",
  },
  {
    path: "/atlas",
    label: "All 202 cities",
    blurb:
      "The city index, searchable by city or by any place inside it. Biggest first, with an A–Z toggle.",
  },
  {
    path: "/stamps",
    label: "Your album",
    blurb:
      "Everything you have stamped, the category breakdown, fifteen badges and the ten levels. Stamping is self-reported.",
  },
  {
    path: "/cities/lisbon",
    label: "A city",
    blurb:
      "One city's places. Clear all of them and the city pays a bonus — a four-place city is a four-place quest.",
  },
  {
    path: "/pick/lisbon/a-vida-portuguesa",
    label: "A place",
    blurb:
      "A single place, and the Stamp button. The button says Stamp rather than Check in, because there is no location check.",
  },
];

export default function LocalLegendsPage() {
  return (
    <div className="lal-hub">
      <div className="lal-hub__inner">
        <p className="lal-hub__eyebrow">Local Legends</p>
        <h1 className="lal-hub__title">The same 890 places, as a game</h1>

        <p className="lal-hub__lede">
          Every place in this album came from a local&rsquo;s own recommendation
          &mdash; the same data this site is built on. Local Legends turns it
          into a stamp album: clear quests, keep a streak, fill the book. Every
          screen is listed below, so pick one and start.
        </p>

        <h2 className="lal-hub__h2">Every screen in the game</h2>

        <ul className="lal-hub__grid">
          {DESTINATIONS.map((d) => (
            <li key={d.path}>
              <Link href={d.path} className="lal-hub__card">
                <span className="lal-hub__name">{d.label}</span>
                <code className="lal-hub__path">{d.path}</code>
                <span className="lal-hub__blurb">{d.blurb}</span>
              </Link>
            </li>
          ))}
        </ul>

        <p className="lal-hub__cta">
          <Link href="/today" className="lal-btn">
            Start with today&rsquo;s place
          </Link>
        </p>

        <p className="lal-hub__note">
          Once you are inside, the game keeps its own navigation along the bottom
          of the screen &mdash; Today, Quests, Cities and Stamps &mdash; so none
          of these links are needed again.
        </p>
      </div>
    </div>
  );
}
