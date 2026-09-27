# Like a Local Guide

A pixel-measured rebuild of **likealocalguide.com**, captured rather than
eyeballed. Every measurement in this README was read off the live site with
`getComputedStyle` and the site's own stylesheets, not eyeballed off a
screenshot.

This was built at `research/lal-clone/` inside a larger monorepo, as reference
material for a different app. That app has been removed and this is now the
repository: the clone *is* the project, not a study of one.

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

## The world filmstrip

`components/CountryFilmstrip.tsx` is a band of 100 famous places on a
continuously rotating 3D strip, mounted full-bleed on the home page between the
city picker and the promise row. It is a React port of a `character-filmstrip`
shader bundle; the projection maths is carried over unchanged because it is what
produces the depth, and three things around it are not.

**It is not an iframe.** The source bundle renders into a sandboxed `srcdoc`
iframe, which is right for a third-party preview and wrong here — it would put
100 images behind an opaque origin and make focus-driven loading harder for no
benefit.

**Transform writes are culled.** Writing eight style properties on 100 nodes
every frame is ~800 layout-affecting writes per frame and it drops frames on a
mid-range laptop. Cards beyond `DRAW_WINDOW` keep their last transform and are
skipped, turning ~800 writes per frame into ~140. Measured on the real page:
15 of 100 cards are being written at any moment.

**Only focused cards mount video.** 100 autoplaying drone clips is 7–11 MB
each, so ~900 MB decoding at once, and it is unusable on a phone. Every card
renders a compressed still; a `<video>` is mounted only inside `FOCUS_WINDOW`
of centre and unmounted on exit. The focused card is always the one playing, so
the rotating-footage look survives.

### The data

- `data/places.ts` — 100 places, 59 countries, 8 of them in India. The
  ordering is a deliberate world tour that closes on itself: it ends in the
  Polar region and restarts in Europe, so the wrap does not jump the Pacific
  backwards. `query` is a Wikimedia search term, not a filename.
- `data/place-images.json` — one record per place: downloaded path, author,
  licence, Commons page. **Most of this imagery is CC BY-SA, which requires
  naming the author.** The card credit is not decorative and must not be
  removed for a cleaner card.
- `public/places/` — the 100 images, ~8.7 MB total, ~88 KB average.
- `data/place-videos.json` — currently `{}`. See below.

### Adding video

`place-videos.json` is keyed by the same id as the image file — a slug of the
place name — and the component reads `VIDEOS[id]?.src`. Populate it and the
focus window mounts the clip; leave it empty and the card falls back to the
still with a slow drift so it never looks broken. The intended shape:

```json
{
  "lisbon": {
    "src": "/places/lisbon.mp4",
    "provider": "pexels",
    "licence": "Pexels licence",
    "title": "Aerial view of the Tagus"
  }
}
```

No clips are committed. The only footage measured for this set was the source
site's own video, which is not ours to license, so every clip still has to be
sourced. Two things to know before wiring a provider in:

- Ship **H.264/MP4**. That is the format Safari and iOS require, and it is the
  only sane production choice. It cannot be verified in Playwright's bundled
  Chromium, which ships without proprietary codecs and fails such a file with
  `error 4` / `networkState 3` — a harness limitation, not a bug in the
  component. Verify codec playback in a real browser, or add a VP9/WebM
  `<source>` alongside the MP4.
- Whatever provider is used must be free-to-use and must be recorded per clip.
  The image pipeline is a model for this: fetch with a tool, store the licence
  with the asset, never hotlink.

---

## Layout

Routes: `/`, `/cities`, `/[slug]`, `/blog`, `/blog/[slug]`, `/about`,
`/contact`, `/partners`, `/plan`.

`/plan` replaced `/social-impact`. The trip planner is a different product from
the rest of this one and is not measured against the live site — see
[The trip planner](#the-trip-planner) below.

- `app/globals.css` — the whole design system: tokens, primitives, the
  responsive layer, and the font-mode switch. One file, because a design system
  split across files is a design system nobody can hold in their head.
- `app/interior.css` — the directory and editorial interior system.
- `app/filmstrip.css` — the world filmstrip, isolated because it is the only
  band that is genuinely full-bleed and the only one not built from
  `.lal-box`.
- `app/plan.css` — the trip planner, in its own `--lp-*` / `.lp-*` namespace so
  it cannot move anything `tools/verify.mjs` measures.
- `components/` — `Header`, `Footer`, `Hero`, `CityPicker`, `Sections`,
  `CountryFilmstrip`, `Interior`.
- `lib/data.ts` — cities, tips and copy.
- `public/` — the site's images, downloaded rather than hotlinked.

No Tailwind. The values came from `getComputedStyle`, and reproducing them in
arbitrary-value utilities would have been more typing and less legible than the
declarations they came from.

## The trip planner

`/plan` is a route planner in the shape Furkot uses: a plan drawer on the left,
a map in the middle, and the directory's `Find` / `Sleep` / `Eat` drawers on the
right. Add places, drop pins, set a daily driving limit, and the itinerary splits
itself into days.

```bash
npm run check:plan   # 49 rule assertions, no browser
npm run smoke:plan   # 57 browser assertions, needs a dev or start server
```

### Three decisions that shape everything else

**Every distance is either routed or labelled.** Road geometry comes from the
OSRM demo server. When it cannot be reached — it is a shared free service and it
rate-limits — the leg falls back to a straight-line estimate and says so, on the
leg, in the totals, and on the map, where estimated legs are drawn dashed rather
than solid. A planner that showed a straight line as though it were a road would
be lying about the one number a traveller plans around, so the distinction is part
of the `Leg` type rather than a log line.

**Only the car profile is routed.** The demo server answers `/route/v1/bike/…`
and `/route/v1/foot/…` with HTTP 200 and a *car* route — same geometry, same
duration to the metre. Asking all three profiles for Vienna → Rome returns three
identical objects. It does not reject the profile, it ignores it. So bicycle and
walking itineraries use the estimate path and say why.

**Pins sit at city centroids, and the page says so.** The directory holds 892
places and no coordinates for any of them.
`data/city-coords.json` is 202 city centroids from the GeoNames `cities15000`
dump — 186 resolved by name with population as the tiebreak, 16 hand-entered and
marked `"source": "manual"`. `tools/gen-city-coords.mjs` regenerates the file and
reproduces the committed copy byte for byte. Upgrading to real per-venue points
is a geocoding run over the 892 slugs, and nothing else would change: every
consumer reads `coordsFor` or a `Stop.at`.

### What the dataset does not support, shown rather than smoothed over

The directory is 892 entries across 202 cities, and the drawers partition it
exactly once each:

| drawer | count | from |
|---|---:|---|
| Find | 780 | tours, sightseeing, attractions, shopping, nightlife, **and everything untagged** |
| Sleep | **26** | hotels — in **12** of the 202 cities |
| Eat | 86 | restaurants — in 57 cities |

Two of those numbers shape the whole design.

**There are 26 hotels in the entire directory, in 12 cities.** So 190 cities have
an empty Sleep tab and the overnight suggestion has nothing to point at. Both
states are printed in the UI; the planner does not invent lodging, and the
overnight line distinguishes "the directory has 3 hotels here" from "the
directory has none for this city".

**578 of the 892 entries carry no category**, because the extractor reads a tag
from a node the source only renders on some cards. They are filed under Find and
marked, because a place with no category cannot be known to be a hotel or a
restaurant — filing it under either would invent the one fact a traveller would
act on.

### Two bugs the tests caught

Both compiled cleanly and looked right:

- **The estimate path returned legs with empty `fromId`/`toId`.** Everything
  downstream matches a leg to its stops by id, so every non-car leg matched
  nothing: no row in the drawer and no line on the map. The itinerary silently
  emptied the moment you switched to bicycle.
- **Adding the same place twice produced two stops with the same id.** A React
  key collision, an ambiguous lookup, a leg whose two ends were the same stop,
  and a remove that took out both. `Stop.id` is now unique per stop and the
  directory entry it came from lives in a separate `placeId`; the drawer shows
  *Added* rather than letting you duplicate it.

`tools/smoke-plan.mjs` stubs the OSRM response for the routed-path assertions.
Without that, a green run in a sandbox with a flaky network would only ever have
proved the fallback works.

### What is not built

- **No routing through a real venue geocoder**, so the map answers "which city",
  not "which door". See above.
- **Reordering is up/down buttons, not drag-and-drop.** Furkot drags stops around
  the map; a pointer-driven drag needs capture, a threshold so a click is not a
  drag, and keyboard equivalents. The buttons work for everyone now, and the
  accessibility cost of drag is the part that cannot be patched in later.
- **No live hotel prices or booking links.** The directory has hotel *names* and
  nothing else — no rates, no availability, no provider — so "Sleep" can only
  point at an entry.
- **`/plan` is not pixel-verified against Furkot.** The live planner is behind a
  login, so there was no reference to measure against. The panel layout and
  behaviour are taken from Furkot's help centre, which documents all of it.

---

## Accounts and cloud saves

Optional, and off until it is configured. The quest book and the trip planner
both keep their state in `localStorage` and have always worked that way; an
account only adds a copy of that same state to Postgres so it follows you to
another device. Nothing about the site requires signing in.

**What is here**

| | |
|---|---|
| `lib/auth.ts` | the Better Auth instance and its config |
| `lib/auth-client.ts` | the only auth module a client component may import |
| `app/api/auth/[...all]/route.ts` | sign-up, sign-in, sign-out, session |
| `app/api/saves/route.ts` | the caller's own save, session-checked |
| `supabase/schema.sql` | the `saves` table, RLS locked |
| `lib/auth/sync.ts` | push on change, pull on load, debounced |
| `lib/auth/reconcile.ts` | which copy wins — pure, and checked |

**Setting it up**

1. Three values, in `.env.local` (copy `.env.example`; it is gitignored):

   | variable | where |
   |---|---|
   | `NEXT_PUBLIC_APP_URL` | `http://localhost:4310` locally |
   | `BETTER_AUTH_SECRET` | `node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"` |
   | `DATABASE_URL` | Supabase → Database → Connection string → **URI, port 5432** |
   | `AUTH_TRUSTED_ORIGINS` | only if you are not on `localhost` — see below |

   `DATABASE_URL` is the one that gets missed: it is the **database password**,
   which is not the publishable key, not the anon key, and not the service-role
   key. It lives in the Database section of the dashboard, not the API section.
   Port 5432, not 6543 — Better Auth opens real transactions and the transaction
   pooler refuses them.

**Deploying to Vercel.** `.env.local` is a Next convention and **Vercel never
reads it** — the values there exist only on this machine. Set the same values in
the dashboard (Project → Settings → Environment Variables), or:

```bash
npx vercel env add NEXT_PUBLIC_APP_URL production
npx vercel env add BETTER_AUTH_SECRET   production
npx vercel env add DATABASE_URL         production
npx vercel env add GOOGLE_CLIENT_ID       production
npx vercel env add GOOGLE_CLIENT_SECRET   production
```

Scope matters: set them for **Production** and **Preview**, or a preview build
fails sign-in while production works, which reads as a flaky bug rather than a
missing variable.

`NEXT_PUBLIC_APP_URL` should be the deployed origin. If it is left unset the app
now derives it from Vercel's own `VERCEL_URL`, and trusts the deployment's
production and branch URLs automatically, so a fresh deploy signs in without
configuration — but setting it explicitly is still better, because
`NEXT_PUBLIC_*` is inlined at build time and an explicit value is what you can
read.

The one thing the code cannot do is guess: **add the deployed callback URI** to
the Google credential, alongside the local one.

```
http://localhost:4310/api/auth/callback/google
https://<your-app>.vercel.app/api/auth/callback/google
```

Without it Google answers `redirect_uri_mismatch` and sign-in fails at the last
step, after the consent screen.

**"Invalid origin".** Better Auth compares the request's `Origin` header against
`trustedOrigins` and refuses anything else, so a sign-in that looks correctly
configured can still fail on a config that reads correct. One server is reachable
at several *different* origins, and the browser does not care that they are the
same server:

| you typed | trusted? |
|---|---|
| `http://localhost:4310` | yes — `NEXT_PUBLIC_APP_URL` |
| `http://127.0.0.1:4310` | yes — added automatically |
| `http://[::1]:4310` | yes — added automatically |
| `http://192.168.x.x:4310` | **no** — the "Network" URL Next prints |
| your deployed host | yes — from Vercel's own env, or `NEXT_PUBLIC_APP_URL` |

The three loopback spellings are added in code because they are this machine by
definition and cannot be reached from anywhere else. The LAN address is not
knowable statically, so it goes in `AUTH_TRUSTED_ORIGINS` (comma separated) — a
narrow list on purpose, since this is a CSRF control and anything loose in it
lets another site drive a sign-in. Note the check only runs on requests that
carry a cookie, which is Better Auth's reasoning: a cookieless request cannot be
a forged authenticated action.

2. Create Better Auth's four tables:

   ```bash
   npm run auth:migrate              # or -- --print to see the SQL first
   ```

   Not `npx @better-auth/cli migrate`: that package's `latest` is 1.4.21 and its
   newest release of any tag is a 1.5 beta, both behind the 1.7 library installed
   here. `tools/migrate.mjs` calls the same `getMigrations` the CLI does, from the
   installed package, so the schema always matches the code.

3. Create the saves table — paste `supabase/schema.sql` into Supabase → SQL
   Editor. It has to run second, because it references the `"user"` table from
   step 2.

4. `npm run dev`, then "Sign in" in the header.

**Signing in.** A centred `<dialog>` with two peers, not a fallback chain:
"Continue with Google" first, because on a phone it is one tap, then the email
form for people who would rather not hand a Google account to a travel site.
Native `<dialog>` rather than a div overlay, because `showModal()` gives the
focus trap, the inert background, Escape, and focus-return for free — the four
things a hand-rolled overlay gets subtly wrong.

Google needs two more optional values:

| variable | where |
|---|---|
| `GOOGLE_CLIENT_ID` | Google Cloud Console → Credentials → OAuth client ID → Web application |
| `GOOGLE_CLIENT_SECRET` | on the same credential |

with the redirect URI `{NEXT_PUBLIC_APP_URL}/api/auth/callback/google` and the
origin `{NEXT_PUBLIC_APP_URL}`, and the People API enabled for the project. With
either value missing the provider is **not registered at all** rather than
registered broken — a provider with an id and no secret produces an OAuth
redirect Google answers with an error the player cannot act on. The button still
renders, because the request it makes exists either way, and says so in words
when it fails. The email form is unaffected.

**On the keys.** No Supabase anon, publishable or service-role key is used, and
none is needed. This is not an oversight: the server already holds a SQL
connection for Better Auth's tables, so reaching for the service-role key — which
bypasses RLS — to read four columns would add a secret to the attack surface for
nothing. The `saves` table is protected by RLS instead, and with no PostgREST
client there is no reason for a publishable key to reach a browser bundle at all.

**How a conflict is settled.** `saves` has one timestamp per payload rather than
one per row, so a phone that only played the quest game and a laptop that only
planned a trip do not overwrite each other. Where a genuine conflict remains it
is last-writer-wins per column, with the timestamp set by the database rather
than the client, so a device with a wrong clock cannot win forever. The one case
that is *not* last-writer-wins is a local save with unsynced work: it is never
overwritten by a cloud copy, because there is no timestamp on a `localStorage`
save to compare and losing a player's progress is the one failure this must not
have. `npm run check:sync` covers that decision.

**Not built:** email verification, password reset, and Google sign-in. All three
need an SMTP provider and a redirect allowlist. `requireEmailVerification` is
`false` in `lib/auth.ts`, which is fine for a demo and **not** fine for a public
deploy — anyone can sign up as anyone.

---

## The weather twin

`/plan` carries a weather-driven digital twin in the top of its left column, above
the itinerary drawer. It is a panel and not a route, because the brief is explicit
that this is an enhancement to the existing solution rather than a new
application — and a traveller who had to leave the planner to look at the weather
would be looking at two things that disagree the moment either changed.

It reads the trip you have already built: your stops, the cities they sit in, the
legs the planner has already routed, and the directory entries behind them. It
writes nothing back, ever.

```bash
npm run check:twin   # 20 browser assertions, needs a dev or start server
```

### What it does, against the four requirements

| Requirement | How |
| --- | --- |
| Live weather | OpenWeather current conditions **and** the 3-hour forecast, per city, through `app/api/twin/observe` |
| Geospatial map | Impact halos on the planner's own MapLibre map, over the same markers, plus a legend |
| Social signals | GDACS alerts (with coordinates), Reddit and Hacker News, bucketed to your cities |
| What-if | Five continuous controls — rainfall, temperature, wind, standing water, storm hours — and four named presets |

### Why the API key is not in the browser

`OWM_API_KEY` is read inside the route handler and nowhere else. The route is
server-only, so the key never reaches the client bundle. That is also why the
three public feeds are fetched server-side rather than in the browser: Reddit
answers a burst from a shared address with HTTP 429 for minutes at a time, and a
page full of client-side polling would get this project cut off from all three
within a day. A key in a `NEXT_PUBLIC_` variable would be spent by somebody else
by the morning.

### The model, and what it is not

Five hazards in real units — `rain` mm/h, `heat` °C over 30, `wind` km/h gust,
`flood` cm standing, `storm` hours remaining — and six operational channels, kept
apart on purpose: `availability`, `capacity`, `movement`, `demand`, `duration`,
`workforce`. "Impact" as one number is the step that makes a twin
unfalsifiable, and six quantities with different signs are not one quantity.

The **prior** is a stated engineering judgement, written down in
`lib/twin/impact.ts` as a table of what each hazard does to each channel at each
shelter level, with its reasoning. It is not a trained regressor, and it is not
presented as one: a regression over what this project actually has would memorise
noise and print a number nobody can interrogate. The **correction** comes from
real records — an official alert, or public reports that name your city — and it
is small, clamped, and smoothed by `n / (n + 4)`, so a cell with one report is
overwhelmingly prior and a cell with forty is mostly evidence. The panel prints
that count on every load.

Effects **cascade in four named orders** and no further: direct, access (the road
between you and the place — which is why a flooded road closes a dry café),
workforce (the city, not the venue), and reroute (the only order that improves
anything, because people whose plans break do not disappear, they go somewhere
else). Each hop damps both the effect and its confidence, so an effect that has
travelled three links is visibly less certain than the hazard that started it.

### The three decisions that matter most

**The what-if is a ratio, and prints the unit it resolves to.** A slider set to
"40 mm/h" means nothing at your current conditions — in clear air it is a
catastrophe and in a downpour it is Tuesday. Every control multiplies the
observed reading and prints the absolute value next to it, so you never have to
do the arithmetic to know whether what you are imagining is a real change. Depth
is the exception and carries its own unit: water accumulates, so it has an origin
that is not "clear skies".

**The days and nights come from the planner's own split.** Not a weather-shaped
reimplementation of it. `lib/twin/itinerary.ts` hands the inflated leg times back
to `splitIntoDays` and `totalsFor` — the same functions, the same daily limit, the
same "a leg longer than the cap cannot be split" rule — and reports the
difference. If the planner's rules move, the twin's answer moves with them,
because there is only one rule. And when a middle stop is closed the two legs
either side of it **join** into one, which is the honest consequence of not going
somewhere rather than quietly dropping a leg.

**Flooding is never read from a forecast.** No weather response carries standing
water, and deriving it from rainfall would be the most confident wrong number in
the layer: depth depends on drainage, terrain and hours of accumulation. So
`flood` arrives from exactly two places — an official alert, or your own control
— and the panel says which.

### What it refuses to do

- **It will not invent a trip.** The graph is empty until there is one. A twin
  that populated itself so the panel had something to draw would be answering a
  question nobody asked.
- **It will not guess a pin's shelter.** A coordinate you dropped has no category
  and no prose, so it is classed `unknown` and labelled as such, rather than
  assumed safe or assumed exposed.
- **It will not report an outage as calm.** A source that did not answer is shown
  as "no answer", a source that answered with nothing near your trip is shown as
  "nothing near", and a weather service that fails for a city is rendered as
  *unaffected* with the reason attached. The `±` on every figure is
  confidence-derived, not a fitted interval, and is labelled as such.
- **A ratio on a zero does nothing, and the panel says so.** A "Downpour" preset
  on a clear day triples a rainfall of nothing. The controls report which of them
  are inert rather than implying a response the model does not have.

### Files

```
lib/twin/hazard-scale.ts   the eleven thresholds, in units, in one place
lib/twin/impact.ts         the prior, and the calibrated correction
lib/twin/graph.ts          the twin's graph, built from your trip
lib/twin/propagate.ts      the four cascade orders
lib/twin/itinerary.ts      the effect on days and nights, via the planner's split
lib/twin/weather.ts        OpenWeather shapes, unit conversion, the condition word
lib/twin/feeds.ts          the three public feeds, server-only
lib/twin/signals.ts        bucketing, the keyword-count polarity, calibration
app/api/twin/observe/      the route: the only place the key exists
components/twin/           the panel, the controls, the impacts, the feed
```

## Known gaps

- **Accounts are wired but unconfigured.** Auth and cloud saves are complete and
  committed, with no Supabase project attached yet, so `npm run auth:migrate` and
  the sync round trip have never run against a real database. The migration
  script's path to Postgres is verified; the happy path is not. See "Accounts and
  cloud saves" above.
- **The weather twin needs a server, so it cannot be statically exported.**
  `app/api/twin/observe` is a `force-dynamic` POST that pulls live weather, and a
  route handler cannot be emitted as a static file at all. Any future static
  export — for a native app, an offline bundle, or a CDN-only deploy — has to
  exclude this route or it will fail somewhere considerably less legible than
  here. The web build is unaffected, and is the product the twin ships in.
- **The twin's model is a prior, not a trained regressor, and it says so on the
  panel.** The thresholds in `lib/twin/hazard-scale.ts` and the table in
  `lib/twin/impact.ts` are a stated engineering judgement about outdoor
  hospitality. The real records that exist — a handful of alerts and public posts
  — are used to calibrate it within a third of a severity step, smoothed by
  `n / (n + 4)`, and the panel prints how many there were. Anyone who wants the
  numbers to mean something other than judgement needs the observations to reach
  a few hundred, and the table should be revisited when they do.
- **No filmstrip footage yet.** The architecture and the mount/unmount window
  are done and verified; `data/place-videos.json` is empty because no
  free-licensed clip has been sourced. See "Adding video" above.
- **The three container-box edges at 1440** (see above). The filmstrip does not
  change this — it is an insertion between two existing bands, so it shifts
  everything below it down without altering their internal geometry.
- The mobile nav is `display: none` behind its toggle; the original keeps the
  panel off-canvas at `x: 420`. Same result, different mechanism, so the
  off-canvas panel measures as 0×0 here.
- The 1px header rounding at ≤1024, inherited by everything below it.
- Interior pages were built from the same design system and the captured
  screenshots, not measured element-by-element. The home page is the one that
  was verified to zero. `/cities` is now also exact at 1440; `/about`,
  `/contact`, `/partners` and `/lisbon` have exact h1s but unfinished lede and
  section spacing, and `/blog` is unmeasured.
- `/social-impact`'s category and country inputs render but are not wired to
  anything — the `DirectoryFilter` has no `useState`, so they do not filter yet.
- **A concurrent agent is working in this repo** (it also runs a dev server on
  port 4330) and has been committing shared files. `components/WorldGlobe.tsx`
  is its work, not this task's: it is untracked, imported by nothing, and its
  two react-globe typing errors at line 177 **fail `next build` for the whole
  clone**. They need fixing before the build is green again.
- **Do not run `next build` while `next dev` is up.** They share `.next/`, and
  the build clobbers the dev server's chunks, which fails at runtime with
  `Cannot find module './vendor-chunks/@swc.js'`. Stop the dev server first, or
  the corruption has to be cleared with `rm -rf .next`.
