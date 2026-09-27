# Risk register

Checked and not fixed, or deliberately left. Written so the next person does not
have to re-derive it, and so that accepting a risk is a decision somebody made
rather than an oversight.

Each entry says what was verified and how. A risk note with no evidence is a
rumour.

**BLOCKER** cannot launch. **FIX BEFORE LAUNCH** will be visible or unlawful.
**ACCEPT** documented and consciously left.

---

## The thing to settle first

`package.json` described this project as "Pixel-faithful frontend clone of
likealocalguide.com". The code is a reproduction of a real commercial website
that belongs to a real business, carrying that business's:

- trademark (`public/lal-logo.avif`, 9,741 bytes, rendered at
  `components/Header.tsx:19`)
- live customer email addresses (`app/contact/page.tsx:12-14` —
  `hello@`, `partners@` and `press@@likealocalguide.com`, wired to `mailto:`)
- pricing and commercial terms (`app/partners/page.tsx`)
- affiliate arrangements (`components/Footer.tsx` — Stay22)
- 237 image files under `public/`

Nobody on this project has stated, in any commit or in conversation, that this is
our company to build. **Everything below is scoped on the assumption that it is
not.** If it is, this file is out of date in a good way and the remaining
technical items still stand.

The two items that are hardest to fix and are not about law:

**1. A fabricated endorsement of a real third party, in an `aria-label`.**
`components/CountryFilmstrip.tsx:449`:

```tsx
aria-label={`${place.name}, ${place.country}. ${place.fromLonelyPlanet ? "Lonely Planet 2027 pick." : ""}`}
```

`fromLonelyPlanet` is set on entries sourced from Lonely Planet's 2027 list, and
the imagery on those cards is a Wikimedia Commons search result rather than
anything connected to that list. So this announces a press endorsement that was
never given, about places that were never picked, to screen-reader users
specifically. `app/blog/[slug]/page.tsx` also claims a verification methodology
— "someone on the team went, paid, and went back a second time" — across 160
scraped posts.

**2. `app/about/page.tsx` says "no pay-to-play listings" and has no no-ranking-bought
line, while `app/partners/page.tsx` sells placement at $500/yr for major cities.**
Two pages of the same site making directly contradictory claims about the same
thing.

Fixing 1 and 2 costs nothing and the site is strictly more credible without them.
They are listed as FIX BEFORE LAUNCH rather than done here because they are
copy decisions about a business I cannot make.

---

## BLOCKER 3 — the operator of this site is not named anywhere

`lib/business.ts` ships `legalName`, `registeredAddress`, `jurisdiction` and
`privacyEmail` as `null`.

**Verified:** the rendered HTML of `/privacy`, `/terms` and `/cookies` each
contain "This document is a draft" and "Not filled in". `components/Footer.tsx`
shows "Not yet stated" on every page. The gap is visible, not silent.

**Why it blocks.** DPDP Act 2023 §5(1) requires a Data Fiduciary to publish its
name and the contact details of its Data Fiduciary and Data Processor; §5(4)
makes that a condition of processing. This site requests tiles from a third-party
server, so it is processing personal data and is inside the Act.

**To fix:** fill in the four nulls in `lib/business.ts`. Every page and the footer
read from that one object; `missingOperatorDetails()` returns empty and the draft
markers disappear on their own. Run `npm run check:consent` to confirm.

**Do not** invent a company name, postal address or registration number to make
this go away. `lib/business.ts` exists precisely so that is a deliberate,
visible act rather than something that happens by typing.

---

## BLOCKER 4 — 237 images with no licence record

**Verified:** 237 image files under `public/`. `lib/content.ts` (as it stood when
the clone was assembled) records that CDN URLs were rewritten to local `/content/`
paths — i.e. the files were taken from likealocalguide.com's own CDN.

`public/globe/earth-blue-marble.jpg` is the exception and is correctly attributed
in `public/globe/ATTRIBUTION.txt` (NASA, public domain).

**Why it blocks.** If any of these are under a licence requiring attribution,
that attribution is missing. If any are the property of photographers, they are
being republished without permission.

**To fix:** an audit of `public/` before launch, not after. Either record a
licence per file the way `place-images.json` did for the Wikimedia set, or
replace with images whose licence permits this use. This is the one item here
that scales with effort rather than shrinking with it.

---

## FIX BEFORE LAUNCH 5 — third-party embeds and runtime requests

**Verified:**

| Where | What | Third party? |
|---|---|---|
| `components/WorldGlobe.tsx:282` | `tile.openstreetmap.org` raster tiles | **Yes** — now gated |
| `components/WorldGlobe.tsx:17` | `NEXT_PUBLIC_CESIUM_ION_TOKEN` satellite imagery, if set | **Yes** — not gated separately |
| `app/layout.tsx:2` | `next/font/google` (Fraunces, Inter) | No — build-time, self-hosted |
| `app/contact/page.tsx` `<form action="#">` | posts nowhere | No |

**Handled in this pass.** The OSM tile request is now withheld until the visitor
answers the consent prompt, by gating the Cesium import itself in
`WorldGlobe.tsx` rather than covering a live globe with an overlay — an overlay
would have let the tiles go out, carrying the IP address, before anybody was
asked. `/cookies` names the request and the recipient. `npm run check:consent`
asserts that undecided is not granted.

**Residual.** The ion path is a different provider with its own terms, and the
gate treats it as the same "map" category. If a token is ever set, `/cookies`
needs a second row.

**No `<iframe>` and no `next/script` anywhere.** No Google Maps, YouTube, X,
Instagram, Facebook, Stripe, tag manager, analytics or session-replay tag. The
tile request was the only one.

---

## FIX BEFORE LAUNCH 6 — accessibility defects that survived the restructure

**Verified in the current tree:**

- `components/Sections.tsx:10`, `components/Interior.tsx:41`,
  `components/CountryFilmstrip.tsx:426` — `alt=""` on content images, 7
  occurrences in total. An empty alt on a photograph hides it from a screen
  reader entirely.
- `components/CityPicker.tsx:10,31`, `components/Interior.tsx:112` — imagery in
  `background-image` with no `role="img"` and no `aria-label`. Same result: no
  accessible name, and nothing to fix it with.
- `components/CountryFilmstrip.tsx:431-443` — autoplaying muted video with an
  explicit `jsx-a11y/media-has-caption` disable. Silent video is inaccessible by
  definition.
- `components/Header.tsx:17` — a hamburger button carrying only
  `aria-label="Footer menu"`-style text and a `&#9776;` entity, with no
  `aria-expanded` and no `aria-controls`. A screen-reader user cannot tell whether
  the menu is open.

**Not fixed here.** These are in the pixel-matched components, and changing them
changes the measured output. That is a real trade-off, not a reason to skip it —
but it is a design decision, and it should be made deliberately rather than
inherited.

**Forms.** `app/contact/page.tsx` is the one form and it is already correct:
every input has a real `<label htmlFor>`, and `autoComplete` is set per field.
The form has no backend, which is stated plainly in the privacy policy rather
than left for a visitor to discover.

---

## FIX BEFORE LAUNCH 7 — unsubstantiated claims in the copy

**Verified:**

- `app/layout.tsx:35` — "Skip the tourist traps... hidden gems that locals swear
  by." Nobody has counted anything, so nothing here has been measured.
- `components/Footer.tsx` — "We only recommend places we genuinely love."
- `app/about/page.tsx` — "award-winning local tours", "no pay-to-play listings",
  "no ranking bought by a bigger advertiser" (contradicted by `app/partners`).
- `app/blog/[slug]/page.tsx` — "Someone on the team went, paid, and went back a
  second time."

None of these are things the codebase can support. `/terms` now says plainly that
listings are not verified and that claims about a place's character are the
author's opinion. The remaining fix is on the pages themselves, and it is copy
editing against a business I cannot see.

---

## FIX BEFORE LAUNCH 8 — the contact form is inert

**Verified:** `app/contact/page.tsx`, `<form className="g-form" action="#">` with a
`<button type="submit">`. There is no server action, no route handler and no
`public/` backend, so submitting reloads the page and sends nothing.

The page says "We read every message." That is not currently true of this
implementation.

`/privacy` states the form goes nowhere rather than implying a working contact
channel, which is the honest version. Either wire a form handler or change the
copy — the current state is the one combination that is wrong.

---

## FIX BEFORE LAUNCH 9 — colour contrast was never checked

There is no contrast check in this repository, and no token layer in the
`--lal-*` style. The palette is hand-measured from screenshots of another site,
which tells you what it looked like there and nothing about whether it passes
WCAG AA here.

**To fix:** a contrast pass over the `--lal-*` tokens. Known starting suspects,
because they are the ones most likely to have been matched by eye against a
screenshot:

| Token | Value | Concern |
|---|---|---|
| `--lal-ink-3` | `#7a6e71` | mid grey on `#fff`, likely under 4.5:1 |
| `--lal-ink-4` | `#6f6467` | as above |
| `--lal-ink-5` | `#a89ea1` | very light grey, almost certainly under 4.5:1 |
| `--lal-accent` | `#b833ab` | magenta on white, check both directions |

`--lal-ink-3` and `--lal-ink-5` are used for body-adjacent text in the new legal
styles, so this is a live issue in code added here, not only inherited.

---

## ACCEPT 10 — no accounts, and that is the right call

There is no sign-in, no account, no session and no server-side record of a
visitor. The former TravelBuddy app in this repository *did* have better-auth
wired up, and it was removed with the rest of that tree.

For a static editorial site this is better, not worse: there is no credential to
breach, no personal data to request, and §11–17 of the DPDP Act is satisfied
mostly by having nothing to hand over. `/privacy` says so rather than implying
capabilities the site lacks.

The cost is that there is no saved plan, no cross-device continuity and no way
to contact a reader except the inert form above. Both are product decisions, not
compliance ones.

---

## Verified clean, recorded so it is not re-litigated

- **Dead legal links.** `components/Footer.tsx` linked "Privacy Policy", "Terms &
  Conditions" and "Small Business Toolkit" all at `href="/"`. A visitor clicking
  a link labelled with a document's name got the homepage. All four now point at
  real routes, and the prerendered HTML is asserted to contain zero
  `href="/"` legal links.
- **Legal pages render.** `/privacy`, `/terms` and `/cookies` prerender to
  ~30 kB each with the operator block, the draft marker and the OpenStreetMap
  attribution present.
- **The globe tile request.** Verified reachable and serving real content
  directly, and now gated. `WorldGlobe.tsx` also documents that CARTO's
  `dark_all` basemap returns HTTP 200 with an "API KEY REQUIRED" watermark baked
  into the image, which is why OSM is used instead — worth keeping, because the
  failure is silent.
- **`next/font/google` is not a runtime third-party request.** Fraunces and Inter
  are fetched at build time and self-hosted; the layout comment already says so.
- **The consent record.** One localStorage key holding a version number and a
  boolean. No identifier, no timestamp, no IP, nothing server-side. It cannot be
  used to single a visitor out, which is the property that makes "we keep no
  personal data" true here rather than approximately true.
