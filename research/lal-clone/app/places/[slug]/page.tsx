import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";

import { placeBySlug, PLACES_DETAILED } from "../../../lib/places";

import "../../places.css";

type Params = { params: Promise<{ slug: string }> };

/**
 * /places/<slug> — what a place actually is, once you have picked it.
 *
 * Built from data that already exists rather than new copy: the strip supplied
 * the name, country, region and coordinates, the image fetcher supplied the
 * photograph and its licence, and data/place-blurbs.json supplies the prose.
 * The page adds no factual claims of its own, so a card on the filmstrip, a pin
 * on the globe and this route cannot disagree about what a place is.
 *
 * Statically generated for all 100, which is why the params are awaited the
 * Next 15 way rather than read synchronously.
 */
export function generateStaticParams() {
  return PLACES_DETAILED.map((place) => ({ slug: place.id }));
}

export async function generateMetadata({ params }: Params): Promise<Metadata> {
  const { slug } = await params;
  const place = placeBySlug(slug);
  if (!place) return { title: "Place" };
  return {
    title: `${place.name}, ${place.country}`,
    description: place.blurb.slice(0, 155),
  };
}

const formatCoords = (lat: number, lng: number) => {
  const ns = lat >= 0 ? "N" : "S";
  const ew = lng >= 0 ? "E" : "W";
  return `${Math.abs(lat).toFixed(2)}° ${ns}, ${Math.abs(lng).toFixed(2)}° ${ew}`;
};

export default async function PlacePage({ params }: Params) {
  const { slug } = await params;
  const place = placeBySlug(slug);
  if (!place) notFound();

  const index = PLACES_DETAILED.findIndex((p) => p.id === place.id);
  const previous = PLACES_DETAILED[(index - 1 + PLACES_DETAILED.length) % PLACES_DETAILED.length];
  const next = PLACES_DETAILED[(index + 1) % PLACES_DETAILED.length];

  const sameRegion = PLACES_DETAILED.filter(
    (p) => p.region === place.region && p.id !== place.id,
  );

  return (
    <article className="pl">
      <div className="pl__hero">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img className="pl__heroimg" src={place.image} alt="" />
        <div className="pl__heroscrim" />
        <div className="pl__herobody">
          <p className="pl__eyebrow">
            <Link href="/cities">{place.region}</Link>
            {place.fromLonelyPlanet ? <span className="pl__lp">Lonely Planet 2027 pick</span> : null}
          </p>
          <h1 className="pl__title">{place.name}</h1>
          <p className="pl__country">{place.country}</p>
        </div>
      </div>

      <div className="pl__inner">
        <p className="pl__lede">{place.blurb}</p>

        <dl className="pl__facts">
          <div>
            <dt>Region</dt>
            <dd>{place.region}</dd>
          </div>
          <div>
            <dt>Country</dt>
            <dd>{place.country}</dd>
          </div>
          {place.lat != null && place.lng != null && (
            <div>
              <dt>Coordinates</dt>
              <dd>
                <Link href={`/globe?place=${place.id}`}>{formatCoords(place.lat, place.lng)}</Link>
              </dd>
            </div>
          )}
          <div>
            <dt>Position</dt>
            <dd>
              {String(index + 1).padStart(3, "0")} of {PLACES_DETAILED.length}
            </dd>
          </div>
        </dl>

        {place.bestFor.length > 0 && (
          <>
            <h2 className="pl__h2">What it is for</h2>
            <ul className="pl__tags">
              {place.bestFor.map((tag) => (
                <li key={tag}>{tag}</li>
              ))}
            </ul>
          </>
        )}

        {place.goWhen && (
          <>
            <h2 className="pl__h2">When to go</h2>
            <p className="pl__body">{place.goWhen}</p>
          </>
        )}

        <h2 className="pl__h2">See it on the map</h2>
        <p className="pl__body">
          Turn the globe to {place.name} and read the rest of the {place.region} list
          without scrolling.{" "}
          <Link href={`/globe?place=${place.id}`}>Open the globe</Link>, or{" "}
          <Link href="/cities">browse all {PLACES_DETAILED.length} places</Link>.
        </p>

        {place.siblings.length > 0 && (
          <>
            <h2 className="pl__h2">Also in {place.country}</h2>
            <ul className="pl__also">
              {place.siblings.map((s) => (
                <li key={s.id}>
                  <Link href={`/places/${s.id}`}>
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img src={s.image} alt="" loading="lazy" decoding="async" />
                    <span>{s.name}</span>
                  </Link>
                </li>
              ))}
            </ul>
          </>
        )}

        {sameRegion.length > 0 && (
          <>
            <h2 className="pl__h2">More in {place.region}</h2>
            <ul className="pl__chips">
              {sameRegion.map((p) => (
                <li key={p.id}>
                  <Link href={`/places/${p.id}`}>{p.name}</Link>
                </li>
              ))}
            </ul>
          </>
        )}

        {place.meta && (
          <p className="pl__credit">
            Photograph: {place.meta.author} · {place.meta.licence}.{" "}
            {place.meta.commonsPage && (
              <a href={place.meta.commonsPage} rel="noreferrer noopener" target="_blank">
                Source on Wikimedia Commons
              </a>
            )}
          </p>
        )}

        <nav className="pl__pager" aria-label="Nearby places">
          <Link href={`/places/${previous.id}`} rel="prev">
            <span aria-hidden="true">&larr;</span> {previous.name}
          </Link>
          <Link href={`/places/${next.id}`} rel="next">
            {next.name} <span aria-hidden="true">&rarr;</span>
          </Link>
        </nav>
      </div>
    </article>
  );
}
