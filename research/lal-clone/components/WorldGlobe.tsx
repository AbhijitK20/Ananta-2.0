"use client";

/**
 * WorldGlobe — the same 100 places the filmstrip shows, plotted on a globe.
 *
 * ── Why this is not the snippet it started as ───────────────────────────────
 * The version this replaces bound a `scroll` listener that called
 * `focusGlobe()` on *every* event, and `focusGlobe` started a 500ms
 * `pointOfView` flight each time. Scrolling the page therefore re-targeted the
 * globe dozens of times a second and the camera never settled. Here the globe
 * has no scroll listener at all: it reacts to `active` changing, and bursts of
 * changes are coalesced into one flight per animation frame so only the last
 * one survives.
 *
 * It also dropped two other things from the original: the `LocationDetailRow`
 * rendered `selectedLocation.email` twice (`email-1` and `email-2`), and the
 * default `globeTextureUrl` pointed at a hardcoded cdn.21st.dev asset. The
 * texture is local and public domain, the licence is in
 * public/globe/ATTRIBUTION.txt, and there is one row per fact.
 *
 * ── Coordinates ─────────────────────────────────────────────────────────────
 * Sourced from Wikipedia article coordinates by tools/geocode-places.mjs. They
 * are per-place, not per-country, so Uluru and the Taj Mahal sit on their own
 * landmarks rather than in the middle of Australia and India.
 */
import dynamic from "next/dynamic";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { PLACES, type Place } from "../data/places";
import imageMeta from "../data/place-images.json";

const Globe = dynamic(() => import("react-globe.gl"), {
  ssr: false,
  loading: () => <div className="worldglobe__loading" aria-hidden="true" />,
});

type Meta = { image: string; author: string; licence: string; commonsPage: string };
const META = imageMeta as unknown as Record<string, Meta>;

const slugOf = (s: string) =>
  s
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");

export type Pin = {
  id: string;
  name: string;
  country: string;
  code: string;
  region: string;
  lat: number;
  lng: number;
  index: number;
  meta?: Meta;
};

/**
 * Only places that actually have coordinates can be plotted.
 *
 * Exported so the globe and the list beside it are built from one pass. If each
 * derived its own list they would drift the moment a place lost coordinates,
 * and clicking a row would fly the camera to the wrong pin.
 */
export function buildPins(): Pin[] {
  const out: Pin[] = [];
  PLACES.forEach((place, index) => {
    if (place.lat == null || place.lng == null) return;
    out.push({
      id: slugOf(place.name),
      name: place.name,
      country: place.country,
      code: place.code,
      region: place.region,
      lat: place.lat,
      lng: place.lng,
      // Index into PLACES, not into `out`, so a card and its pin always agree
      // even if some places are dropped for want of coordinates.
      index,
      meta: META[slugOf(place.name)],
    });
  });
  return out;
}

export function WorldGlobe({
  active,
  onSelect,
}: {
  active: number | null;
  onSelect: (index: number) => void;
}) {
  const pins = useMemo(buildPins, []);
  const globeRef = useRef<{ pointOfView?: (p: object, ms?: number) => void; controls?: () => { autoRotate: boolean; autoRotateSpeed: number } } | null>(null);
  const [ready, setReady] = useState(false);
  const [reduced, setReduced] = useState(false);

  // Coalescing targets: a burst of focus changes schedules at most one flight.
  const targetRef = useRef<Pin | null>(null);
  const rafRef = useRef(0);
  // Don't fly on mount. The first card is not a user choice, and yanking the
  // camera to it the instant the section loads reads as a glitch.
  const settled = useRef(false);

  useEffect(() => {
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    const on = () => setReduced(mq.matches);
    on();
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, []);

  const flyTo = useCallback(
    (pin: Pin) => {
      const globe = globeRef.current;
      if (!globe) return;
      const controls = globe.controls?.();
      // autoRotate fights an explicit pointOfView, so stand it down for the
      // duration of the flight and let it resume afterwards.
      const wasRotating = controls?.autoRotate ?? false;
      if (controls) controls.autoRotate = false;
      globe.pointOfView?.({ lat: pin.lat, lng: pin.lng, altitude: 1.55 }, reduced ? 0 : 900);
      if (controls) {
        window.setTimeout(() => {
          controls.autoRotate = wasRotating;
        }, reduced ? 0 : 950);
      }
    },
    [reduced],
  );

  useEffect(() => {
    if (active == null) return;
    const pin = pins.find((p) => p.index === active);
    if (!pin) return;

    if (!settled.current) {
      // First render: orient to the opening card without animating.
      settled.current = true;
      const globe = globeRef.current;
      if (globe) globe.pointOfView?.({ lat: pin.lat, lng: pin.lng, altitude: 2.1 }, 0);
      return;
    }

    targetRef.current = pin;
    if (rafRef.current) return; // a frame is already pending and will take the latest
    rafRef.current = requestAnimationFrame(() => {
      rafRef.current = 0;
      const t = targetRef.current;
      if (t) flyTo(t);
    });
  }, [active, pins, flyTo]);

  useEffect(() => () => cancelAnimationFrame(rafRef.current), []);

  /* Labels are returned as JSX, which react-globe.gl renders through React and
     therefore escapes. The author/licence from Commons are never interpolated
     into this path -- they are rendered as text elsewhere -- so there is no
     injection surface here. */
  const labelFor = useCallback(
    (pin: Pin) => (
      <div className="worldglobe__label">
        <strong>{pin.name}</strong>
        <span>{pin.country}</span>
      </div>
    ),
    [],
  );

  const pointData = useMemo(
    () =>
      pins.map((p) => ({
        ...p,
        color: (active != null && p.index === active) ? "#f5a623" : "#8fb8d8",
      })),
    [pins, active],
  );

  return (
    <div className="worldglobe">
      <Globe
        ref={globeRef as never}
        // Local, public domain. See public/globe/ATTRIBUTION.txt.
        globeImageUrl="/globe/earth-blue-marble.jpg"
        backgroundColor="rgba(0,0,0,0)"
        showAtmosphere
        atmosphereColor="#5b8fc9"
        atmosphereAltitude={0.14}
        showGraticules
        onGlobeReady={() => setReady(true)}
        pointsData={pointData}
        pointsMerge={false}
        pointLat="lat"
        pointLng="lng"
        pointColor="color"
        pointAltitude={0.012}
        pointRadius={0.32}
        pointsTransitionDuration={420}
        /* The hover handler's first argument is `object | null` in
           react-globe.gl 2.x -- it goes null when the pointer leaves the point,
           which is the case this line exists to handle. Declaring the
           parameter as bare `object` is what made it unassignable. */
        onPointHover={(pin: object | null) => {
          // Canvas gives no hover affordance of its own.
          document.body.style.cursor = pin ? "pointer" : "";
        }}
        /* pointLabel is typed to return `React.ReactHTMLElement<HTMLElement>`,
           which is an element that *already carries* a `ref`. JSX cannot
           produce that shape -- `<div>` with children gives ReactElement -- so
           a rich label like the one above is unspellable in the type system
           even though globe.gl only ever reads the element. The cast is
           confined to this one call rather than loosening labelFor's return
           type, so the rest of the file keeps its real checking. */
        pointLabel={
          ((pin: object) => labelFor(pin as Pin)) as unknown as NonNullable<
            React.ComponentProps<typeof Globe>["pointLabel"]
          >
        }
        onPointClick={(pin: object) => {
          const p = pin as Pin;
          if (typeof p?.index === "number") onSelect(p.index);
        }}
      />

      <p className="worldglobe__hint" data-ready={ready ? "true" : "false"}>
        {pins.length} places plotted · click a pin to jump the strip
      </p>
    </div>
  );
}
