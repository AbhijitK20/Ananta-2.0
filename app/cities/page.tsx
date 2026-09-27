import type { Metadata } from "next";
import Link from "next/link";

import { PlaceExplorer } from "../../components/PlaceExplorer";
import { cities } from "../../lib/content";
import { PLACES_DETAILED, placeCountries } from "../../lib/places";
import "../interior.css";
import "../places.css";

export const metadata: Metadata = {
  title: "Explore every place",
  description:
    "Pick any of 100 famous places — from the Taj Mahal to the Salar de Uyuni — and see what it is for, when to go, and where it sits on the globe.",
};

/**
 * /cities — the 100 places, not the 14 city guides.
 *
 * This route used to list fourteen scraped city directories with a pick count
 * each, which had nothing to do with the hundred places on the home filmstrip
 * and the globe: two datasets, one word. It now lists the same hundred the
 * carousel and the globe read, so tapping a card anywhere lands somewhere real.
 *
 * The fourteen city guides are still here. They are a different product — a
 * directory of vetted venues inside one city — so they get their own section at
 * the bottom rather than being deleted, and the home page city picker is
 * untouched.
 */
export default function CitiesPage() {
  return (
    <div className="g-page">
      <div className="g-wrap">
        <h1 className="g-h1">Explore every place</h1>
        <p className="g-lede">
          {PLACES_DETAILED.length} places worth the trip, from the Eiffel Tower to
          the Salar de Uyuni. Search by name, country or region — every card here is
          the same card you find on the home carousel and the globe.
        </p>

        <PlaceExplorer />

        <section className="px__cities">
          <h2 className="g-h2">City guides</h2>
          <p className="g-lede">
            Want the vetted venue-by-venue guide instead? These are the city
            directories — restaurants, hotels, tours and bars, each checked by
            someone who lives there.
          </p>
          <ul className="px__citylist">
            {cities.map((city) => (
              <li key={city.slug}>
                <Link href={`/${city.slug}`}>
                  <span className="px__cityname">{city.name}</span>
                  {city.picks != null && (
                    <span className="px__citypicks">{city.picks} local picks</span>
                  )}
                </Link>
              </li>
            ))}
          </ul>
        </section>

        <p className="px__foot">
          {PLACES_DETAILED.length} places across {placeCountries.length} countries.{" "}
          <Link href="/globe">See them on the globe</Link>.
        </p>
      </div>
    </div>
  );
}
