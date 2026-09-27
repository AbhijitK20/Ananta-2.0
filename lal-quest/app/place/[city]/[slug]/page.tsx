/**
 * One place, prerendered.
 *
 * Same split as the city route: the view is a client component because the save
 * holds the stamp, the route is a server component so it can enumerate params.
 *
 * 890 of them, which is the whole dataset. That is a lot of pages to build, and
 * it is the right trade for this app: every place page is pure content that
 * never changes between deploys, so rendering it on demand would mean running
 * the same work a thousand times a day to produce byte-identical HTML.
 *
 * `dynamicParams` is left at its default for the same reason as the city route:
 * with it set to `false`, an unknown id is rejected during route resolution,
 * `notFound()` below never runs, and the server logs an internal
 * `NoFallbackError` per bad URL instead of rendering app/not-found.tsx.
 */

import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { PLACES, placeOf } from "../../../../lib/content";
import PlaceView from "./PlaceView";


export function generateStaticParams() {
  return PLACES.map((place) => ({ city: place.city, slug: place.slug }));
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ city: string; slug: string }>;
}): Promise<Metadata> {
  const { city, slug } = await params;
  const place = placeOf(`${city}/${slug}`);
  if (!place) return { title: "Place not found" };
  return {
    title: `${place.name}, ${place.cityLabel}`,
    // The dataset's own "why it matters" line. It is the most honest description
    // available — a local's words rather than a copywriter's.
    description: place.snippet.slice(0, 180),
  };
}

export default async function PlacePage({
  params,
}: {
  params: Promise<{ city: string; slug: string }>;
}) {
  const { city, slug } = await params;
  const place = placeOf(`${city}/${slug}`);
  if (!place) notFound();

  return <PlaceView id={place.id} />;
}
