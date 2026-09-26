"use client";

/**
 * CountryFilmstrip — 100 famous places on a continuously rotating 3D strip.
 *
 * Ported from the `character-filmstrip` shader bundle. The projection maths is
 * carried over unchanged, because it is what produces the depth; what changed
 * is the data, the architecture, and the two things a 100-card set breaks.
 *
 * ── Why not 100 <video> ────────────────────────────────────────────────────
 * The measured cost of 100 autoplaying drone clips is 7–11 MB each, so roughly
 * 900 MB of media decoding at once, across 100 parallel video pipelines. That
 * stutters on a desktop and is unusable on a phone. So every card renders a
 * compressed still, and a <video> is mounted only while that card is inside
 * FOCUS_WINDOW of the centre, and unmounted the moment it leaves. At most a
 * handful ever decode, and the rotating-footage look survives because the
 * focused card is always the one playing.
 *
 * ── Why the transform writes are culled ────────────────────────────────────
 * Writing 8 style properties on 100 nodes every frame is 800 layout-affecting
 * writes per frame and it will drop frames on a mid-range laptop. The maths
 * only needs resolving for cards near the centre, so cards beyond
 * DRAW_WINDOW keep their last transform and are skipped entirely. That turns
 * ~800 writes per frame into ~140.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type { Place } from "../data/places";
import { PLACES, REGION_ORDER } from "../data/places";
import imageMeta from "../data/place-images.json";
import videoMeta from "../data/place-videos.json";

type Meta = {
  id: string;
  name: string;
  country: string;
  code: string;
  region: string;
  image: string;
  licence: string;
  author: string;
  commonsPage: string;
};

type VideoMeta = {
  src: string;
  provider: string;
  licence: string;
  title: string;
};

const META = imageMeta as unknown as Record<string, Meta>;
const VIDEOS = videoMeta as unknown as Record<string, VideoMeta>;

/** The id both fetched data files are keyed by. Kept in one place so a new
    fetcher cannot silently disagree with this component. */
const placeId = (name: string) =>
  name
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");

/** Resolve a place to its image and, when one has been fetched, its video.
    Video is optional by design: posters exist for all 100 places, footage for
    however many have been sourced, and a place with no clip still gets the
    slow drift so it never looks broken. */
const withMedia = (place: Place): Place & { image: string; video?: string; meta?: Meta } => {
  const id = placeId(place.name);
  return {
    ...place,
    image: META[id]?.image ?? "/places/placeholder.jpg",
    video: VIDEOS[id]?.src,
    meta: META[id],
  };
};

const FOCUS_WINDOW = 1.6; // inside this, a card is a candidate for video
const DRAW_WINDOW = 7; // beyond this, skip the transform write entirely
const IDLE_DELAY = 3600; // ms of no input before the strip drifts on its own
const IDLE_AMPLITUDE = 2.45;

export type CountryFilmstripProps = {
  /**
   * Controlled focus. The strip keeps its own `active` state so it still works
   * standalone, but when this is supplied it becomes an input: the sibling globe
   * uses it to fly the strip to whichever pin was clicked.
   */
  activeIndex?: number | null;
  /** Fired whenever the strip changes focus by any means -- user or auto-drift. */
  onActiveChange?: (index: number) => void;
};

export function CountryFilmstrip({
  activeIndex = null,
  onActiveChange,
}: CountryFilmstripProps = {}) {
  const places = useMemo(() => PLACES.map(withMedia), []);
  const count = places.length;

  const stageRef = useRef<HTMLDivElement>(null);
  const deckRef = useRef<HTMLDivElement>(null);
  const cardRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const frameRef = useRef<0 | 1 | 2>(0);

  const [active, setActive] = useState(0);
  const [region, setRegion] = useState<string | null>(null);
  const [playing, setPlaying] = useState<Set<number>>(() => new Set());

  // Everything the animation loop mutates lives in a ref. Putting the phase in
  // React state would re-render the whole tree on every frame.
  const anim = useRef({
    phase: 0,
    target: 0,
    base: 0,
    pointerX: 0,
    pointerY: 0,
    active: false,
    lastInput: 0,
    previous: 0,
    raf: 0,
    visible: true,
    reduced: false,
  });

  /* The last set committed to state, mirrored in a ref so the animation loop
     can compare against it. Comparing against the `playing` state instead
     would put it in the effect's dependency list, and the effect owns the
     requestAnimationFrame loop -- so every focus change would cancel and
     restart the loop mid-drift. */
  const playingRef = useRef<Set<number>>(new Set());

  const phase = anim.current;

  /* ------------------------------------------------------- focus plumbing -- */

  /* The parent's callback goes through a ref rather than a dependency. The
     parent is very likely to pass an inline arrow, and listing it as a
     dependency of `moveTo` would change `moveTo`'s identity on every parent
     render -- which re-runs the effect that owns the requestAnimationFrame
     loop, cancelling and restarting the drift mid-animation. */
  const notifyRef = useRef<((index: number) => void) | undefined>(undefined);
  useEffect(() => {
    notifyRef.current = onActiveChange;
  }, [onActiveChange]);

  /* Set when the parent, rather than the user, caused a focus change. Without
     this the two halves ping-pong: globe click -> strip moves -> strip reports
     the new index -> globe is told to fly again -> ... */
  const suppressRef = useRef<number | null>(null);

  const commit = useCallback((index: number) => {
    setActive(index);
    if (suppressRef.current === index) {
      suppressRef.current = null;
      return;
    }
    notifyRef.current?.(index);
  }, []);

  /* --------------------------------------------------------- interaction -- */

  const moveTo = useCallback(
    (index: number) => {
      const a = anim.current;
      const current = ((Math.round(a.phase) % count) + count) % count;
      let delta = index - current;
      if (delta > count / 2) delta -= count;
      if (delta < -count / 2) delta += count;
      a.base += delta;
      a.target = a.base;
      a.active = false;
      a.lastInput = performance.now();
      commit(((a.base % count) + count) % count);
    },
    [commit, count],
  );

  const step = useCallback(
    (direction: 1 | -1) => {
      const a = anim.current;
      a.base += direction;
      a.target = a.base;
      a.active = false;
      a.lastInput = performance.now();
      commit(((a.base % count) + count) % count);
    },
    [commit, count],
  );

  /* External focus, e.g. the globe flying to a pin the user clicked. The
     `lastExternal` guard matters because `active` is a dependency: after
     moveTo commits, this effect runs again with active === activeIndex and
     would otherwise call moveTo a second time and skip a card. */
  const lastExternal = useRef<number | null>(null);
  useEffect(() => {
    if (activeIndex == null) return;
    if (activeIndex === active) return;
    if (lastExternal.current === activeIndex) return;
    lastExternal.current = activeIndex;
    suppressRef.current = activeIndex;
    moveTo(activeIndex);
  }, [active, activeIndex, moveTo]);

  /* Jump to a region: land on that region's first card, honouring the wrap. */
  const focusRegion = useCallback(
    (name: string | null) => {
      setRegion(name);
      if (!name) return;
      const index = places.findIndex((p) => p.region === name);
      if (index >= 0) moveTo(index);
    },
    [moveTo, places],
  );

  /* ------------------------------------------------------------- lifecycle -- */

  useEffect(() => {
    const a = anim.current;
    a.lastInput = performance.now();
    a.previous = performance.now();

    a.reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

    const stage = stageRef.current;
    if (!stage) return;

    let onScroll: IntersectionObserver | undefined;
    if (typeof IntersectionObserver !== "undefined") {
      onScroll = new IntersectionObserver(([entry]) => {
        a.visible = entry?.isIntersecting ?? true;
        // No point burning a frame budget on a band nobody is looking at.
        if (a.visible && !a.raf) a.raf = requestAnimationFrame(render);
      });
      onScroll.observe(stage);
    }

    const cards = cardRefs.current;

    const onPointerMove = (event: PointerEvent) => {
      const rect = stage.getBoundingClientRect();
      const nx = Math.max(-1, Math.min(1, ((event.clientX - rect.left) / rect.width - 0.5) * 2));
      const ny = Math.max(-1, Math.min(1, ((event.clientY - rect.top) / rect.height - 0.5) * 2));
      a.pointerX = nx;
      a.pointerY = ny;
      a.active = true;
      a.target = a.base + (window.innerWidth < 650 ? ny * 2.2 : nx * 3.1);
      a.lastInput = performance.now();
      stage.style.setProperty("--fs-pointer-x", `${((nx + 1) * 50).toFixed(1)}%`);
    };

    const onPointerLeave = () => {
      a.active = false;
      a.pointerX = 0;
      a.pointerY = 0;
      a.target = a.base;
      stage.style.setProperty("--fs-pointer-x", "50%");
    };

    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      const dominant = Math.abs(event.deltaY) > Math.abs(event.deltaX) ? event.deltaY : event.deltaX;
      const direction = Math.sign(dominant);
      if (!direction) return;
      a.base += direction;
      a.target = a.base;
      a.active = false;
      a.lastInput = performance.now();
      commit(((a.base % count) + count) % count);
    };

    const onKey = (event: KeyboardEvent) => {
      const forward = event.key === "ArrowRight" || event.key === "ArrowDown";
      const backward = event.key === "ArrowLeft" || event.key === "ArrowUp";
      if (!forward && !backward) return;
      event.preventDefault();
      step(forward ? 1 : -1);
    };

    /* The render loop. Declared as a function declaration so the observer above
       can reference it before this point in the source. */
    function render(time: number) {
      const s = anim.current;
      s.raf = 0;
      if (!s.visible) return;

      const deltaTime = Math.min(32, time - s.previous);
      s.previous = time;
      const ease = s.reduced ? 1 : 1 - Math.pow(0.001, deltaTime / 1000);

      if (!s.active && time - s.lastInput > IDLE_DELAY) {
        const idle = time - s.lastInput - IDLE_DELAY;
        s.target = s.base + Math.sin(idle * 0.00042) * IDLE_AMPLITUDE;
      }

      s.phase += (s.target - s.phase) * ease;

      const compact = window.innerWidth < 650;
      const activeIndex = ((Math.round(s.phase) % count) + count) % count;
      const horizontalSpacing = Math.min(168, Math.max(112, window.innerWidth * 0.116));
      const verticalSpacing = Math.min(122, Math.max(88, window.innerHeight * 0.112));

      const shouldPlay = new Set<number>();
      const nextFrame = ((activeIndex + 1) % 3) as 0 | 1 | 2;
      frameRef.current = nextFrame;

      for (let index = 0; index < count; index += 1) {
        const card = cards[index];
        if (!card) continue;

        let delta = index - s.phase;
        while (delta > count / 2) delta -= count;
        while (delta < -count / 2) delta += count;

        const distance = Math.abs(delta);

        // Beyond the draw window the card keeps whatever transform it last had.
        if (distance > DRAW_WINDOW) {
          if (card.style.opacity !== "0") {
            card.style.opacity = "0";
            card.style.pointerEvents = "none";
          }
          continue;
        }

        const focus = Math.exp(-distance * distance * 1.28);
        const side = Math.max(0, 1 - distance / 5);
        const direction = Math.sign(delta);

        if (distance < FOCUS_WINDOW) shouldPlay.add(index);

        const x = compact ? delta * 24 + Math.sin(delta * 0.9) * 25 : delta * horizontalSpacing;
        const y = compact ? delta * verticalSpacing : distance * 8 + s.pointerY * focus * 10;
        const z = focus * 145 - distance * 148;
        const scale = 0.54 + side * 0.15 + focus * 0.54;
        const rotateX = compact ? delta * 2.1 : -s.pointerY * focus * 3.5;
        const rotateY = compact
          ? -delta * 5
          : -direction * (distance > 0.2 ? 14 + Math.min(distance, 3) * 5 : 0) + s.pointerX * focus * 3;
        const rotateZ = compact ? delta * -1.4 : delta * 0.7;

        card.style.setProperty("--focus", focus.toFixed(4));
        card.style.zIndex = String(Math.round(1000 - distance * 100));
        card.style.opacity = String(Math.max(0.13, side * 0.76 + focus * 0.24));
        card.style.pointerEvents = distance < 1.2 ? "auto" : "none";
        card.style.filter = `blur(${Math.max(0, distance - 1.5) * 0.38}px)`;
        card.style.transform = [
          "translate(-50%, -50%)",
          `translate3d(${x.toFixed(2)}px, ${y.toFixed(2)}px, ${z.toFixed(2)}px)`,
          `rotateX(${rotateX.toFixed(2)}deg)`,
          `rotateY(${rotateY.toFixed(2)}deg)`,
          `rotateZ(${rotateZ.toFixed(2)}deg)`,
          `scale(${scale.toFixed(4)})`,
        ].join(" ");
        card.setAttribute("aria-current", index === activeIndex ? "true" : "false");
      }

      // Only commit the playing set when it actually changes, so React does not
      // re-render 100 cards sixty times a second.
      const previous = playingRef.current;
      if (shouldPlay.size !== previous.size || [...shouldPlay].some((i) => !previous.has(i))) {
        playingRef.current = shouldPlay;
        setPlaying(shouldPlay);
      }
      if (activeIndex !== lastActive.current) {
        lastActive.current = activeIndex;
        commit(activeIndex);
      }

      s.raf = requestAnimationFrame(render);
    }

    const lastActive = { current: -1 };
    anim.current.raf = requestAnimationFrame(render);

    stage.addEventListener("pointermove", onPointerMove);
    stage.addEventListener("pointerleave", onPointerLeave);
    stage.addEventListener("wheel", onWheel, { passive: false });
    window.addEventListener("keydown", onKey);

    return () => {
      if (anim.current.raf) cancelAnimationFrame(anim.current.raf);
      anim.current.raf = 0;
      stage.removeEventListener("pointermove", onPointerMove);
      stage.removeEventListener("pointerleave", onPointerLeave);
      stage.removeEventListener("wheel", onWheel);
      window.removeEventListener("keydown", onKey);
      onScroll?.disconnect();
    };
  }, [count, step]);

  /* ----------------------------------------------------------------- view -- */

  return (
    <div
      className="fs"
      ref={stageRef}
      role="group"
      aria-roledescription="carousel"
      aria-label="100 famous places, a rotating filmstrip. Use the arrow keys to browse."
    >
      <p className="fs__label">Around the world</p>
      <p className="fs__count" aria-live="off">
        {String(active + 1).padStart(3, "0")} / {count}
      </p>

      <div className="fs__deck" ref={deckRef}>
        {places.map((place, index) => (
          <button
            key={place.name}
            type="button"
            className="fs-card"
            ref={(node) => {
              cardRefs.current[index] = node;
            }}
            onClick={() => moveTo(index)}
            onFocus={() => moveTo(index)}
            aria-label={`${place.name}, ${place.country}. ${place.fromLonelyPlanet ? "Lonely Planet 2027 pick." : ""}`}
          >
            <span className="fs-card__frame">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                className="fs-card__img"
                src={place.image}
                alt=""
                loading={index < 8 ? "eager" : "lazy"}
                decoding="async"
                draggable={false}
              />
              {playing.has(index) && place.video && (
                // eslint-disable-next-line jsx-a11y/media-has-caption
                <video
                  className="fs-card__video"
                  key={frameRef.current}
                  src={place.video}
                  autoPlay
                  muted
                  loop
                  playsInline
                  preload="auto"
                />
              )}
            </span>
            {place.meta && (
              <span className="fs-card__credit">
                {place.meta.author.slice(0, 44)} · {place.meta.licence}
              </span>
            )}
            {/* One index badge, inside the footer. The source bundle also had a
                second .fs-card__idx as a direct child of the button; with no
                positioning on it that badge landed in normal flow and floated
                outside the card, so it is not reproduced here. */}
            <span className="fs-card__foot">
              <span className="fs-card__idx" aria-hidden="true">
                {String(index + 1).padStart(2, "0")}
              </span>
              <span className="fs-card__meta">
                <span className="fs-card__name">{place.name}</span>
                <span className="fs-card__role">{place.country}</span>
              </span>
            </span>
          </button>
        ))}
      </div>

      <div className="fs__regions" role="group" aria-label="Jump to a region">
        <button
          type="button"
          className="fs__region"
          aria-pressed={region === null}
          onClick={() => focusRegion(null)}
        >
          All
        </button>
        {REGION_ORDER.map((name) => {
          const total = places.filter((p) => p.region === name).length;
          return (
            <button
              key={name}
              type="button"
              className="fs__region"
              aria-pressed={region === name}
              onClick={() => focusRegion(name)}
            >
              {name} {total}
            </button>
          );
        })}
      </div>

      <p className="fs__hint">drag · scroll · arrow keys</p>
      <p className="fs__sr">
        Currently showing {places[active]?.name}, {places[active]?.country}, card{" "}
        {active + 1} of {count}.
      </p>
    </div>
  );
}
