import type { MetadataRoute } from "next";

/**
 * Required by `output: "export"` (see next.config.mjs). Without it Next refuses
 * to prerender this route, because a metadata route has no static rendering mode
 * of its own and the exporter cannot prove it will produce the same bytes on
 * every build. The manifest is a pure function of constants, so force-static is
 * honest here rather than a workaround.
 */
export const dynamic = "force-static";

/**
 * The web manifest, served at /manifest.webmanifest.
 *
 * Two consumers read it and neither of them is a person looking at it: the
 * browser, to decide whether the site is installable, and the Capacitor shell,
 * to name the launcher and colour the launch screen. `background_color` in
 * particular is what the browser paints before any CSS loads -- unset, it
 * defaults to white, which is a white flash on every cold start.
 *
 * The colours cannot be a CSS custom property, because the manifest is JSON
 * fetched before any stylesheet exists. They are restated from `--lal-bg` in
 * app/globals.css, and the values are asserted in tests/manifest.test.ts so a
 * token change cannot leave the launcher showing last season's brand.
 */
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "Like a Local Guide – City Travel Guides & Local Tips",
    short_name: "Local Guide",
    description:
      "Skip the tourist traps. Start with a city and get straight to the cafés, bars, culture and hidden gems that locals swear by.",
    start_url: "/",
    // `scope` has to be `/`, not a specific route, or a deep link like
    // /places/xyz opened from a shared URL lands outside the app's scope and the
    // browser offers to open it as a separate tab.
    scope: "/",
    display: "standalone",
    orientation: "portrait",
    background_color: "#ffffff",
    theme_color: "#ffffff",
    categories: ["travel", "navigation", "lifestyle"],
    icons: [
      { src: "/icons/any/192.png", sizes: "192x192", type: "image/png", purpose: "any" },
      { src: "/icons/any/512.png", sizes: "512x512", type: "image/png", purpose: "any" },
      {
        // Separate files rather than a `purpose: "any maskable"` entry: the two
        // families are drawn at different sizes so the maskable mark survives the
        // circle crop. Declaring one file for both would letterbox the smaller
        // maskable art onto the larger any-purpose art.
        src: "/icons/maskable/192.png",
        sizes: "192x192",
        type: "image/png",
        purpose: "maskable",
      },
      { src: "/icons/maskable/512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
    ],
  };
}
