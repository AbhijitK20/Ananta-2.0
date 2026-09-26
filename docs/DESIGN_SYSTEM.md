# DESIGN SYSTEM — Ananta

> Tokens, components, copy rules and accessibility. The test for anything here is
> whether a traveller can tell in under two seconds whether something **fits**.

The claim this product makes is *"this actually fits"*. The design's whole job is
to make that visible. The feasibility meter is the signature element — it is the
one place boldness is spent. Everything around it stays quiet.

---

## 1. Direction

> A **map-centric decision tool** for time-constrained travellers. Trust-first.
> Editorial-warm surface over a technical data layer.

Two aesthetics that look like opposites — warm monochrome serif, and monospace
tactical grid — compose rather than conflict when applied to **different
layers**. Brutalism's bimodal density is the point: tight mono metadata clusters
next to vast negative space.

| Dial | Value | Why |
|---|---|---|
| `DESIGN_VARIANCE` | **5** | Above the trust-first 3–4, it needs an identity. Below arty, it is a tool. |
| `MOTION_INTENSITY` | **4** | Motion serves feasibility feedback only. Never spectacle. |
| `VISUAL_DENSITY` | **6** | Cockpit. Map + ranked list + itinerary coexist; airy would waste the map. |

## 2. Tokens

Grounded in the subject — Mumbai's **monsoon** — not the default travel palette.
Avoid the three defaults: cream + terracotta serif, near-black + acid accent,
broadsheet hairlines.

### Colour

| Token | Hex | Role |
|---|---|---|
| `canvas` | `#F6F4EF` | bone, unbleached |
| `surface` | `#FFFDF8` | raised surfaces |
| `ink` | `#17150F` | warm carbon. **Never `#000`** |
| `ink-muted` | `#6F6A5E` | secondary text |
| `ink-faint` | `#9A948A` | tertiary, disabled |
| `rule` | `#E4E0D6` | **all** 1px dividers |
| `accent` | `#0E4F4A` | monsoon teal — the *only* brand accent |
| `accent-soft` | `#D7E4E2` | accent at 12% for fills |
| `alarm` | `#B23A2E` | chalk vermilion (kolam / signage red) — over budget, infeasible, closed |
| `alarm-soft` | `#F5E2DF` | |
| `fit` | `#4A6B3A` | muted leaf — fits, confirmed, available |
| `fit-soft` | `#E2EADD` | |
| `warn` | `#9A6B1F` | hours unverified, inferred data |
| `info` | `#3D5A80` | neutral informational |

**The rule that makes it work: `accent` / `alarm` / `fit` are semantic, not
decorative.** `accent` never appears where `alarm` means something. If you find
yourself reaching for a fourth colour, you have found a new semantic — name it
and add it deliberately.

Shadow opacity stays under **0.05**. `rounded-full` is **banned on containers**.

### Dark mode

`canvas #14130F` · `surface #1C1B16` · `ink #EDE9DF` · `ink-muted #A29C90` ·
`rule #2C2A23` · accent lightens to `#3E8E86` · `alarm` to `#D4665A` ·
`fit` to `#7FA06B`.

For any **user-picked** accent, derive a legible text colour from its WCAG
relative luminance rather than guessing. TREK has this in
`theme/applyAppearance.ts:58-67` — worth porting the approach.

### Type

Three roles, paired deliberately:

| Role | Face | Notes |
|---|---|---|
| Display | **Instrument Serif** | Editorial voice. **Explicitly not Playfair** |
| UI | **Geist Sans** | Bans Inter / Roboto / Open Sans |
| Data | **Geist Mono** | Every duration, distance and rupee figure, with `tabular-nums` |

```css
--font-display: 'Instrument Serif', Georgia, serif;
--font-ui: 'Geist Sans', system-ui, sans-serif;
--font-data: 'Geist Mono', ui-monospace, monospace;
```

**Per-tier user font scaling.** Every tier reads its own `--fs-scale-*` times a
root multiplier, so one accessibility slider rescales the whole app. The rule:
**the value and the unit always share a tier.** From TREK
(`client/src/index.css:762-765`, `Roadtrip/typeScale.ts:16-38`).

```css
:root {
  --fs-scale-body: 1;   --fs-scale-meta: 1;   --fs-scale-display: 1;
}
.text-body  { font-size: calc(1rem      * var(--fs-scale-body)); }
.text-meta  { font-size: calc(0.8125rem * var(--fs-scale-meta)); }
.text-num   { font-family: var(--font-data); font-variant-numeric: tabular-nums; }
```

### Spacing, radius, elevation

4px base. Radius: `sm 4` · `md 8` · `lg 12` · `full` **pills and icon buttons
only**. Shadows: two levels, both under 0.05 opacity. Borders are `1px solid
var(--rule)` and always — never a shadow standing in for a divider.

### Z-index scale

Never a bare `z-50`. One scale, named:

```
0    base          10   sticky         20   overlay
30   dropdown      40   modal          50   toast
60   map-marker    70   map-popup
```

`map-marker` sits above overlays because a hovered marker must never be occluded
— AdventureLog raises the hovered marker to `z-index: 100000` for exactly this.

### Motion

| Token | Curve | Duration | Used for |
|---|---|---|---|
| `ease-out-soft` | `cubic-bezier(.2,.8,.2,1)` | 180 ms | entrances, hover |
| `ease-in-out` | `cubic-bezier(.4,0,.2,1)` | 240 ms | layout shifts |
| `ease-feedback` | `cubic-bezier(.34,1.3,.64,1)` | 320 ms | the meter filling |

Named properties only — never `transition: all`. `prefers-reduced-motion` is
honoured everywhere, with a global override.

## 3. Component inventory

Build in this order. Everything reads the contracts; nothing computes.

### Primitives — `src/components/ui/`
`Button` · `Card` · `Badge` · `Popover` · `Sheet` · `Skeleton` · `EmptyState` ·
`Toggle` · `Slider` · `SegmentedControl` · `Tooltip` · `Dialog`

`Skeleton` needs **8 structural patterns** — a skeleton is a structural copy of
the real thing, not a spinner. `minimum 0.15s` so fast responses do not flash.

### The signature — `src/components/fit/`

**`FitMeter`** — the thesis made visual.

```
┌────────────────────────────────────────────────┐
│ activity ▸ travel ▸ buffer        2h 05m left   │
│ ████████████████░░░▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓░░░░░░   │
│ └─fits─┘         └─overflow, alarm colour─┘    │
└────────────────────────────────────────────────┘
```

Renders `Fit` directly: three segments proportional to `activityMin`,
`travelMin`, `bufferMin`, against `availableMin`, overflow in `alarm`. The
metre **fills and goes red** as an option stops fitting — animate it, that is
what `ease-feedback` is for. `verdict: 'tight'` gets a `warn` hairline, not red.

**`TravelConnector`** — the pattern that makes a plan read as a journey.

```
   │  12 min walk · 850 m · via Tulsi Baug     │  ← clickable: change this leg's mode
   ▼                                            │
 [ Restaurant ]  14:10 – 15:10
```

A **hairline sibling** of the stop list, not a property of a stop. From TREK
`client/src/components/Planner/DayPlanSidebarRouteConnector.tsx:14-36`. Render
`estimated: true` legs differently from live ones — we are honest about which.

**`TimeBudgetBar`** — the window as **countable blocks**, not a vague bar. Mask
it with `repeating-linear-gradient` at one block per **30 minutes**, so "2h
budget" is literally 4 blocks and overrun is a hatched tail. Masked, so it is
real holes rather than paint. From TREK
`client/src/components/Roadtrip/RangeStrip.tsx:57-72`.

**`StressRadar`** — 7 dimensions, 0–100.

| Dimension | Weight | What it measures |
|---|---|---|
| `overload` | 0.25 | planned minutes over a sane target |
| `pinDebt` | 0.18 | too many fixed-time anchors |
| `weatherRisk` | 0.14 | exposure in current conditions |
| `fomoRisk` | 0.13 | tempting things the plan excludes |
| `spreadRisk` | 0.12 | geo dispersion of stops |
| `transitComplexity` | 0.10 | transfers + legs |
| `reservationRisk` | 0.08 | bookings that could fail |

Labels at **68** → `"High friction"`, at **38** → `"Trip feels sane"`. Show
**one** "Rescue move:" sentence for the worst factor only. Per-factor bar colour
**inverts for positive dimensions**. Borrowed from
`nomadnote/components/TripStressRadar.tsx:120-246`.

**`WhyLedger`** — dual, because the reasoning is the product.

- *Why this* — `ScoreComponent[]` as ranked sentences, with the learned ones
  marked.
- *Why not that* — the `Rejection` for a specific thing: the constraint, the
  shortfall, and three actions. Not present in any of the five traveller apps we
  read, and the one a judge will remember.

**`ScoreBreakdownList`** — the components as a small bar chart with the weight
visible. Proves the ranking is arithmetic, not a hunch.

### Result card — `src/components/fit/ResultCard.tsx`

Order matters. Top to bottom:

1. **Fit meter** — the verdict, above everything
2. Name + `category` in `text-meta` caps
3. **Duration · price · distance** in `--font-data` `tabular-nums`
4. Rating `4.6 (312)` — Bayesian-smoothed, and show the raw count so the
   shrinkage is visible
5. Blurb, 2 lines max
6. **Provenance badges** — `inferred` fields get a `warn` "AI-inferred" pill
7. Accessibility as **yes/no pills with glyph AND word** — `✓ Step-free` /
   `✗ Not step-free` in `fit`/`alarm`. The *negatives* are the decision-grade
   information. From `trip-tracker/.../place-box-content.component.html:19-43`
8. Primary action

A card that does not fit is **rendered but de-emphasised** with the blocking
reason inline. Hiding it would waste the hardest-won information we have.

### Map — `src/components/map/`

`MapCanvas` (MapLibre + OpenFreeMap, no API key) · `ClusterLayer` ·
`RouteLine` · `CardMapCoupling`

Performance rules that are not optional, from `maplibre-gl-js/src`:

- `circle` layers at **all** zooms. One instanced quad per point, no placement
  pass. `symbol` only for ≤ 20 live labels.
- **`cluster: true` disables partial tile reload entirely**
  (`geojson_source.ts:575-577`). Clustered and live-hit layers must be
  **separate sources** or you lose `updateData` speedups.
- Hit-test `circle`, not `symbol` — collision-hidden symbols are not queryable.
- De-dup `e.features` by id. Tile buffering guarantees duplicates.
- `promoteId`, **not** `generateId`, or hover state dies on `setData`.
- `clusterProperties` for a cluster label of the form **"12 of 40"**, and it must
  say what the 12 means: *open now*, *fits your window*, *fits your budget*. A bare
  count invites the reading that it is a live footfall figure, and it is not — it
  is a count against the traveller's own `DiscoveryContext`, recomputed on the
  client from the same feasibility gate the plan used. If `opening_hours` is
  absent for a record, it is neither open nor closed, and the label must not
  imply otherwise.
- Cluster counts as **HTML**, not glyphs — raster basemaps and blocked glyph
  endpoints make glyph clusters unreliable. AdventureLog's
  `FullMap.svelte:313-352` says so in a comment worth reading.

**Card ↔ map coupling.** Clicking a card must do something visible:
`revealInCluster()` → `getVisibleParent(marker).spiderfy()`. That is the whole
fix for "I clicked a card and nothing happened"
(TREK `Map/markerCluster.ts:47-64`).

**"Search this area"** re-arms on pan: radius ladder `1/2/5/10/20/50 km`, only
re-prompt past ~0.002° drift or an empty result, plus a real geofence circle.
Panning raises a CTA instead of firing requests, which makes dragging an
intentional gesture **and** caps API spend
(AdventureLog `routes/map/+page.svelte:515-560, 1226-1293`).

## 4. Copy rules

No AI-slop patterns. Banned outright:

- Emoji in code **and** copy → `lucide-react`, one family, `strokeWidth`
  standardised
- `...` → `…`; straight quotes → curly; Title Case headings; active voice
- Colon reveals ("Here's the thing:")
- Fake-profound kickers
- "Simply", "effortlessly", "dive in", "unlock", "seamless", "elevate"

**Completed sentences with real numbers**, always. Not `Constraint violated` —
*"Needs 40 min more than you have left"*, *"₹300 over your per-person limit"*,
*"Closed — opens tomorrow 09:00"*.

**Zero-result states are the highest-value copy in the product.** The best string
found in any reference repo:
*"No recommendations in this area. Try a larger radius."*
Pair it with cause-branching and a way forward:

| Situation | Copy |
|---|---|
| Constraints too tight | *"Nothing fits all your constraints. Here is what gives."* |
| Area empty | *"No recommendations in this area. Try a larger radius."* |
| No data at all | *"No places here yet — add your first one!"* |
| Blocked by one thing | *"Everything nearby is closed right now. Next opening 09:00."* |

Always offer `Try: {example}` chips.

## 5. Accessibility — non-negotiable

| Requirement | Implementation |
|---|---|
| Keyboard navigable | every flow, visible `focus-visible` ring on all interactive |
| Disclosure panels | `inert` + `grid-rows` collapse, with a `prefers-reduced-motion` override. The only correct pattern found — `trip-tracker/trip.component.html:337`, `styles.scss:373-390` |
| Contrast | `ink` on `canvas` and `ink-muted` on `canvas` ≥ 4.5:1. `alarm` and `fit` as text ≥ 4.5:1, not just as fills |
| Colour is never the only signal | the meter has segments **and** a text verdict; pills have glyph **and** word |
| Motion | `prefers-reduced-motion` honoured globally |
| Text scaling | the per-tier system above, so browser zoom and the slider both work |
| Map | list view is a first-class alternative, not a fallback. The map is not keyboard-navigable and pretending otherwise is worse than not shipping it |
| Live regions | plan changes and replans announce politely |

## 6. Enforcement

`npm run theme:lint` **fails the build on any hex literal outside
`src/styles/tokens.css`**. This is not ceremony: TREK's own token guarantee
decayed into an inline `#fbbf24` the moment nobody enforced it, and a design
system without a gate is a mood board.

Put it in CI. Add `--watch` to the dev script so the feedback is instant.

## 7. Definition of done

- [ ] Feasibility meter on every card, overflow in `alarm`, animates on change
- [ ] `TravelConnector` between every pair of stops, clickable to change mode
- [ ] `TimeBudgetBar` masked into 30-minute blocks
- [ ] `StressRadar` with correct weights, 68/38 labels, one rescue move
- [ ] `WhyLedger` showing **both** why-this and why-not-that, ≤ 2 taps
- [ ] Card ↔ map coupling works, including inside clusters
- [ ] `theme:lint` in CI, zero violations
- [ ] Keyboard-navigable end to end, `prefers-reduced-motion` honoured
- [ ] 8 skeleton patterns, no layout shift
- [ ] No emoji in code or copy; all four cause-branching zero-result states
- [ ] Mobile at 360px, desktop at 1440px

## 8. Borrowed patterns, and where they came from

Every non-obvious pattern below is lifted from a specific reference repository, so
the credit is on the record and the reasoning is checkable. The clones are
gitignored, so the paths are for provenance, not for clicking.

| # | Source | What we took |
|---|---|---|
| 1 | TREK `client/src/components/Planner/DayPlanSidebarRouteConnector.tsx:14-36` | the travel connector |
| 2 | TREK `client/src/components/Roadtrip/RangeStrip.tsx:57-72` | the masked block bar |
| 3 | TREK `client/src/index.css:762-765` + `Roadtrip/typeScale.ts:16-38` | the per-tier scale |
| 4 | TREK `client/src/theme/applyAppearance.ts:58-67` | WCAG luminance derivation |
| 5 | NomadNote `components/TripStressRadar.tsx:120-246` | the radar, complete — and the reason the component is credited rather than renamed |
| 6 | NomadNote `components/ItineraryBuilder.tsx:123-160` | bar + number + title pattern |
| 7 | AdventureLog `frontend/src/lib/components/map/FullMap.svelte:313-352` | HTML cluster counts |
| 8 | AdventureLog `frontend/src/routes/map/+page.svelte:515-560` | the viewport-delta gate |
| 9 | trip-tracker `frontend/src/app/.../place-box-content.component.html:19-43` | accessibility pills |
| 10 | trip-planner | the permalink idea only: FNV-32a hash → seeded PRNG → alliterative slug, so the same context always yields the same shareable URL with no database |

Full findings in `research/findings/01-traveler-uiux.md`.
