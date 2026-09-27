import Link from "next/link";

import { CITIES, type City } from "../lib/data";

function Tile({ city }: { city: City }) {
  return (
    <Link
      href={`/${city.slug}`}
      className="lal-tile"
      style={{ backgroundImage: `url(${city.image})` }}
    >
      <span className="lal-tile__scrim" />
      <span className="lal-tile__label">{city.name}</span>
    </Link>
  );
}

export function CityPicker() {
  const featured = CITIES.find((c) => c.featured) ?? CITIES[0];
  const rest = CITIES.filter((c) => c.slug !== featured.slug);

  return (
    <section className="lal-cities lal-box">
      <div className="lal-container lal-cities__inner">
        <h2 className="lal-h2">Choose your city</h2>

        <div className="lal-cities__panel">
        <Link
          href={`/${featured.slug}`}
          className="lal-feature"
          style={{ backgroundImage: `url(${featured.image})` }}
        >
          <span className="lal-feature__scrim" />
          <span className="lal-feature__body">
            <span className="lal-badge">Our home city</span>
            <span className="lal-feature__title">{featured.name}</span>
            <span className="lal-feature__desc">{featured.blurb}</span>
            <span className="lal-feature__cta">Explore {featured.name} &rarr;</span>
          </span>
        </Link>

        <div className="lal-tile-grid">
          {rest.map((city) => (
            <Tile key={city.slug} city={city} />
          ))}
        </div>
        </div>

        <div className="lal-cities__cta">
          <Link href="/cities" className="lal-btn">
            See all cities
          </Link>
        </div>
      </div>
    </section>
  );
}
