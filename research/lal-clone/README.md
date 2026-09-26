# Like a Local Guide — frontend clone

A pixel-measured rebuild of **likealocalguide.com**, captured rather than
eyeballed. It is **reference material, not product surface**: nothing in the
TravelBuddy app imports it, and it lives under `research/` so `theme:lint`
never sees it.

```bash
npm install          # only needed for the tools/ scripts (playwright)
npm run dev          # http://localhost:4310
npm run typecheck
npm run build

LAL_FONTS=system npm run dev   # see "The font problem" below — read it first
```

---

## What "exact" means here, measured

`tools/verify.mjs` compares the border box of 56 named elements between the live
site and this build. At 1440×900:

| | differing elements |
|---|---|
| 1440 | **3** — and all three are the container's own edge, not its content |
| 1024 | 27 — ±1px cascade, plus a 2px panel width from the original's own fractional maths |
| 390 | 55 — same 1px cascade; widths and x-positions exact |

The 1px cascade at narrow widths comes from the logo: a 500×178 AVIF at 190px
wide is 67.68px, and the original rounds it one way and this build the other.
Every element below the header inherits that single pixel.

The 3 remaining rows at 1440 are `.lal-header__inner`, `.lal-hero__inner` and
`.lal-cities__inner`: 1220px wide here against 1200px there, because this
build puts the reference's 10px inset on the container itself rather than on a
wrapper around it. **Every child of those three measures identically** — the
difference is where the box edge is drawn, not where anything sits.

---

## The font problem — read before "fixing" the type

**The live site serves no webfonts.** It declares `Fraunces` and `Inter` and
ships no `@font-face` for either, and no Google Fonts request. Verified on the
live page: canvas measurement of `"Fresh local tips"` at 600/30px returns the
same `194.44px` for `Fraunces, Georgia, serif`, `serif` and `Georgia`, and
`document.fonts` lists only Font Awesome and an icon font.

Worse, Elementor writes the display family as `"Fraunces", **Sans-serif**`. So
with Fraunces unavailable the site's headings render in the body **sans**, and
its intended display serif never appears on screen at all. Confirmed by
measurement: the live h1 is 659px wide, identical under `sans-serif`, `Arial`,
`Helvetica`, `Roboto` and `Inter/sans-serif`, against 575px for Georgia and
769px for DejaVu Serif.

So the live pixels and the actual design do not match, and a faithful clone has
to choose. Both are one flag apart:

| mode | what you get |
|---|---|
| **default** | real Fraunces + Inter, self-hosted by `next/font`. This is the design. Headings measure wider and two paragraphs gain a line. |
| `LAL_FONTS=system` | drops to the same fallback the live site gets, reproducing its exact metrics. Set this to bug-for-bug the current rendering. |

Both modes have identical geometry. Only glyph widths change.

---

## The pipeline

The screenshot is the least useful artefact. This is what produced the clone:

```bash
# 1. capture: screenshots + computed styles + the page's own CSS
node tools/capture.mjs https://likealocalguide.com/ /tmp/lal-ref

# 2. build against those numbers

# 3. verify: measure the rebuild against the live site, exit 1 on any delta
node tools/verify.mjs https://likealocalguide.com/ http://localhost:4310/ tools/pairs.json 1440
```

`capture.mjs` writes, per route: a full-page desktop and mobile PNG, a JSON
probe of every visible element's computed style and border box, the DOM
outline, every inline `<style>` block, and every linked stylesheet. The probe is
the part that matters — it records `min-height`, `grid-template-columns`,
`aspect-ratio`, the exact `getComputedStyle` of every box, which is how the
following were recovered rather than guessed:

- The city panel is **not** capped at 1104px. Elementor sets `--width: 92%` from
  768px up, and 92% of 1200 happens to be 1104. At 1024 the same 92% gives 885.
- The hero is a 20px-guttered box containing a wrapper with 10px of inset
  containing a 1200px inner. Collapsing those layers puts everything 20px right
  of where it belongs while looking perfectly centred.
- The header is 124px tall because the right-hand group carries 10px of padding,
  not because of anything on the logo.
- The footer's nav row is 496px because each link has `padding: 20px 10px`
  **and** `margin: 0 10px`. With only the padding, a flex row shrink-wraps to
  396px.
- A centred heading in Elementor is `width: fit-content` with auto margins, not
  a full-width block with `text-align: center`. The footer title is 196px wide,
  not 1200px, and a screenshot cannot tell you which it is.

### Things that look like bugs and are not

Each of these cost a round of measurement to identify, and each is commented at
the point it appears in `app/globals.css`:

- **`.lal-fit` is declared last in the file, and has to stay there.** It is
  `width: fit-content; margin-inline: auto`, and every component rule below it
  uses a `margin` shorthand that would otherwise win.
- **The tip card body is not `flex: 1`.** The grid row stretches the card and
  leaves the slack below the body. Stretching the body instead added 21px to
  every card and made the section 21px taller.
- **The footer fine print is `width: max-content`, not 939px.** The reference
  box is the sentence's own width, 939.109px. Rounding it to 939 wraps the last
  word onto a second line.
- **The Explore Guides button sits 4px above the vertical centre of its row.**
  It is an `inline-block`, so the parent's 26.4px line box adds a descender
  under it; the reference centres the 53px wrapper, not the 45px button.
- **The hero does not shrink its type on mobile.** At 390 the original still
  runs a 52px h1 and a 19px lede and simply wraps to three lines. Reducing the
  font — the reflex — produces a page 453px shorter than the original.

---

## Layout

Routes: `/`, `/cities`, `/[slug]`, `/blog`, `/blog/[slug]`, `/about`,
`/contact`, `/partners`, `/social-impact`.

- `app/globals.css` — the whole design system: tokens, primitives, the
  responsive layer, and the font-mode switch. One file, because a design system
  split across files is a design system nobody can hold in their head.
- `components/` — `Header`, `Footer`, `Hero`, `CityPicker`, `Sections`.
- `lib/data.ts` — cities, tips and copy.
- `public/` — the site's images, downloaded rather than hotlinked.

No Tailwind. The values came from `getComputedStyle`, and reproducing them in
arbitrary-value utilities would have been more typing and less legible than the
declarations they came from.

## Known gaps

- The three container-box edges at 1440 (see above).
- The mobile nav is `display: none` behind its toggle; the original keeps the
  panel off-canvas at `x: 420`. Same result, different mechanism, so the
  off-canvas panel measures as 0×0 here.
- The 1px header rounding at ≤1024, inherited by everything below it.
- Interior pages were built from the same design system and the captured
  screenshots, not measured element-by-element. The home page is the one that
  was verified to zero.
