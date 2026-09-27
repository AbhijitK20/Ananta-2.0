import Link from "next/link";

import { CityPicker } from "../components/CityPicker";
import CrowdCanvas from "../components/CrowdCanvas";
import { CountryFilmstrip } from "../components/CountryFilmstrip";
import { ParallaxHero } from "../components/ParallaxHero";
import { Promise, Tips } from "../components/Sections";

export default function HomePage() {
  return (
    <>
      <ParallaxHero />
      <CityPicker />
      {/* 100 famous places on a rotating strip. Placed directly after the city
          picker: the picker asks "where do you want to go", and this widens the
          answer to the whole world before the page settles into advice.

          The globe deliberately lives on its own page rather than here. Beside a
          filmstrip the two competed for the same attention and the strip lost --
          the planet is the better object and deserves the room. See /globe. */}
      <section className="lal-world" aria-labelledby="lal-world-title">
        <h2 className="lal-sr" id="lal-world-title">
          Around the world
        </h2>
        <CountryFilmstrip />
        <p className="lal-world__more">
          <Link href="/globe">See all 100 on a globe</Link>
        </p>
      </section>
      <Promise />
      <Tips />
      {/* Closing band. Deliberately last: it is the page's sign-off, and the
          canvas only ticks while it is on screen. */}
      <section className="lal-crowd" aria-labelledby="lal-crowd-title">
        <div className="lal-crowd__inner">
          <p className="lal-crowd__eyebrow">People, not places</p>
          <h2 className="lal-crowd__title" id="lal-crowd-title">
            Someone local is already there
          </h2>
          <p className="lal-crowd__sub">
            Every itinerary on this site is written by someone who lives in the city they are
            showing you around.
          </p>
        </div>
        <CrowdCanvas />
      </section>
    </>
  );
}
