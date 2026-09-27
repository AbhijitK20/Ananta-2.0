/**
 * One city, prerendered.
 *
 * The view is a client component — the stamp set lives in the save, so the
 * page has to be under the provider — but the *route* is a server component so
 * it can enumerate its params and be statically generated.
 *
 * Splitting them is what turns `/cities/[slug]` from server-rendered-on-demand
 * into a prerendered page. That matters here for the same reason it matters in
 * the clone this app is built beside: a fully static route table is the
 * precondition for shipping the built assets inside a native shell and swapping
 * them over the air without a store submission.
 *
 * 202 params, one per city in the dataset. Every one of them is prerendered at
 * build time.
 *
 * `dynamicParams` is deliberately left at its default. Setting it to `false`
 * looks stricter but is worse: Next then rejects an unknown slug during *route
 * resolution*, before the page component runs, so the `notFound()` below never
 * executes, `app/not-found.tsx` is never reached, and the server logs an
 * internal `NoFallbackError` for every bad URL a scraper guesses. The client
 * gets a 404 either way — this way just gets it without the stack trace, and
 * without giving up the static route table.
 */

import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { CITIES, cityOf } from "../../../../lib/game/content";
import CityView from "./CityView";

export function generateStaticParams() {
  return CITIES.map((city) => ({ slug: city.slug }));
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ slug: string }>;
}): Promise<Metadata> {
  const { slug } = await params;
  const city = cityOf(slug);
  if (!city) return { title: "City not found" };
  return {
    title: `${city.label} — ${city.places.length} local picks`,
    description: `Collect all ${city.places.length} places locals recommended in ${city.label}.`,
  };
}

export default async function CityPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  // The one thing `generateStaticParams` does not cover: a slug that is not in
  // the dataset. Every real city is prerendered, so this only runs for a
  // guessed URL — and it has to 404 rather than render an empty city page.
  const city = cityOf(slug);
  if (!city) notFound();

  return <CityView slug={city.slug} />;
}
