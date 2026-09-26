# ATHITI — Traveler UI/UX Pattern Extraction from Cloned Reference Repos

**Brief:** "what can I actually do in Mumbai in the next 2 hours, near my hotel, within budget, as a family of 4 with a toddler"

**Date:** 2026-09-26
**Repos read (all read-only):** TREK, AdventureLog, trip-tracker, nomadnote, plan-it, shadcn-ui, maplibre-gl-js

---

## 0. Provenance & coverage caveats (READ FIRST)

| Repo | Which clone I used | Sparse state | Caveat |
|---|---|---|---|
| TREK | **`/home/abhijitk20/Travel_buddy/TREK/`** (teammate's FULL clone) | n/a — full | The `research/domain/trek/` clone is blobless + sparse to `/server/` + `/shared/`, which contains **zero UI**. `client/src/**` exists only in the full clone. All TREK citations below are the full clone. |
| AdventureLog | **`/home/abhijitk20/Travel_buddy/AdventureLog/`** (teammate's FULL clone) | n/a — full | Same story: `research/domain/adventurelog/` is sparse to `backend/` + `frontend/src/`; the full clone is what I used. All paths below are under the full clone. |
| trip-tracker (actually "TRIP", Angular+Leaflet+Django) | `research/domain/trip-tracker/` | `src/`, `backend/`, `mcp-server/` | Full UI available. No full clone at repo root; sparse covers everything needed. |
| nomadnote | `research/systems/nomadnote/` | not sparse | Complete. |
| plan-it | `research/peer/plan-it/` | not sparse | Complete. |
| shadcn-ui | `research/adopt/shadcn-ui/` | `/packages/`, `/templates/`, `/registry.json` | **`registry.json` is 0 bytes and `packages/shadcn/src/registry/` contains only CLI source — the actual component registry and the `new-york-v4/blocks/*` composition templates are NOT in this sparse checkout.** Templates are also mostly empty scaffolds. See §10 for what I could actually verify. |
| maplibre-gl-js | `research/adopt/maplibre-gl-js/` | `/src/` (renderer internals) | A very recent/renamed branch: `ui/anchor.ts` and `ui/handler_inertia.ts` are new. |

Full-clone absolute roots used (for provenance):
- `/home/abhijitk20/Travel_buddy/TREK/client/src/...`
- `/home/abhijitk20/Travel_buddy/AdventureLog/frontend/src/...`

For the rest, paths are relative to `research/`.

---

## Per-repo summary tables

### TREK (`/home/abhijitk20/Travel_buddy/TREK/`)
| | |
|---|---|
| **Good for** | The single richest source here. (a) A real 3000-line day-plan sidebar with **inline inter-stop travel-time connectors** — the exact thing ATHITI needs. (b) A `RouteConnector` that is one thin DOM row you can copy verbatim. (c) `RangeStrip` — a constraint bar that visualises a *budget* as a measurable quantity with an explanatory tail. (d) A deliberate **type scale anchored to the day-plan's own px values** (`typeScale.ts`). (e) Two renderers (Leaflet + MapboxGL) sharing one hover-card, one cluster vocabulary, one `revealInCluster`. (f) A huge i18n surface with real, non-generic product copy. |
| **Steal** | `RouteConnector` (DayPlanSidebarRouteConnector.tsx) · `RangeStrip` + `typeScale` · `revealInCluster` (markerCluster.ts) · `PlaceHoverCard` (cursor-following, pointer-events:none) · `PoiCategoryPill` (frosted icon-only segmented control) · the token set in `client/src/index.css:700-780` · the `--fs-scale-<tier>` user font-size system. |
| **Avoid** | 3060-line component with ~4000 lines of inline `style={{}}` and a colossal density of "this is why (#NNNN)" comments — do not copy the code style, only the DOM shapes. Their `CLUSTER_OPTIONS` comments describe bugs they were fighting; you inherit the fixes, not the archaeology. Their `poiClusters.ts` custom grid-cluster is only needed because they render raw OSM POIs into Leaflet; use MapLibre's native clustering instead. |

### AdventureLog (`/home/abhijitk20/Travel_buddy/AdventureLog/`)
| | |
|---|---|
| **Good for** | SvelteKit + daisyUI + svelte-maplibre. (a) The best **nearby/radius discovery UX** in the set: a 3-mode search bar (`My` / `Places` / `Nearby`) with a radius select and a "Search this area" button that re-arms itself when you pan. (b) `FullMap.svelte` is a clean, reusable map abstraction: `cluster` options, cluster click-to-expand via `getClusterExpansionZoom`, marker slots with `isActive`/`setActive`, style-change remount nonce. (c) `MapNearbyRadiusLayer` — a real geofence circle as `FillLayer` + dashed `LineLayer`. (d) A genuinely great i18n string set with real recovery copy ("No recommendations in this area. Try a larger radius."). (e) daisyUI theming with 9 themes. |
| **Steal** | `FullMap.svelte` cluster/expand plumbing · `MapSearchBar` 3-mode segmented control + its `min-[380px]` responsive label hiding · radius options list (`1/2/5/10/20/50 km`) · "Unscheduled Items" tray with dashed border + per-item `+`/`+trip context` split button · `CollectionStats` radial/percentage stat grid · `MapRecommendationsLayer` z-index discipline for HTML popups. |
| **Avoid** | 2630-line `CollectionItineraryPlanner.svelte` that is a single 6-way mega-if on object type (location/transportation/lodging/note/checklist). If ATHITI ever has >1 entity type in the itinerary, split it. `svelte-dnd-action` with `isSavingOrder`/`savingDay` state is fiddly — `dnd-kit` (NomadNote) is easier to reason about. Do not copy `class:opacity-100={isRaised}` on an already-`group-hover` element (it's there and it works, but it's fragile). |

### trip-tracker (TRIP) (`research/domain/trip-tracker/`)
| | |
|---|---|
| **Good for** | (a) **The best map↔list coupling of any repo**: hovering a list row calls `getVisibleParent()` and lights up the *cluster* if the pin is folded, and `.list-hover` styles the cluster red. (b) A "highlight a whole day on the map" mode that dims every other marker (`.leaflet-tripday-pane-highlighting` → `opacity: .55`) and draws per-day coloured animated polylines. (c) A grid-rows `0fr → 1fr` collapse with `[attr.inert]` for real keyboard removal. (d) **Accessibility affordances that matter for families**: dog-friendly 🚶 and restroom 🚽 as first-class yes/no chips on the POI card, with a green/red pill. (e) `createClusterGroup()` is a 14-line copyable Leaflet cluster factory with sane options. |
| **Steal** | `highlightExistingMarker` + `.list-hover` · day-highlight dim-and-route · `inert` collapse · 🚶/🚽 accessibility chips · `distance` per-row (`{{distance}}km from previous`) · the resizable left panel with double-click-to-reset. |
| **Avoid** | The `book` modal cluster — 40+ modals in `app/modals/` for a single screen is a maintenance trap. `@if`/`@for` + PrimeNG (not just Tailwind) means you inherit two design systems. `p-3` utility soup in 2063 lines of inline template. |

### nomadnote (`research/systems/nomadnote/`)
| | |
|---|---|
| **Good for** | (a) **The Trip Stress Radar** — the single most on-brief UI in the whole set: 7 weighted dimensions, conic-gradient dial, per-factor bar with per-factor polarity, confidence badge, and "Rescue move:" copy per worst factor. (b) A day-column itinerary with an **"energy load" progress bar per day** (`totalMin / 8h target`) — the time-budget visualisation ATHITI needs. (c) Pacing presets as toggle chips with the hour count *in the label* (`Slow (6h/day)`). (d) Inline per-item "why" string (`item.reason`) surfaced as a tooltip. (e) Zero-server MapLibre with pin-drop mode. (f) `analyzeTrip()` insight cards. |
| **Steal** | `TripStressRadar.tsx` **in full** · `DayColumn` energy bar + `title` attr · `MODE_LABELS` · the `travelTimePainScore` 10-dot meter · `FilterBar` two-tier chip UI (6 quick pills + expandable panel with an active-count badge) · `MapView` `fitBounds(bounds, {padding:60, duration:1000, maxZoom:15})` and `flyTo` on selection · `PlaceDetailSheet` slide-up for mobile. |
| **Avoid** | The hard-shadow "atlas" aesthetic (`shadow-[6px_6px_0_hsl(var(--foreground))]`, 2px black borders) is a strong brand voice but reads as toy-like and will fight a calm "you can actually do this in 2 hours" promise. Emoji-as-icon (`🍽️ 🖼️ 🌿`) is cheap and will render inconsistently on Android. The itinerary `SortableItem` indent hack (`ml-12`) to fake a time gutter is brittle. |

### plan-it (`research/peer/plan-it/`)
| | |
|---|---|
| **Good for** | (a) A **pure-CSS vertical timeline with a pseudo-element rail** — 40 lines, zero JS, priority-coloured dots, perfect for a no-framework fallback or a static export. (b) `renderCrowdBadge` — a 4-threshold 1-10 scale mapped to four labels with real, human copy ("Packed — expect long waits", "Light — enjoy short lines"). (c) A fully-tokenised CSS design system (`:root` + `html.dark`) with 4-step spacing, 4 radii, 3 shadows, 3 transitions, and an a11y-comment-annotated muted-text token. (d) A "Walking to here" badge that is a real `<a>` to Google Maps directions. (e) `<select>`-based time entry with a split AM/PM toggle group. (f) Full bilingual i18n (EN/ES) in one file. |
| **Steal** | The `.timeline` CSS block verbatim · `renderCrowdBadge` thresholds + labels · the token block in `static/css/app.css:9-91` · `badge-*` semantics (walk / wait / reminder / walk-map / restaurant / backup / priority) · `<select>`-as-inline-reminder on each timeline row. |
| **Avoid** | The whole `innerHTML = template literal` rendering approach (no escaping discipline, `app.js:500-1100`) is a XSS-shaped footgun. The AM/PM split `<input>` + toggle is fiddly and has four separate validation error messages. `$btnGenerate.innerHTML = "&#128640; Generate Itinerary"` hardcoded emoji in a JS string. No map at all. |

### shadcn-ui (`research/adopt/shadcn-ui/`)
| | |
|---|---|
| **Good for** | Not much in this checkout — see caveat. |
| **Steal** | Nothing verifiable beyond the scaffold shape (see §10). |
| **Avoid** | Do not cite this checkout as a source of component compositions; the registry content is absent. |

### maplibre-gl-js (`research/adopt/maplibre-gl-js/`)
| | |
|---|---|
| **Good for** | Renderer truth. (a) `Marker` `occludedOpacity` → `opacityWhenCovered` + `maplibregl-marker-covered` class, i.e. **built-in "this pin is behind a hill, dim it"**. (b) `PositionAnchor` enum + `anchorTranslate` map + `applyAnchorClass` (the source of the anchor→CSS-class contract you must know if you style popups yourself). (c) `Camera.fitBounds` `PaddingOptions` accepting a number *or* `{top,bottom,left,right}` (asymmetric padding — critical when a bottom sheet covers half the map). (d) `setFeatureState` for declarative highlight. |
| **Steal** | `opacityWhenCovered` (default `'0.2'`) · asymmetric `padding` in `fitBounds` · `maplibregl-marker-covered` CSS hook · `anchor` → class contract. |
| **Avoid** | Nothing. This is the source of truth; read it when a map behaviour surprises you. |

---

## 1. Page & screen inventory

### NomadNote — Next.js App Router, 3 routes, sidebar + 5 tabs
`app/page.tsx` (trips index), `app/trips/page.tsx` (the one real screen), `app/settings/page.tsx`.
Layout skeleton (`components/AppShell.tsx:153-257`): `<aside>` sticky sidebar `w-60` / `w-0 md:w-14` (collapsible rail) → `<div flex-1>` → `<header class="h-16">` topbar → `<main class="pb-[76px] md:pb-0">` → `<MobileNav>` bottom bar.

Inside a trip (`app/trips/page.tsx:158-179`), tab bar is 5 items, `border-b-4` underliner, `overflow-x-auto no-scrollbar`:
```tsx
{ value: "places",    icon: <List/>,       label: "Places" },
{ value: "map",       icon: <MapPin/>,     label: "Map" },
{ value: "itinerary", icon: <Calendar/>,   label: "Itinerary" },
{ value: "packing",   icon: <Package/>,    label: "Packing" },
{ value: "settings",  icon: <Settings2/>,  label: "Info" },
```
Mobile bottom bar is 4 equal columns with a raised centre "Add" (`AppShell.tsx:449-467`), labels `Trips / Radar / Add / Settings`, `min-h-12` targets, `pb-[max(env(safe-area-inset-bottom),0.5rem)]`.

### TREK — React Router, `ViewportRoute` splits phone vs desktop per route
`App.tsx:394-466` maps each route to `{phone: M…Screen, desktop: …Page}` — **two entirely separate screen trees**, not CSS. The canonical layout is `TripPlannerPage` = day-plan sidebar (left) + map (right), with `mobile/screens/trip/*` as the phone equivalent. Screens: dashboard, trip planner, journey list/detail/public/studio, collections, atlas, files, settings, admin, help, vacay, in-app notifications, shared-trip (public `/shared/:token`), journey-public (`/public/journey/:token`).

### AdventureLog — SvelteKit, 30+ routes, top navbar only
`frontend/src/lib/components/Navbar.svelte:142` is a single daisyUI `navbar` with `navbar-start` (brand + `lg:hidden` hamburger dropdown), `navbar-center hidden lg:flex` (full nav), `navbar-end` (search button, avatar dropdown with About/Docs/Support/Language/Theme). Nav items (`Navbar.svelte:115-119`): `/collections`, `/worldtravel`, `/map`, `/calendar`, `/users`. `/` is the dashboard.
A collection page (`routes/collections/[id]/+page.svelte:1026`) is `grid-cols-1 lg:grid-cols-4` with `lg:col-span-3` main + a sticky side rail; the main column switches on `currentView` = `all | itinerary | stats | map | calendar` (`:1047-1085`).

### trip-tracker (TRIP) — Angular 4 routes
`app/app.routes.ts`: `/auth`, `/s/t/:token` (shared), `/home` (dashboard = full-screen map), `/trips`, `/trips/:id` (the planner).
`trip.component.html` is **map-as-background, panel-as-overlay**: `<div id="map" class="w-full h-full">` at `z-0`, then a fixed glass panel `top-4 left-4 right-4 md:max-w-1/3 z-40` containing the trip header, then a floating glass control cluster `fixed top-4 right-4 lg:w-88` that toggles the Days panel and the Places panel. Bottom-up panel is `h-2/3`.

### plan-it — 3 static pages in one HTML file
`static/app.html`: `#page-new-trip` (textarea + fields + Generate), `#page-my-plans` (card list), `#page-plan-detail` (the full itinerary). Sidebar `240px` fixed, `main .main-content` with `header .topbar` (`--header-height: 60px`).

---

## 2. The itinerary / timeline component

### 2a. plan-it — the cheapest correct vertical timeline (`static/css/app.css:803-874`, markup `static/js/app.js:800-833`)

Pure CSS rail, no JS. This is the baseline ATHITI should fork from if a framework-light surface is ever needed.

```css
.timeline { position: relative; padding-left: var(--space-8); }
.timeline::before {
  content: ''; position: absolute; left: 15px; top: 4px; bottom: 4px;
  width: 2px; background: var(--color-border); border-radius: 1px;
}
.timeline-item { position: relative; padding-bottom: var(--space-5); }
.timeline-dot {
  position: absolute; left: calc(-1 * var(--space-8) + 7px); top: 6px;
  width: 18px; height: 18px; border-radius: 50%;
  border: 3px solid var(--color-border); background: var(--color-bg-primary); z-index: 1;
}
.timeline-dot.high   { border-color: var(--color-priority-high);   box-shadow: 0 0 6px rgba(220,38,38,.2); }
.timeline-dot.medium { border-color: var(--color-priority-medium); }
.timeline-dot.low    { border-color: var(--color-priority-low); }
.timeline-time   { font-size: var(--text-xs); font-weight: 600; color: var(--color-accent); font-family: var(--font-mono); }
.timeline-meta   { display: flex; flex-wrap: wrap; gap: var(--space-2); margin-top: var(--space-2); }
```
DOM per row:
```html
<div class="timeline-item">
  <div class="timeline-dot high"></div>
  <div class="flex items-center gap-2"><span class="timeline-time">7:30 AM</span></div>
  <div class="timeline-action">Rope drop Space Mountain — expect 20-min wait</div>
  <div class="timeline-meta">
    <span class="badge badge-walk">12 min walk</span>
    <span class="badge badge-wait">20 min wait</span>
    <span class="badge badge-priority high">high</span>
  </div>
</div>
```
**Mobile:** at `≤480px` the gutter shrinks and the dot follows it (`app.css:1369-1373`):
```css
.timeline { padding-left: var(--space-5); }
.timeline-dot { left: calc(-1 * var(--space-5) + 7px); }
.timeline-meta { gap: var(--space-1); }
```

### 2b. TREK — the inter-stop travel-time connector (**the pattern to steal**)

`TREK/client/src/components/Planner/DayPlanSidebarRouteConnector.tsx:14-36` is a *sibling* of the item list, not a property of an item. It is a hairline rule, a mode icon, duration, distance, optional note, hairline rule:

```tsx
/** Slim travel-time connector shown between two consecutive located stops in a day. */
export function RouteConnector({ seg, profile }: { seg: RouteSegment; profile: string }) {
  const effProfile = seg.mode ?? profile
  const driving = effProfile !== 'walking'
  const Icon = profileIcon(effProfile)   // Footprints | Car | Zap(plugin router)
  const line = { flex: 1, height: 1, minHeight: 1, alignSelf: 'center', background: 'var(--border-primary)' }
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '3px 14px',
                  fontSize: 'calc(10.5px * var(--fs-scale-caption, 1))', color: 'var(--text-faint)', lineHeight: 1.2 }}>
      <div style={line} />
      <div style={{ display: 'flex', alignItems: 'center', gap: 4, flexShrink: 0 }}>
        <Icon size={11} strokeWidth={2} />
        <span>{seg.durationText ?? (driving ? seg.drivingText : seg.walkingText)}</span>
        <span style={{ opacity: 0.4 }}>·</span>
        <span>{seg.distanceText}</span>
        {seg.noteText && (<><span style={{ opacity: 0.4 }}>·</span>
          <span style={{ color: 'var(--text-muted)' }}>{seg.noteText}</span></>)}
      </div>
      <div style={line} />
    </div>
  )
}
```
Why this matters: **travel time is a first-class visual band between two cards**, not a number buried on a card. It also becomes an *affordance*: the connector is wrapped in a clickable div that opens a transport-mode menu for that leg (`DayPlanSidebar.tsx:2425-2432`, `aria-label={t('dayplan.transportMode.change')}`).

`HotelRouteConnector` (`:44-…`) is the same thing plus a hotel name row, rendered **above the first stop and below the last stop** — the "depart from / return to hotel" bookend. This is *precisely* ATHITI's "near my hotel" framing, already solved.

The leg computation (which legs exist at all) is a pure function `planDay(dayId)` returning `{ runs, startHotel, endHotel, firstWay, lastWay, wantTop, wantBottom }` (`DayPlanSidebar.tsx:588-…`), then one cached OSRM call per waypoint pair sharing `RouteCalculator`'s cache with the map. Note the guards — they encode real product decisions:
- a run must contain at least one actual place, else two back-to-back flights produce a phantom airport→airport "drive";
- a leg is dropped if the endpoints are outside `withinDriveRange` (an airport 300 km away is not a drive).

Day header structure (`DayPlanSidebar.tsx:1727-1905`): flex row → `[day badge: number, optional stacked WeatherWidget]` → `[title • date]` → `[thin rule]` → `[accommodation chips, rental-car chips]` → `[cost]` → `[2×2 action grid: transit / +transport / +note / collapse]`. The badge is `26px` circle or a `34px` rounded stack with a 1px `currentColor` divider at `opacity .25` between the number and the weather. Selection wins: `background: isSelected ? 'var(--accent)' : dayTintBackground(...)`.

### 2c. NomadNote — vertical day columns with an **energy-load bar** (`components/ItineraryBuilder.tsx`)

Not a rail-and-dot list — it's an **accordion of day cards**, each with a time-budget meter. This is the closest thing in the set to ATHITI's core question.

```tsx
// ItineraryBuilder.tsx:123-160
const totalMin = day.items.reduce((s, i) => s + i.duration + (i.travelTimeFromPrevious ?? 0), 0)
const targetMin = 8 * 60
const energy = Math.min(100, Math.round((totalMin / targetMin) * 100))
...
<div className="mt-2 h-1.5 w-36 overflow-hidden rounded-full bg-muted"
     title={`Energy load: ${formatMinutes(totalMin)} planned of ${formatMinutes(targetMin)} target`}>
  <div className={cn("h-full rounded-full",
         energy > 90 ? "bg-destructive" : energy > 70 ? "bg-accent" : "bg-secondary")}
       style={{ width: `${energy}%` }} />
</div>
```
Thresholds: **>90 % = destructive, >70 % = accent, else secondary.** The header line carries the same numbers in text so the bar is never the only source of truth:
```tsx
<p className="text-xs text-muted-foreground">
  {day.date && day.date.length === 10 ? formatDate(day.date, "EEE, MMM d") : day.date}
  · {day.items.length} {itemLabel} · {formatMinutes(totalMin)}
</p>
```
Item row (`SortableItem`, `:49-105`) — a `useSortable` card, `flex items-center gap-2`, drag handle, then `[time (w-10 font-mono, muted)] [category emoji] [title truncate]`, and beneath, `ml-12 mt-0.5` for the meta row: `Clock {formatMinutes(duration)}` and, only when > 0, `MapPin +{formatMinutes(travelTimeFromPrevious)} walk`.
Lock toggle is `opacity-0 group-hover:opacity-100` and `Lock`/`Unlock`.
Expanded/collapsed via `AnimatePresence` + `motion.div` height 0→auto (`:166-190`), header is a real `<button aria-expanded aria-label={`${expanded?"Collapse":"Expand"} day ${day.dayNumber}`}>`.
Accessibility note: **dnd-kit keyboard support is actually wired** — `useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates })` (`:118-121`).

Pacing presets as chips with the budget in the label (`:41-45`, rendered `:330-345`):
```tsx
const MODE_LABELS = { slow: "Slow (6h/day)", balanced: "Balanced (8h/day)", packed: "Packed (11h/day)" }
```
Backed by `features/itinerary/algorithm.ts:22-26`:
```ts
const MODE_HOURS: Record<ItineraryMode, number> = { slow: 6, balanced: 8, packed: 11 }
const WEIGHTS = { priority: 0.35, proximity: 0.30, timeOfDayFit: 0.20, categoryDiversity: 0.15 }
const WALKING_MIN_PER_KM = 13   // 4.5 km/h
```

### 2d. AdventureLog — day cards, `svelte-dnd-action`, unscheduled tray
`CollectionItineraryPlanner.svelte:1935-…` is a `card bg-base-200 shadow-xl` per day, header = **date pill** (`w-20`, weekday / big day-of-month / month abbrev stacked) + editable day name `<input class="input input-ghost">` that saves on blur + "Day N of M" + a save spinner per day. Body is a `dndzone` grid of typed cards. Time comes from each object's own dates, not a scheduler.
Unscheduled items get their own dashed tray (`:2506`):
```svelte
<div class="card bg-base-200 shadow-xl border-2 border-dashed border-base-300">
  … <h3>{$t('itinerary.unscheduled_items')}</h3> <div class="badge badge-ghost ml-auto">{n} items</div>
  <p class="text-sm opacity-70">{$t('itinerary.unscheduled_items_desc')}</p>
```
with a per-item split button: `+` = add to a day (opens `ItineraryDayPickModal`), `+` outline = add to trip context.

### 2e. trip-tracker — sticky day header + per-row distance (`trip.component.html:292-516`)
Day header is `sticky top-0 z-20` with a `border-l-4` selection indicator, a `w-10 h-10 rounded-lg` count tile, title, `group.day.dt | date:'d MMM, y (EEEE)'`, then a **per-day cost pill** `{{group.stats.cost | number:'1.0-0'}} {{trip.currency}}`, then collapse / add / overflow.
Collapse is a CSS-grid rows animation **with `inert`** — the correct pattern:
```html
<div class="day-collapse" [style.grid-template-rows]="collapsed ? '0fr' : '1fr'"
     [attr.inert]="collapsed ? true : null">
  <div class="day-collapse-content space-y-4" [class.opacity-0]="collapsed">
```
```scss
// src/styles.scss:373-390
.day-collapse { display: grid; transition: grid-template-rows .25s cubic-bezier(.4,0,.2,1); }
.day-collapse-content { overflow: hidden; transition: opacity .2s ease-out; }
@media (prefers-reduced-motion: reduce) {
  .day-collapse, .day-collapse-content { transition-duration: .01ms; }
}
```
**Travel time between stops is a per-row computed `distance`** (`trip.component.ts:314-333`), a running haversine from the previous located item in the day, i18n key `view.distance_from_previous = "{{distance}}km from previous"`. It is **not rendered by default** — it is behind the user-togglable `distance` prop (`availableItemProps = ['place','comment','latlng','price','status','distance']`, `:480`). That's a good lesson: heavy metadata is opt-in per user.

---

## 3. Map ↔ list coupling

### 3a. trip-tracker: the best hover-coupling in the set (`services/trip-map.service.ts`)
```ts
highlightExistingMarker(marker: L.Marker): void {
  if (!this.markerClusterGroup) return;
  const markerElement = marker.getElement() as HTMLElement;
  if (markerElement) { markerElement.classList.add('list-hover'); this.highlightedMarkerElement = markerElement }
  else {
    // the pin is inside a cluster — light up the *bubble*, not nothing
    const parentCluster = (this.markerClusterGroup as any).getVisibleParent(marker);
    if (parentCluster) { const clusterEl = parentCluster.getElement(); if (clusterEl) { clusterEl.add('list-hover'); … } }
  }
}
```
Wired from the list: `(mouseenter)="onRowEnter(item)" (mouseleave)="onRowLeave()"` (`trip.component.html:398`). CSS makes the cluster go red and the pin grow (`src/styles.scss:195-215`):
```scss
.list-hover {
  z-index: 9001 !important;
  .custom-cluster { background-color: red; }
  .marker-anchor { z-index: 9005 !important; width: 54px; height: 54px; border-radius: 50%;
                    border: 3px solid #222 !important;
                    box-shadow: 0 0 0 3px rgba(15,15,35,.25), 0 4px 12px rgba(22,22,22,.25); }
}
```
And the day-highlight mode dims everything else (`:117-126`):
```scss
.leaflet-tripday-pane-highlighting .leaflet-marker-pane
  .leaflet-marker-icon:not(.active-trip-place):not(.active-trip-marker) { opacity: .55 !important; }
.leaflet-tripday-pane-highlighting .leaflet-marker-pane
  .active-trip-place, … .active-trip-marker { opacity: 1 !important; z-index: 1001 !important; }
```
triggered by a class on the map *container* and a per-day coloured animated polyline set:
```ts
// trip-map.service.ts:196-220
const layerGroup = L.featureGroup();
data.paths.forEach(p => layerGroup.addLayer(L.polyline(p.coords, {
  color: p.options.color, weight: p.options.weight,
  className: 'animated-path', smoothFactor: 1.5 })));
…
requestAnimationFrame(() => { …; map.fitBounds(data.bounds, { padding: [30, 30], maxZoom: 16 }) });
```
Per-day colour ramp: `HIGHLIGHT_COLORS[idx % HIGHLIGHT_COLORS.length]`, single day = hard-coded `'#0000FF'` (`trip.component.ts:455-463`). Dash animation (`styles.scss:112-116, 130-134`): `stroke-dasharray: 3 20; animation: dash 20s linear infinite;` → `stroke-dashoffset: -1000`.

Cluster factory (`src/app/shared/map.ts:57-72`) — the copyable options set:
```ts
L.markerClusterGroup({
  chunkedLoading: true, disableClusteringAtZoom: 11, showCoverageOnHover: false,
  maxClusterRadius: 50,
  iconCreateFunction: cluster => L.divIcon({
    html: `<div class="custom-cluster">${cluster.getChildCount()}</div>`,
    className: '', iconSize: [40, 40] }),
});
```

### 3b. TREK: `revealInCluster` — selection *opens* the cluster (`components/Map/markerCluster.ts`)
```ts
export const CLUSTER_UNTIL_ZOOM = 9
export const CLUSTER_RADIUS_PX = 20
export const CLUSTER_OPTIONS = {
  chunkedLoading: true, chunkInterval: 30, chunkDelay: 0,
  maxClusterRadius: (zoom) => (zoom < CLUSTER_UNTIL_ZOOM ? CLUSTER_RADIUS_PX : STACK_RADIUS_PX),
  spiderfyOnMaxZoom: true, spiderfyDistanceMultiplier: 1.6,
  showCoverageOnHover: false, zoomToBoundsOnClick: true, animate: false,
}
export function revealInCluster(group, marker): boolean {
  const parent = group.getVisibleParent(marker) as { spiderfy?: () => void } | null
  if (!parent || parent === marker || typeof parent.spiderfy !== 'function') return false
  parent.spiderfy()
  return true
}
```
The comment above it is the design lesson: *"Picking a stop from the places rail used to raise its pin out of the stack with a z-index. A stop sharing its coordinates now sits in a cluster and has no pin of its own to raise, so the bubble has to open for the selection to be visible at all. Deliberately not `zoomToShowLayer`: the zoom belongs to the day fit, and the selection only ever pans."*
Cluster bubble sizes by count (`createClusterIcon`): `<10 → 36px, <50 → 42px, else 48px`.
Hover is a **cursor-following card**, `pointerEvents: 'none'`, name + rating + category icon + address (`PlaceHoverCard.tsx:33-70`), with a nice touch: `{Number.isInteger(rating) ? rating : rating.toFixed(1)}` — *"One decimal only when it earns it: '4' reads faster than '4.0'."*

### 3c. AdventureLog: MapLibre native clustering + click-to-expand (`FullMap.svelte`)
```svelte
<GeoJSON id={sourceId} data={effectiveGeoJson} cluster={clusterOptions} generateId>
  <CircleLayer applyToClusters hoverCursor="pointer" paint={resolvedClusterCirclePaint} on:click={handleClusterClick} />
  <MarkerLayer applyToClusters let:feature={clusterFeature}>…{count}…</MarkerLayer>   <!-- HTML count, not a glyph -->
  <MarkerLayer applyToClusters={false} on:click={handleMarkerLayerClick} let:feature={featureData}> <slot name="marker" …/> </MarkerLayer>
</GeoJSON>
```
Defaults `clusterOptions = { radius: 300, maxZoom: 8, minPoints: 2 }` (`:63`); the map page tightens it to `{ radius: 300, maxZoom: 8, minPoints: 2 }` (`routes/map/+page.svelte:132`).
Click-to-expand uses the documented source API (`:237-260`):
```ts
geoJsonSource.getClusterExpansionZoom(Number(clusterId), (error, zoomLevel) => eventMap.easeTo({ center, zoom: zoomLevel }));
```
**Cluster colour/radius scale by count, themed from daisyUI tokens** (`:192-207`):
```js
'circle-color':    ['step', ['get','point_count'], withAlpha(clusterInfo,.7),   25, withAlpha(clusterWarning,.7), 80, withAlpha(clusterError,.65)]
'circle-radius':   ['step', ['get','point_count'], 22, 20, 32, 60, 44]
'circle-opacity':  1, 'circle-stroke-color': withAlpha(clusterBaseContent,.25), 'circle-stroke-width': 2, 'circle-blur': 0
```
and matching `text-color` uses each fill's **`*-content`** pair with a hairline halo (`:215-228`).
**Cluster counts are rendered as HTML `<MarkerLayer>`, not as a symbol** — comment at `:321`: *"Render cluster counts as HTML so they don't depend on map glyph/font availability."* That is a genuinely important robustness decision for India/SEA deployments where the glyph endpoint may be blocked.
`fitBounds` is re-run only on a real bounds change, keyed by a string (`:196-199`): `const boundsKey = \`${minLon},${minLat},${maxLon},${maxLat}\``, and degenerate single-point bounds fall back to `easeTo({center, zoom: Math.max(zoom, effectiveFitMaxZoom), duration: 1000})`.
Level-aware max zoom (`:47`): `fitMaxZooms = { country: 4, region: 7, city: 12 }`.

**Geofencing** — a real radius circle (`MapNearbyRadiusLayer.svelte`):
```svelte
<GeoJSON id="map-nearby-radius" data={circleData}>
  <FillLayer paint={{ 'fill-color': '#6366f1', 'fill-opacity': 0.1 }} />
  <LineLayer paint={{ 'line-color': '#6366f1', 'line-width': 2, 'line-opacity': 0.55, 'line-dasharray': [2,2] }} />
</GeoJSON>
```

**Route lines** — three distinguishable classes in `CollectionMap.svelte:1109-1150`:
```js
// walking/activity path — per-feature colour from the feature
'line-color': ['coalesce', ['get','_color'], '#60a5fa'], 'line-width': 3, 'line-opacity': 0.9
// trails
'line-color': '#a855f7', 'line-width': 3, 'line-opacity': 0.85
// transport
'line-color': ['coalesce', ['get','_color'], '#f59e0b'], 'line-width': 2.5, 'line-opacity': 0.85, 'line-dasharray': [4,3]
```
`['coalesce', ['get','_color'], fallback]` is the pattern to copy: a per-feature colour with a safe default.

**Marker z-index discipline** (`FullMap.svelte:388-406`) — worth copying verbatim:
```css
:global(.maplibregl-popup) { z-index: 2147483647 !important; }
:global(.maplibregl-marker) { z-index: 1 !important; }
:global(.maplibregl-marker.map-pin-active) { z-index: 2147483000 !important; }
```
plus the style-change nonce trick (`:110-135`): when the basemap style changes MapLibre drops all custom sources/layers, so they `{#key styleNonce}` around the whole GeoJSON subtree and bump the nonce on `style.load`.

### 3d. NomadNote: `flyTo` on selection, `fitBounds` on data change
```tsx
// MapView.tsx:149-183
const bounds = new maplibre.LngLatBounds();
withCoords.forEach(p => bounds.extend([p.longitude!, p.latitude!]));
mapRef.current!.fitBounds(bounds, { padding: 60, duration: 1000, maxZoom: 15 });
…
mapRef.current.flyTo({ center: [place.longitude, place.latitude],
                       zoom: Math.max(mapRef.current.getZoom(), 15), duration: 600 });
```
Dep is `places.length` only (`:171`) so re-sorting doesn't re-fly. Single point → `flyTo({zoom:14, duration:1000})`. Selection class is toggled on the marker element, not by re-creating it (`:118`, `:140`): `el.classList.toggle("active", selectedPlaceId === place.id)`, styled as `scale(1.15)` + a primary glow (`app/globals.css:152-155`).
Layout coupling is **split-pane on desktop, single-pane on mobile** (`app/trips/page.tsx:251-282`): `flex min-h-[70vh] flex-col md:flex-row`, map `min-h-[50vh] flex-1`, and the selected place's card in a `md:w-80` side column.
Map has three explicit states: `"Loading map…"` (pulsing, `MapView.tsx:261`), `"Map ready"` badge (`:234`), and a full error card with a **Retry** button that bumps `retryKey` and re-runs the effect (`:238-258`).

### 3e. maplibre-gl-js internals worth knowing
- `ui/marker.ts:1068` — `this._opacityWhenCovered = '0.2'` by default; `:690` toggles `maplibregl-marker-covered`. Gives you free "behind terrain" dimming.
- `ui/camera.ts:611-621` — `fitBounds` padding accepts `number | {top,bottom,left,right}`; `extend(defaultPadding, options.padding)`. **Use asymmetric padding** when a bottom sheet covers the map.
- `ui/map.ts:3918-3931` — `setFeatureState(feature, state)` for declarative highlight (better than marker-class juggling for layer-based POIs).
- `ui/anchor.ts:8-22` — `PositionAnchor` = `center|top|bottom|left|right|top-left|top-right|bottom-left|bottom-right`, mapped to `translate()` strings and applied as `maplibregl-marker-anchor-<x>` / `maplibregl-popup-anchor-<x>` classes. Style via those classes, not inline transforms.

### "Many POIs at low zoom" — summary of the four strategies found
1. **Native MapLibre clustering** with a `step` colour/radius scale + HTML count labels (AdventureLog).
2. **Leaflet.markercluster with zoom-dependent radius + spiderfy on max zoom** (TREK) — the only one that handles *coincident* points (several stops at one address, e.g. a hotel with 4 activities).
3. **`disableClusteringAtZoom: 11` + `chunkedLoading: true`** (trip-tracker) — simplest, and `chunkedLoading` is the one people forget; without it a 5 000-POI drop janks the main thread.
4. **Fit-level-aware max zoom** `{country:4, region:7, city:12}` so a global view doesn't zoom to a city.

---

## 4. Confidence / constraint surfacing

### 4a. NomadNote Trip Stress Radar — full spec (`components/TripStressRadar.tsx`)

**Composite score** (`:142`):
```ts
const score = Math.round(clamp(
    overload * 0.25 + pinDebt * 0.18 + weatherRisk * 0.14 + fomoRisk * 0.13
  + spreadRisk * 0.12 + reservationRisk * 0.08 + transitComplexity * 0.1));
```
**The seven raw dimensions** (`:135-141`):
```ts
const transitComplexity = clamp((neighborhoods.size - Math.max(2, tripDays)) * 15
                             + Math.max(0, spreadKm - 10) * 2.5 + (mappedRatio < 0.7 ? 16 : 0))
const overload           = clamp((averageStops - 2.5) * 28)
const pinDebt            = clamp((1 - mappedRatio) * 100)
const weatherRisk        = clamp((0.45 - rainyRatio) * 170)
const fomoRisk           = places.length < 4 ? 0 : clamp((essentialCount - Math.max(1, tripDays)) * 18
                                                     + Math.max(0, mustSeeRatio - 0.5) * 55)
const spreadRisk         = clamp((neighborhoods.size - 2) * 18 + Math.max(0, spreadKm - 8) * 2)
// reservationRisk: regex over title+notes+tags+category, plus (restaurant && (evening || priority<=2))  (:267-277)
```

**Label / headline mapping** (`:170-176`) — exact strings:
| score | Badge variant | label | headline |
|---|---|---|---|
| ≥ 68 | `warning` | `High friction` | `This plan is drifting into vacation homework.` |
| ≥ 38 | `secondary` | `Needs tuning` | `Good trip, a few reality checks needed.` |
| else | `success` | `Trip feels sane` | `This looks like a plan a human could enjoy.` |

**Confidence** (`:248-254`) — a *separate* 3-state badge, and the copy is `{confidence} confidence · updated {lastUpdated}` (`:55`):
```ts
if (!hasDates || places.length < 3) return "Low"
if (mappedCount < Math.ceil(places.length * 0.6)) return "Medium"
return "High"
```
`formatRelativeUpdate` (`:256-265`): `"just now"` < 2 min, `"{m}m ago"` < 60, `"{h}h ago"` < 24, else `"{d}d ago"`.

**The "next repair" rescue** (`:156-164`) — one sentence, always the worst factor. Exact strings:
```
overload:           "Rescue move: make one low-priority stop a backup for each packed day."
mapReadiness:       "Rescue move: pin unmapped saves before trusting the itinerary builder."
weatherRisk:        "Rescue move: add {max(1,ceil(tripDays/3))} indoor backup{s} near your densest neighborhood."
fomoRisk:           "Rescue move: choose one anchor must-see per day and let the rest orbit it."
spreadRisk:         "Rescue move: split days by neighborhood instead of category."
reservationRisk:    "Rescue move: mark ticketed dinners, shows, and tours before you build the final day plan."
transitComplexity:  "Rescue move: make each day a walkable neighborhood loop before adding cross-town stops."
```

**Seven factor cards** — label / value / icon / `note` / `title=definition` / action label (`:178-244`), verbatim:
| factor | note (real copy) | action label | polarity |
|---|---|---|---|
| Overload | `"{n} stops per day is a lot."` when ≥4, else `"Daily density looks humane."` | `Thin busy days` / `Keep days humane` (disabled at 0) | risk |
| Map readiness | `"{mapped}/{total} places have coordinates."` | `Fix coordinates` / `Review locations` | **positive** (value = `100 - pinDebt`) |
| Rain risk | `You have {n}; aim for at least {ceil(days/3)} indoor backup{s}.` or `"There are enough weather backups."` | `Add indoor backups` / `Maintain backups` | risk |
| Anchor pressure | `"{n} favorites or anchors may be too many for {d} days."` / `"Priorities are nicely ranked."` | `Reduce essentials` | risk |
| City spread | `"{n} clusters can create backtracking."` / `"Neighborhood spread is contained."` | `See clusters` | risk |
| Reservation risk | `"Likely booking-sensitive stops need confirmation."` / `"Few stops look reservation-sensitive."` | `Check bookings` | risk |
| Transit complexity | `"Cross-town clusters may make days fragile."` / `"The route shape is workable."` | `Make loops` | risk |

**Per-factor bar colour depends on polarity** (`:74-83`) — the small detail that makes a score legible:
```tsx
factor.positive
  ? (factor.value >= 70 ? "bg-secondary" : factor.value >= 40 ? "bg-accent" : "bg-destructive")
  : (factor.value >= 70 ? "bg-destructive" : factor.value >= 40 ? "bg-accent" : "bg-secondary")
```

**The dial** (`:101-118`) — a `conic-gradient` donut, angle = `score/100 * 360`, 80px→96px, 2px border, `4px 4px 0` hard shadow, with the number in `tabular-nums` and a `text-[9px] uppercase tracking-wide` caption reading literally **`stress`**.

Sub-copy that sells it (`:43`):
> "Most planners help you add more. This one spots what will make the trip feel bad, then gives you the next repair."

Badges for the whole widget (`:37-40`): a `border-2 border-foreground bg-primary` stamp with `font-mono-custom text-[10px] uppercase tracking-[0.14em]` reading **"NomadNote exclusive"** and a `Sparkles` icon.

**Downstream: the action panel** (`components/TripBrief.tsx:111-188`). Clicking a factor's button sets `focus` and opens a `RadarActionPanel` with title / body / a chip list of the offending items / a primary action. Real copy:
```
coordinates:   title "Places missing coordinates"      body "Add an address or pin before asking NomadNote to make a realistic route." / "Every place is map-ready."   action "Add place details"
indoor:        title "Rainy-day backup builder"         body "{n} indoor backup{s} saved. Add museum, cafe, gallery, or bookstore options near your busiest cluster."  list ["Museum","Cafe","Gallery","Bookstore"]  action "Add indoor place"
essentials:    title "Favorites and anchors"            body "Keep one or two anchors per day, then let the itinerary flex around them."  action "Review anchors"
neighborhoods: title "Neighborhood clusters"            body "Use the largest clusters as walkable day loops before adding cross-town stops."  action "Plan loops"
reservations:  title "Booking-sensitive stops"          body "These look like places where a reservation, ticket, or timed entry could matter."  action "Track reservations"
transit:       title "Street-to-street sanity"          body "If a day crosses too many clusters, make the first version neighborhood-based and only then add favorites."  action "Make loops"
```

And the `Signal` companion cards (`TripBrief.tsx:78-89`) — a good/bad tone pair with real copy:
```
"{mapped}/{total} places mapped" → "Your map is ready for routing and neighborhood planning." | "Add pins to unmapped saves for better itinerary grouping."
"Overload risk" (avgStops ≥ 5)  → "Average day has five or more stops. Move one low-priority place into a backup list."
"Route looks workable"          → "Your itinerary density is reasonable for a real travel day."
```
Plus a `Badge` reading `"Packed"` / `"Healthy pace"` (`:54-56`).

`Travel pain score` — a 10-dot meter (`ItineraryBuilder.tsx:396-406`):
```tsx
<span className="text-xs text-muted-foreground">Travel pain score:</span>
<div className="flex gap-0.5">
  {Array.from({ length: 10 }, (_, i) => (
    <div key={i} className={cn("h-2 w-2 rounded-full", i < painScore ? "bg-destructive" : "bg-muted")} />))}
</div>
<span className="text-xs text-muted-foreground">{painScore}/10</span>
```
`travelTimePainScore` (`features/itinerary/algorithm.ts:487-495`): every leg > 20 min adds `(min-20)/10`, capped at 10.

`analyzeTrip()` insight cards (`:414-475`) — icon emoji + title + description, real strings:
```
⚡ "Overloaded itinerary"      "{n} places in {d} days — that's {r} per day. Consider a slow or balanced pace."
🔍 "Some days may be light"    "You have {d} days but only {n} places saved. Add more spots or use slow mode."
👯 "Possible duplicates"       "Found {n} possible duplicate place(s). Check your list before building the itinerary."
📍 "{n} place(s) missing location"  "Places without coordinates won't appear on the map or be included in the auto-itinerary."
🌟 "Best first day picks"      "Start strong: {names}"
```

Per-item "why" (`:264-310`): every suggested item carries `reason: "Locked to this day" | "Grouped with nearby places in cluster"` and a `score`, plus `explanations[].placementReasons[placeId]`. That is the *"why is this recommended"* primitive, done cheaply.

### 4b. plan-it: crowd level (4 thresholds, 1-10)
`static/js/app.js:696-708`:
```js
if (level >= 8)      { label = t("crowd.packed");    colorClass = "crowd-high" }
else if (level >= 6) { label = t("crowd.busy");      colorClass = "crowd-med"  }
else if (level >= 4) { label = t("crowd.moderate"); colorClass = "crowd-low"  }
else                 { label = t("crowd.light");    colorClass = "crowd-low"  }
return '<div class="crowd-banner ' + colorClass + '"><span class="crowd-banner-icon">&#128205;</span><span>' +
  t("crowd.predictedCrowd", {level}) + ' — ' + label + '</span></div>';
```
Copy (`static/js/i18n.js:143-147`): `"Predicted crowd: {level}/10"`, `"Packed — expect long waits"`, `"Busy — plan ahead"`, `"Moderate — good day to visit"`, `"Light — enjoy short lines"`.
Backend tips (`app/engine/crowd.py:52-70`):
```
≥8: "⚠ Peak crowd day — arrive 60+ minutes before opening for best results"
    "⚠ Use single-rider lines where available to cut wait times 50-70%"
    "⚠ Book dining reservations in advance — walk-up waits exceed 60 min"
≥6: "Busy day expected — arrive 30 minutes before opening"
    "Hit the most popular attractions in the first 2 hours"
≥4: "Moderate crowds — a good day to visit"
else: "Light crowds expected — a great day to explore at your own pace"
```
`StatsGrid` (`:710-735`): 4 tiles `Departure / Stops / High Priority / Venue`. `TotalsBar` (`:1010-1018`): `Total Walking: {n} min`, `Total Waiting: {n} min`.
`Alerts` section `:864-878` renders `⚠ {text}` rows; `Strategy` section `:880-894` renders `💡 {text}`. Copy from the planner (`app/engine/planner.py:199-201`): `"🛂 International travel: ensure passports are valid for 6+ months beyond your return date"`, `"💱 Check exchange rates and notify your bank of travel dates"`, alert `"✈ International flight — arrive at the airport 3 hours before departure"`.
LLM confidence gate (`:365-375`): `if (llm_result.get("confidence", 0) >= 0.5)` else "falling back to regex" — a *silent* fallback, which is the one thing ATHITI should **not** copy (an AI-generated plan that silently reverted to a regex is exactly the kind of thing a family needs to know).

### 4c. TREK: verdict panel + warning banner
- `JourneyDetailPageVerdictSection.tsx` — a two-column pros/cons "verdict" with a divider-line header, collapsed-to-counts on mobile, `journey.verdict.lovedIt` / `journey.verdict.couldBeBetter`, and a `md:pointer-events-none` header so the whole thing is a disclosure on mobile only.
- `TripWarningsBanner.tsx:19-22` — three levels with paired soft tokens:
```ts
const STYLE = {
  info:    { Icon: Info,         color: 'var(--info)',    bg: 'var(--info-soft)' },
  warning: { Icon: AlertTriangle, color: 'var(--warning)', bg: 'var(--warning-soft)' },
  error:   { Icon: AlertCircle,  color: 'var(--danger)',  bg: 'var(--danger-soft)' },
}
```
and a placement rule worth copying: *"a warning from a plugin that owns a trip-page tab renders as a compact chip in the navbar centre (click jumps to that tab); all other warnings float above the content at the BOTTOM of the planner, so neither kind ever covers the map toolbar or displaces the working area up top."* It `return null`s when there are none, so it takes no space.

### 4d. A fit-score: NOT FOUND
**NOT FOUND in plan-it, AdventureLog, trip-tracker, nomadnote, TREK.** None of them compute a per-POI "fits your constraints" score. TREK has per-*day* `dayColors` and a route overview; AdventureLog has `recommendation_ratings`; but nothing scores an individual experience against a user's stated budget/time/group. **This is ATHITI's genuine differentiator** and it has no reference implementation to copy — it must be designed from scratch.

---

## 5. Result cards

### NomadNote `PlaceCard` (`components/PlaceCard.tsx`) — order of metadata
`[32px category tile w/ emoji] | [title, line-through+muted if visited] [neighborhood, city w/ pin] | [♥ favourite] [⋯ menu]`
→ optional `notes` `line-clamp-2`
→ a single `flex flex-wrap gap-1.5` metadata row, in this exact order:
```tsx
<Badge variant="secondary">{CATEGORY_LABELS[place.category]}</Badge>
<span>{PRICE_LABELS[place.priceLevel]}</span>                      {/* "Free | Budget | Moderate | Expensive | Luxury" */}
<span><Clock/>{formatMinutes(place.estimatedDurationMinutes)}</span> {/* "45m" | "1h 30m" */}
{place.bestTimeOfDay !== "anytime" && <span>{TIME_ICONS[place.bestTimeOfDay]}</span>}
{place.priority === 1 && <Badge variant="default"><Star className="fill-current"/>Must</Badge>}
```
→ `tags.slice(0,4)` as `#tag` pills
→ visited state: whole card `opacity-75`, title `line-through text-muted-foreground`, plus an absolute top-right `Check` badge.
Selection: `selected ? "border-primary/50 ring-1 ring-primary/30 shadow-md" : "border-border hover:…"` and the whole card is a click target (`onClick={() => setSelectedPlace(place.id)}`).
Hover-revealed actions: `opacity-100 sm:opacity-0 sm:group-hover:opacity-100` (heart + ⋯). Menu items: `Edit` / `Mark visited|unvisited` / `Open source` (only if `sourceUrl`) / separator / `Delete` (destructive).
Enter animation: `framer-motion` `layout` + `initial {opacity:0,y:8} animate {opacity:1,y:0} exit {opacity:0,scale:.96}` 200 ms.

**What is NOT on the card:** no rating, no distance-from-you, no "fits your 2h" indicator, no accessibility. That gap is ATHITI's opportunity.

### AdventureLog `LocationCard` (`cards/LocationCard.svelte:592-635`) — inline stats strip
```svelte
{#if adventure.location}  <MapMarker class="w-4 h-4 text-primary"/><span class="truncate max-w-[18rem]">{adventure.location}</span>
{#if adventure.rating}
  … 5 Star / StarOutline icons with `text-warning fill-current` / `StarOutline` …
  <span class="text-xs text-base-content/60">({adventure.rating}/5)</span>
{#if adventurePriceLabel}
  <span class="badge badge-ghost badge-sm whitespace-nowrap">💰 {adventurePriceLabel}</span>
…tags as badge-ghost badge-sm, overflow as `+{remainingCount}`
```
Location-first ordering: **name → category badge → image carousel → location → rating → price → tags.**

### trip-tracker `place-list-item` — accessibility chips (the ATHITI-relevant one)
```html
<span class="…"
  [class]="place.allowdog ? 'bg-emerald-100 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-400'
                        : 'bg-primary-100 text-primary-600 dark:bg-primary-800 dark:text-primary-500'">🐶</span>
… 🚽 with sky-* colours …
… visited: `pi-eye` in `bg-blue-100 text-blue-700` else `pi-eye-slash` in `bg-primary-100` …
<span [style.--color-bg-opacity]="place.category.color" class="color-bg-opacity …">{{ place.category.name }}</span>
```
and the same trio at a larger size with **text** yes/no in the detail sheet (`place-box-content.component.html:19-43`):
```html
<span class="bg-green-100/80 text-green-800 … dark:bg-green-900/50 dark:text-green-300">🐶 {{ t('yes') }}</span>
<span class="bg-red-100/80  text-red-800  … dark:bg-red-900/50  dark:text-red-300">🚽 {{ t('no')  }}</span>
```
**This is the pattern for toddler/family UX: not hide the constraint, badge it green/red with a glyph *and* a word.** A family of 4 with a toddler needs 🚽 Stroller, 🍼, 🌂, 🐶, ♿ all visible on the card, not behind a filter.

The trip-item row metadata order (`trip.component.html:406-497`): `[time chip (mono, primary-tinted)] [place name + 20px category thumbnail] [comment line-clamp-1] … right cluster: [coords chip] [price chip + (paid_by)] [distance km chip] [status pill with category colour]`, and a `pi pi-chevron-right` slide-in on `group-hover`.

### TREK `PlaceHoverCard` + POI pill — the map's card
`ratingBadge.ts` and the pill are described in §3b. The category↔colour contract is the important bit (`components/Map/poiCategories.ts:20-32`):
```ts
export const POI_CATEGORIES: PoiCategory[] = [
  { key: 'restaurant', labelKey: 'poi.cat.restaurants', Icon: Utensils, color: '#EF4444' },
  { key: 'cafe',        labelKey: 'poi.cat.cafes',       Icon: Coffee,   color: '#B45309' },
  { key: 'bar',         labelKey: 'poi.cat.bars',        Icon: Wine,     color: '#A855F7' },
  { key: 'hotel',       labelKey: 'poi.cat.hotels',      Icon: BedDouble, color: HOTEL_COLOR },
  { key: 'sights',      labelKey: 'poi.cat.sights',      Icon: Camera,    color: '#EC4899' },
  { key: 'museum',      labelKey: 'poi.cat.museums',     Icon: Landmark,  color: '#6366F1' },
  { key: 'nature',      labelKey: 'poi.cat.nature',      Icon: Trees,     color: '#16A34A' },
  { key: 'activity',    labelKey: 'poi.cat.activities',  Icon: Ticket,    color: '#F59E0B' },
]
```
Comment at `:7-9`: *"`color` doubles as the active-pill fill AND the marker colour, so the pill and the map agree visually."* — one token, three surfaces.

### TREK `RangeStrip` (`components/Roadtrip/RangeStrip.tsx`) — the best "constraint visual" I found
A horizontal bar, cut into **blocks of a fixed real-world distance** rather than percent:
```ts
const BLOCK_KM = 50
export function blockMask(rangeKm) {
  const blocks = Math.round(rangeKm / BLOCK_KM)
  if (blocks < 3 || blocks > 30) return undefined    // below 3 the cuts read as damage; above 30 they eat the bar
  const step = 100 / blocks
  return `repeating-linear-gradient(90deg, #000 0 calc(${step}% - 2px), transparent calc(${step}% - 2px) ${step}%)`
}
```
Three segments: `filled` (accent gradient) / `rest` (surface) / `wear` (a `repeating-linear-gradient(135deg, var(--border-primary) 0 3px, transparent 3px 6px)` hatch). The mask is applied via `maskImage`/`WebkitMaskImage` so it makes **real holes** (comment: *"Cut as a MASK rather than painted over: … A mask makes real holes, so whatever is behind the bar shows through and nothing has to know the background."*).
The bar is `role="img"` with `aria-label="{value} {unit} — {note}"`, and the note chips repeat each reading in prose: `t('roadtrip.limit.afterFill', {percent, distance})`, `t('roadtrip.limit.blockNote', {distance})`, `t('roadtrip.limit.wearNote', {percent})`, plus a swatch tying the hatch chip to the bar tail.
Comment worth stealing: *"the bar for a 240 km car is visibly shorter than the bar for a 600 km one, which is the comparison somebody typing a consumption is actually making — and it turns the bar into something countable rather than something to eyeball."*
**Direct ATHITI translation: cut the time-budget bar into blocks of 30 real minutes. "2h budget" then renders as exactly 4 blocks, and 3h20m of plans visibly overflow the 4th. That is countable, not eyeballed.**

---

## 6. Input & filtering UX

### NomadNote `FilterBar` — two-tier chips with a live count badge
Collapsed row: `[⚙ Filters (n)] [6 quick category pills] [✕ Clear]`, horizontally scrollable, `overflow-x-auto no-scrollbar`.
Badge count (`:64-68`):
```tsx
<span className="bg-primary-foreground/20 text-primary-foreground rounded-full w-4 h-4 text-xs flex items-center justify-center font-bold">
  {filters.categories.length + filters.priceLevel.length + filters.timeOfDay.length
   + (filters.favorites ? 1 : 0) + (filters.freeOnly ? 1 : 0)}
</span>
```
Expanded panel: three labelled chip groups (`Category`, `Price`, `Best time`) + a flags row. All real labels:
- **Category (13, `FilterBar.tsx:13-16`)**: `restaurant, cafe, bar, accommodation, attraction, museum, park, beach, market, viewpoint, nightlife, shopping, nature` → `CATEGORY_LABELS` gives `Restaurant, Café, Bar, Stay, Attraction, Museum, Park, Shopping, Transport, Viewpoint, Beach, Nightlife, Market, Street, Religious, Nature, Entertainment, Health, Other` (`lib/utils.ts:85-105`). Note `accommodation → "Stay"`, not "Hotel" — a rename for the traveller's vocabulary.
- **Price (5)**: `Free, Budget, Moderate, Expensive, Luxury` (`lib/utils.ts:107-113`), with `PRICE_LEVEL_MULTIPLIER = {free:0,budget:1,moderate:2,expensive:3,luxury:4}` for the maths.
- **Best time (4)**: `morning, afternoon, evening, night` with emoji `🌅 ☀️ 🌆 🌙` (`lib/utils.ts:170-176`).
- **Flags (4, `:169-173`)**: `"❤️ Favorites"`, `"🆓 Free only"`, `"✅ Visited"`, `"🔲 Unvisited"`.
Chip active state: `bg-primary text-primary-foreground border-primary`; inactive `bg-card border-border text-muted-foreground hover:border-primary/40`. Chip shape `rounded-full px-2.5 py-1 text-xs border`.

### NomadNote pacing presets — budget in the label (see §2c)
`Slow (6h/day)` / `Balanced (8h/day)` / `Packed (11h/day)` with icons `Coffee / Sun / Zap`. This is ATHITI's "how much do you want to do" control, done in 6 words.

### AdventureLog `MapSearchBar` — 3-mode segmented control
`modes = [{id:'my', labelKey:'map.search_mode_my'}, {id:'places', …}, {id:'nearby', …}]` rendered as `role="tablist" aria-label={$t('map.search_locations')}` with `role="tab" aria-selected={mode===m.id}` and responsive label hiding:
```svelte
<span class="truncate text-[10px] min-[380px]:text-[11px] sm:text-sm leading-none max-[379px]:sr-only">
```
That's the single best responsive-label trick in the set: **container-query breakpoints (`min-[380px]`) rather than viewport breakpoints**, so the control works at any width.
Labels: `My` / `Places` / `Nearby`. Placeholder `"Search for a place to add..."`. Nearby hint: **"Pan the map, then tap Search this area at the top of the map."**
Debounce is 300 ms **and** it refuses to fire under 3 characters (`:77-83`), with `onMount(() => () => clearTimeout(searchTimeout))`.
Radius options (`:234-250`), metric/imperial:
```
[1000 '1 km'], [2000 '2 km'], [5000 '5 km'], [10000 '10 km'], [20000 '20 km'], [50000 '50 km']
// imperial: [1609 '1 mi'], …
```
Nearby panel: two `<select>`s (`Category`: `🏛️ Tourism` / `🍴 Food` / `🏨 Lodging`; `Search radius`) and a full-width `Search this area` button. `showSearchThisArea` re-arms when you pan more than 0.002° in either axis or the result set is empty (`:556-560`).

### AdventureLog quick-filter chips on the map
```html
{#if showVisited}  <input type="checkbox" class="checkbox checkbox-success checkbox-sm"/> <span>{visited} ({visitedAdventures})</span>
{#if showPlanned} <input type="checkbox" class="checkbox checkbox-info checkbox-sm"/>    <span>{planned} ({plannedAdventures})</span>
{#if showRegions} <input type="checkbox" class="checkbox checkbox-accent checkbox-sm"/>   …
{#if showCities}  <input type="checkbox" class="checkbox checkbox-warning checkbox-sm"/> …
```
**Putting the count in the label of the toggle is a genuinely good ATHITI pattern**: "Visited (12)", "Planned (5)" tells you what toggling will do.

### TREK `PoiCategoryPill` — frosted icon-only segmented control
`PoiCategoryPill.tsx`: `border-radius: 999`, `backdropFilter: 'blur(20px) saturate(180%)'`, `padding: 4, gap: 2`, each segment `34×34` (`width: 'auto', flexGrow: 1` when `fullWidth`), label lives only in a Tooltip, `aria-pressed={on}`, `aria-label={t(cat.labelKey)}`. Active segment fills with `cat.color`.
Two extra affordances worth stealing:
- **per-segment loading spinner** that replaces the icon, and *only* when the segment is active (`const loading = on && !!loadingKeys?.has(cat.key)`);
- **per-segment error dot** (a 8px red dot top-right with a `var(--sidebar-bg)` ring), which then makes a single `RotateCw "Search this area"` button appear — the bar tells you *which* categories failed, not just that something did.

### TREK `CollectionFilterBar` — compact dropdowns with counts
`Dropdown` is a 30-line click-away + `Escape` popover with `role="listbox"` / `role="option"` / `aria-selected`, each option ending in either a count chip `<span class="col-filter-count">{o.count}</span>` or a `Check`. Options are `{key,label,icon,count}`. Rating filter is a minimum-rating ladder: `All`, then `5+ 4+ 3+ 2+ 1+` with a yellow `Star` icon. Sort: `default` / `name_asc`. Status: `All` + `Idea / Want / Visited` each with an icon in its status colour and a count.

### plan-it natural-language bar (the only true NL input)
`static/app.html:113-162`:
```html
<label class="form-label" for="trip-input" data-i18n="newTrip.whatsYourTrip">What's your trip?</label>
<textarea id="trip-input" class="form-textarea" rows="8" …>
```
Placeholder + hint (real copy, `i18n.js:53-54`):
> "e.g. Drive to Kennedy Space Center from Orlando tomorrow — stop for lunch, stay overnight at a hotel near Cocoa Beach, and drive back the next morning. Need long-term parking at KSC."
> "Include as many details as possible — venue, date, mode of travel (drive/fly), meal stops, hotel stays, long-term parking, return trip, and any special interests. The more details you provide, the better your itinerary."

Supporting fields: `Departure Time` (split HH:MM inputs + AM/PM toggle, hint "When you plan to leave. Enter the time and select AM or PM."), `Starting Location (Street Address, City, State, Zip Code)` (hint: "Required if provided — must include street address, city, state, and zip code, separated by commas."), `Restaurant Preferences` (hint "Diet, cuisine, or price preferences for meal stops."), and a checked-by-default `Remind me 15 minutes before each stop` with hint "Sets a default reminder for every schedule item. You can adjust individual reminders after generating."

**The four address validation messages are the most useful part** (`i18n.js:194-199`) — they teach the format instead of rejecting:
```
"Address is missing city and state — use a comma between them (e.g. \"Orlando, Florida\")."
"Please enter a full address with commas: street, city, state, zip (e.g. \"9801 International Dr, Orlando, Florida 32819\")."
"Address is missing a street number (e.g. \"9801 International Dr, Orlando, Florida 32819\")."
"Address is missing a 5-digit zip code (e.g. \"32819\")."
"Address is missing street, city, state, or zip. Use commas: street, city, state, zip."
```

### ATHITI gap
**No repo has a group-size or child-age input. NOT FOUND anywhere.** `face of a toddler` is unrepresented. The closest is trip-tracker's dog-yes/no toggle.

---

## 7. Empty / loading / error / zero-result states

This is the section ATHITI cares about most. Every real string I found:

### Zero-result phrasing (the "unmet demand" log)
| Repo:line | Exact string | Notes |
|---|---|---|
| `AdventureLog frontend/src/locales/en.json` `map.no_results` | **"No places found"** | flat, unhelpful |
| `…map.recommendations_empty` | **"No recommendations in this area. Try a larger radius."** | ✅ **the best one — it names a recovery action** |
| `…map.search_error` | "Search failed. Try again later." | |
| `…map.select_on_map` | "Select a pin or search result to see details." | idle-state instruction |
| `…map.loading_details` | "Loading details..." | |
| `…map.no_locations_to_explore` | "No locations on the map to explore." | |
| `…map.geolocation_unavailable` / `_denied` | "Location is not available in this browser." / "Location access was denied." | two distinct messages for two distinct causes ✅ |
| `…map.fullscreen_failed` | "Could not toggle fullscreen." | |
| `…search.places_min_chars` | "Type at least 3 characters to search places." | ✅ explains the *reason for the silence* |
| `…search.try_searching_desc` | "Try searching for locations, collections, notes, transport, countries, regions, cities, or users." | ✅ names the corpus |
| `…search.no_actions` | "No matching quick actions." | |
| `…search.empty_prompt_title` / `_desc` | "Search your AdventureLog" / "Find locations, collections, notes, transport, world travel destinations, and users from one place." | ✅ empty *search* state has a title AND a description |
| `…search.retry` / `load_more` | "Retry" / "Load more" | |
| `nomadnote app/trips/page.tsx:208` | `{filters.search ? "No places match your search" : "No places yet — add your first one!"}` | ✅ **branches on cause** — the two are genuinely different CTAs |
| `nomadnote components/CommandPalette.tsx:62` | "No results found" | |
| `nomadnote components/ItineraryBuilder.tsx:289` | `toast.info("No local coordinate matches found yet. Add city or country to the remaining items.")` | ✅ says what to do |
| `nomadnote components/ItineraryBuilder.tsx:384` | `"Not enough trip data yet for meaningful insights."` / `"Build an itinerary first to see insights."` | ✅ two different states of the *same* panel |
| `nomadnote app/trips/page.tsx:83,90` | `toast.info("No unvisited places left!")` / `toast.info("No indoor places saved yet")` | |
| `nomadnote app/trips/page.tsx:377` | "No indoor places saved yet. Add a museum, cafe, gallery, or bookstore backup near your busiest neighborhood." | ✅ + 3 suggestion buttons: `"Museum near me"`, `"Cafe near hotel"`, `"Gallery near downtown"` |
| `nomadnote components/TripBrief.tsx:133,139,151` | "No indoor backups yet. Add museum, cafe, gallery, or bookstore options before the weather decides for you." / "No overloaded anchors yet." / "No obvious booking-sensitive stops found." | ✅ *"before the weather decides for you"* is a great line |
| `plan-it i18n.js:70,78,113` | "Plan Not Found" / "This plan may have been removed from your session." / "No saved itineraries" / "No schedule items." | |
| `plan-it i18n.js:36` | "No saved itineraries yet" (sidebar) | |
| `trip-tracker public/i18n/en.json` `empty_states` | `nothing_there: "Nothing there."` · `no_plans: "No plans yet"` · `no_days: "No days"` · `no_places: "No places"` · `no_plan: "No plan"` · `no_trips: "No trips"` / `no_trips_desc: "Create a trip"` · `every_place_used: "Every place is used"` · `no_unused_place: "No unused place"` · `checklist_empty: "Your checklist is empty"` / `start_adding: "Start adding items or paste from another trip"` · `packing_list_empty: "Your packing list is empty"` · `no_attachments: "No attachments"` | |
| `AdventureLog itinerary.*` | `no_itinerary_yet: "No Itinerary Yet"` / `start_planning: "Start planning your trip by adding items to specific days."` · `no_plans_for_day: "No plans for this day"` · `unscheduled_items: "Unscheduled Items"` / `unscheduled_items_desc: "These items are linked to this trip but haven't been added to a specific day yet."` · `item_not_found: "Item not found"` · `no_trip_context_items: "No trip context items yet."` · `auto_generate_itinerary_desc: "This collection has dated items but no itinerary yet. Would you like to automatically organize them by date?"` | |
| `AdventureLog search.*` | `results_heading` / `results` / `found` | "Results" + n + "found" |

**Synthesis for ATHITI's unmet-demand log:** the best zero-result pattern found is the *pair* — `(a)` a plain statement, `(b)` one concrete next action, `(c)` 2-3 tappable example queries. NomadNote's Places tab does all three (`app/trips/page.tsx:216-229`):
```tsx
{[
  "Tokyo Station, Tokyo",
  "35.7148, 139.7967",
  "https://www.google.com/maps?q=Senso-ji+Temple+Tokyo",
].map(example => (
  <button … onClick={() => openCaptureWithExample(example)}>
    Try: {example.length > 28 ? `${example.slice(0, 25)}...` : example}
  </button>))}
```
`Try: {a real example}` is a great affordance. For ATHITI, seed the examples with the *actual* unmet demand, e.g. `Try: "playground for a 3-year-old, under 2h, ₹500"`.

### Empty-state DOM patterns
- **Icon + headline + optional body + optional action**, centred, `py-12`:
  ```svelte
  <!-- CollectionItineraryPlanner.svelte:1764-1770 -->
  <div class="card bg-base-200 shadow-xl"><div class="card-body text-center py-12">
    <CalendarBlank class="w-16 h-16 mx-auto mb-4 opacity-50" />
    <h3 class="text-2xl font-bold mb-2">{$t('itinerary.no_itinerary_yet')}</h3>
    <p class="opacity-70">{$t('itinerary.start_planning')}</p>
  </div></div>
  ```
- plan-it: `.empty-state` / `.empty-state-icon` / `.empty-state-title` / `.empty-state-text` (`app.css:1029-1046`).
- trip-tracker: `<h3 class="text-lg font-semibold … mb-2">{t('empty_states.no_plans')}</h3>` **immediately followed by an add button** — the empty state *is* the primary CTA (`trip.component.html:504-512`).

### Loading states
- **Angular control-flow placeholder with a minimum display** — the best of the set, because it prevents a skeleton flash on fast responses:
  ```html
  } @placeholder (minimum 0.15s) {
    … 3 fake day groups, each: <p-skeleton shape="circle" size="2.5rem"/> + 2 skeleton lines, then 2 skeleton item rows …
  }
  ```
  (`trip.component.html:518-541`) — the skeleton is a *structural copy* of the real content: day header (circle + 2 lines) then 2 item rows. Same shape extracted to `shared/trip-skeleton/trip-skeleton.component.html`.
- NomadNote `Skeleton` (`components/ui/skeleton.tsx`) → `.skeleton` class with a shimmer keyframe (`app/globals.css:124-136`):
  ```css
  .skeleton { @apply relative overflow-hidden bg-muted rounded; }
  .skeleton::after { content:''; position:absolute; inset:0;
    background: linear-gradient(90deg, transparent 0%, hsl(var(--muted-foreground)/.1) 50%, transparent 100%);
    animation: shimmer 1.5s infinite; }
  ```
- **Trip-tracker map loader is a bespoke 3-ring sonar ping** over a dark scrim (`trip.component.html:6-15`):
  ```html
  <div class="pointer-events-none absolute inset-0 z-10 flex items-center justify-center bg-primary-950" animate.leave="a-fade-scale">
    <div class="relative flex h-16 w-16 items-center justify-center">
      <span class="absolute inline-flex h-full w-full animate-ping rounded-full bg-white/10"></span>
      <span class="absolute inline-flex h-9 w-9 animate-ping rounded-full bg-white/10 [animation-delay:300ms]"></span>
      <span class="relative inline-flex h-2.5 w-2.5 rounded-full bg-white/80 shadow-[0_0_16px_2px_rgba(255,255,255,.35)]"></span>
  ```
- AdventureLog: `<span class="loading loading-spinner loading-xs"></span>` + `{$t('map.searching')}` inside the same dropdown that will hold results, and `{$t('map.searching_nearby')}` = `"Finding nearby places…"` (ellipsis character, not three dots).
- NomadNote build button: `building ? <><Loader2 className="h-4 w-4 animate-spin mr-2" />Working…</> : …` (`:353-361`) — the button itself becomes the spinner and the label becomes `Working…`.

### Error states
- **NomadNote `MapView`** — a full-surface error card with icon, headline, body, and a real retry:
  ```
  "Map failed to load"  /  "Map failed to load. Check your connection or retry."  /  [⟳ Retry]
  ```
  (`MapView.tsx:240-257`). The retry does `mapRef.current?.remove(); mapRef.current = null; setRetryKey(k => k+1)`.
- **NomadNote import preview** — a `bg-destructive/10 text-destructive` inline message and a *pre-import summary card* with 4 stat tiles: `Days / Schedule / Places / Bookings` (`AppShell.tsx:313-324`), plus a **warning callout before you commit**:
  > "Some imported schedule items do not have coordinates yet. The itinerary still imports, and you can map-match places later." (`AppShell.tsx:321`)
- **trip-tracker batch errors are quantitative** — `messages.*` never says "some failed":
  ```
  "{{success}} plan(s) added, {{failed}} failed — check console for details"
  "{{success}} items updated, {{failed}} items updated"
  "Config updates are applied"
  "Delete {{name}} is used in {{count}} trip(s). Delete anyway?"
  ```
  ✅ The "is used in N trip(s). Delete anyway?" cascade-warning is a good model for "this request will affect N travellers".
- **Destructive confirm** is a modal that names the thing and says "permanently": `Delete {title}?` / "This place will be removed permanently." with `Cancel` / `Delete` at `flex-1` each (`nomadnote app/trips/page.tsx:338-347`).
- `plan-it` distinguishes five time-format errors (`i18n.js:189-193`) — over-specified; don't copy.
- `trip-tracker messages.could_not_parse_gpx` = "Couldn't parse GPX data"; `could_not_load_trip` = "Could not load trip".

### Offline / degraded (worth stealing for a traveller app)
- `nomadnote` settings page ships four honest badges: `No tracking` `No analytics` `No ads` `No server` (`app/settings/page.tsx:63-66`).
- `nomadnote` service-worker register + `public/manifest.json` → installable PWA; `capacitor.config.ts` → iOS/Android wrapper. This is directly relevant: ATHITI should be installable and work offline-ish.
- `TREK` `client/src/index.css:13-33` — an extended comment on phone scroll/overscroll/`overflow-x: clip` (not `hidden`, which creates a scroll container) and `html body { background-color: transparent }` beating the themed `body` rule. Real-world mobile gotchas, documented.

---

## 8. Booking / request / add-to-plan interaction

| Pattern | Where | States |
|---|---|---|
| **"Add" that opens a Quick Action modal, not a form** | `nomadnote AppShell.tsx:268-279` — `Quick action` dialog with 3 `ActionButton`s: `Add place` / "Choose a trip, then paste links or notes." · `New trip` / "Start a fresh private travel workspace." · `Import JSON` / "Preview a local export before merging." Each button is a 2px-bordered card with a 40px icon tile, label, and one-line description. | open/closed |
| **"Choose a trip" as a first-class step** | `AppShell.tsx:351-381` — if no trip is chosen, the modal body is `"Create a trip before adding places."` + a `New trip` button, rather than a broken form. | ✅ excellent anti-dead-end |
| **Book-now CTA on a card** | `plan-it app.js:1001` — `<a class="btn btn-sm btn-secondary mt-2">{t('btn.bookNow')}</a>` on hotels; `:930` `Search Flights` as `btn-primary`; `:909` `Reserve Parking`; `:951` `Compare & Book`; `:974` `Open App` (deep link). All `target="_blank" rel="noopener"`. | static |
| **Reminder as a per-row inline `<select>`** | `plan-it app.js:789-798` — options `"" | 5 | 10 | … | 60` labelled `🔔 None` / `🔔 {min} min`, `title="Reminder Before (min)"`. Persisted with `default_reminder_min: 15` from the New Trip form. | `None` / `{min} min` |
| **"Add to trip context" vs "Add to a day" as a split button** | `AdventureLog CollectionItineraryPlanner.svelte:2530-2560` — a `join` group, primary `+` = `Add to day` (opens `ItineraryDayPickModal`), outline `+` = `Add to trip context`. Both `aria-label`ed and `title`d. | hover-revealed (`opacity-0 group-hover:opacity-100`) |
| **Status of a booking is a colour-coded type chip** | `trip-tracker trip.component.html:344-366` — `bookingTypeIcon(booking.type)` + `booking.label` + `· {reference}`, `bookingTypeClass(booking.type)`, `max-w-[11rem] @sm:max-w-[16rem]`, `ring-1 ring-inset ring-black/5 dark:ring-white/10`, and an **add button styled as a dashed outline** `border border-dashed border-primary-300` reading `+ {{t('bookings.add_booking')}}`. Clicking a chip opens the edit modal. | editable vs `opacity-60 cursor-not-allowed` when the trip is archived |
| **Archived = read-only everywhere, with a persistent restore banner** | `trip.component.html:86-127` — an orange `bg-orange-500/90 backdrop-blur-md` bar: `Trip is archived` + `Restore` + a collapsible `Notes` showing `archival_review` text. Every mutating control gets `[disabled]="trip()?.archived"`. | ✅ a great model for a stale/expired ATHITI plan |
| **Reservations inside a stop** | `TREK DayPlanSidebar.tsx:2280-…` — a stop can carry several bookings; each is a separate chip with its own tint (`confirmed → bg-[rgba(22,163,74,.1)] text-[#16a34a]`, else `bg-[rgba(217,119,6,.1)] text-[#d97706]`) and its own outline, with a comment explaining why: *"The status, the time and the flight/train number used to sit in one pill strung together on a middle dot, which read as one run-on sentence."* Plus a `+` button to add a booking to that specific stop. | |
| **Share = copy a URL, with a fallback** | `plan-it app.js:619-639` — `navigator.clipboard.writeText` → success toast, `.catch()` → `showToast(shareUrl, "info")`, and an `execCommand('copy')` textarea fallback for old browsers. | |
| **Save = dirty badge, not a modal** | `nomadnote ItineraryBuilder.tsx:313` — `<Badge variant="warning" className="text-[11px]">Unsaved itinerary changes</Badge>` appears next to the heading the moment `dirty` is true; `Save` button only renders when `days.length > 0`. | clean/dirty |
| **Export as text, not just JSON** | `nomadnote components/ItineraryTextExport.tsx` — a plain-text itinerary with a privacy footer: `Private & local-first. No account needed.` | |

**"Request" as a first-class verb: NOT FOUND.** No repo has a "request this experience / ask the host / send enquiry" flow with a pending/sent/declined state machine. The nearest is trip-tracker's booking chips, which *record* a booking, they don't *request* one. ATHITI will be inventing this.

---

## 9. Provider / host side UX

**Verdict: essentially NOT FOUND in any of the five apps.** Findings:

- `AdventureLog frontend/src/routes/admin/+page.server.ts` is a **17-line redirect to Django admin**: `return redirect(302, publicUrl + '/admin/')`. All the real admin lives in `backend/server/{users,adventures,billing,integrations,achievements,worldtravel}/admin.py` — Django admin, not a designed surface. There is `AdventureLog/frontend/src/lib/components/settings/integrationCatalog.ts` and `IntegrationsSettings.svelte` (a *traveler* connecting their own Strava/Immich/Google Maps), which is the closest thing to a "provider" surface and is traveller-side, not host-side.
- `plan-it`: nothing. `peer/plan-it/static/app.html` has three pages, all traveller.
- `nomadnote`: nothing. `PlaceForm.tsx` is a traveller editing their own saved place; there is no listing submission, no moderation, no availability.
- `trip-tracker`: nothing; `app/modals/place-create-provider-modal/` + `provider-multiline-create-modal/` are for importing POIs from an external data provider (OSM/Photon/Google), not from a human host.
- `TREK`: `pages/AdminPage.tsx` is an operator console for *self-hosters* (users, jobs, plugins, backups) — not a marketplace host. `components/Studio/*` is a printable trip-book designer (export, page numbers, peer cursors) — closest to "an operator producing an artefact".

**What I can offer as substitutes**, all traveller-side but structurally reusable:
- Bulk/import editor fields: `TREK components/Planner/PlaceFormModal.tsx`, `FileImportModal.tsx`, `AirTrailImportModal.tsx`, `BookingImportModal.tsx` — the "paste a wall of text and we'll parse it" pattern.
- `trip-tracker modals/multi-places-create-modal` — bulk place creation.
- `AdventureLog CollectionModal.svelte` / `ImportCollectionModal.tsx` / `LabelManager.tsx`.
- Trip *sharing* (read-only public view) is the one "other-audience" surface that exists and is worth studying: `TREK pages/SharedTripPage.tsx` (route `/shared/:token`) and `pages/JourneyPublicPage.tsx` (`/public/journey/:token`), plus `trip-tracker shared-trip.component.*` (`/s/t/:token`) and `AdventureLog SocialShareModal.svelte` + `MobileQR.svelte`. `TripShareFullAccess` is even an alembic migration in trip-tracker, so there are two share permission levels.

---

## 10. Design system details

### NomadNote — shadcn-style HSL channel tokens + an "atlas" layer (`app/globals.css`)
Full token set, `:root` / `.dark` (`:8-51`): `--background --foreground --card --card-foreground --popover --popover-foreground --primary --primary-foreground --secondary --secondary-foreground --muted --muted-foreground --accent --accent-foreground --destructive --destructive-foreground --border --input --ring --radius`.
Light: `--background: 48 45% 96%` (warm paper), `--primary: 228 100% 55%` (electric blue), `--secondary: 176 100% 30%` (deep teal), `--accent: 70 100% 55%` (acid yellow), `--destructive: 8 86% 55%`, `--radius: 0.35rem`.
Dark: `229 28% 7%` bg, primary `228 100% 68%`, secondary `176 80% 46%`, accent `70 100% 58%`, `--border: 48 24% 82%` (**inverted — light border in dark mode**, which is what makes the hard-shadow look work).
Type: `Fraunces` (variable, with `font-variation-settings: "SOFT" 25, "WONK" 1`) for `h1,h2,h3` + `.font-display`; `Manrope` body; `IBM Plex Mono` as `.font-mono-custom`. Three custom utilities:
```css
.nomad-action { @apply inline-flex h-10 … border-2 border-foreground bg-card … shadow-[4px_4px_0_hsl(var(--foreground))]
                 hover:-translate-y-0.5 hover:translate-x-0.5 hover:shadow-[2px_2px_0_…] focus-visible:ring-2 focus-visible:ring-ring; }
.atlas-card  { @apply border-2 border-foreground bg-card shadow-[6px_6px_0_hsl(var(--foreground))]; }
.atlas-label { @apply font-mono-custom text-[10px] font-semibold uppercase tracking-[0.18em] text-muted-foreground; }
```
`Badge` variants via cva (`components/ui/badge.tsx:5-21`): `default | secondary | outline | destructive | success | warning | muted`, all with `font-mono-custom text-[10px] uppercase tracking-[0.12em]`.
Body background is a 44px grid + two corner gradients (`:65-71`) — a signature texture.
**Accessibility done right:** `.dark` toggling honours `prefers-color-scheme` (`AppShell.tsx:52-60`); `html { -webkit-text-size-adjust: 100% }`; custom 5px scrollbars; `no-scrollbar` utility.

### TREK — the most systematic token set (`client/src/index.css:700-870`)
Surfaces: `--bg-primary --bg-secondary --bg-tertiary --bg-elevated --bg-card --bg-input --bg-hover --bg-selected`.
Text: `--text-primary --text-secondary --text-muted --text-faint`.
Borders: `--border-primary --border-secondary --border-faint`.
Accent family (4 tokens, `index.css:719-735`): `--accent` (fill), `--accent-text` (on-fill text), `--accent-on` (accent as text/border on a surface), `--accent-hover`, `--accent-subtle` (faint accent-tinted surface for chips/selected).
**Status tokens as pairs** (`:767-770`, dark at `:865-867`):
```css
--success: #16a34a;  --success-soft: #dcfce7;
--danger:  #dc2626;  --danger-soft:  #fef2f2;
--warning: #d97706;  --warning-soft: #fffbeb;
--info:    #2563eb;  --info-soft:    #eff6ff;
```
Shadows: `--shadow-sm --shadow-md --shadow-lg --shadow-modal --shadow-dropdown --shadow-popover --shadow-card --shadow-elevated --shadow-glow`. Layout: `--sidebar-width: 240px --header-height: 60px`. Transitions: `--transition-fast: 150ms ease --transition-base: 250ms ease`.
**Per-tier user font scaling** (`:762-765`): `--fs-scale-title --fs-scale-subtitle --fs-scale-body --fs-scale-caption`, all `1` by default, consumed as `calc(12px * var(--fs-scale-body, 1))`. This is an **accessibility feature, not a style**: the user sets a per-tier text size in settings and *every* component honours it. `components/Roadtrip/typeScale.ts` documents the whole discipline:
```ts
/** A day's name — the day plan's own size. */ dayTitle: 'calc(14px * var(--fs-scale-body, 1))',
/** A stop's name — the day plan's own size. */ name:     'calc(12.5px * var(--fs-scale-body, 1))',
/** A clock reading, and a service stop's dwell. */  time: 'calc(11px * var(--fs-scale-caption, 1))',
/** The word "Stay" — the smallest thing in the rail. */ micro:'calc(8px * var(--fs-scale-caption, 1))',
```
with the rule *"A value and its unit always share one tier, so scaling one tier cannot break a pair apart."*
**~12 colour schemes** as `[data-scheme]` overrides (`:924-982`): indigo, violet, teal, aqua, rose, red, orange, amber, purple, blue + a high-contrast light (`--text-primary: #000000`) and dark.
**Day-tint alpha ramps** (`:743-747`) — a plugin's colour strength *per region of a card*, because density differs:
```css
--day-tint-badge: 16%;  --day-tint-header: 8%;  --day-tint-header-hover: 14%;  --day-tint-activity: 6%;
```
plus a **colour clamping band** in OKLCH L so a plugin can't pick an unreadable day colour: `--day-tint-l-min: 0.40; --day-tint-l-max: 0.78;` — *"This bounds a colour, it does not boost one: hue and chroma are never touched, so a near-white GREY still lands as a faint tint. That is the intended trade."*
`nightPauseMarker.ts` + `NightPauseDrag.tsx` + `NightPauseTooltip` + `NightPauseMarker` — an inline "pause here overnight" affordance on a route.

### plan-it — a compact, fully documented CSS system (`static/css/app.css:9-91`)
```css
:root {
  --color-bg-primary: #ffffff;  --color-bg-secondary: #f7f8fa;  --color-bg-card: #ffffff;
  --color-bg-card-hover: #f0f2f5;  --color-bg-input: #ffffff;  --color-bg-chip: #eef0f4;
  --color-border: #d4d7de;  --color-border-focus: #4f5ef5;  --color-border-subtle: #e5e7ec;
  --color-text-primary: #111827;  --color-text-secondary: #5f6675;
  /* WCAG 2.1 AA: 4.5:1 against the darkest light surface (--color-bg-chip). */
  --color-text-muted: #656c7a;  --color-text-inverse: #ffffff;
  --color-accent: #4f5ef5;  --color-accent-hover: #6b78f7;  --color-accent-muted: rgba(79,94,245,.1);
  --color-success: #16a34a; --color-warning: #d97706; --color-danger: #dc2626; --color-info: #2563eb;
  --color-priority-high: #dc2626; --color-priority-medium: #d97706; --color-priority-low: #2563eb;
  --font-sans: 'Inter', …;  --font-mono: 'JetBrains Mono', …;
  --text-xs: .75rem; --text-sm: .8125rem; --text-base: .9375rem; --text-lg: 1.125rem;
  --text-xl: 1.375rem; --text-2xl: 1.75rem; --text-3xl: 2.25rem;
  --space-1: 4px; --space-2: 8px; --space-3: 12px; --space-4: 16px; --space-5: 20px;
  --space-6: 24px; --space-8: 32px; --space-10: 40px; --space-12: 48px; --space-16: 64px;
  --radius-sm: 6px; --radius-md: 10px; --radius-lg: 14px; --radius-xl: 20px;
  --shadow-card: 0 1px 2px rgba(0,0,0,.06), 0 2px 8px rgba(0,0,0,.04);
  --shadow-elevated: 0 4px 12px rgba(0,0,0,.1), 0 8px 24px rgba(0,0,0,.08);
  --shadow-glow: 0 0 16px rgba(79,94,245,.12);
  --transition-fast: 150ms ease;  --transition-base: 250ms ease;
  --sidebar-width: 240px;  --header-height: 60px;
}
html.dark { --color-bg-primary:#0f1117; … color-scheme: dark; }
```
Note the `--color-priority-*` triple: **priority is a first-class token, not a badge colour** — the timeline dot, the badge, and the stat all read the same three variables. And there's a **contrast test in CI** (`test_contrast_tokens.py`) asserting the muted-text token clears 4.5:1 against the chip surface, plus *"The visual hierarchy must survive the contrast fix."* — that's the right kind of test.
Also: every badge has a hand-written dark-mode override using rgba at ~.15 alpha with a light foreground (`:161-170`), e.g.
```css
html.dark .badge-walk      { background: rgba(96,165,250,.15);  color: #93c5fd; }
html.dark .badge-reminder  { background: rgba(245,158,11,.15);  color: #fcd34d; }
html.dark .badge-backup    { background: rgba(239,68,68,.15);   color: #fca5a5; }
```
**Dark mode is done by explicit per-badge override, not by opacity math.** For ATHITI that means: define each semantic badge as `{bg, fg}` in light *and* dark, and test both.

### AdventureLog — daisyUI, 9 themes
`frontend/src/lib/index.ts:510-520`:
```ts
export let themes = [ {name:'light'},{name:'dark'},{name:'dim'},{name:'night'},{name:'forest'},
                      {name:'aqua'},{name:'aestheticLight'},{name:'aestheticDark'},{name:'northernLights'} ]
```
All components use daisyUI semantic classes (`bg-base-200`, `text-base-content/70`, `border-base-300`, `btn-primary`, `badge-warning`, `card bg-base-200 shadow-xl`, `stats stats-vertical sm:stats-horizontal`, `progress progress-primary progress-xs`, `alert alert-warning alert-soft`, `menu menu-sm bg-base-100 rounded-box`, `loading loading-spinner loading-xs`).
Two custom conventions: `text-base-content/60` for tertiary text (so it re-themes automatically), and `.markdown-content` for rendered markdown.
**Colour comes from OSM tags → emoji** (`lib/index.ts:521+`, ~60 mappings): `camp_site 🏕️, playground 🛝, viewpoint 👀, theme_park 🎢, beach 🏖️, museum 🏛️, zoo 🦁, brewery 🍺, …` plus `osmTagToEmoji` normalisation (`tag.trim().toLowerCase().replace(/-/g,'_')`).

### trip-tracker — PrimeNG Aura preset remapped to zinc + Tailwind
`src/mytheme.ts`: `definePreset(Aura, { semantic: { primary: {50..950: '{zinc.50}'…}, colorScheme: { light: {primary:{color:'{zinc.950}'}}, dark: {…} } } })`.
Category colour is injected as a CSS custom property and tinted with `color-mix` (`styles.scss:239-245`):
```scss
.color-bg-opacity { background: color-mix(in srgb, var(--color-bg-opacity) 10%, transparent);
                    color: var(--color-bg-opacity); }
.dark .color-bg-opacity { background: color-mix(in srgb, var(--color-bg-opacity) 20%, transparent); }
```
**That is the cleanest category-tint system found**: one hex per category, two derived surfaces, correct in both schemes, no hand-written pairs. The row does `[style.--color-bg-opacity]="place.category.color"`.
Cluster style: `.custom-cluster { background:#4f46e5; color:#fff; border-radius:9999px; padding:.5rem; font-weight:600; border:3px solid #fff }`.
Tooltip: `.class-tooltip { width:200px; white-space:pre-wrap; border-radius:8px; text-align:center; padding:12px }` with a `.dark` variant.

### shadcn-ui — what I could actually verify
**Nothing usable.** `registry.json` is 0 bytes; `packages/shadcn/src/registry/` contains only the CLI (`add.ts builder.ts registry.ts schema.ts …`); the `templates/*` are scaffolds:
```
templates/vite-monorepo/packages/ui/src/styles/globals.css:
  @import "tailwindcss";
  @source "../../../apps/**/*.{ts,tsx}";
  @source "../../../components/**/*.{ts,tsx}";
  @source "../**/*.{ts,tsx}";
```
The one transferable idea is the **monorepo composition boundary**: `packages/ui/src/{components,lib,hooks,styles}` is a workspace package, and `components.json` sits in *both* `apps/web` and `packages/ui` — so the shared component library is itself a valid shadcn consumer. If ATHITI wants a component library, mirror that shape (`packages/ui` + `components.json` in both places) and the `@source` globs to keep Tailwind's content detection correct across workspaces.
Composition patterns worth reusing therefore come from the *apps* that use shadcn-style primitives — which in this research set is **NomadNote** (it vendors the whole `components/ui/*` set: badge, button, card, dialog, dropdown-menu, input, label, popover, select, separator, skeleton, switch, tabs, textarea, tooltip, cva + `cn()` = `twMerge(clsx(...))`).

---

## 11. Responsive & accessibility

### Breakpoints (measured, not assumed)
- **BREAKPOINT USAGE COUNT across trip-tracker's templates**: `md:` **217**, `sm:` 65, `lg:` 57, `xl:` 20, `2xl:` 0. **This codebase lives at `md` and ignores `2xl`.** Copy that.
- **TREK**: the phone/desktop split is a *component* split (`ViewportRoute phone desktop`, `App.tsx:195`), and the CSS boundary is `@media (max-width: 767px)` (`index.css:13`) — a literal 768 phone breakpoint.
- **plan-it**: `@media (max-width: 900px)` (2- and 3-col grids → 1), `@media (max-width: 768px)` (sidebar becomes an off-canvas drawer `translateX(-100%)` + `.sidebar.open { transform: translateX(0) }` + a `.sidebar-overlay` fixed scrim), `@media (max-width: 480px)` (phone), `@media (hover: none) and (pointer: coarse)` (touch-only), `@media print` (`:2114`).
- **Nomadnote**: `md:` (sidebar→bottom nav at `md`), `min-[380px]` and `min-[420px]` (container-query breakpoints for the radar's dial row and the brief header), `min-[380px]:text-[11px]` / `max-[379px]:sr-only` in AdventureLog. **Arbitrary-value container queries are the most under-used responsive tool in this set.**
- Tailwind defaults confirmed by usage: `sm 640 / md 768 / lg 1024 / xl 1280`.

### Mobile patterns
- **trip-tracker**: the whole panel becomes a bottom sheet — `fixed left-4 right-4 bottom-4 sm:bottom-auto sm:top-4` for the archive banner, and the plans panel is `fixed top-4 left-4 right-4 md:h-auto! md:bottom-4! md:w-sm lg:w-md xl:w-lg md:max-w-1/3` with `translate-x-0`/`-translate-x-full` slide. Icon buttons collapse to `⋯` on mobile (`<div class="flex sm:hidden"><p-button icon="pi pi-window-minimize">`).
- **AdventureLog**: `PlaceQuickStart` / `LocationQuickStart` and the `max-[379px]:sr-only` label trick; `md:grid-cols-2` for card grids; `@container` queries on the bookings row (`@sm:max-w-[16rem]`).
- **TREK**: `client/src/index.css:13-33` documents why `html { overflow: visible }` on phone (iOS Safari only collapses the address bar when the *root* scroller moves), why `overflow-x: clip` and never `hidden` (Android forced-zoom widens the layout viewport and pushes fixed elements off-screen), and why `html body { background-color: transparent }` needs the `html body` selector to beat the themed `body` rule on source order.
- **nomadnote**: `pb-[76px] md:pb-0` on `<main>` to clear the fixed bottom nav; `max-h-[90dvh] overflow-y-auto` on dialogs; `style={{ maxHeight: "75dvh" }}` on the mobile sheet; `pb-[max(env(safe-area-inset-bottom),0.5rem)]` on the bottom nav.

### ARIA / keyboard / focus — quoted specifics
- **NomadNote command palette** (`CommandPalette.tsx:63-68`): `autoFocus` on `Command.Input`, placeholder `"Search places, trips, commands…"`, an `ESC` `<kbd>` shown `hidden sm:block`, and `Escape` handled globally (`:31-35`) to close. `⌘K`/`Ctrl+K` bound in `AppShell.tsx:64-68`; `⌘N` opens the quick-action dialog; the `⌘K` kbd hint is rendered in both the sidebar and the topbar (`AppShell.tsx:210, 239`).
- **NomadNote filter chips are `<button>`s with visible selected state but no `aria-pressed`** — a real gap; TREK's `PoiCategoryPill` does it right: `aria-pressed={on}` + `aria-label`.
- **NomadNote day header**: real `<button aria-expanded={expanded} aria-label={`${expanded?"Collapse":"Expand"} day ${day.dayNumber}`}>` (`ItineraryBuilder.tsx:138-143`).
- **NomadNote map controls**: every icon button has `aria-label` *and* `title` with identical strings — `aria-label="Center map on my location" title="Center map on my location"`, and the pin-drop toggle flips to `aria-label="Cancel pin drop"`.
- **NomadNote lock toggle** has no accessible name at all (`ItineraryBuilder.tsx:94-102`) — only an icon. Don't copy.
- **dnd-kit keyboard drag is real** (`ItineraryBuilder.tsx:118-121`): `useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates })` with `PointerSensor` `activationConstraint: { distance: 5 }` so a tap doesn't start a drag.
- **trip-tracker `inert` on collapsed content** (`trip.component.html:337`) — the only correct collapse pattern found.
- **trip-tracker tooltip suppression on touch**: `const touchDevice = 'ontouchstart' in window; if (!touchDevice) marker.bindTooltip(...)` (`map.ts:82-92, 105-112, 163-170`) — markers don't get hover-cards on phones.
- **AdventureLog marker accessibility** (`ClusterMap.svelte:280-287`): markers are real `<button type="button" aria-label={markerLabel(markerProps)} title={markerTitle(markerProps)}>`, base class includes `focus:outline-6 focus:outline-black`; a non-default `text-font` fallback stack `['Noto Sans Regular','Arial Unicode MS Regular']` because *"Many raster-only styles rely on an external `glyphs` endpoint and won't have Open Sans."*
- **AdventureLog popup shows on focus, not just hover** (`MapRecommendationsLayer.svelte:59-62, 69`): `on:focus={() => (hoveredId = rec.id)}` and `group-focus-within:opacity-100`.
- **AdventureLog Escape + `role="tablist"`** on the search modes; `<ul role="listbox">` on the results; `aria-selected` on each tab.
- **TREK dropdown Escape** (`CollectionFilterBar.tsx:22-27`): `document.addEventListener('mousedown', onDoc)` + `document.addEventListener('keydown', onKey)` with `if (e.key === 'Escape') setOpen(false)`, both cleaned up.
- **plan-it tooltip system** (`app.css:1296-1341`): a `.ea-tooltip` with a CSS arrow (`::after` 6px triangle), a `.flip` variant when it would go off-screen, `pointer-events: none`, and `@media (hover:none) and (pointer:coarse) { [data-tooltip] { cursor: auto } }` so touch doesn't show tooltips.
- **plan-it touch targets**: `min-height: 44px` on every `button` in the sandbox; the FAB is a pill with a label, not a bare icon.
- **Reduced motion** is honoured in exactly one place: `trip-tracker src/styles.scss:384-389` (`transition-duration: .01ms` under `prefers-reduced-motion: reduce`). NomadNote uses framer-motion + CSS shimmer with **no** reduced-motion handling. **ATHITI must handle this** — a pulsing radar dial and animated route dashes are exactly what triggers vestibular symptoms.
- **Contrast**: plan-it has a CI test (`test_contrast_tokens.py`) for the muted token; both plan-it and AdventureLog annotate their muted-text values with the WCAG target in a comment; trip-tracker relies on Tailwind's `dark:` variants per element (high maintenance).
- **Colour-blind safety**: nothing in any repo does this explicitly, but two patterns are implicitly safe — status is always icon+colour+text (`plan-it` `⚠`/`💡`/`☕` prefixes, trip-tracker `pi-eye`/`pi-eye-slash` + 🚶/🚽 glyphs) and the priority ladder uses *shape* (ring thickness, dot size) as well as hue (plan-it `.timeline-dot.high` gets a `box-shadow` glow, medium/low don't).

---

# TOP 15 PATTERNS TO BUILD (ranked)

### 1. Inter-stop travel-time connector as a first-class timeline row
**What:** a full-width sibling row between two stop cards: `hairline — [mode icon] {duration} · {distance} · {note} — hairline`, at ~10.5px in `--text-faint`, clickable to change that leg's travel mode.
**Why:** ATHITI's whole promise is "in the next 2 hours" — the traveller must see where the time goes. A number on a card is invisible; a band between two cards is read as distance. It's also the cheapest place to surface "this leg is 40 min, your plan doesn't fit".
**Source:** `TREK/client/src/components/Planner/DayPlanSidebarRouteConnector.tsx:14-36` (verbatim structure) + `HotelRouteConnector:44+` for the hotel bookend; `DayPlanSidebar.tsx:2425-2432` for the clickable-leg affordance.
**Effort:** S (one component + one routing call per leg).

### 2. Time-budget bar cut into blocks of real minutes, with a hatched overflow tail
**What:** a horizontal bar where each block = 30 real minutes of budget. "2h budget" = 4 blocks. Overruns spill into a hatched tail. Masked with `repeating-linear-gradient` so it's real holes. `role="img"` + `aria-label="{used} of {budget} — {note}"`. Below 3 or above 30 blocks, drop the mask.
**Why:** turns "does this fit?" from arithmetic into counting. "3h20m of plans in a 2h budget" is instantly legible as a 4-block bar plus a striped 0.67 block.
**Source:** `TREK/client/src/components/Roadtrip/RangeStrip.tsx:57-72` (`blockMask`, `BLOCK_KM`) and `:118-133` (three segments + `role="img"`); the note-chip row at `:150-163`.
**Effort:** S (pure CSS + two numbers).

### 3. Per-day "energy load" meter on the day header, with the numbers also in text
**What:** `totalMin (duration + travel) / targetMin` → a 36px-wide bar; thresholds `>90% destructive`, `>70% accent`, else `secondary`; `title="Energy load: 6h 20m planned of 8h target"`; the header line also reads `Mar 3 · 5 places · 6h 20m`.
**Why:** the meter is a glance, the text is the truth, the `title` is the detail. Three levels of resolution from one number, and it never relies on colour alone.
**Source:** `nomadnote/components/ItineraryBuilder.tsx:123-160` (verbatim) + `MODE_HOURS = {slow:6, balanced:8, packed:11}` in `features/itinerary/algorithm.ts:22-26`.
**Effort:** S.

### 4. Confidence-and-repair panel (NomadNote Trip Stress Radar), simplified to 4 dimensions
**What:** a conic-gradient dial (0-100) + one label/headline + **the single worst factor's "Rescue move:" sentence** + a 2-column grid of factor cards each with label / value bar / one-sentence note / one action button that opens a repair panel listing the offending items.
**For ATHITI keep 4 factors, drop 3:** `Time overspill` (does the day exceed the stated budget?), `Travel drag` (sum of inter-stop legs vs total), `Neighborhood spread` (distinct clusters), `Kids friction` (stops with no 🚽/🍼/shade, or legs with no indoor fallback). Keep the "positive polarity" inversion for `Map readiness`.
**Why:** this is the entire ATHITI thesis as a UI: don't add more, show what's broken and give the next repair. The worst-factor-only rescue copy keeps it to one sentence instead of a wall.
**Source:** `nomadnote/components/TripStressRadar.tsx:120-246` (scoring, labels, thresholds, rescue map, factor definitions) and `:29-99` (DOM); repair panel at `components/TripBrief.tsx:111-188`.
**Effort:** M (scoring is ~40 lines; the dial and cards are ~120 lines of JSX).

### 5. Zero-result state as a triple: statement + one next action + 3 tappable example queries
**What:** headline differentiated by cause (`"Nothing fits in 2 hours near your hotel"` vs `"No indoor options in the rain"`), one sentence naming the action, then 3 `Try: {example}` chips.
**Why:** you log these as unmet demand, so the *copy itself* is the telemetry. Make the examples real queries and the chips double as demand probes. Branching on cause is what separates a useful zero-state from `"No results found"`.
**Source:** `nomadnote/app/trips/page.tsx:204-233` (verbatim structure, incl. the `Try: {…}` chips) + the best recovery string in the set, `AdventureLog frontend/src/locales/en.json` `map.recommendations_empty`: **"No recommendations in this area. Try a larger radius."**; two-state insights copy from `nomadnote/components/ItineraryBuilder.tsx:384`.
**Effort:** S (copy + layout), M if you also wire the demand log.

### 6. Accessibility chips as a green/red pill with glyph **and** word, on every card
**What:** `🐶 Yes` / `🐶 No` in `bg-green-100/80 text-green-800` / `bg-red-100/80 text-red-800`, plus `♿`, `🍼`, `🚽`, `🌂` variants. Rendered as a wrap row *below* the title, always visible, never behind a filter.
**Why:** a family of 4 with a toddler filters on stroller-accessible + toilets + shade + quiet. Surface the *negatives* too — "🚽 No" is decision-grade information that a filter chip can never deliver at the moment of choice.
**Source:** `trip-tracker/src/src/app/shared/place-box-content/place-box-content.component.html:19-43` (detail-sheet yes/no, exact markup) and `app/shared/place-list-item/place-list-item.component.html:13-32` (compact icon-only chips, exact markup).
**Effort:** S.

### 7. Map↔list coupling that opens the cluster, not just the pin
**What:** on list-row hover/selection, if the pin is inside a cluster, call `getVisibleParent(marker).spiderfy()`; style the hovered cluster or pin distinctly. On the map→list direction, `flyTo({zoom: max(currentZoom,15), duration:600})` and toggle an `.active` class on the existing marker element (never re-create it).
**Why:** the #1 bug in every list+map UI is "I clicked a card and nothing happened because the pin was inside a bubble." Solve it explicitly.
**Source:** `TREK/client/src/components/Map/markerCluster.ts:47-64` (`revealInCluster`, verbatim) + `:66-75` (count-scaled bubble sizes); `nomadnote/components/MapView.tsx:174-183` (`flyTo`) and `:140` (`classList.toggle("active", …)`).
**Effort:** S.

### 8. Hover card that follows the cursor and never takes the pointer
**What:** `position: fixed`, `left: x+14, top: y-10`, `pointerEvents: 'none'`, `zIndex: 9999`, `maxWidth: 220`, contents = name + rating (one decimal only if earned) + category icon+name + address. `pointer-events:none` prevents the mouseleave-stolen flicker that makes hover cards feel broken.
**Why:** cheapest high-value map affordance; also the reason the card can be shared by two renderers.
**Source:** `TREK/client/src/components/Map/PlaceHoverCard.tsx:33-70` (verbatim) + the comment at `:11-16` explaining it was written twice and drifted; trip-tracker's touch suppression at `src/app/shared/map.ts:163-170`.
**Effort:** S.

### 9. Radius-based "Search this area" with a re-arming button and a radius ladder
**What:** mode segmented control (`My` / `Places` / `Nearby`) → a Category select (`Tourism / Food / Lodging`) + a Radius select (`1/2/5/10/20/50 km`, `1/5/10/25 mi`) + a `Search this area` button that re-arms when the map centre moves > 0.002° or results are empty. A translucent indigo circle (`fill-opacity .1` + `line-dasharray [2,2]`) shows the radius. Minimum 3 characters, 300 ms debounce.
**Why:** "near my hotel, within budget" *is* a radius query. This is the most complete, most reusable nearby-discovery UX in the set.
**Source:** `AdventureLog/frontend/src/routes/map/+page.svelte:1226-1293` (panel markup, verbatim) + `:234-250` (radius options) + `:515-560` (`searchThisArea` + re-arm logic); `components/map/MapSearchBar.svelte:128-158` (3-mode tablist) and `:77-83` (debounce/min-chars); `components/map/MapNearbyRadiusLayer.svelte:17-34` (geofence circle, verbatim).
**Effort:** M.

### 10. Pacing presets with the budget inside the label
**What:** a chip group: `Relaxed (2h)`, `Standard (4h)`, `Full day (8h)`, `Packed (11h)` — with an icon each — and the *same* number reused as the denominator of every time-budget bar in the app.
**Why:** one control answers "how much do you want to do today" and simultaneously calibrates every meter on the page. Six words, zero extra UI.
**Source:** `nomadnote/components/ItineraryBuilder.tsx:41-45` + `:330-345` (chip markup) + `features/itinerary/algorithm.ts:22-26` (`MODE_HOURS`).
**Effort:** S.

### 11. 8 category tokens where one hex is the pill fill, the marker colour, and the chip tint
**What:** `[{key, labelKey, Icon, color}]` for Restaurants/Cafés/Bars/Stays/Sights/Museums/Nature/Activities; `color` used as the segmented-pill active fill, the marker fill, and (via `color-mix`) the chip background. Segmented control is frosted (`backdrop-filter: blur(20px) saturate(180%)`), icon-only, `aria-pressed`, with per-segment loading spinner and error dot, and one shared `Search this area` button that appears when any segment is stale.
**Why:** one source of truth means the filter and the map can never disagree. The per-segment error dot tells you *which* category failed, which is the difference between a usable and an unusable filter under a flaky network.
**Source:** `TREK/client/src/components/Map/poiCategories.ts:20-32` (verbatim) + `components/Map/PoiCategoryPill.tsx:30-108` (verbatim) + `components/Collections/CollectionFilterBar.tsx:120-134` (the `5+ 4+ 3+` minimum-rating ladder).
**Effort:** M.

### 12. Cluster counts as HTML, not as a map glyph
**What:** `circle` layer styled by a `step` expression on `point_count` (3 tiers, themed from semantic tokens) + a `MarkerLayer applyToClusters` that renders the count as a DOM `<span>`. Click a cluster → `getClusterExpansionZoom` → `easeTo`. Native MapLibre `cluster: {radius, maxZoom, minPoints}`, `chunkedLoading`-equivalent, `showCoverageOnHover: false`, level-aware `maxZoom` (`{country:4, region:7, city:12}`). Leaflet fallback gets `maxClusterRadius: (zoom) => zoom < 9 ? 20 : STACK_RADIUS` + `spiderfyOnMaxZoom: true`.
**Why:** raster-only basemaps and blocked glyph endpoints are the norm on cheap Android devices in India. HTML labels always render. And the comment at `FullMap.svelte:321` states the reason outright.
**Source:** `AdventureLog/frontend/src/lib/components/map/FullMap.svelte:313-352` (verbatim layers) + `:192-228` (step paint) + `:237-260` (click-to-expand, verbatim) + `:171-234` (bounds-keyed fitBounds + single-point fallback); `trip-tracker/src/src/app/shared/map.ts:57-72`; `TREK/client/src/components/Map/markerCluster.ts:5-35`.
**Effort:** M.

### 13. Three distinguishable route-line classes, each with a `coalesce` colour fallback
**What:** walking/activity paths (per-feature colour, `width 3`, `opacity .9`), trails (purple, `width 3`), transport legs (amber, `width 2.5`, `line-dasharray [4,3]`) — all with `'line-color': ['coalesce', ['get','_color'], fallback]`. Plus a CSS-rule-only dim mode: adding one class to the map container drops every non-highlighted marker to `opacity: .55`.
**Why:** three line semantics is exactly the minimum to distinguish "you walk this" / "this is a track" / "you ride this". And the dim-container trick means "highlight this day on the map" is *one classList.toggle*, not per-marker bookkeeping.
**Source:** `AdventureLog/frontend/src/lib/components/collections/CollectionMap.svelte:1109-1150` (verbatim paint objects); `trip-tracker/src/src/styles.scss:117-126` (dim rule) + `services/trip-map.service.ts:196-220` (featureGroup + `fitBounds({padding:[30,30], maxZoom:16})`) + `trip.component.ts:455-463` (per-day colour ramp).
**Effort:** M.

### 14. Skeleton that is a structural copy of the real content, with a minimum display time
**What:** three fake day groups — each a `circle` + 2 lines, then 2 item rows of `3.25rem` chip + `flex-1 max-w-[55%]` line — rendered from Angular's `@placeholder (minimum 0.15s)`. On the button, the spinner replaces the icon and the label becomes `Working…`.
**Why:** a generic grey-brick skeleton tells the user nothing about what is coming; a structural copy sets the correct expectation and prevents layout shift. The 0.15 s floor kills the skeleton flash on fast (cached) responses.
**Source:** `trip-tracker/src/src/app/components/trip/trip.component.html:518-541` (verbatim), extracted as `app/shared/trip-skeleton/trip-skeleton.component.html`; the shimmer keyframe in `nomadnote/app/globals.css:124-136`; `nomadnote/components/ItineraryBuilder.tsx:353-361`.
**Effort:** S.

### 15. Per-tier user font scaling via CSS variables, with value+unit sharing a tier
**What:** `--fs-scale-title/subtitle/body/caption`, default `1`, consumed everywhere as `calc(12px * var(--fs-scale-body, 1))`. A settings control sets them. Rule: *a value and its unit always share one tier* so scaling can't break a pair. 9 sizes: `total 20 / dayTitle 14 / name 12.5 / time 11 / meta 10 / marker 10.5 / label 9 / micro 8 / panelTitle 15`.
**Why:** ATHITI's users will include a tired parent holding a toddler on one arm. Per-tier scaling is a genuine accessibility capability that costs one variable and one settings screen, and it degrades gracefully (a value with a unit always scales together).
**Source:** `TREK/client/src/index.css:762-765` (the four vars) + `TREK/client/src/components/Roadtrip/typeScale.ts:16-38` (the whole scale + the rule).
**Effort:** S for the variables + a settings slider; M to retrofit every component.

---

## Appendix — quick "NOT FOUND" list

| Thing asked for | Status |
|---|---|
| Per-POI "fit score" / "this fits your 2 hours and ₹500" indicator | **NOT FOUND in any of the 5 apps.** No app scores an individual experience against a user's constraints. ATHITI's core differentiator; design from scratch. |
| Group-size / child-age / toddler input | **NOT FOUND anywhere.** Closest is trip-tracker's dog-friendly boolean. |
| "Request this experience" / enquiry-to-host flow with pending states | **NOT FOUND anywhere.** Nearest: trip-tracker *recording* an existing booking. |
| Host/provider listing editor, availability calendar, host dashboard | **NOT FOUND.** AdventureLog redirects `/admin` to Django admin; TREK's AdminPage is a self-hoster console; plan-it/nomadnote/trip-tracker have none. |
| Range sliders for time/budget | **NOT FOUND.** AdventureLog uses `<select>` ladders (1/2/5/10/20/50 km) — arguably better for coarse buckets. NomadNote uses chips. No repo uses a slider for time or budget. |
| Natural-language bar for *search* (as opposed to plan-it, which uses NL for *generation*) | Only plan-it, and only for itinerary generation (`static/app.html:113-119`). Every place-search is a plain text input + chips. |
| shadcn-ui block composition templates | **NOT IN CHECKOUT.** `research/adopt/shadcn-ui/registry.json` is 0 bytes; `packages/shadcn/src/registry/` has CLI only; `templates/*` are empty scaffolds. Sparsity: `/packages/`, `/templates/`, `/registry.json`. Use NomadNote's vendored `components/ui/*` as the practical shadcn reference instead. |
| Horizontal-scroll or calendar-grid itinerary | **NOT FOUND.** All five apps use a vertical list/accordion. The only horizontal arrangement is AdventureLog's day grid `grid-cols-1 md:grid-cols-2 xl:grid-cols-3` for *global/trip-context* items (`CollectionItineraryPlanner.svelte:1820`), not for day timelines. |
| Dark-mode contrast test in CI | Only plan-it (`test_contrast_tokens.py`), and only for one token. |
