import { CityPicker } from "../components/CityPicker";
import { ParallaxHero } from "../components/ParallaxHero";
import { Promise, Tips } from "../components/Sections";

export default function HomePage() {
  return (
    <>
      <ParallaxHero />
      <CityPicker />
      {/* The 100-place filmstrip used to sit here, between the city picker and
          the advice sections. It is on /partners now, and the reason is
          measurable rather than aesthetic: tools/verify.mjs compares the border
          box of 56 named elements against likealocalguide.com, and the strip
          cost 26 of this page's 56. A 100-card rotating carousel is not part of
          the page being cloned, so on the page being cloned it can only be
          wrong.

          The strip earns its place on /partners, where the sub-headline claims
          "100+ cities" and the strip is the proof of that claim. The globe is
          still one tap away here via /cities. */}
      <Promise />
      <Tips />
    </>
  );
}
