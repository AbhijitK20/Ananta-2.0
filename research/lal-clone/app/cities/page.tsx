import type { Metadata } from "next";

import { CityCard } from "../../components/Interior";
import { cities } from "../../lib/content";
import "../interior.css";

export const metadata: Metadata = {
  title: "Explore by City",
  description: "Pick a city to uncover the places locals actually go.",
};

export default function CitiesPage() {
  return (
    <div className="g-page">
      <div className="g-wrap">
        <h1 className="g-h1">Explore by City</h1>
        <p className="g-lede">
          Pick a city to uncover the places locals actually go — every pick chosen
          and checked by someone who lives there.
        </p>

        <form className="g-search" action="#">
          <div className="g-search__row">
            <input type="search" name="q" placeholder="Search a city" aria-label="Search a city" />
            <button type="submit" aria-label="Search">
              <span aria-hidden="true">&#8981;</span>
            </button>
          </div>
        </form>
        <p className="g-hint">Type a city above &ndash; more are on the way.</p>

        <div className="g-homecity">
          <p className="g-homecity__eyebrow">Our home city</p>
          <h2 className="g-homecity__title">New York City</h2>
          <p className="g-homecity__desc">
            90+ picks from the team behind Like A Local Tours.
          </p>
        </div>

        <h2 className="g-h2">Explore all cities</h2>
        <div className="g-grid g-grid--cities g-grid--inset">
          {cities.map((city) => (
            <CityCard key={city.slug} city={city} />
          ))}
        </div>
      </div>
    </div>
  );
}
