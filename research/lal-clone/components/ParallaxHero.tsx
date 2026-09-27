"use client";

import Image from "next/image";
import { useEffect, useRef } from "react";
import gsap from "gsap";
import { ScrollTrigger } from "gsap/ScrollTrigger";

/**
 * The landing hero: three stacked layers of artwork that separate as the page
 * scrolls, with the search that the whole site is built around sitting on top.
 *
 * Layer depths and the artwork are lifted from an Osmo-supplied snippet, so the
 * attribution at the foot is a licence condition rather than decoration. What
 * changed is everything this app has an opinion about.
 *
 * Four deliberate departures from the source snippet:
 *
 * 1. No Lenis. The snippet smooth-scrolls the entire document, but this app
 *    mounts a Cesium globe and a MapLibre canvas on sibling routes, both of
 *    which want the wheel for zoom and camera control. Lenis captures `wheel`
 *    globally and takes it from them. ScrollTrigger scrubs correctly against
 *    native scroll, so the effect is unchanged and the dependency is not taken.
 *
 * 2. Scoped teardown. The snippet calls `ScrollTrigger.getAll().forEach(kill)`,
 *    which reaches outside this component and kills triggers it does not own --
 *    including the ones the filmstrip and the globe set up. We hold the context
 *    we created and revert only that.
 *
 * 3. `prefers-reduced-motion` is honoured. Scroll-linked movement is precisely
 *    the vestibular trigger that setting exists to suppress, so skipping the
 *    timeline is not a degraded mode here, it is the correct one. The layers
 *    still paint; they just do not move.
 *
 * 4. The artwork is served from this app's own `public/`, not hotlinked from
 *    the CDN the snippet points at. A deploy should not depend on a third party
 *    staying up, and the bytes are committed so the build is reproducible.
 */

/** Intrinsic size of every asset in `public/parallax`. */
const LAYER_W = 2000;
const LAYER_H = 1906;

/**
 * Travel per layer, in percent of the layer's own height, ordered so the opaque
 * base moves furthest and the near overlay least, which is what reads as depth.
 * The values are the snippet's; they are tuned to this artwork and changing
 * them without looking would be guesswork.
 */
const LAYERS = [
  { layer: "1", travel: 70 },
  { layer: "2", travel: 55 },
  { layer: "4", travel: 10 },
] as const;

/**
 * `yPercent` is a percentage of the layer's own height, and a layer sized to the
 * hero has no headroom to move into -- translate one and it tears open along the
 * top edge, showing the page behind. Scaling each layer about its bottom edge
 * buys `scale - 1` of overscan, so the requirement is `scale - 1 >= travel/100`.
 * The margin absorbs subpixel rounding at fractional viewport heights.
 */
function scaleFor(travel: number) {
  return 1 + travel / 100 + 0.1;
}

export function ParallaxHero() {
  const rootRef = useRef<HTMLElement>(null);

  /* The stage is a full viewport tall, but the header sits above it and the
     header is not a fixed height -- it is derived from a wrapping row, and the
     stylesheet's own comment notes that changing a padding there moves it from
     124 to 117. At 124 the search field, which is the one thing this page
     exists to offer, sat half under the fold; below 700px the header wraps and
     ate 200px, which pushed it entirely under.

     So the height is measured rather than hard-coded, and CSS subtracts it. The
     124px in the stylesheet is only a pre-paint fallback; this is the value
     that counts. It re-reads on resize because the header's wrap points move
     with the viewport. */
  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;

    const header = document.querySelector<HTMLElement>(".lal-header");
    const sync = () => {
      root.style.setProperty(
        "--lal-parallax-inset",
        `${header?.offsetHeight ?? 0}px`,
      );
    };

    sync();
    window.addEventListener("resize", sync);
    return () => window.removeEventListener("resize", sync);
  }, []);

  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;

    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;

    // Registered once per module, not per mount: ScrollTrigger keeps a global
    // plugin registry and re-registering on every mount is wasted work.
    gsap.registerPlugin(ScrollTrigger);

    const context = gsap.context(() => {
      const timeline = gsap.timeline({
        scrollTrigger: {
          trigger: root,
          start: "0% 0%",
          // One viewport of travel. The hero is the first screen, so by the time
          // the timeline completes the layers have scrolled away and the city
          // picker has taken the stage.
          end: "100% 0%",
          // Scrubbed, not eased. The layers are bound to scroll position, so any
          // smoothing here reads as input lag on the surface the visitor is
          // already trying to aim at.
          scrub: true,
        },
      });

      for (const [index, { layer, travel }] of LAYERS.entries()) {
        timeline.to(
          root.querySelectorAll(`[data-parallax-layer="${layer}"]`),
          {
            yPercent: travel,
            scale: scaleFor(travel),
            transformOrigin: "50% 100%",
            ease: "none",
          },
          index === 0 ? undefined : "<",
        );
      }
    }, root);

    return () => context.revert();
  }, []);

  return (
    <section ref={rootRef} className="lal-parallax" aria-labelledby="lal-parallax-title">
      <div className="lal-parallax__stage">
        <div className="lal-parallax__layers">
          <Image
            data-parallax-layer="1"
            src="/parallax/layer-1.webp"
            alt=""
            width={LAYER_W}
            height={LAYER_H}
            priority
            sizes="100vw"
            className="lal-parallax__img"
          />
          <Image
            data-parallax-layer="2"
            src="/parallax/layer-2.webp"
            alt=""
            width={LAYER_W}
            height={LAYER_H}
            sizes="100vw"
            className="lal-parallax__img"
          />
          {/*
            Layer 4 sits before the copy, not after it as it does in the source
            snippet. These are absolutely positioned siblings, so DOM order is
            paint order: with the image last it covered the text outright. Depth
            here is the transform, not the markup order, so moving it earlier
            costs the effect nothing.
          */}
          <Image
            data-parallax-layer="4"
            src="/parallax/layer-4.webp"
            alt=""
            width={LAYER_W}
            height={LAYER_H}
            sizes="100vw"
            className="lal-parallax__img"
          />

          {/*
            Dissolves the artwork into the page background so the hero has no hard
            bottom edge. It sits over the images and under the copy: pinned over
            the whole hero it also sat over the text, and because its last stop
            is fully opaque it was quietly greying the headline out.
          */}
          <div className="lal-parallax__fade" aria-hidden />

          {/*
            The copy band. Its gradient ramps to solid `--lal-bg` before the first
            line of type, so the text lands on the same surface as the rest of the
            page instead of on an arbitrary photograph -- a mid-tone snowfield
            under the ink colour measures nowhere near the contrast the heading
            needs, and no token-pair linter can see that, because ink over a
            photograph is not a pair it can resolve.

            The ramp is measured in px and its length is tied to the band's own
            top padding, so it still clears the text when the heading reflows
            from three lines on a phone to one on a desktop.
          */}
          <div className="lal-parallax__copy">
            <p className="lal-parallax__eyebrow">SEE A CITY LIKE A LOCAL</p>
            <h1 className="lal-parallax__title" id="lal-parallax-title">
              Find the places locals love
            </h1>
            <p className="lal-parallax__desc">
              Skip the tourist traps. Start with a city and get straight to the
              cafés, bars, culture and hidden gems that locals swear by.
            </p>

            <div className="lal-search__wrap">
              <form className="lal-search" action="/cities" method="get" role="search">
                <input
                  className="lal-search__input"
                  type="search"
                  name="q"
                  placeholder="Enter City Name"
                  aria-label="Enter City Name"
                />
                <button type="submit" className="lal-search__submit" aria-label="Search">
                  <svg width="16" height="16" viewBox="0 0 512 512" aria-hidden="true" fill="currentColor">
                    <path d="M505 442.7L405.3 343c-4.5-4.5-10.6-7-17-7H372c27.6-35.3 44-79.7 44-128C416 93.1 322.9 0 208 0S0 93.1 0 208s93.1 208 208 208c48.3 0 92.7-16.4 128-44v16.3c0 6.4 2.5 12.5 7 17l99.7 99.7c9.4 9.4 24.6 9.4 33.9 0l28.3-28.3c9.4-9.4 9.4-24.6.1-34zM208 336c-70.7 0-128-57.2-128-128 0-70.7 57.2-128 128-128s128 57.3 128 128-57.3 128-128 128z" />
                  </svg>
                </button>
              </form>
            </div>

            <p className="lal-parallax__hint">
              Try &ldquo;Lisbon&rdquo;, &ldquo;London&rdquo;, &ldquo;New York City&rdquo; or
              &ldquo;Paris&rdquo;
            </p>
          </div>
        </div>
      </div>

      {/*
        Attribution. The snippet this came from is licensed to Osmo and the three
        layers are their artwork, so this line is a condition of use. It also
        keeps the provenance honest next to imagery nobody on this project
        commissioned.
      */}
      <p className="lal-parallax__credit">
        Hero artwork by{" "}
        <a href="https://www.osmo.supply/" target="_blank" rel="noreferrer noopener">
          Osmo
        </a>
      </p>
    </section>
  );
}
