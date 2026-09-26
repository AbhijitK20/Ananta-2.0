# 04 — Data Layer & Retrieval Implementation Details

**Project:** ATHITI — local experience discovery for Mumbai / Navi Mumbai
**Scope:** OSM tag semantics, Overpass harvest, opening-hours evaluation, travel-time APIs, geo utilities, retrieval, routing facade, map UX, geocoding fallback.
**Method:** direct reads of the cloned reference repos. Every claim tagged `repo/path:line`.
**Repos are READ-ONLY.** Nothing in `research/` was modified.

---

## 0. Executive summary (the 6 things that change the build)

| # | Finding | Impact |
|---|---------|--------|
| 1 | **CORRECTED — see §4.0. `spatie/opening-hours` (PHP) is NOT an OSM grammar parser, but the npm port `opening_hours@3.15.0` that we actually install DOES parse OSM format, verified live. This finding originally over-reached from the PHP repo.** It takes a PHP/JSON *normalised* structure. Its only string entry points are `Time::fromString("HH:MM")` and `TimeRange::fromString("HH:MM-HH:MM")`. There is no tokenizer for `Mo-Fr 09:00-18:00`, no `24/7`, no `PH off`, no comments. | We must write (or adopt) the **OSM `opening_hours` tokenizer** ourselves and emit the normal form this library consumes. Non-trivial. |
| 2 | **`ch.disabling_allowed` was REMOVED in GraphHopper 3.0** and is now a hard startup error. Replaced by per-request `ch.disable=true`. | Any config or wrapper written from pre-3.0 docs will crash the server on boot. |
| 3 | **GraphHopper `custom_model` is POST-`/route` only** — explicitly *not* GET /route, /isochrone, /spt, /map-matching. | A Mumbai congestion multiplier on the **isochrone** is not expressible via custom_model. Must be baked into a server-side profile file, or approximated client-side. |
| 4 | **Orama has no Marathi / Devanagari tokenizer and no SQLite persistence.** Supported locales include `indian` (Hindi) and `nepali` but not Marathi; persistence is `save()`/`load()` of an in-memory JS object. | Orama buys typo-tolerance + facets but costs a second datastore and no Marathi stemming. FTS5 remains the primary. |
| 5 | **Only two of the routing providers need no API key today**: `valhalla1.openstreetmap.de` and `routing.openstreetmap.de` (FOSSGIS). OSRM `isochrones` is `NotImplementedError` in routingpy. | Valhalla is our only free isochrone source; FOSSGIS OSRM is our only free matrix. |
| 6 | **`opening_hours:covid` has NO field definition in id-tagging-schema** and neither does `lastcheck`. `check_date` is the modern `check_date=YYYY-MM-DD`. | Do not model `opening_hours:covid`; model `check_date` and treat covid-era `opening_hours:*` as junk to strip. |

---

## 1. OSM tag semantics we must match (source of truth = `data/id-tagging-schema/data/fields/`)

### 1.0 The field-type vocabulary (this becomes our zod mapping)

`data/id-tagging-schema/SCHEMA.md:380-431` — the complete list of iD field `type` values:

* Text: `text`, `number`, `integer`, `localized`, `tel`, `email`, `url`, `identifier`, `colour`, **`schedule`**, `textarea`, `date`
* Combo: `combo`, `typeCombo`, **`multiCombo`**, `manyCombo`, `networkCombo`, **`semiCombo`**, `directionalCombo`
* Checkbox: **`check`** (3-state: `yes` / `no` / *no tag*), `defaultCheck` (2-state), `onewayCheck`
* Radio: **`radio`**, `structureRadio`
* Special: `access`, `address`, `roadspeed`, `roadheight`, `restrictions`, `wikidata`, `wikipedia`

Key semantics we must reproduce:
* `check` = **3-state**. `SCHEMA.md:418` — "3-state checkbox: `yes`, `no`, unknown (no tag)". So `fee` **must** be `boolean | null`, never `boolean`.
* `multiCombo` = "Dropdown field for adding `yes` value to multiple keys with the same prefix (a common multikey) and suffixes selected among specified options" — `SCHEMA.md:396`. **This is exactly `diet:*`.**
* `semiCombo` = semicolon-delimited multi-value — `SCHEMA.md:398`. **This is exactly `cuisine`.**
* `schedule` = "Field for entering a recurring schedule (`opening_hours=*`, `service_times=*`)" — `SCHEMA.md:387`.
* `default` property: `SCHEMA.md:459-470` — "The default value for the field", e.g. `"default": "yes"`.
* `typeCombo` = "If unset, tag will be `key=yes`, but dropdown contains options like `stream`, `ditch`, `river`" — `SCHEMA.md:393`. **This is `amenity`, `tourism`, `shop`, `leisure`, `craft`** (`data/fields/amenity.json:1-5`, `tourism.json`, `shop.json`, `leisure.json`, `craft.json` — all `type: "typeCombo"`, all with **no** `strings.options`, i.e. the value vocabulary lives in the *preset* files, which are NOT in this sparse clone).

### 1.1 Per-tag table (exact JSON quoted)

#### `opening_hours` — `data/fields/opening_hours.json:1-8`
```json
{
    "key": "opening_hours",
    "type": "schedule",
    "label": "Hours",
    "placeholder": "Mo-Fr 09:00-18:00",
    "snake_case": false,
    "caseSensitive": true
}
```
* Type: `schedule` (free-text grammar, not an enum).
* `snake_case: false` and `caseSensitive: true` → **we must preserve case**; do NOT lowercase or convert spaces to underscores.
* Placeholder `Mo-Fr 09:00-18:00` is the canonical example to use in our own UI.
* Nested variant: `data/fields/opening_hours/drive_through.json:1-11` — `opening_hours:drive_through`, also `schedule`, `snake_case: false`, `caseSensitive: true`, gated on `prerequisiteTag: {key: "drive_through", value: "yes"}`.

#### `opening_hours:covid` — **NOT PRESENT**
`grep -rn "opening_hours" data/fields/` returns exactly two files: `opening_hours.json:2` and `opening_hours/drive_through.json:2`. `ls data/fields/ | grep -i covid` → empty. **The schema has deliberately dropped covid-era keys.** Do not model them; strip any `opening_hours:*` sub-key that is not `drive_through` on ingest.

#### `wheelchair` — `data/fields/wheelchair.json:1-16`
```json
{
    "key": "wheelchair",
    "type": "radio",
    "strings": {
        "options": {
            "designated": "Designated",
            "yes": "Yes",
            "limited": "Limited",
            "no": "No"
        }
    },
    "label": "Wheelchair Access",
    "terms": ["handicap access"]
}
```
Closed 4-value enum + **absence = unknown**. No `default`. `terms` includes the Indian-English synonym "handicap access" — worth putting in our LLM enrichment prompt.

#### `fee` — `data/fields/fee.json:1-5`
```json
{ "key": "fee", "type": "check", "label": "Fee" }
```
* `check` ⇒ 3-state ⇒ `boolean | null`.
* **There is no `fee:no.json` file.** `fee=no` is just the negative of `fee=yes`. So a `fee:no` reference collapses to `fee === false`.
* The schema treats `fee` as *provenanced* (absent ≠ free), which is correct: 0% of our Bandra West sample has it (measured).

#### `capacity` — `data/fields/capacity.json:1-10`
```json
{
    "key": "capacity",
    "type": "number",
    "minValue": 0,
    "label": "Capacity",
    "placeholder": "2, 20, 200...",
    "terms": ["people"]
}
```
Non-negative integer, unbounded above. No `default`, no max. Sub-keys: `capacity:persons` (`data/fields/capacity/persons.json:1-8`, placeholder `50, 100, 200...`), `capacity:disabled` (`capacity/disabled_parking.json:1-5`, label "Accessible Spaces"), `capacity:caravans`, `capacity:tents` (both gated on `prerequisiteTag.valueNot`).

#### `cuisine` — `data/fields/cuisine.json:1-116`
`type: "semiCombo"` (semicolon-delimited), label "Cuisines", `terms: ["fare", "food types"]`. **103 allowed values**, verbatim from `cuisine.json:7-109`:

```
pizza, burger, coffee_shop, regional, italian, sandwich, chinese, chicken, japanese,
kebab, mexican, american, asian, ice_cream, indian, sushi, seafood, thai, french,
german, breakfast, greek, steak_house, fish_and_chips, korean, barbecue, donut,
noodle, vietnamese, fish, turkish, cake, pasta, tex-mex, bubble_tea, ramen,
mediterranean, spanish, friture, tea, grill, juice, salad, crepe, hot_dog, hotpot,
pancake, dessert, diner, tapas, portuguese, beef_bowl, russian, indonesian, wings,
lebanese, arab, curry, malaysian, bagel, georgian, polish, african, western,
sausage, filipino, caribbean, soba, peruvian, brazilian, oriental, fine_dining,
frozen_yogurt, argentinian, balkan, bavarian, british, ethiopian, shawarma,
persian, middle_eastern, pastry, soup, fries, taiwanese, bistro, european,
moroccan, hawaiian, brunch, udon, syrian, ukrainian, austrian, nepali, irish,
croatian, pakistani, lao, hungarian, bolivian, jamaican, cuban
```
Mumbai-relevant subset already present: `indian`, `regional`, `chinese`, `arab`, `lebanese`, `shawarma`, `kebab`, `vietnamese`, `tea`, `juice`, `dessert`, `ice_cream`, `bubble_tea`, `pakistani`, `african`, `middle_eastern`, `cafe`-adjacent `coffee_shop`.
⚠ **Absent but common in real Mumbai OSM: `mughlai`, `maharashtrian`, `parsis`, `gujarati`, `kathiyawadi`, `rolls`, `chaat`, `biryani`, `momos`, `cafe`, `fastfood`.**
**Conclusion: the schema vocabulary is a UI suggestion list, not a closed enum for real OSM data. Make `cuisine` `z.array(z.string())` with a hint lookup table, not `z.enum()`.**

#### `diet:vegetarian` / `diet:vegan` / `diet:halal` — `data/fields/diet_multi.json:1-28`
```json
{
    "key": "diet:",
    "type": "multiCombo",
    "label": "Dietary Options",
    "terms": ["fruitarian","gluten free","halal","kosher","lactose free","meat",
              "pescatarian","raw","vegan","vegetarian"],
    "strings": {
        "options": {
            "vegetarian": "Vegetarian",
            "vegan": "Vegan",
            "halal": "Halal",
            "gluten_free": "Gluten-Free",
            "kosher": "Kosher",
            "lactose_free": "Lactose-Free",
            "pescetarian": "Pescetarian"
        }
    }
}
```
* `key: "diet:"` + `type: "multiCombo"` ⇒ the key is a **prefix**; each selected suffix becomes `diet:<suffix>=yes`. `SCHEMA.md:396,449`.
* 7 selectable values; 10 search `terms`. The terms list is the *broader* real-world vocabulary (`fruitarian`, `meat`, `raw` searchable but not selectable).
* Real OSM also uses `diet:vegetarian=only` and `diet:halal=only`. The schema models only `yes`. **Accept `yes|no|only`, normalise to a tri-state.**

#### `indoor` / `outdoor` / `covered`
* `data/fields/indoor.json:1-5` → `{ "key": "indoor", "type": "check", "label": "Indoor" }` (3-state).
* `data/fields/indoor_type.json:1-5` → `{ "key": "indoor", "type": "typeCombo", "label": "Type" }` — a **type-alternate** for the same key (malls/buildings: `indoor=room|building`). `SCHEMA.md:393`.
* **There is no `outdoor.json`.** `outdoor` is a namespaced sub-key — the file is `data/fields/outdoor_seating.json:1-5` → `{ "key": "outdoor_seating", "type": "check", "label": "Outdoor Seating" }`. Real OSM `outdoor=yes` has no field.
* `data/fields/covered.json:1-5` → `{ "key": "covered", "type": "check", "label": "Covered" }`.
* `data/fields/covered_no.json:1-12` → the type-alternate with an explicit "unknown" option:
```json
{
    "key": "covered",
    "type": "check",
    "label": "{covered}",
    "strings": { "options": { "undefined": "Assumed to be No", "yes": "Yes", "no": "No" } }
}
```
  ⚠ **`covered_no` is the trap for ATHITI**: it encodes the assumption *"absent covered ⇒ not covered"*. For an open-air market or a lakeside promenade, that assumption is wrong. **Do not adopt `covered_no` semantics. Keep `covered` tri-state and expose an explicit `coverageKnown: false`.**

#### `takeaway` — `data/fields/takeaway.json:1-17`
```json
{
    "key": "takeaway",
    "type": "radio",
    "label": "Takeout",
    "strings": {
        "options": { "yes": "Yes", "no": "No", "only": "Takeout Only" }
    },
    "terms": ["take out", "takeaway", "takeout"]
}
```
Closed 3-value radio. **`only` is a third state, not a boolean.** Sibling: `data/fields/delivery.json:1-5` → `{ "key": "delivery", "type": "check", "label": "Delivery" }`.

#### `opening_date` / last-check
* `data/fields/opening_date.json:1-6` → `{ "key": "opening_date", "type": "date", "label": "Expected Opening Date", "placeholder": "YYYY-MM-DD" }` — ISO 8601 date, **future-dated** (for not-yet-open venues).
* **`lastcheck` is NOT a field.** The modern equivalent is `data/fields/check_date.json:1-11`:
```json
{
    "key": "check_date",
    "type": "date",
    "label": "Last Checked Date",
    "placeholder": "YYYY-MM-DD",
    "universal": true,
    "terms": ["last survey date", "survey date"]
}
```
  `universal: true` (`SCHEMA.md:452-454`) → appears for **all** presets. Its `terms` explicitly include "last survey date", confirming it is the `lastcheck` replacement.
* **Staleness rule for ATHITI:** if `check_date` is older than N days the POI's hours must be surfaced as `unverified`, not as fact. If `check_date` is absent but `opening_hours` is present (our 16% case), the data is at best 2010s-era and must be flagged.

#### Bonus tags present that we should harvest (all quoted from the clone)

| File | JSON |
|---|---|
| `data/fields/smoking.json:1-18` | `{ "key":"smoking","type":"combo","label":"Smoking","placeholder":"No, Separated, Yes...","strings":{"options":{"no":"No smoking anywhere","separated":"In smoking areas, not physically isolated","isolated":"In smoking areas, physically isolated","outside":"Allowed outside","yes":"Allowed everywhere","dedicated":"Dedicated to smokers (e.g. smokers' club)"}},"autoSuggestions":false,"customValues":false }` — **`autoSuggestions:false` + `customValues:false` ⇒ this IS a closed enum.** High-signal for nightlife filtering. |
| `data/fields/organic.json:1-16` | `{ "key":"organic","type":"radio","label":"Organic Products","strings":{"options":{"no":"None","yes":"Some","only":"Only"}},"terms":["natural","non-gmo"] }` |
| `data/fields/internet_access.json:1-17` | `{ "key":"internet_access","type":"combo","label":"Internet Connection","strings":{"options":{"yes":"Yes","no":"No","wlan":"Wifi","wired":"Wired","terminal":"Terminal"}},"autoSuggestions":false,"customValues":false,"terms":["wifi","wlan"] }` — closed enum, **nomad/café-work filter.** |
| `data/fields/air_conditioning.json:1-10` | `{ "key":"air_conditioning","type":"check","label":"Air Conditioning","terms":["cooling system","refrigeration"] }` — **critical for a May–June Mumbai product.** |
| `data/fields/name.json:1-11` | `{ "key":"name","type":"localized","label":"Name","universal":true,"placeholder":"Common name (if any)","terms":["label","title"] }` — `localized` ⇒ `name:hi`, `name:mr` exist; `SCHEMA.md:456`. |
| `data/fields/short_name.json`, `official_name.json`, `alt_name.json` | all `type: "localized"`, `universal: true`, each gated on `prerequisiteTag: {key: "name"}` |
| `data/fields/phone.json:1-13` | `keys: ["phone","contact:phone"]`, `type: "tel"`, `placeholder: "+000 0000 0000 0000"` — **two keys, must read both** (`SCHEMA.md:441-447`) |
| `data/fields/website.json:1-16` | `keys: ["website","contact:website"]`, `type: "url"`, `universal: true` |
| `data/fields/email.json:1-9` | `keys: ["email","contact:email"]` |
| `data/fields/wikidata.json:1-9` | `keys: ["wikidata","wikipedia"]`, `type: "wikidata"`, `universal: true` — **one hop to a rich, structured, multi-lingual dataset. Our cheapest enrichment lever.** |
| `data/fields/image.json:1-14` | `type: "url"`, `universal: true`, `terms: ["icon","image uri","photo","picture"]` |
| `data/fields/description.json:1-9` | `type: "textarea"`, `universal: true`, `terms: ["summary"]` |
| `data/fields/brand.json` / `operator.json` | both `type: "text"`, label "Brand" / "Operator" |
| `data/fields/indoor_seating.json:1-5` | `{ "key":"indoor_seating","type":"check","label":"Indoor Seating" }` — Mumbai May. |

### 1.2 The zod enum draft (copy-pasteable)

```ts
// src/domain/tags.ts
// Values transcribed from data/id-tagging-schema/data/fields/*.json
// every `null` = "tag absent" (iD `check` is a 3-state checkbox — SCHEMA.md:418)

import { z } from 'zod'

/** Mirrors iD `type: "check"` (3-state). fee.json:2, air_conditioning.json:2 */
export const tri = z.boolean().nullable()

/** radio/combo fields with a *closed* vocabulary.
 *  Only list a field here if its field JSON sets `autoSuggestions:false`
 *  AND `customValues:false` (see SCHEMA.md:593-608) — otherwise real OSM
 *  data will contain values outside the list.
 */

// wheelchair.json:5-10  (radio; 4 options, no default)
export const Wheelchair = z.enum(['designated', 'yes', 'limited', 'no'])
export type Wheelchair = z.infer<typeof Wheelchair>

// takeaway.json:6-10  (radio; 3 options)
export const Takeaway = z.enum(['yes', 'no', 'only'])
export type Takeaway = z.infer<typeof Takeaway>

// organic.json:5-10  (radio; 3 options)
export const Organic = z.enum(['no', 'yes', 'only'])
export type Organic = z.infer<typeof Organic>

// smoking.json:7-14  (combo with autoSuggestions:false + customValues:false => CLOSED)
export const Smoking = z.enum([
  'no',            // No smoking anywhere
  'separated',     // In smoking areas, not physically isolated
  'isolated',      // In smoking areas, physically isolated
  'outside',       // Allowed outside
  'yes',           // Allowed everywhere
  'dedicated',     // Dedicated to smokers (e.g. smokers' club)
])
export type Smoking = z.infer<typeof Smoking>

// internet_access.json:6-12  (combo, autoSuggestions:false + customValues:false => CLOSED)
export const InternetAccess = z.enum(['yes', 'no', 'wlan', 'wired', 'terminal'])
export type InternetAccess = z.infer<typeof InternetAccess>

/** diet_multi.json is `multiCombo` with key prefix `diet:` — each option is a
 *  YES-NO sub-key, never a value of `diet:vegetarian`.
 *  Real OSM uses `only` as well as `yes`; normalise all three.
 */
export const DietFlag = z.enum(['yes', 'no', 'only'])
export type DietFlag = z.infer<typeof DietFlag>

/** diet_multi.json:19-25 selectable + :6-15 searchable terms. */
export const DIET_SELECTABLE = [
  'vegetarian', 'vegan', 'halal', 'gluten_free', 'kosher', 'lactose_free', 'pescetarian',
] as const

export const DIET_SEARCHABLE = [
  ...DIET_SELECTABLE,
  'fruitarian', 'meat', 'raw', // terms only (diet_multi.json:7,11,14)
] as const
// NOTE: `pescatarian` is searchable but NOT selectable (diet_multi.json:8 vs :25) —
// keep both lists or you will drop real data.

// cuisine.json:7-109. `type: "semiCombo"` => semicolon-delimited.
// 103 schema values. A *suggestion list*, NOT a closed set — real
//  Mumbai values like `mughlai`, `maharashtrian`, `chaat`, `rolls`, `biryani`,
//  `parsis`, `gujarati`, `kathiyawadi`, `momos` are absent from the schema.
export const CUISINE_SCHEMA_HINT = [
  'pizza','burger','coffee_shop','regional','italian','sandwich','chinese','chicken',
  'japanese','kebab','mexican','american','asian','ice_cream','indian','sushi','seafood',
  'thai','french','german','breakfast','greek','steak_house','fish_and_chips','korean',
  'barbecue','donut','noodle','vietnamese','fish','turkish','cake','pasta','tex-mex',
  'bubble_tea','ramen','mediterranean','spanish','friture','tea','grill','juice','salad',
  'crepe','hot_dog','hotpot','pancake','dessert','diner','tapas','portuguese','beef_bowl',
  'russian','indonesian','wings','lebanese','arab','curry','malaysian','bagel','georgian',
  'polish','african','western','sausage','filipino','caribbean','soba','peruvian',
  'brazilian','oriental','fine_dining','frozen_yogurt','argentinian','balkan','bavarian',
  'british','ethiopian','shawarma','persian','middle_eastern','pastry','soup','fries',
  'taiwanese','bistro','european','moroccan','hawaiian','brunch','udon','syrian','ukrainian',
  'austrian','nepali','irish','croatian','pakistani','lao','hungarian','bolivian','jamaican',
  'cuban',
] as const

/** open vocabulary on purpose. Split on ';' per SCHEMA.md:398 */
export const Cuisine = z.array(z.string().trim().min(1))
export type Cuisine = z.infer<typeof Cuisine>

/** Numbers. capacity.json:2-4 => minValue 0, no max. */
export const Capacity = z.number().int().nonnegative().nullable()
export const CapacityPersons = z.number().int().nonnegative().nullable()
export const CapacityDisabled = z.number().int().nonnegative().nullable()

/** Dates, ISO 8601 `YYYY-MM-DD` (check_date.json:4, opening_date.json:4) */
export const IsoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/)

/** `type: "schedule"`, case-sensitive, NOT snake_cased
 *  (opening_hours.json:6-7). Keep the raw string verbatim + a parse status.
 */
export const OpeningHours = z.object({
  raw: z.string(),                       // verbatim, case preserved
  rawCovid: z.string().optional(),       // accepted but never trusted
  parsed: z.boolean(),
  /** 'ok' | 'partial' | 'unparsable' | 'absent' — see §4 */
  status: z.enum(['ok', 'partial', 'unparsable', 'absent']),
  /** true iff grammar unambiguously said "open" for the queried instant */
  open: z.boolean().nullable(),
  /** ISO 8601 instants, Asia/Kolkata. null when unknown. */
  opensAt: z.string().nullable(),
  closesAt: z.string().nullable(),
  /** check_date.json — drives the staleness badge. */
  lastChecked: IsoDate.nullable(),
  /** opening_date.json — future venue; hide until <= today */
  opensOn: IsoDate.nullable(),
})

/** `type: "typeCombo"` (amenity.json:3, tourism.json:3, shop.json:3,
 *  leisure.json:3, craft.json:3). Options live in the PRESET files, which are
 *  not in this sparse clone. Open vocabulary. */
export const PrimaryKey = z.enum([
  'amenity','tourism','shop','leisure','craft','historic','office','healthcare','aerialway',
])
export const PrimaryValue = z.string().trim().min(1)   // open, NOT an enum

/** craft.json:7-62 gives the *complete* craft value list — 56 values, closed. */
export const CraftValue = z.enum([
  'carpenter','electronics_repair','winery','metal_construction','photographer','electrician',
  'hvac','plumber','brewery','tailor','caterer','shoemaker','sawmill','window_construction',
  'handicraft','gardener','joiner','dressmaker','confectionery','stonemason','painter',
  'glaziery','beekeeper','roofer','builder','key_cutter','upholsterer','cleaning','blacksmith',
  'pottery','signmaker','distillery','agricultural_engines','jeweller','locksmith','tiler',
  'photographic_laboratory','watchmaker','clockmaker','floorer','tinsmith','grinding_mill',
  'boatbuilder','sculptor','scaffolder','plasterer','oil_mill','bookbinder','insulation',
  'saddler','chimney_sweeper','carpet_layer','parquet_layer','sailmaker','basket_maker','rigger',
])
export type CraftValue = z.infer<typeof CraftValue>

/** `name: "localized"` (name.json:3) — every key shares the `name` prefix. */
export const LocalizedName = z.object({
  name: z.string().optional(),
  nameHi: z.string().optional(),   // name:hi
  nameMr: z.string().optional(),   // name:mr  <- Marathi; see §7 tokenizer gap
  altName: z.string().optional(),  // alt_name.json  (universal)
  shortName: z.string().optional(),// short_name.json (universal)
  officialName: z.string().optional(),
})

/** The full ATHITI POI tag projection, exactly the keys our Overpass `out` asks for. */
export const OsmTags = z.object({
  ...LocalizedName.shape,

  // -- classification (item 2) --
  primaryKey: PrimaryKey,
  primaryValue: PrimaryValue,
  craft: CraftValue.optional(),

  // -- hours --
  openingHours: OpeningHours,
  driveThruHours: z.string().optional(),   // opening_hours:drive_through

  // -- accessibility --
  wheelchair: Wheelchair.nullable(),
  capacity: Capacity,
  capacityPersons: CapacityPersons,
  capacityDisabled: CapacityDisabled,

  // -- money / openness --
  fee: tri,                    // fee=yes|fee=no|absent
  covered: tri,                // NOT covered_no semantics — see §1.1
  coverageKnown: z.boolean(),  // = ('covered' in tags)
  indoor: z.boolean().nullable(),

  // -- food & drink --
  cuisine: Cuisine,
  diet: z.record(DietFlag).optional(),   // { vegetarian: 'yes', halal: 'only' }
  takeaway: Takeaway.nullable(),
  delivery: tri,                            // delivery.json
  outdoorSeating: tri,                      // outdoor_seating.json
  indoorSeating: tri,                       // indoor_seating.json
  smoking: Smoking.nullable(),
  organic: Organic.nullable(),

  // -- comfort (May–June) --
  airConditioning: tri,                     // air_conditioning.json
  internetAccess: InternetAccess.nullable(),

  // -- provenance --
  phone: z.string().optional(),     // phone | contact:phone  (phone.json:3-6)
  website: z.string().optional(),   // website | contact:website
  email: z.string().optional(),
  address: z.object({                 // `type: "address"`, addr: prefix (SCHEMA.md:444)
    housenumber: z.string().optional(),
    street: z.string().optional(),
    suburb: z.string().optional(),   // addr:suburb == locality, very useful in Mumbai
    city: z.string().optional(),
    district: z.string().optional(), // addr:district == Mumbai suburban district
    postcode: z.string().optional(),
    state: z.string().optional(),    // Maharashtra
  }).partial(),
  access: z.enum([                     // data/fields/access.json:19-45 (closed, documented)
    'yes','no','permissive','private','designated','destination','customers','dismount',
    'permit','unknown',
  ]).nullable(),
  accessKnown: z.boolean(),
  wikidata: z.string().optional(),   // wikidata.json keys:["wikidata","wikipedia"]
  wikipedia: z.string().optional(),
  image: z.string().optional(),
  description: z.string().optional(),
  brand: z.string().optional(),
  operator: z.string().optional(),
  lastChecked: IsoDate.nullable(),   // check_date (NOT lastcheck)
  opensOn: IsoDate.nullable(),       // opening_date
})
```

---

## 2. Tag co-occurrence / per-category harvest checklist

**Honest statement of the evidence:** the sparse clone of `id-tagging-schema` contains **only** `data/fields/`, `data/preset_categories/` and `data/preset_defaults.json` (verified: `ls data/` → `fields preset_categories preset_defaults.json`; `find . -name "*amenity*"` → only `data/fields/amenity.json` and `data/fields/disused/amenity.json`). **The `data/presets/` tree — which is where the per-category field lists live — is NOT in the clone.** So the per-category tag checklists below are derived from three verifiable sources in the clone plus the schema layout documented in `SCHEMA.md`:

1. `data/preset_defaults.json:1-63` — the **editor's own notion of which presets matter most**, split by geometry.
2. `data/fields/*.json` — the field inventory that exists at all, plus `universal: true` flags.
3. `SCHEMA.md:80-88` (preset schema) + `SCHEMA.md:120-200` (`tags` / `addTags` / `fields` / `moreFields` semantics) — the mechanism by which co-occurrence is declared.

The mechanism itself, quoted (`SCHEMA.md:120-134`):
```
##### `tags`
An object with the `"key": "value"` tags a feature must have to match this preset. A `"*"` wildcard
value can be set to have this preset match any value for that key. ...
iD will pick the best match based on `matchScore`, the number of tags, and the use of wildcard values.
```
and (`SCHEMA.md:136-152`) `addTags`:
> "The tags that are added to the feature when selecting this preset. Defaults to `tags`. … **iD's validator will recommend that users add missing tags from `addTags` to matching features.**"

and (`SCHEMA.md:174-190`) `fields` / `moreFields`:
> "Both these properties are arrays of field paths (e.g. `description` or `generator/type`). `fields` are shown by default and `moreFields` are shown if manually added by the user or **if a matching tag is present**."

**⇒ `addTags` + `moreFields` ARE the per-category tag checklist, expressed as a union.** That is the artefact to obtain (a full `data/presets/` checkout) before we finalise the enrichment prompt.

### 2.1 `data/preset_defaults.json` — verbatim, and what it tells us

```json
{
    "area": ["category-landuse","category-building","category-water","category-natural",
             "leisure/park","amenity/hospital","amenity/place_of_worship","amenity/cafe",
             "amenity/restaurant","area"],
    "line": ["category-road_major","category-road_minor","category-rail","category-path",
             "category-waterway","category-barrier","category-natural","category-utility","line"],
    "point": ["category-natural","leisure/park","amenity/hospital","amenity/place_of_worship",
              "amenity/cafe","amenity/restaurant","amenity/fast_food","amenity/bar",
              "amenity/bank","shop/supermarket","category-advertising","point"],
    "vertex": ["highway/crossing/traffic_signals","highway/crossing/uncontrolled",
               "highway/crossing/unmarked","railway/level_crossing","highway/traffic_signals",
               "highway/turning_circle","highway/turning_loop","traffic_calming",
               "highway/mini_roundabout","highway/motorway_junction","point"],
    "relation": ["category-route","category-restriction","public_transport/stop_area",
                 "type/boundary","type/waterway","type/multipolygon","type/enforcement",
                 "type/site","relation"]
}
```

Readings that matter:
* **The `area` list is the "big landmark" set** — `leisure/park`, `amenity/place_of_worship`, `amenity/cafe`, `amenity/restaurant` are the *only four* amenity-ish presets that are area-first. These are exactly the multi-polygon POIs we need `out center` for.
* **The `point` list is the "small POI" set** — adds `amenity/fast_food`, `amenity/bar`, `amenity/bank`, `shop/supermarket`. Note **`amenity/bar` is point-only**, and **`amenity/museum`, `amenity/theatre`, `amenity/marketplace`, `shop/craft`, `craft=*` are in NEITHER list** — the iD maintainers consider them *below* the noise floor for a default editing session. For a discovery product that means those categories are exactly the long tail we must harvest exhaustively: under-mapped *and* under-modelled.
* ⚠ **Methodological warning for our enrichment prompts:** if we derive "expected tags" from `preset_defaults.json` we will systematically under-prompt for the long tail.

### 2.2 `universal: true` — the genuinely near-universal set

`SCHEMA.md:452-454`: "If a field definition contains the property `"universal": true`, this field will appear in the "Add Field" list for all presets."

Fields in the clone with `"universal": true`:
* `name.json:5` — Name
* `short_name.json:5`, `official_name.json:5`, `alt_name.json:5` (all gated on `prerequisiteTag: {key:"name"}`)
* `description.json:5`, `image.json:5`, `website.json:15`
* `wikidata.json:6`, `wikipedia.json:6`
* `check_date.json:6`

⇒ **Every ATHITI POI should be harvested for exactly: `name*`, `alt_name`, `short_name`, `description`, `image`, `website`/`contact:website`, `wikidata`+`wikipedia`, `check_date`, plus `phone`/`contact:phone` (universally expected even though not flagged), plus `addr:*` and `access`.** Defensible and citable.

### 2.3 Per-category tag checklist (Overpass harvest AND LLM enrichment prompt)

Column key: **A** = "ask for it in the Overpass filter" (free) · **E** = "ask the enrichment LLM to extract/confirm it"

| Category | Always-in-`out` (A) | Category-specific (A) | Enrichment prompt targets (E) |
|---|---|---|---|
| `amenity=restaurant` | `name*`, `addr:*`, `cuisine`, `diet:*`, `opening_hours`, `website`, `phone`, `check_date` | `wheelchair`, `fee`, `takeaway`, `delivery`, `outdoor_seating`, `indoor_seating`, `air_conditioning`, `internet_access`, `smoking`, `capacity`, `organic`, `access` | regional sub-cuisine (Maharashtrian/Gujarati/Parsi/Kathiyawadi — absent from schema), `diet:vegan=only` vs `yes`, seasonal `outdoor_seating`, seat `capacity`, `takeaway=only`, `air_conditioning` |
| `amenity=cafe` | same as restaurant | `outdoor_seating`, `internet_access`, `takeaway`, `smoking`, `wheelchair`, `fee` | `internet_access=wlan` + SSID, laptop policy (usually only in `description`/social), shaded vs unshaded `outdoor_seating`, `cuisine=coffee_shop` |
| `amenity=fast_food` | same as restaurant | `takeaway`, `delivery`, `diet:*`, `cuisine`, `opening_hours` | `chaat`/`rolls`/`vada pav` (all absent from schema), `diet:vegetarian=only`, hours granularity |
| `tourism=attraction` | `name*`, `addr:*`, `website`, `phone`, `image`, `description`, `wikidata` | `fee`, `wheelchair`, `opening_hours`, `check_date` | `description` → one-line "what you'd actually do here"; `fee` (many Indian attractions free/donation); `wheelchair` (ghat/old-Bombay stone steps); `wikidata` → monument type |
| `shop=craft` | `name*`, `addr:*`, `phone`, `website`, `check_date` | `craft`, `opening_hours`, `wheelchair`, `fee` | `craft` disambiguation (`craft.json` has 56 values; `embroidery` is *absent*); working studio vs retail counter; `payment:coins` |
| `amenity=place_of_worship` | `name*`, `name:hi`, `name:mr`, `religion`, `denomination`, `addr:*` | `wheelchair`, `opening_hours`, `fee`, `internet_access` | ghat/ustad/celebration from `description`; **aarti/mass timings are frequently NOT in `opening_hours` → must be enriched**; `wheelchair` (stepped ghat); `cuisine=prasad` (absent from schema) |
| `tourism=museum` | `name*`, `addr:*`, `website`, `phone`, `wikidata`, `wikipedia`, `image` | `fee`, `opening_hours`, `wheelchair`, `check_date` | `fee` + `fee:conditional`; weekly-off; what's actually in the collection |
| `amenity=theatre` | `name*`, `addr:*`, `website`, `phone`, `wikidata` | `opening_hours`, `wheelchair`, `fee`, `capacity`, `smoking` | `opening_hours` is a *performance* schedule, not office hours — always enrich; seat `capacity`; price range |
| `amenity=marketplace` | `name*`, `addr:*`, `opening_hours`, `check_date` | `wheelchair`, `fee`, `payment:*`, `internet_access` | market days in `opening_hours`; what is actually sold; ⚠ `covered` (NOT `covered_no` semantics — an open-air market would be mis-tagged); `addr:suburb` (Ghatkopar/Dadar/Bandra) |
| `leisure=park` | `name*`, `addr:*`, `access`, `operator` | `opening_hours` (many Indian parks are `24/7`), `fee`, `wheelchair`, `surface`, `covered` | garden/maidan vs sports ground vs playground; `access` (closed 10-value vocab, `access.json:19-45`); `wheelchair` (Haji Ali / Marine Drive ramps) |
| `amenity=bar` | `name*`, `addr:*`, `opening_hours`, `cuisine`, `smoking` | `fee`, `capacity`, `wheelchair`, `outdoor_seating`, `takeaway` | `smoking` (closed 6-value enum, high-signal for nightlife); late-night `opening_hours`; `capacity` |
| `craft=*` | `name*`, `addr:*`, `phone`, `opening_hours`, `check_date` | `craft`, `wheelchair`, `website` | `craft` value (closed 56-value list, `craft.json:7-62`); working studio vs workshop vs shop; `operator` |
| `historic=*` (adjacent) | `name*`, `addr:*`, `wikidata`, `wikipedia`, `website` | `fee`, `wheelchair`, `opening_hours`, `description` | what's there now; `wikidata` → period |
| `natural=beach` / `leisure=water_park` (adjacent) | `name*`, `fee`, `wheelchair`, `opening_hours` | `access`, `description`, `covered` | `access`; seasonal `fee`; lifeguard hours |

**`access` deserves a special note.** `data/fields/access.json:1-56` gives a **rich, self-documenting closed vocabulary** with human-readable descriptions: `yes` ("Access allowed by law; a right of way"), `no`, `permissive` ("Access allowed until such time as the owner revokes the permission"), `private` ("Access allowed only with permission of the owner on an individual basis"), `designated`, `destination` ("Access allowed only to reach a destination"), `customers` ("Restricted to customers at the destination"), `dismount`, `permit` ("Access allowed only with a valid permit or license"), `unknown`. Its `keys` are `["access","foot","motor_vehicle","bicycle","horse"]`. For ATHITI this is **more important than `fee`**: a privatised ghat or beach that is physically present but `access=private` is not an experience we can sell. Add `access` + `access:conditional` to the harvest and surface it as `bookable: false` with a reason.

---

## 3. A production Overpass query, and what OSMnx actually does

### 3.1 How OSMnx builds QL (the real code)

**Settings string** — `data/osmnx/osmnx/_overpass.py:236-247`:
```python
def _make_overpass_settings() -> str:
    maxsize = "" if settings.overpass_memory is None else f"[maxsize:{settings.overpass_memory}]"
    return settings.overpass_settings.format(timeout=settings.requests_timeout, maxsize=maxsize)
```
with `data/osmnx/osmnx/settings.py:162`:
```python
overpass_settings: str = "[out:json][timeout:{timeout}]{maxsize}"
```
and `settings.py:165`: `requests_timeout: float = 180`. ⚠ **A 180 s `[timeout:180]` is far too generous for a shared public server and will get you slot-limited. Use 25–60.**

**Tag→QL** — `data/osmnx/osmnx/_overpass.py:286-354` (this is the exact function to copy):
```python
def _create_overpass_features_query(
    polygon_coord_str: str,
    tags: dict[str, bool | str | list[str]],
) -> str:
    overpass_settings = _make_overpass_settings()
    ...
    # add node/way/relation query components one at a time
    components = []
    for d in tags_list:
        for key, value in d.items():
            if isinstance(value, bool):
                tag_str = f'[{key!r}](poly:{polygon_coord_str!r});(._;>;);'
            else:
                tag_str = f'[{key!r}={value!r}](poly:{polygon_coord_str!r});(._;>;);'

            for kind in ("node", "way", "relation"):
                components.append(f"({kind}{tag_str});")

    components_str = "".join(components)
    return f"{overpass_settings};({components_str});out;"
```
Observations to carry over:
* `tags` values may be `True` (key-only), a `str`, or a `list[str]`.
* `tags` is a **UNION, not an intersection** — `data/osmnx/osmnx/features.py:117`: "Results are the union, not intersection of the tags and each result matches at least one tag."
* It emits `out;` — **bare `out`, no `center`, no `body`/`tags` modifier, and it recurses `>` (down) to get member nodes.** For roads that's required. For POIs it is a huge waste.
* `poly:` requires a closed ring of `lat lon` pairs, **lat first** — `_overpass.py:278-281`:
```python
for geom in multi_poly.geoms:
    x, y = geom.exterior.xy
    coord_list = [f"{xy[1]:.6f}{' '}{xy[0]:.6f}" for xy in zip(x, y, strict=True)]
    coord_strs.append(" ".join(coord_list))
```
and `_overpass.py:275-276`: "rounding lats and lons to 6 decimals (approx 5 to 10 cm resolution) so we can hash and cache URL strings consistently". **Reuse the 6-dp rounding verbatim — it is load-bearing for caching.**

**Network (road) variant** — `_overpass.py:401`:
```python
query_str = f"{overpass_settings};(way{way_filter}(poly:{polygon_coord_str!r});>;);out;"
```

**Filter vocabulary worth stealing** for a road/corridor query, `_overpass.py:77-84` (`drive`):
```python
filters["drive"] = (
    f'["highway"]["area"!~"yes"]{settings.default_access}'
    f'["highway"!~"abandoned|bridleway|bus_guideway|construction|corridor|'
    f"cycleway|elevator|escalator|footway|no|path|pedestrian|planned|platform|"
    f'proposed|raceway|razed|rest_area|service|services|steps|track"]'
    f'["motor_vehicle"!~"no"]["motorcar"!~"no"]'
    f'["service"!~"alley|driveway|emergency_access|parking|parking_aisle|private"]'
)
```
with `settings.py:141`: `default_access: str = '["access"!~"private"]'` and `settings.py:28-35`'s rationale ("Best to be permissive here then remove complicated combinations of tags programatically after the full graph is downloaded").

### 3.2 Batching / subdivision

`settings.py:157`: `max_query_area_size: float = 50 * 1000 * 50 * 1000` (2.5 km² per query). `_overpass.py:268-272`:
```python
# subdivide the polygon if its area exceeds max size
poly_proj, crs_proj = projection.project_geometry(polygon)
multi_poly_proj = utils_geo._consolidate_subdivide_geometry(poly_proj)
```

### 3.3 Rate limiting / retry / DNS pinning (all copy this)

**Rate limit via the `/status` endpoint** — `_overpass.py:145-233`:
```python
def _get_overpass_pause(base_endpoint, *, recursion_pause=5, default_pause=60) -> float:
    if not settings.overpass_rate_limit:
        return 0
    url = base_endpoint.rstrip("/") + "/status"
    ...
    status = response_text.split("\n")[4]
    status_first_part = status.split(" ")[0]
    ...
        _ = int(status_first_part)  # number of available slots
        pause: float = 0
    except ValueError:
        if status_first_part == "Slot":
            utc_time_str = status.split(" ")[3]
            pattern = "%Y-%m-%dT%H:%M:%SZ,"
            utc_time = dt.datetime.strptime(utc_time_str, pattern).replace(tzinfo=dt.UTC)
            utc_now = dt.datetime.now(tz=dt.UTC)
            seconds = int(np.ceil((utc_time - utc_now).total_seconds()))
            pause = max(seconds, 1)
        elif status_first_part == "Currently":
            time.sleep(recursion_pause)
            pause = _get_overpass_pause(base_endpoint)
        else:
            ...return default_pause
    return pause
```
Three token shapes: `"<n> free slots"` → 0; `"Slot available after <ts>,"` → sleep to ts; `"Currently running <n> queries"` → re-poll every 5 s. Falls back to 60 s on any parse/connection error. `settings.py:161` `overpass_rate_limit: bool = True`.

**DNS pinning so the status check and the query hit the same server** — `_overpass.py:228-271`. The docstring is the reason this matters:
> "For example, the server overpass-api.de just redirects to one of the other servers (currently gall.openstreetmap.de and lambert.openstreetmap.de). So if we check the status endpoint of overpass-api.de, we may see results for server gall, but when we submit the query itself it gets redirected to server lambert. **This could result in violating server lambert's slot management timing.**"

`settings.py:143`: `doh_url_template = "https://8.8.8.8/resolve?name={hostname}"` (DNS-over-HTTPS fallback, `_http.py:177-225`).

**Retry on 429/504** — `_overpass.py:477-486`:
```python
    # handle 429 and 504 errors by pausing then recursively re-trying request
    if response.status_code in {429, 504}:
        error_pause = 55
        msg = (f"{hostname!r} responded {response.status_code} {response.reason}: "
               f"we'll retry in {error_pause} secs")
        utils.log(msg, level=lg.WARNING)
        time.sleep(error_pause)
        return _overpass_request(data)
```
(no cap on the recursion — add a bounded backoff instead.)

### 3.4 Caching (copy this design)

`data/osmnx/osmnx/_http.py:25-89`:
```python
def _save_to_cache(url, response_json, ok) -> None:
    if settings.use_cache:
        if not ok:
            ...warning...
        elif isinstance(response_json, dict) and ("remark" in response_json):
            msg = f"Did not save to cache because response contains remark: {response_json['remark']!r}"
            ...warning...
        else:
            cache_filepath = _resolve_cache_filepath(url)
            cache_filepath.parent.mkdir(parents=True, exist_ok=True)
            cache_filepath.write_text(json.dumps(response_json), encoding="utf-8")
...
def _resolve_cache_filepath(key: str, extension: str = "json") -> Path:
    digest = sha1(key.encode("utf-8")).hexdigest()   # noqa: S324
    return Path(settings.cache_folder) / f"{digest}.{extension}"
```
Three rules worth stealing:
1. **SHA-1 of the canonical request URL** — they build the GET-form URL from the POST data so POST and GET share a key: `_overpass.py:451` `prepared_url = str(requests.Request("GET", url, params=data).prepare().url)`.
2. **Never cache a response containing a `remark`** — Overpass uses `remark` to say "runtime error / partial data / memory exceeded". Caching a remark is caching a failure.
3. **Use `OrderedDict` for params so the URL is byte-stable** — `_http.py:38-41`: "Users should always pass OrderedDicts instead of dicts of parameters into request functions, so the parameters remain in the same order each time, producing the same URL string, and thus the same hash."

Plus `settings.py:114-116`: `use_cache: bool = True`, `cache_folder = "./cache"`; and `settings.py:17-24` `cache_only_mode` — "download network data from Overpass then raise a `CacheOnlyModeInterrupt` … **Useful for sequentially caching lots of raw data** (as you can only query Overpass one request at a time) then using the local cache to quickly build many graphs simultaneously with multiprocessing."

HTTP identity — `_http.py:140-175`: `User-Agent`, `referer`, `Accept-Language` (default `"en"`, `settings.py:147`); `settings.py:148-150` `http_referer`/`http_user_agent` default to `"OSMnx Python package (https://github.com/gboeing/osmnx)"`. **Set a real ATHITI UA with a contact URL — it is the polite thing and Overpass operators use it.**

Error taxonomy — `data/osmnx/osmnx/_errors.py:4-21`: `CacheOnlyInterruptError(InterruptedError)`, `ValidationError(ValueError)`, `InsufficientResponseError(ValueError)` ("Exception for empty or too few results in server response"), `ResponseStatusCodeError(ValueError)`. Response logging also logs size + host, `_http.py:306-310`.

Etiquette — `data/osmnx/docs/source/getting-started.rst:141`:
> "Be a good neighbor! OSMnx works with Overpass's rate limiting to avoid overwhelming their resources. **Don't run multiple/parallel OSMnx instances simultaneously** to circumvent their limits. … If you will make many queries (e.g., more than 1k/day), **you need to host your own local Overpass instance.**"

### 3.5 The production Overpass QL template (copy-pasteable)

Design rules, each traceable:
* `[out:json][timeout:60]` — long enough for a small bbox, short enough not to hog a slot.
* Bbox syntax `(S,W,N,E)` is the cheap path; the `poly:` ring from `_overpass.py:250-283` is for irregular sub-city shapes — **Mumbai's coastline is very irregular, so use `poly:` for coastal bboxes and bbox for inland grids.**
* One `out center` at the end, not per-component. `out center` gives every element a `center: {lat, lon}` for ways/relations and passes nodes through unchanged — this replaces OSMnx's expensive `>;` down-recursion for POIs.
* Filter junk server-side with a cheap existence check `["name"]`, which cuts our 9% nameless features at the source.
* **Overpass QL has no per-tag output selection.** To get "only the tags I want" you must filter by their presence, or accept all tags. Since only 16% have `opening_hours`, it cannot go in the filter. **Design decision: accept all tags, project in TypeScript.** This is exactly why §1.2's zod schema is `.nullable()` everywhere.

```overpassql
/*
  ATHITI experience harvest — bbox template
  Derived from data/osmnx/osmnx/_overpass.py:286-354 and :250-283
  bbox order: (S, W, N, E).  poly ring order: "lat lon" pairs.
  Bandra West + Khar + Santacruz, ~19.06N 72.83E
*/
[out:json][timeout:60];

// ── A. EAT / DRINK ─────────────────────────────────────────────────────────
(
  nwr["amenity"~"^(restaurant|cafe|fast_food|bar|pub|ice_cream|food_court|biergarten)$"]
     ["name"](18.9600,72.7900,19.1000,72.8900);
  nwr["cuisine"](18.9600,72.7900,19.1000,72.8900);
  nwr["shop"~"^(bakery|confectionery|tea|juice)$"](18.9600,72.7900,19.1000,72.8900);
)->.eat;

// ── B. SEE / DO ────────────────────────────────────────────────────────────
(
  nwr["tourism"~"^(attraction|museum|gallery|viewpoint|artwork|theme_park|zoo|aquarium)$"]
     ["name"](18.9600,72.7900,19.1000,72.8900);
  nwr["historic"](18.9600,72.7900,19.1000,72.8900);
  nwr["amenity"~"^(theatre|cinema|nightclub|casino|public_bath|planetarium)$"]
     ["name"](18.9600,72.7900,19.1000,72.8900);
  nwr["leisure"~"^(park|garden|pitch|playground|bird_park|nature_reserve|golf_course|sports_centre|marina|slipway)$"]
     ["name"](18.9600,72.7900,19.1000,72.8900);
  nwr["natural"~"^(beach|peak|hill|waterfall|cave_entrance|rock|spring|volcano)$"]
     ["name"](18.9600,72.7900,19.1000,72.8900);
  nwr["man_made"~"^(pier|breakwater|lighthouse|tower|obelisk)$"]
     ["name"](18.9600,72.7900,19.1000,72.8900);
)->.seedo;

// ── C. MAKE / SHOP (the long tail — under-mapped AND under-modelled) ───────
(
  nwr["craft"](18.9600,72.7900,19.1000,72.8900);
  nwr["shop"~"^(craft|bicycle|kayak|surfboard|books|record_shop|antiques|art|charity|second_hand|electronics|mobile_phone|computer|boutique|jewelry|department_store|wholesale|trade|garden_centre)$"]
     ["name"](18.9600,72.7900,19.1000,72.8900);
  nwr["amenity"~"^(marketplace|arts_centre|social_centre|swimming_pool|sports_centre|diving|boat_rental)$"]
     ["name"](18.9600,72.7900,19.1000,72.8900);
  nwr["office"~"^(company|government|coworking)$"](18.9600,72.7900,19.1000,72.8900);
)->.make;

// ── D. SPIRITUAL / COMMUNITY (high search volume in Mumbai) ───────────────
(
  nwr["amenity"~"^(place_of_worship|grave_yard|shrine)$"]
     ["name"](18.9600,72.7900,19.1000,72.8900);
  nwr["amenity"~"^(cafe|restaurant|fast_food)$"]
     ["cuisine"~"^(vegan|vegetarian)$"](18.9600,72.7900,19.1000,72.8900);
  nwr["amenity"~"^(drinking_water|fountain|toilets)$"](18.9600,72.7900,19.1000,72.8900);
)->.spirit;

// ── UNION + OUT ────────────────────────────────────────────────────────────
(.eat; .seedo; .make; .spirit;);
out center;
```

The polygon variant (coastline / Navi Mumbai, where a bbox would pull in the sea and half Thane) — note the `lat lon` order and that ways/relations come back with `center`:
```overpassql
[out:json][timeout:90];
(
  nwr["amenity"~"^(restaurant|cafe|bar)$"](poly:"19.0725 72.7750 19.1350 72.8300 19.1300 72.8100 19.0700 72.8000");
  nwr["leisure"="park"]["name"](poly:"19.0725 72.7750 19.1350 72.8300 19.1300 72.8100 19.0700 72.8000");
  nwr["tourism"~"^(attraction|museum|gallery)$"]["name"](poly:"19.0725 72.7750 19.1350 72.8300 19.1300 72.8100 19.0700 72.8000");
);
out center;
```

**Client-side wrapper contract (port these behaviours, do not re-invent):**
```
1. canonicalise the ring to 6 dp                       _overpass.py:280
2. sha1(canonical GET-form url) -> cache key           _http.py:88
3. if cache hit (and no "remark") -> return, no HTTP   _overpass.py:452-454
4. GET /status -> parse line 5 token 0                 _overpass.py:196
     int        -> 0 slots free, pause 0
     "Slot"     -> sleep until the named UTC instant
     "Currently" -> sleep 5 s and re-poll
     anything else / error -> pause 60
5. POST to <baseUrl>/interpreter with the QL           _overpass.py:450,469-475
6. on 429 or 504 -> sleep 55 s, retry (cap at 3)      _overpass.py:477-486
7. if response has "remark" -> DO NOT CACHE, raise     _http.py:56-58
8. if elements == [] -> InsufficientResponseError      _errors.py:16
9. split bbox > 2.5 km2 before step 1                  settings.py:157
```

---

## 4.0 CORRECTION — the npm port parses OSM `opening_hours` (verified, do not re-investigate)

The original §4 finding said we must write an OSM `opening_hours` tokenizer ourselves. **That is
wrong for our stack, and the mistake came from analysing the wrong package.** The finding read
`adopt/opening-hours-php` (Spatie's PHP library). We are not installing that — we install the npm
port `opening_hours@3.15.0`, which is a *different, extended* codebase that includes the OSM
tokenizer.

Verified live on Node 24 with `npm install opening_hours`:

```
new opening_hours('Mo-Fr 09:00-18:00')
  .getOpenIntervals(wed, thu)   ->  [["2026-09-23T03:30:00.000Z","2026-09-23T12:30:00.000Z",false,null]]
  .getOpenDuration(wed, thu)    ->  [32400000, 0]        // 9 hours, correct
```

03:30Z–12:30Z is 09:00–18:00 **IST**, so timezone handling is correct too (the README notes it uses
`suncalc` + Nominatim data for `sunrise`/`sunset` keywords).

All of these real OSM strings parse without throwing:
`Mo-Fr 09:00-18:00` · `Mo-Su 09:00-21:00` · `24/7` · `Mo,Tu,We 10:00-14:00; 16:00-20:00` ·
`off` · `open` · `Jan 1 off` · `Mo-Su 08:00-12:00,14:00-20:00`

**Consequence for the build:** we do NOT write our own tokenizer. We wrap `opening_hours` behind a
thin adapter (its licence is LGPL-3.0, so keeping it swappable is still the right call) and use
`getOpenIntervals` rather than a boolean `isOpen` — the feasibility gate needs the actual open
*windows* to answer "is it open during the traveller's specific window", which is strictly more
than a yes/no.

Still true from the original finding, and still binding: `PH off` and inline comments are NOT
supported, and the library can throw on malformed input — so the adapter must catch and degrade to
"hours unknown" rather than 500.

---

## 4. `opening_hours` grammar coverage — the real limitation

### 4.1 The headline finding

`adopt/opening-hours-php` = **spatie/opening-hours**, a PHP library whose input is a **normalised array**, not the OSM grammar string. Confirmed three ways:
* `src/OpeningHours.php:102-127` — `create(array $data, ...)`; the PHPDoc array shape is `{monday?, tuesday?, …, sunday?, exceptions?, filters?, overflow?, data?, dateTimeClass?}`.
* `src/TimeRange.php:23-32` — the only string entry: `TimeRange::fromString('HH:MM-HH:MM')`.
* `README.md:702-708` — under "## Adapters / ### OpenStreetMap": **"You can convert OpenStreetMap format to `OpeningHours` object using [osm-opening-hours] (thanks to mgrundkoetter)."**

⇒ **The OSM grammar lives in a *separate* package (`ujamii/osm-opening-hours`), not in this repo.** The npm package `opening_hours` is likewise a *different* codebase from this PHP one. So the adapter shape we must build is: *OSM string → (our tokenizer) → this library's normalised array → `OpeningHours::create`*.

Also relevant: `composer.json:23-25` requires PHP `^8.2`; latest release in `CHANGELOG.md:5-7` is **4.2.2 (2026-07-09)**. "port to npm as `opening_hours`" in the brief refers to a JS port of the OSM grammar, not of this library — verify which one before wiring.

### 4.2 What the library DOES support (grammar coverage, precisely)

| OSM construct | Supported? | Evidence |
|---|---|---|
| Multiple ranges per day | YES | `README.md:38` `'monday' => ['09:00-12:00', '13:00-18:00']`; `OpeningHoursForDay::fromStrings` `src/OpeningHoursForDay.php:29-44` sorts and maps them |
| Week day names (lowercase English) | YES | `src/Day.php:9-17` enum `monday`…`sunday`; `Day::fromName` lowercases (`Day.php:24-31`) |
| Day **range** `monday to friday` | YES | `OpeningHours::readDatesRange` `src/OpeningHours.php:802-832`; split on `/\sto\s/`, then `daysBetween` |
| Date range with dashes `12-24 to 12-26` | YES | same; `README.md:170-183` |
| Overnight spans `friday => ['20:00-03:00']` | YES **but opt-in** | `'overflow' => true` required (`README.md:99-107`; `OpeningHours.php:376-392`, `:542-549`) |
| `24:00` end-of-day | YES | `Time::fromString` regex `/^(([0-1][0-9]\|2[0-3]):[0-5][0-9]\|24:00)$/` — `src/Time.php:29-31` |
| Off-days (`[]`) | YES | `'sunday' => []`, `README.md:44`; `OpeningHoursForDay::isEmpty()` `:250-253` |
| `isAlwaysOpen()` (i.e. `24/7`) | YES | `OpeningHours.php:1024-1032` — matches when **every** day stringifies to exactly `'00:00-24:00'` |
| Holidays / date exceptions | YES | `'exceptions' => ['2016-11-11' => [...], '12-25' => []]` `README.md:44-49`. Exact `Y-m-d` AND recurring `m-d`. Precedence in `forDate` `OpeningHours.php:333-335`: `Y-m-d` → `m-d` → weekday |
| Recurring-vs-one-off exception disambiguation | YES | `setExceptionsFromStrings` `:866-889` tries `m-d` first, falls back to `Y-m-d`, else `InvalidDate` |
| Callable "filters" (dynamic closures) | YES | `README.md:185-210`; `forDate` `:325-331` — first non-null wins. README warns: "we will loop on all filters for each date … so you must be careful with filters" |
| Arbitrary per-range metadata (`data`) | YES | `DataTrait`; `README.md:109-136`; `OpeningHours.php:748` `Arr::pull($data,'data',null)` |
| schema.org `OpeningHoursSpecification` | YES | `src/OpeningHoursSpecificationParser.php:1-225`; `createFromStructuredData` `:129-143` |
| `nextOpen` / `nextClose` / `previousOpen` / `previousClose` | YES | `OpeningHours.php:468-710` |
| `currentOpenRange` + Start/End | YES | `:409-466` |
| **Merge overlapping ranges** | YES | `mergeOverlappingRanges` `:151-196`, `createAndMergeOverlappingRanges` `:216-219` |
| Round-trip to schema.org | YES | `asStructuredData` `:970-1012` |
| `diffInOpenHours/Minutes/Seconds` | YES | `README.md:538-568` |
| `isOpenOn('2024-12-25')` date-string form | YES | `:359-369` regex `/^(?:(\d+)-)?(\d{1,2})-(\d{1,2})$/` |
| **`24/7` literal string** | **NO** | never appears as a parseable input; only reachable as `['monday'=>['00:00-24:00'], …]`. Our tokenizer must expand `24/7` into that. |
| **`Mo-Fr 09:00-18:00` (the actual OSM string)** | **NO** | `TimeRange::fromString` does `explode('-', $string)` and requires exactly 2 parts (`TimeRange.php:25-31`) → `"Mo-Fr 09:00-18:00"` throws `InvalidTimeRangeString` |
| **`PH off`, `Mo-We off`, `sunrise-sunset`, `sunset-sunrise`** | **NO** | not in the codebase |
| **Comments (`// note`)** | **NO** | not in the codebase |
| **PH / public holidays** | **NO, explicitly rejected** | `OpeningHoursSpecificationParser.php:94-96` — `'PublicHolidays', 'https://schema.org/PublicHolidays' => throw new InvalidOpeningHoursSpecification('PublicHolidays not supported')` |
| **`open` / `closed` as data** | **NO** | only as *derived booleans* (`isOpen`/`isClosed` `OpeningHours.php:399-407`); no string input. `formatHours` treats `00:00-00:00` as *closed* (`OpeningHoursSpecificationParser.php:172-175`) |
| Week numbers / year selectors (`2024-Mo-Fr`) | **NO** | not in the codebase |
| **`opening_hours:covid`** | **NO** | obviously; and not in the schema either (§1.1) |

### 4.3 Partial / missing data behaviour — quoted

* **Empty day** → `OpeningHoursForDay` with zero ranges; `isEmpty()` true (`:250-253`); `regularClosingDays()` (`:712-717`) returns those day names; `isOpenOn('sunday')` false (`:359-369`).
* **Entirely empty spec** → `isAlwaysClosed()` true but *only* if there are no filters (`:1014-1022`):
```php
$allExceptionsAlwaysClosed && $noFiltersApplied && $allOpeningHoursAlwaysClosed
```
  Note the `$noFiltersApplied` guard — a callable filter suppresses the verdict.
* **Day key with a range that overlaps another** → hard throw at construction: `InvalidDateRange::invalidDateRange($dayKey, $day)` (`OpeningHours.php:791-793`, `:772-774`).
* **Overlapping time ranges within one day** → hard throw at construction: `OpeningHoursForDay::guardAgainstTimeRangeOverlaps` (`:260-267`) → `OverlappingTimeRanges::forRanges` (`Exceptions/OverlappingTimeRanges.php:39-45`).
  ⚠ **This is the #1 real-data crash.** `Mo-Fr 09:00-13:00, 12:00-14:00` is extremely common in sloppy OSM data. Always run `mergeOverlappingRanges` first.
* **`opens`/`closes` mismatch in structured data** → throw: `'Property opens and closes must be both null or both string'` (`OpeningHoursSpecificationParser.php:150-157`).
* **`00:00-00:00`** → treated as closed, returns `null` (`:172-175`).
* **`opens`/`closes` regex** → `^\d{2}:\d{2}(:\d{2})?$` (`:160-166`); seconds stripped (`:169-170`); `23:59` normalised to `24:00` (`:177`).
* **Non-string day name in structured data** → throw (`:73-77`).

### 4.4 The complete throw list — what our wrapper MUST catch

All under `Spatie\OpeningHours\Exceptions\Exception` (which extends `\Exception`, `Exceptions/Exception.php:16-18`):

| Exception | Factory | Trigger |
|---|---|---|
| `InvalidTimeString` | `::forString($s)` `Exceptions/InvalidTimeString.php:7-10` | `Time::fromString` regex fail, e.g. `9:00` (no leading zero), `24:30`, `25:00` |
| `InvalidTimeRangeString` | `::forString($s)` | `TimeRange::fromString` when `explode('-')` != 2 parts |
| `InvalidTimeRangeArray` | `::create()` | `TimeRange::fromArray` when no `hours` value (`:54-56`) |
| `InvalidTimeRangeList` | `::create()` | `fromList` with 0 or non-`TimeRange` members (`:69-76`) |
| `InvalidDayName` | `::invalidDayName($n)` `Exceptions/InvalidDayName.php:27-33` | `Day::fromName` — day must be a lowercase English word |
| `InvalidDateRange` | `::invalidDateRange($entry, $date)` `Exceptions/InvalidDateRange.php:63-66` | a day/exception key resolves to a day/date already set |
| `InvalidDate` | `::invalidDate($date)` | exception key is neither valid `m-d` nor `Y-m-d` (`:876-885`) |
| `InvalidDateTimeClass` | `::forString($c)` | `dateTimeClass` doesn't implement `DateTimeInterface` (`:95-97`) |
| `InvalidTimezone` | `::create()` | `parseTimezone` gets a truthy non-string, non-`DateTimeZone` (`:1053-1068`) |
| `OverlappingTimeRanges` | `::forRanges($a, $b)` | see §4.3 |
| `MaximumLimitExceeded` | `::forString($s)` | `nextOpen`/`nextClose`/`previousOpen`/`previousClose` exhaust `dayLimit` (default `DEFAULT_DAY_LIMIT = 8`, `OpeningHours.php:26`, `:480-486`, `:568-576`, `:616-624`, `:675-683`) |
| `SearchLimitReached` | `::forDate($d)` | `$searchUntil` passed to next/previous* (`:500-502`, `:590-592`, `:639-641`) |
| `NonMutableOffsets` | `::forClass($c)` | `ArrayAccess::offsetSet/offsetUnset` on `OpeningHoursForDay` (`:200-208`) |
| `InvalidOpeningHoursSpecification` | constructor | all `OpeningHoursSpecificationParser` errors; re-wrapped with the item index: `"Invalid openingHoursSpecification item at index $index: $message"` (`:16-27`) |
| `ValueError` (PHP native) | — | leaks from `Day::from` via `Day::fromName` (`Day.php:26-30`) — **not a `Spatie` exception; a bare `catch (Exception)` will not catch it** |
| `JsonException` | — | `createFromString` when the JSON is malformed (`OpeningHoursSpecificationParser.php:43-48`) |

**Non-throwing failure we must handle ourselves:** the OSM string. There is *no* parser, so "invalid OSM grammar" is our code's problem, not theirs. Adopt exactly four statuses (already in §1.2's zod): `ok` / `partial` / `unparsable` / `absent`, and **never** let a parse failure hide a POI — set `status: 'unparsable'`, `open: null`, and let the UI say "hours unknown".

### 4.5 Representative parsing code to quote in our adapter PR

```php
// adopt/opening-hours-php/src/Time.php:27-36  — the ONLY string->time parser
public static function fromString(string $string, mixed $data = null, ?DateTimeInterface $date = null): self
{
    if (! preg_match('/^(([0-1][0-9]|2[0-3]):[0-5][0-9]|24:00)$/', $string)) {
        throw InvalidTimeString::forString($string);
    }
    [$hours, $minutes] = explode(':', $string);
    return new self($hours, $minutes, $data, $date);
}

// adopt/opening-hours-php/src/TimeRange.php:23-32
public static function fromString(string $string, $data = null): self
{
    $times = explode('-', $string);
    if (count($times) !== 2) {
        throw InvalidTimeRangeString::forString($string);
    }
    return new self(Time::fromString($times[0]), Time::fromString($times[1]), $data);
}

// adopt/opening-hours-php/src/TimeRange.php:109-132  — overnight detection
public function isReversed(): bool         { return $this->start->isAfter($this->end); }
public function overflowsNextDay(): bool   { return $this->isReversed(); }
public function spillsOverToNextDay(): bool{ return $this->isReversed(); }
public function containsTime(Time $time): bool {
    return $time->isSameOrAfter($this->start) && ($this->overflowsNextDay() || $time->isBefore($this->end));
}

// adopt/opening-hours-php/src/OpeningHours.php:321-336  — exception precedence
public function forDate(DateTimeInterface $date): OpeningHoursForDay
{
    $date = $this->applyTimezone($date);
    foreach ($this->filters as $filter) {
        $result = $filter($date);
        if (is_array($result)) return OpeningHoursForDay::fromStrings($result);
    }
    return $this->exceptions[$date->format('Y-m-d')]
        ?? $this->exceptions[$date->format('m-d')]
        ?? $this->forDay(Day::onDateTime($date));
}

// adopt/opening-hours-php/src/OpeningHours.php:802-832  — "A to B" / "A-B" ranges
protected function readDatesRange(Day|string $key): iterable
{
    if ($key instanceof Day) return [$key->value];
    $toChunks = preg_split('/\sto\s/', $key, 2);
    if (count($toChunks) === 2) return $this->daysBetween(trim($toChunks[0]), trim($toChunks[1]));
    $dashChunks = explode('-', $key);
    $chunksCount = count($dashChunks);
    $firstChunk = trim($dashChunks[0]);
    if ($chunksCount === 2 && preg_match('/^[A-Za-z]+$/', $firstChunk)) {
        return $this->daysBetween($firstChunk, trim($dashChunks[1]));
    }
    ...
    return [$key];
}
```

Three operational notes:
* **Timezone is mandatory.** `applyTimezone` (`:896-899`) / `getDateWithTimezone` (`:901-912`) mean we must always construct with `Asia/Kolkata` and never let the server TZ leak in. `forDate` calls `Day::onDateTime($date)` which uses `$dateTime->format('l')` (`Day.php:19-22`) — the *local* day name, so the timezone application order matters.
* **Day limit.** `nextOpen` on an always-closed POI throws `MaximumLimitExceeded` after 8 days. **Always pass `$searchUntil` or a `$cap`** (`OpeningHours.php:468-472`, `:496-502`) when scanning for "when is this open next".
* **`overflow` must be enabled explicitly.** The schema.org path hard-codes it (`OpeningHoursSpecificationParser` merged with `['overflow' => true]`, `:136-137`) but the array path does not. Set it for any bar/nightlife POI.

---

## 5. Isochrone / travel-time API shapes

### 5.1 GraphHopper (self-hostable, no key)

**`/route`** — `data/graphhopper/docs/web/api-doc.md:14-52`. GET uses `point=lat,lon`; POST uses `"points": [[lon,lat],[lon,lat]]` — the docs are explicit about the inversion (`:26`: "unlike to the GET endpoint, points are specified in `[longitude, latitude]` order"). Singular→plural renames on POST: `points`, `snap_preventions`, `curbsides`, `point_hints`; `details` stays `details` (`:23-24`).

Response (`api-doc.md:105-126`, example `:127-197`):
```
paths[0].distance            metres (float)
paths[0].time                ms (int)          <-- note ms, not s
paths[0].ascend / .descend   metres
paths[0].points              encoded polyline (if points_encoded) else GeoJSON coords
paths[0].points_encoded      bool
paths[0].bbox                [minLon, minLat, maxLon, maxLat]
paths[0].snapped_waypoints   encoded | array
paths[0].instructions[].{text, street_name, distance, time, interval:[from,to], sign, exit_number?, turn_angle?}
paths[0].details             { street_name: [[fromRef,toRef,"value"], ...] }
```
⚠ `time` is in **ms** for `/route` (`paths[0].time: 129290` in the example = 129.29 s, `api-doc.md:194`).
Other useful params: `instructions` (default true), `elevation` (false), `points_encoded` (true), `points_encoded_multiplier` (1e5), `calc_points` (true), `point_hint`, `snap_prevention` (default `[tunnel, bridge, ferry]`; supported `motorway|trunk|ferry|tunnel|bridge|ford`, `api-doc.md:47`), `details` (available: `average_speed`, `street_name`, `edge_id`, `road_class`, `road_environment`, `max_speed`, `time`, `:48`), `timeout_ms` (`:51`), `via_point_instructions` (`:52`).
⚠ Elevation caveat (`api-doc.md:42`): "If enabled you have to use a modified version of the decoding method or set points_encoded to false."

**`/isochrone`** — `api-doc.md:253-269`:
> "In addition to routing, the end point to obtain an isochrone is `/isochrone`. **To get a point list instead of a polygon you can have a look into the /spt endpoint.**"

| Parameter | Default | Meaning (`api-doc.md:261-269`) |
|---|---|---|
| `profile` | — | required |
| `point` | — | **required**, `latitude,longitude` string |
| `buckets` | 1 | "Number by which to divide the given `time_limit` to create `buckets` nested isochrones of time intervals `time_limit-n*time_limit/buckets` for `n=[0,buckets)`" |
| `reverse_flow` | false | false = point→polygon; true = polygon→point ("*How many potential customer can be reached within 30min travel time from your store* vs. *How many customers can reach your store*") |
| `time_limit` | 600 | seconds |
| `distance_limit` | -1 | metres |
| `pt.earliest_departure_time` | — | required for `pt` profile, ISO-8601 `yyyy-MM-ddTHH:mm:ssZ` (`:92`) |

Response shape (from routingpy's parser, `adopt/routingpy/routingpy/routers/graphhopper.py:496-515`):
```python
accessor = "polygons" if type == "json" else "features"
for index, polygon in enumerate(response[accessor]):
    Isochrone(
        geometry=[l[:2] for l in polygon["geometry"]["coordinates"][0]],  # takes in elevation for some reason
        interval=int(max_range * ((polygon["properties"]["bucket"] + 1) / buckets)),
        center=center, interval_type=interval_type,
    )
```
So: `type=json` → `{polygons:[{geometry:{coordinates:[[[lon,lat,elev],...]]}, properties:{bucket}}]}`; `type=geojson` → `{features:[...]}`.

**`/matrix`** — not documented in this clone (no `MatrixResource` present), but the exact param set is in the routingpy adapter (`routers/graphhopper.py:517-630`):
```
GET /matrix?profile=…&point=lat,lon&point=…&out_array=times&out_array=distances
or   &from_point=…&to_point=…   (when sources/destinations given)
```
Note `sources`/`destinations` are **0-based indices** into `locations` (`graphhopper.py:549-554`), translated to `from_point`/`to_point` (`:602-608`), with `IndexError` on out-of-range (`:585-586`, `:594-597`). `out_array` ∈ `weights|times|distances` (`:556-560`), emitted as repeated params (`:610-612`).

Response (`graphhopper.py:623-630`):
```python
durations = response.get("times")      # seconds, NxM
distances = response.get("distances")  # metres, NxM
return Matrix(durations=durations, distances=distances, raw=response)
```
⚠ `/matrix` time is **seconds** (unlike `/route`'s ms), and unreachable cells are `null`.

**`/info`** — `api-doc.md:199-226`: `{build_date, bbox, version, elevation, profiles:[{name}], features, encoded_values}`. **Call it at boot to discover which `encoded_values` exist** (`custom-models.md:110`: "To learn about all available encoded values you can query the `/info` endpoint").

### 5.2 GraphHopper weighting customisation (the Mumbai congestion multiplier)

**The weighting formula** — `data/graphhopper/docs/core/custom-models.md:37`:
```
edge_weight = edge_distance / (speed * priority) + edge_distance * distance_influence + turn_penalty
```
* `speed` **changes the reported travel time too**.
* `priority` changes **only** route choice, not time. `custom-models.md:44-48`:
  > "What if we want to increase an edge's weight, so it won't be part of the optimal route in case there is a better alternative, but we do not want to modify the travelling time? **This is the reason why there is the `priority` factor** … By default, `priority` is always `1`, so it has no effect."
* `distance_influence` trades time for distance. `custom-models.md:52-58` (worked example: "A value of `30` means that one extra kilometer of detour must save you `30s` of travelling time").
* `turn_penalty` adds absolute weight without changing duration. `custom-models.md:60-64`.

**Three operators** — `custom-models.md:188-190`: `multiply_by`, `limit_to`, `do`. Plus `else` / `else_if`. Rules apply **top-to-bottom**, each only if its `if` matches (`custom-models.md:120-124`). Example of two matching rules both firing: `0.5 * 0.7 = 0.35` (`:226-231`).
Conditions are Java expressions: `road_class == PRIMARY || road_environment == TUNNEL` (`:220`), `country == USA` (`:284`), `state == US_CA` (`:294`), `max_width < 2.5` (`:270`), boolean encoded values used bare (`:256-266`).

**Encoded values available as conditions** — `custom-models.md:68-96`: `road_class` (OTHER, MOTORWAY, TRUNK, PRIMARY, SECONDARY, TRACK, STEPS, CYCLEWAY, FOOTWAY…), `road_environment` (ROAD, FERRY, BRIDGE, TUNNEL…), `road_access` (DESIGNATED, YES, DISCOURAGED, DESTINATION, DELIVERY, PRIVATE, NO…), `surface`, `sidewalk`, `cycleway`, `toll` (MISSING, NO, HGV, ALL), **`urban_density` (RURAL, RESIDENTIAL, CITY)**, `max_speed`, `lanes`, `curvature`, `average_slope`, `max_slope`, `lit`, `roundabout`, `get_off_bike`, `country` (ISO3166-1 alpha3), `state` (ISO3166-2), plus `<vehicle>_average_speed` and `<vehicle>_priority`, and special expressions `backward_*`, `in_*`, `prev_*` (turn_penalty only), `country.isRightHandTraffic()`, `edge.getDistance()`.

**A full POST /route custom-model request** — `custom-models.md:157-181`:
```json
{
  "points": [[13.31543, 52.509535],[13.29779, 52.512434]],
  "profile": "car",
  "ch.disable": true,
  "custom_model": {
    "speed":    [{ "if": "true", "limit_to": "100" }],
    "priority": [{ "if": "road_class == MOTORWAY", "multiply_by": "0" }],
    "distance_influence": 100
  }
}
```

**⚠ The hard constraint** — `custom-models.md:169-170`:
> "Note that this only works for custom profiles and **so far only for POST /route (but not GET /route or /isochrone, /spt or /map-matching)**."

⇒ **A congestion multiplier cannot be applied to a GraphHopper isochrone per-request.** It must be a server-side profile file. Real shipped example — `data/graphhopper/core/src/main/resources/com/graphhopper/custom_models/car.json:6-15`:
```json
{
  "distance_influence": 90,
  "priority": [ { "if": "!car_access", "multiply_by": "0" } ],
  "speed": [
    { "if": "road_environment == FERRY", "limit_to": "ferry_speed" },
    { "else": "", "limit_to": "car_average_speed" },
    { "if": "true", "limit_to": "max_speed * 0.9" }
  ]
}
```
wired up in `data/graphhopper/config-example.yml:29-45`:
```yaml
profiles:
 - name: car
   custom_model_files: [car.json]
 - name: foot
   custom_model_files: [foot.json, foot_elevation.json]
```
`config-example.yml:20-27` documents `weighting` (default `'custom'`), `turn_costs`, and that you may use the `custom_model` field directly in the profile instead of files.

⇒ **ATHITI Mumbai congestion model = a second profile**, e.g. `car_mumbai_peak.json`, layered *after* `car.json`:
```jsonc
// car_mumbai_peak.json
// NOTE: GraphHopper custom models have NO time-of-day condition, so "peak vs
// off-peak" must be TWO PROFILES selected by the client from the IST clock,
// not one model with a time check.
{
  "priority": [
    // penalise WITHOUT inflating the reported duration (custom-models.md:44-48)
    { "if": "road_class == MOTORWAY || road_class == TRUNK", "multiply_by": "0.35" },
    { "if": "urban_density == CITY",                          "multiply_by": "0.70" },
    { "if": "road_class == PRIMARY",                          "multiply_by": "0.80" }
  ],
  "speed": [
    // and now actually slow things down (this DOES change reported time)
    { "if": "urban_density == CITY", "limit_to": "30" }
  ],
  "distance_influence": 120
}
```
Client rule: `hour in [8..11) || hour in [18..22)` → `profile: "car_mumbai_peak"`, else `"car"`. That is the only way to get time-dependent weighting in GH.

Two more shipped examples worth copying:
```jsonc
// core/src/main/resources/com/graphhopper/custom_models/car_avoid_private_etc.json
{
  "turn_penalty": [{
    "if": "prev_road_access != road_access && (road_access == DESTINATION || road_access == PRIVATE || road_access == DELIVERY || road_access == CUSTOMERS || road_access == MILITARY)",
    "add": "2000"
  }]
}
// core/src/main/resources/com/graphhopper/custom_models/curvature.json
{ "priority": [ { "if": "curvature >= 0.98", "multiply_by": "0.4" } ] }   // "prefer curvy roads"
```

**`ch.disabling_allowed` is GONE** — `data/graphhopper/core/src/main/java/com/graphhopper/GraphHopper.java:462-466`:
```java
// disabling_allowed config options were removed for GH 3.0
if (ghConfig.has("routing.ch.disabling_allowed"))
    throw new IllegalArgumentException("The 'routing.ch.disabling_allowed' configuration option is no longer supported");
if (ghConfig.has("routing.lm.disabling_allowed"))
    throw new IllegalArgumentException("The 'routing.lm.disabling_allowed' configuration option is no longer supported");
```
Replacement — `data/graphhopper/web-api/src/main/java/com/graphhopper/util/Parameters.java:155-162`:
```java
public static final class CH {
    public static final String PREPARE = "prepare.ch.";
    /** This property name in HintsMap configures at runtime if CH routing should be ignored. */
    public static final String DISABLE = "ch.disable";
}
```
plus `Parameters.java:170` `lm.disable`, `:172` `lm.active_landmarks`. Docs `api-doc.md:65-69`:
> "Unlock certain flexible features via `ch.disable=true` per request or disable CH on the server-side by using an **empty list for `profiles_ch`**. The only exception is the parameter `algorithm=alternative_route` which is also available without specifying `ch.disable=true`."

Hybrid mode (`api-doc.md:57-63`): `ch.disable` + `lm.active_landmarks` (default 4, "Not recommended to change this").
Algorithms (`api-doc.md:74`): `dijkstra`, `astar`, `astarbi` (default), `alternative_route`, `round_trip`; constants at `Parameters.java:30-88`.

**`heading`** — `api-doc.md:75-77`:
> "Favour a heading direction for a certain point. Specify either one heading for the start point or as many as there are points. In this case headings are associated by their order to the specific points. **Headings are given as north based clockwise angle between 0 and 360 degree.** This parameter also influences the tour generated with `algorithm=round_trip` and forces the initial direction."
> `heading_penalty` | 300 | "Penalty for omitting a specified heading. The penalty corresponds to the accepted **time delay in seconds** in comparison to the route without a heading."
> `pass_through` | `false` | "If `true` u-turns are avoided at via-points with regard to the `heading_penalty`."

Constants: `Parameters.java:133-136` — `DEFAULT_HEADING_PENALTY = 300`, `HEADING_PENALTY = "heading_penalty"`; `:123-126` `PASS_THROUGH` with the comment "(not for CH)".
Semantics — `data/graphhopper/docs/core/heading.md:3`:
> "A heading with the value 'NaN' won't be enforced and a heading not within [0, 360] will trigger an IllegalArgumentException. **It is important to note that if you force the heading at via or end points the outgoing heading needs to be specified.** I.e. if you want to force 'coming from south' to a destination you need to specify the resulting 'heading towards north' instead, which is 0."

Concrete call, `heading.md:40`:
`localhost:8989/route?profile=car&point=42.566757,1.597751&point=42.567396,1.597807&type=json&instructions=false&points_encoded=false&ch.disable=true&heading=270`

**`curbsides`** — `Parameters.java:139-150` + `api-doc.md:49-50`. Values `left|right|any|auto` (`Parameters.java:141-149`), with `auto` described as "automatically avoids crossing the street for bigger roads (PRIMARY, SECONDARY) i.e. forces 'right' for right-hand traffic" — **exactly the Indian-driver problem**. `curbsides_strictness` ∈ `strict` (throws if unfulfillable) / `soft`; default `strict`.

**`pt` public transit** — `api-doc.md:86-98`: `pt.earliest_departure_time`, `pt.arrive_by`, `pt.profile` (range query), `pt.profile_duration` (default `PT60M`), `pt.limit_street_time`, `pt.ignore_transfers`, `pt.limit_solutions`. **For a Mumbai product this is how we get "next train from Andheri"** — and `reader-gtfs/` is in the sparse clone for a reason.

**Error shape** — `api-doc.md:228-252`: `{ "message": "Cannot find point 2: 2248.224673, 3.867187", "hints": [{"message": "..."}] }`; codes 500 / 501 / 400.

### 5.3 routingpy — the adapter interface to mirror

`adopt/routingpy/routingpy/routers/__init__.py:1-16` states the dogma:
> "Each router has at least a `directions` method, many offer additionally `matrix` and/or `isochrones` methods. Other available provider endpoints are allowed and generally encouraged. … **routingpy's dogma is, that all routers expose the same mandatory arguments for common methods in an attempt to be consistent for the same method across different routers. Unlike other collective libraries, we additionally chose to preserve each router's special arguments, only abstracting the most basic arguments, such as locations and profile (car, bike, pedestrian etc.)**"

Registry + factory (`routers/__init__.py:28-72`):
```python
_SERVICE_TO_ROUTER = {
    "google": Google, "graphhopper": Graphhopper, "ign": IGN,
    "mapbox_osrm": MapboxOSRM, "mapbox-osrm": MapboxOSRM, "mapbox": MapboxOSRM,
    "mapboxosrm": MapboxOSRM, "openrouteservice": ORS, "opentripplanner": OpenTripPlannerV2,
    "opentripplanner_v2": OpenTripPlannerV2, "ors": ORS, "osrm": OSRM, "otp": OpenTripPlannerV2,
    "otp_v2": OpenTripPlannerV2, "valhalla": Valhalla,
}
def get_router_by_name(router_name):
    try: return _SERVICE_TO_ROUTER[router_name.lower()]
    except KeyError: raise RouterNotFound("Unknown router '{}'; options are: {}".format(router_name, _SERVICE_TO_ROUTER.keys()))
```

Base client — `routingpy/client_base.py:91-198`: `BaseClient(base_url, user_agent, timeout, retry_timeout, retry_over_query_limit, skip_api_error, **kwargs)` with one `@abstractmethod _request(url, get_params, post_params, first_request_time, retry_counter, dry_run)`. Global `options` (`:37-85`): `default_timeout=60`, `default_retry_timeout=60`, `default_retry_over_query_limit=True`, `default_skip_api_error=False`, `default_user_agent='routingpy/v{ver}'`, `default_proxies=None`. `DEFAULT` sentinel (`:88`) distinguishes "caller did not pass" from "caller passed None". URL building is sorted+urlencoded (`:200-223`).

Retry/backoff — `client_default.py:34` `_RETRIABLE_STATUSES = set([503])`; `:144-155`:
```python
elapsed = datetime.now() - first_request_time
if elapsed > self.retry_timeout: raise exceptions.Timeout()
if retry_counter > 0:
    # 0.5 * (1.5 ^ i) is an increased sleep time of 1.5x per iteration,
    # starting at 0.5s when retry_counter=1. The first retry will occur
    # at 1, so subtract that first.
    delay_seconds = 1.5 ** (retry_counter - 1)
    time.sleep(delay_seconds * (random.random() + 0.5))   # +/-50% jitter
```
Status→exception map — `client_default.py:222-250`:
```python
if status_code == 200: ... return response.json()   (or .content if image/tiff)
if status_code == 429: raise exceptions.OverQueryLimit(status_code, response.text)
if 400 <= status_code < 500: raise exceptions.RouterApiError(status_code, response.text)
if 500 <= status_code:      raise exceptions.RouterServerError(status_code, response.text)
if status_code != 200:      raise exceptions.RouterError(status_code, response.text)
```
`skip_api_error` swallows `RouterApiError` in batch loops (`:194-200`); `retry_over_query_limit=False` makes `OverQueryLimit` fatal (`:207-209`).

**Normalised return types** (three, no more) — see §8.1 for the TS port. Python originals:
```python
# routingpy/direction.py:63-146
class Direction:
    def __init__(self, geometry=None, duration=None, distance=None, raw=None)
    # .geometry  -> [[lon,lat], ...]  (decoded polyline5 or GeoJSON)   :91-97
    # .duration  -> SECONDS                                            :99-106
    # .distance  -> METRES                                             :108-115
    # .km (:118-124), .mi (:126-133), .raw (:135-142)
class Directions:   # iterable list of Direction + .raw                 :23-61
# routingpy/isochrone.py:57-105
class Isochrone:
    def __init__(self, geometry=None, interval=None, center=None, interval_type=None)
    # .geometry [[lon,lat],...] (outer ring)                            :67-74
    # .center   [lon,lat] "might deviate from the input coordinate"    :76-85
    # .interval seconds or metres depending on .interval_type           :87-94
class Isochrones:   # iterable list + .raw                              :28-53
# routingpy/matrix.py
class Matrix:
    # .durations [[dur(o1,d1), ...], ...] seconds, null for unreachable
    # .distances same shape, METRES
    # .raw
```
**Every one keeps `raw`. Keep that in TS.**

### 5.4 openrouteservice-js — the request shapes

`adopt/openrouteservice-js/src/OrsBase.js:20-38` — the key rule:
```js
if (Constants.propNames.apiKey in args) {
  this.defaultArgs[Constants.propNames.apiKey] = args[Constants.propNames.apiKey]
} else if (!args[Constants.propNames.host]) {
  // Do not error if a host is specified; useful for locally-run instances of ORS
  console.error(Constants.missingAPIKeyMsg)
  throw new Error(Constants.missingAPIKeyMsg)
}
```
⇒ **ORS against a self-hosted instance needs no key — just pass `host`.** Transport, `OrsBase.js:52-66`: `POST` to `host + '/' + [api_version, service, profile, format].join('/')` (built in `src/OrsUtil.js:37-61`) with header `Authorization: <api_key>` (raw, **no `Bearer` prefix**). Timeout via `AbortController`, default 5000 ms (`OrsBase.js:68-86`). Errors carry `.status` and `.response`. Defaults, `src/constants.js:2-4`: `defaultAPIVersion: 'v2'`, `defaultHost: 'https://api.openrouteservice.org'`.

Isochrones body — `README.md:75-101`:
```js
await Isochrones.calculate({
  locations: [[8.690958, 49.404662], [8.687868, 49.390139]],
  profile: 'driving-car',
  range: [600],                 // NOTE: array
  units: 'km',
  range_type: 'distance',
  attributes: ['area'],
  smoothing: 0.9,
  avoidables: ['highways'],
  avoid_polygons: { type: 'Polygon', coordinates: [[[lon,lat], ...]] },
  area_units: 'km'
})
```
`src/OrsIsochrones.js:15-48` (`getBody`) shows the **argument-shuffling trick** — `restrictions` / `avoidables` / `avoid_polygons` move under an `options` key:
```js
if (args.restrictions)   { options.profile_params = { restrictions: {...args.restrictions} }; delete args.restrictions }
if (args.avoidables)     { options.avoid_features  = [...args.avoidables];           delete args.avoidables }
if (args.avoid_polygons) { options.avoid_polygons  = {...args.avoid_polygons};       delete args.avoid_polygons }
if (Object.keys(options).length > 0) return { ...args, options }
```
Response: a **GeoJSON FeatureCollection**; `dev_app/components/IsochronesApp.js:119-127` splits `response.features` per input location. routingpy's parser (`routers/openrouteservice.py:445-462`) reads `features[].geometry.coordinates[0]` plus `properties.value` and `properties.center`. Param docs `openrouteservice.py:360-413`: `range_type` (time|distance), `location_type` (`start`|`destination`), `smoothing` (0..1), `attributes` (`area|reachfactor|total_pop`), `intersections`.

Matrix — `README.md:206-221`:
```js
await Matrix.calculate({
  locations: [[8.690958,49.404662],[8.687868,49.390139],[8.687868,49.390133]],
  profile: "driving-car",
  sources: ['all'], destinations: ['all']
})
```
`src/OrsMatrix.js:1-15` adds **nothing** — pure boilerplate (sets `service: 'matrix'`, `api_version: 'v2'`). The whole ORS matrix request is `{locations, sources, destinations, metrics, resolve_locations}` POSTed to `/v2/matrix/driving-car/json` (`routers/openrouteservice.py:509-527`); response `{durations, distances}` with `durations` in **seconds** (`:530-535`). Sources/destinations are **0-based indices** (`:484-490`).

### 5.5 Which of these need NO API key today — the decisive table

`routers/*._DEFAULT_BASE_URL`:

| Provider | Default base URL | Key required? | Source |
|---|---|---|---|
| **Valhalla** | `https://valhalla1.openstreetmap.de` | **NO** — `__init__` has no `api_key` param at all | `routers/valhalla.py:36,40-47` |
| **OSRM (FOSSGIS)** | `https://routing.openstreetmap.de/routed-bike` | **NO** — no `api_key` param | `routers/osrm.py:30,34` |
| OpenTripPlannerV2 | `http://localhost:8080` | N/A (self-hosted) | `routers/opentripplanner_v2.py:31,35` |
| **GraphHopper** | `https://graphhopper.com/api/1` | **YES** for the hosted API | `routers/graphhopper.py:31,86-88`: `if base_url == self._DEFAULT_BASE_URL and api_key is None: raise KeyError("API key must be specified.")` — **pass a custom `base_url` (your own GH) and no key is required** |
| **ORS** | `https://api.openrouteservice.org` | **YES** for hosted | `routers/openrouteservice.py:30,84-86` (same guard). Self-host ⇒ pass `host` and skip the key (`OrsBase.js:31-37`) |
| MapboxOSRM | mapbox | YES | `routers/mapbox_osrm.py` |
| IGN | `https://data.geopf.fr/navigation` | key | `routers/ign.py:32,36` |
| Google | google | key + billing | `routers/google.py` |

⚠ **Valhalla's default profile is bike, not car** — `routing.openstreetmap.de/routed-bike`; `routers/osrm.py:317-320` warns: "the public FOSSGIS instances ignore any profile parameter set this way and instead chose to encode the 'profile' in the base URL, e.g. https://routing.openstreetmap.de/routed-bike". For car we must use `https://routing.openstreetmap.de/routed-car`.
⚠ **FOSSGIS OSRM cannot give us isochrones** — `routers/osrm.py:288-289`:
```python
def isochrones(self):  # pragma: no cover
    raise NotImplementedError
```
⇒ **Valhalla is our only no-key isochrone source today.** FOSSGIS OSRM (`/table/v1/{profile}/{coords}`) is our only no-key matrix (`routers/osrm.py:365-367`; `annotations=("duration","distance")` at `:294`).

Valhalla request shape (`routers/valhalla.py:303-495`, `:452-495`):
```python
params = { "locations": Valhalla._build_locations(locations), "costing": profile, "contours": contours }
if options or preference:
    params["costing_options"] = dict()
    profile = profile if profile != "multimodal" else "transit"
    params["costing_options"][profile] = dict()
    if options: params["costing_options"][profile] = options
    if preference == "shortest": params["costing_options"][profile]["shortest"] = True
# denoise in [0,1] (1 = only the largest contour; 0.5 = drop contours < half the
#   area of the largest for that time value)  -- valhalla.py:353-357
# generalize = Douglas-Peucker tolerance in metres                -- :359
# polygons, date_time, avoid_locations, avoid_polygons, show_locations, id
```
Response (`routers/valhalla.py:496-513`): `features[]` with `geometry.type ∈ ("LineString","Polygon")`; ⚠ **it iterates `reversed(response["features"])`** to realign intervals with the requested order. `denoise` matters most for us — 1.0 gives a single clean polygon instead of a swarm of little ones.

Valhalla matrix (`routers/valhalla.py:721-738`) — note the **unit conversion and the `None` guard**:
```python
durations = [[destination["time"] for destination in origin] for origin in response["sources_to_targets"]]
distances = [[destination["distance"] * 1000 if destination["distance"] is not None else None
              for destination in origin] for origin in response["sources_to_targets"]]
```
Valhalla returns **km**; routingpy multiplies by 1000. Trap for a TS port.

Valhalla waypoint constraints — `routers/valhalla.py:88-113` (`Valhalla.Waypoint`) maps 1:1 onto GraphHopper's `heading`/`curbsides`:
```python
waypoint = Valhalla.WayPoint(position=[8.15315, 52.53151], type='through', heading=120,
                              heading_tolerance=10, minimum_reachability=10, radius=400)
# -> {"lon": ..., "lat": ..., "type": "through", "heading": 120,
#     "heading_tolerance": 10, "minimum_reachability": 10, "radius": 400}
```
⇒ **`heading_tolerance` is Valhalla's name for GraphHopper's `heading_penalty`.** That gives us a portable, meaningful "you must arrive heading roughly north" semantic for both free providers.

Valhalla also exposes `expansion` (`:841` — the SPT point-list Valhalla-side analogue of GH's `/spt`) and `raster` (`:565`) and `optimized` (`:1045`).

---

## 6. Geo utilities worth copying (turf)

The `adopt/turf` working tree is empty (files deleted, present in git). Read via `git show HEAD:<path>` — **read-only, no mutation.** 2551 tracked files, ~100 `packages/turf-*` packages.

### 6.1 The seven requested APIs — exact signatures

| Need | Package | Signature | Notes |
|---|---|---|---|
| distance | `@turf/distance` | `distance(from: Coord, to: Coord, options?: {units?: Units}): number` | Haversine; default `'kilometers'`. `packages/turf-distance/index.ts:29-51` |
| bearing | `@turf/bearing` | `bearing(start: Coord, end: Coord, options?: {final?: boolean}): number` | returns **-180…180, positive clockwise from north**. `{final:true}` → final bearing, normalised to [-180,180] (`:64-71`). `packages/turf-bearing/index.ts:29-71` |
| along | `@turf/along` | `along(line: Feature<LineString>\|LineString, distance: number, options?: {units?: Units}): Feature<Point>` | **Geodesic, not vertex-snapped.** `packages/turf-along/index.ts:26-57` |
| bbox | `@turf/bbox` | `bbox(geojson: AllGeoJSON, options?: {recompute?: boolean}): BBox` | `[minX, minY, maxX, maxY]` = `[minLon, minLat, maxLon, maxLat]`; **trusts `geojson.bbox` unless `recompute:true`** (`:28-30`). `packages/turf-bbox/index.ts:22-47` |
| buffer | `@turf/buffer` | `buffer<T>(geojson: T, radius?: number, options?: {units?: Units; steps?: number})` | default `units:'kilometers'`, `steps:8`. **Pulls in `@turf/jsts` + `d3-geo` (`geoAzimuthalEquidistant`)** — the heaviest turf dependency. `packages/turf-buffer/index.ts:1-13, 47-90` |
| nearest point on line | `@turf/nearest-point-on-line` | `nearestPointOnLine(lines, inputPoint: Coord, options?: {units?: Units}): Feature<Point, {lineStringIndex, segmentIndex, totalDistance, lineDistance, segmentDistance, pointDistance, ...}>` | **v7.4 renamed 4 properties; old ones deprecated but still working** — read the docstring. `packages/turf-nearest-point-on-line/index.ts:20-30, 55-100` |
| concave hull | `@turf/concave` | `concave(points: FeatureCollection<Point>, options?: {maxEdge?: number; units?: Units}): Feature<Polygon\|MultiPolygon> \| null` | `maxEdge` default `Infinity`; **returns `null`** if no triangle survives. Delegates to `@turf/tin` + a local `dissolve`. `packages/turf-concave/index.ts:42-76` |
| convex hull | `@turf/convex` | `convex<P>(geojson, options?: {concavity?: number; properties?: P}): Feature<Polygon,P> \| null` | `concavity` default `Infinity` (= true convex); `1` = thin; **returns `null`** if `convexHull.length <= 3`. Wraps the `concaveman` package. `packages/turf-convex/index.ts:34-62` |

Two implementation details worth copying outright:

**`along` — a subtle edge case.** `packages/turf-along/index.ts:35-56`:
```ts
for (let i = 0; i < coords.length; i++) {
  if (distance >= travelled && i === coords.length - 1) break;
  else if (travelled >= distance) {
    const overshot = distance - travelled;
    if (!overshot) return point(coords[i]);
    const direction = bearing(coords[i], coords[i-1]) - 180;
    return destination(coords[i], overshot, direction, options);
  } else {
    travelled += measureDistance(coords[i], coords[i+1], options);
  }
}
return point(coords[coords.length - 1]);
```
It uses `bearing(a,b) - 180` as a *back-azimuth* (only accurate for short segments) and **silently returns the last vertex** if `distance` exceeds the line length. For "show me the POI at 800 m along my walking route", that truncation is a real hazard — assert on the returned index instead.

**`buffer` throws on missing args**, unlike most turf fns (`:62-68`):
```ts
if (!geojson) throw new Error("geojson is required");
if (typeof options !== "object") throw new Error("options must be an object");
if (typeof steps !== "number") throw new Error("steps must be an number");
if (radius === undefined) throw new Error("radius is required");
if (steps <= 0) throw new Error("steps must be greater than 0");
```
and the docstring warns (`:26-32`): "When using a negative radius, the resulting geometry may be invalid if it's too small compared to the radius magnitude. If the input is a FeatureCollection, **only valid members will be returned** … the output collection may have fewer members than the input, or even be empty."

Also note the `geojson-vt`-free `buffer` behaviour: for Points it goes through `d3-geo` + jsts (`:120+`), which is why we should avoid it for a simple 500 m circle.

### 6.2 What we actually need — the short list

**For a travel-time corridor:**
| Keep | Why |
|---|---|
| `@turf/distance` | straight-line fallback when the routing provider is down; also the sanity bound on any matrix result |
| `@turf/bbox` | 6-dp canonicalisation of the query bbox — **matches `_overpass.py:280` exactly**, so the same string can feed both the Overpass URL and its cache key |
| `@turf/nearest-point-on-line` | **essential** — snap harvested POIs to the route polyline so we can say "180 m off your route" and compute distance-to-route |
| `@turf/along` | the "things near the 5 km / 10 km / 15 km mark of this walk" UI |
| `@turf/point-on-line` (same family) | boolean test before showing a POI on a route |
| `@turf/bbox-polygon` | wrap the bbox for the isochrone pre-query |

**For cluster-then-route:**
| Keep | Why |
|---|---|
| `@turf/clusters` / `@turf/clusters-kmeans` / `@turf/clusters-dbscan` | pre-cluster so the matrix request stays small (N<=50 for GH/ORS). `git ls-files` confirms all three packages exist. |
| `@turf/centroid` or `@turf/center-of-mass` | the cluster anchor we route *to* |
| `@turf/convex` | the "walkable area" hull for a cluster, `concavity` ~1.5–2.0 for tight-but-not-degenerate |
| `@turf/boolean-point-in-polygon` | final filter: is the POI actually inside the isochrone? |
| `@turf/buffer` | **only if unavoidable** — `@turf/jsts` + `d3-geo` is a big bundle for a 500 m circle. For a *circle* prefer a hand-rolled 64-gon. Keep `@turf/buffer` for the negative-radius (buffer-difference) case. |

**Do NOT need:** `@turf/concave` (needs `@turf/tin` + a local `dissolve`, returns `null` often; the isochrone polygon from the routing engine already *is* a concave hull), `@turf/bbox-clip`, the `@turf/boolean-*` family beyond `point-in-polygon`.

**Bundle budget:** `@turf/distance` + `@turf/bearing` + `@turf/destination` + `@turf/bbox` + `@turf/bbox-polygon` + `@turf/along` + `@turf/nearest-point-on-line` + `@turf/point-on-line` + `@turf/centroid` + `@turf/clusters-kmeans` + `@turf/boolean-point-in-polygon` + `@turf/helpers` + `@turf/invariant` + `@turf/meta` — all tiny, no JSTS, no d3-geo.

---

## 7. Search / retrieval — Orama

`data/orama/packages/orama` = `@orama/orama` **v3.2.0** (`packages/orama/package.json:2-3`).

### 7.1 Schema configuration (numeric + enum + text mix)

Allowed schema types — `packages/orama/src/types.ts:129-133`:
```ts
export type ScalarSearchableType = 'string' | 'number' | 'boolean' | 'enum' | 'geopoint'
export type ArraySearchableType = 'string[]' | 'number[]' | 'boolean[]' | 'enum[]' | Vector
export type SearchableType = ScalarSearchableType | ArraySearchableType
```
Plus nested objects (`types.ts:107-109`) and `` `vector[${n}]` `` (`types.ts:127`, `Vector` type at `:36-39` alongside `HybridWeights {text, vector}`). `geopoint` is a `{lon, lat}` — `packages/orama/src/components/defaults.ts:48-55`.

Filter operators are **keyed by the declared schema type** — `types.ts:227-259`:
```ts
export type Operator<Value> = Value extends 'string'   ? string | string[]
  : Value extends 'string[]'   ? string | string[]
  : Value extends 'boolean'    ? boolean
  : Value extends 'boolean[]'  ? boolean
  : Value extends 'number'     ? ComparisonOperator
  : Value extends 'number[]'   ? ComparisonOperator
  : Value extends 'enum'       ? EnumComparisonOperator
  : Value extends 'enum[]'     ? EnumArrComparisonOperator
  : Value extends 'geopoint'   ? GeosearchOperation
  : never
```
with (`types.ts:189-224`):
```ts
export type ComparisonOperator  = { gt?, gte?, lt?, lte?, eq?, between?: [number, number] }
export type EnumComparisonOperator   = { eq?: string|number|boolean, in?: [...], nin?: [...] }
export type EnumArrComparisonOperator = { containsAll?: [...], containsAny?: [...] }
export type GeosearchRadiusOperator  = { radius: { coordinates: Point, value, unit?: 'cm'|'m'|'km'|'ft'|'yd'|'mi', inside?, highPrecision? } }
export type GeosearchPolygonOperator = { polygon: { coordinates: Point[], inside?, highPrecision? } }
```
**⇒ `enum` is the right choice for `cuisine`/`diet` (filterable, not tokenised), `enum[]` for multi-cuisine, `number` for capacity, `geopoint` for lat/lon with radius+polygon filters — which is exactly our isochrone pre-filter.**

Boolean composition — `types.ts:260-274`: `{ and?: [...] } | { or?: [...] } | { not?: {...} }`.

Schema validation is per-insert and **throws** on vector-size mismatch — `src/components/defaults.ts:70-76`:
```ts
if (isVectorType(type)) {
  const vectorSize = getVectorSize(type)
  if (!Array.isArray(value) || value.length !== vectorSize)
    throw createError('INVALID_INPUT_VECTOR', prop, vectorSize, value.length)
  continue
}
```
Undefined values are skipped (`:44-46`) — good, matches our `.nullable()` fields. `enum` accepts `string|number` (`:57-59`); `enum[]` must be an array of `string|number` (`:60-68`).

### 7.2 Facets

`types.ts:148-171`:
```ts
export interface StringFacetDefinition  { limit?: number; offset?: number; sort?: FacetSorting }
export interface NumberFacetDefinition  { ranges: { from: number; to: number }[] }
export interface BooleanFacetDefinition { true?: boolean; false?: boolean }
export type FacetsParams<T> = Partial<Record<LiteralUnion<T['schema']>, FacetDefinition>>
```
`src/components/facets.ts:28-60` pre-seeds numeric range buckets **in the user's declared order** (`["${range.from}-${range.to}", 0]`) so the UI order is stable — a nice touch, worth replicating. Number facets are bucketed not exact (`:72-75`); `number[]` facets dedupe inserted values per doc (`:77-80`). Default sort is `'desc'` (`:24-26`).

### 7.3 Typo tolerance

Two independent mechanisms:

1. **Bounded Levenshtein** — `src/components/levenshtein.ts:10-73`. Returns `-1` above tolerance, with three early-outs: length diff (`:25,39`), `term.startsWith(word)` (`:28-31`), and `word.startsWith(term)` → **returns 0, i.e. any prefixed word is a free match** (`:33-36`). Plus per-row `rowMin > tolerance` early termination (`:66-69`).
2. **BM25 scoring** — `src/components/algorithms.ts:116-127`:
```ts
export function BM25(tf, matchingCount, docsCount, fieldLength, averageFieldLength, { k, b, d }) {
  const idf = Math.log(1 + (docsCount - matchingCount + 0.5) / (matchingCount + 0.5))
  return (idf * (d + tf * (k + 1))) / (tf + k * (1 - b + (b * fieldLength) / averageFieldLength))
}
```
Defaults per `types.ts:340-347`: **k = 1.2, b = 0.75, d = 0.5**, all tunable via `search({ relevance: {k,b,d} })`.

Multi-field fusion is a *boost multiply plus a 1.5x recurrence for repeats* — `src/components/algorithms.ts:5-41`:
```ts
if (boost === 0) throw createError('INVALID_BOOST_VALUE')
...
const boostScore = score * boost
if (oldScore !== undefined) tokenScoresMap.set(token, [oldScore * 1.5 + boostScore, count + 1])
else                   tokenScoresMap.set(token, [boostScore, 1])
```
The `1.5` is an undocumented magic constant: a token matching in *two different properties* is 2.5x its single-field score. Exactly what you want for "matches `name` **and** `description`" — and worth knowing before you tune boosts empirically.

### 7.4 Ranking / threshold semantics

`types.ts:456-468`:
> "`threshold: 0` … The result will contain all the documents that contain **both** 'Red' and 'Headphones' … `threshold: 1` … contain **either** 'Red' or 'Headphones'."

Implemented in `algorithms.ts:43-113`:
* `threshold === 1` → return all (`:45-47`)
* `threshold === 0 && keywordsCount === 1` → return all (single term = 100% match) (`:49-53`)
* otherwise sort by **(keyword-count desc, score desc)** (`:65-76`), find the last index still holding all keywords (`:78-85`), and if none exists: `threshold === 0 ⇒ return []` (`:87-91`)
* `threshold === 0` → slice to that index (`:103-105`)
* `0 < t < 1` → `thresholdLength = last + ceil(t*100*(total-last)/100)`, slice (`:110-113`)

Also available and directly useful: `boost` per property (`types.ts:360-379`), `sortBy` `{property, order}` **or a custom comparator** (`types.ts:255-262`, `:277-279`), `distinctOn` (`:409-421`), `groupBy` with a `reduce` (`:181-188`, `:423-436`).

Entry point — `src/methods/search.ts:16-36`:
```ts
export function search(orama, params, language?) {
  const mode = params.mode ?? MODE_FULLTEXT_SEARCH
  if (mode === MODE_FULLTEXT_SEARCH) return fullTextSearch(...)
  if (mode === MODE_VECTOR_SEARCH)   return searchVector(...)
  if (mode === MODE_HYBRID_SEARCH)   return hybridSearch(...)
  throw createError('INVALID_SEARCH_MODE', mode)
}
```

### 7.5 Working config (copy-pasteable)

```ts
import { create, insertMultiple, search, save, load } from '@orama/orama'
// data/orama/packages/orama/src/methods/{create,insert,search,serialization}.ts
// data/orama/packages/orama/src/types.ts:129-133 (types), :189-224 (operators)

const schema = {
  // ---- identity / text ----
  id:            'string',
  name:          'string',
  nameHi:        'string',
  nameMr:        'string',
  altName:       'string',
  description:   'string',
  cuisine:       'enum[]',        // semiCombo -> filterable, not tokenised
  diet:          'enum[]',        // ['vegetarian','vegan','halal',...]
  keywords:      'string[]',      // LLM-enriched free text

  // ---- classification ----
  primaryKey:    'enum',          // 'amenity' | 'tourism' | 'shop' | 'leisure' | 'craft' | ...
  primaryValue:  'enum',
  craft:         'enum',          // closed 56-value list (craft.json:7-62)
  tagsRaw:       'string',        // semicolon-joined, never parsed at query time

  // ---- tri-state / numeric ----
  wheelchair:      'enum',        // 'yes'|'limited'|'no'|'designated'|'unknown'
  fee:             'boolean',     // false = proven free; ABSENT = unknown
  feeKnown:        'boolean',
  covered:         'boolean',
  airConditioning: 'boolean',
  outdoorSeating:  'boolean',
  indoorSeating:   'boolean',
  internetAccess:  'enum',
  smoking:         'enum',        // closed 6-value enum
  takeaway:        'enum',        // 'yes'|'no'|'only'
  organic:         'enum',
  capacity:        'number',
  rating:          'number',      // ours, never OSM
  reviewCount:     'number',

  // ---- opening hours ----
  hoursStatus:   'enum',          // 'ok'|'partial'|'unparsable'|'absent'
  hoursRaw:      'string',        // verbatim opening_hours; case preserved
  openNow:       'boolean',       // precomputed per-request, ephemeral
  lastChecked:   'string',        // check_date YYYY-MM-DD, sorts lexically

  // ---- geo (radius + polygon filters available on this type) ----
  loc:           'geopoint',      // { lon, lat }
  ward:          'enum',          // 'Bandra' | 'Andheri' | 'Colaba' | ...  (addr:suburb)
  city:          'enum',          // 'Mumbai' | 'Navi Mumbai'
  travelMinutes: 'number',        // from the matrix, per-session
  clusterId:     'string',        // pre-clustering for matrix batching
} as const

const db = create({ schema, language: 'english', sort: { supported: true } })
// default tokenizer: createTokenizer({ language: language ?? 'english' })  -- create.ts:118-120

await insertMultiple(db, poiDocuments, { batchSize: 1000, concurrent: false })
// insertMultiple: methods/insert.ts:269-303 (batchSize default 1000 at :294, :343)

const res = await search(db, {
  term: 'sea facing cafe with wifi',
  properties: ['name', 'description', 'cuisine', 'keywords', 'altName'],
  exact: false,
  tolerance: 1,                             // bounded Levenshtein, components/levenshtein.ts:81
  relevance: { k: 1.4, b: 0.7, d: 0.5 },    // algorithms.ts:116-127
  boost: { name: 3, nameMr: 2, keywords: 1.5, description: 1 },
  where: {
    and: [
      { cuisine: { containsAny: ['coffee_shop', 'italian'] } },   // enum[] operator
      { fee: { eq: false } },                                      // proven FREE, not just untagged
      { wheelchair: { in: ['yes', 'limited', 'designated'] } },
      { hoursStatus: { in: ['ok', 'partial'] } },
      { loc: { radius: { coordinates: { lon: 72.83, lat: 19.06 }, value: 20, unit: 'km' } } },
      { or: [ { airConditioning: { eq: true } }, { indoorSeating: { eq: true } } ] },
    ],
  },
  facets: {
    cuisine:      { limit: 20, sort: 'DESC' },
    primaryValue: { limit: 12, sort: 'DESC' },
    feeKnown:     { true: true, false: true },
    capacity:     { ranges: [{ from: 0, to: 20 }, { from: 20, to: 100 }, { from: 100, to: 1e9 }] },
    travelMinutes:{ ranges: [{ from: 0, to: 600 }, { from: 600, to: 1200 }, { from: 1200, to: 3600 }] },
  },
  distinctOn: 'name',
  groupBy: { properties: ['ward'], maxResult: 20 },
  threshold: 0.5,                      // algorithms.ts:107-113
  limit: 50, offset: 0,
})
// res.count, res.hits[{id, score, document}], res.facets{...}, res.elapsedTime
```

Persistence — `src/methods/serialization.ts:13` `load(orama, raw)`, `:22` `save(orama)`. There is **no SQLite/file backend in the clone.**

### 7.6 ⚠ The Devanagari gap — the decisive argument against Orama

`src/components/tokenizer/languages.ts:8-40` lists **31 languages**: `arabic, armenian, bulgarian, czech, danish, dutch, english, finnish, french, german, greek, hungarian, indian, indonesian, irish, italian, lithuanian, nepali, norwegian, portuguese, romanian, russian, serbian, slovenian, spanish, swedish, tamil, turkish, ukrainian, vietnamese, sanskrit`.

* `indian: 'hi'` and `nepali: 'ne'` **are Devanagari** — but they carry **Hindi and Nepali** stopword lists and stemmers, not Marathi. Marathi shares the script but has different morphology and its own stopwords.
* **Only one stemmer ships in-tree** — `english` (`src/components/tokenizer/english-stemmer.ts:56`); everything else expects `@orama/stemmers` (`languages.ts:5-7`: "these locale tags are intentionally decoupled from the file-id codes used by `@orama/stemmers` / `@orama/stopwords`").
* **Only one diacritic-folding exception** — `languages.ts:86-89`: `LANGUAGES_WITH_SIGNIFICANT_DIACRITICS = new Set(['vietnamese'])`. Everything else is ASCII-folded.
* Default is `english` (`src/methods/create.ts:118-120`). Per-language splitters, `languages.ts:42-74`; `indian: /[^A-Za-z0-9अ-ह]+/gim`, `nepali: /[^A-Za-z0-9अ-ह]+/gim`.
* `getLocale` (`languages.ts:78-82`) only feeds `String.prototype.localeCompare` — it does **not** select a stemmer or stopword list.

⇒ **A user typing `झाली` or `बांद्रा` or `ठाणे` will get poor tokenisation.** Mitigations in cost order:
(a) transliterate Devanagari → Latin on ingest *and* on query (a ~200-line function, or `Any-Transliterate`);
(b) `exact: true` on the Hindi/Marathi field so it degrades to prefix only;
(c) index `name:hi`/`name:mr` as `'string'` and search them with `properties: ['nameMr']` + `exact: true` in a **second** pass, merging on id.

### 7.7 What Orama adds over SQLite FTS5, and what it costs

**Adds**
1. **Typo tolerance** — bounded Levenshtein with prefix short-circuits (`levenshtein.ts:28-36`). FTS5 has none built in: you must ship `porter unicode61` + your own n-gram shadow table. "Bandra"/"Bandara"/"Bndra" all match in Orama.
2. **Geo filters as a first-class operator** — `geopoint` with radius and polygon filters, backed by a KD-tree (`src/trees/bkd.ts`; `K = 2` dims and `EARTH_RADIUS = 6371e3` at `:21-22`). FTS5 needs a separate `rtree` virtual table and a manual join. **Orama's polygon filter is a genuine candidate for the isochrone pre-filter.**
3. **Facets with declared ordering** and boolean/numeric range buckets (`facets.ts:45-53`).
4. **`boost` + the 1.5x cross-field recurrence** (`algorithms.ts:26-32`) — a one-line, no-op-in-FTS5 relevance lever.
5. **`threshold` as a continuum** (0 = AND, 1 = OR, in between proportional) — `algorithms.ts:107-113`.
6. **`groupBy` + `reduce` + `distinctOn`** in the same call as the text search.
7. **Zero-config, in-process** (`package.json:4`: "in less than 2kb") — no daemon, no ports, no index files on disk.

**Costs**
1. **Second datastore.** SQLite FTS5 is one file, transactional, hand-queryable with `EXPLAIN QUERY PLAN`, and synchronous via `better-sqlite3`. Orama's `save()`/`load()` is a blob (`serialization.ts:13,22`) — no incremental persistence, no partial dump, no crash safety, no `BEGIN`/`COMMIT`. Our truth stays in SQLite; Orama would be a *derived, rebuildable* index — acceptable, but you must build the rebuild path.
2. **In-process = in the request path.** No separate search service means the index competes with the API for the same event loop, and the whole index lives in the heap. Fine at 5k–50k Mumbai POIs; not at 1M, and then Orama is dead weight.
3. **Language gap (§7.6).** Real cost: a transliteration layer, forever.
4. **No persistence tuning / incremental upsert** beyond `insertMultiple(batchSize)`, `update`, `upsert`.
5. **Two ranking implementations to keep in sync.** FTS5's `bm25()` and Orama's BM25 (`algorithms.ts:116`) have different tokenisation. Every relevance bug becomes "is this FTS or Orama?"
6. **Vector/hybrid search is a trap for us.** `search-vector.ts`, `search-hybrid.ts`, `vector[${n}]`, `HybridWeights` (`types.ts:36-39`) all ship in the box and we have **zero** embeddings. Leave `mode` unset and never import those modules.

**Recommendation:** keep **SQLite FTS5 as the source of truth + the primary retrieval path** (facets are `GROUP BY` on real columns; geo is an R*Tree; we need relational joins for `opening_hours` state). Add Orama **only** as an in-process **typo-tolerant side index** over `name`/`description`, queried in parallel and merged on id, if and only if we measure that typo'd queries are a real failure mode. Bolt-on, not foundation.

---

## 8. Routing provider-adapter shape (mirror this in TypeScript)

### 8.1 The interface to copy

Three methods, three normalised return types, always keep `raw`, and — routingpy's explicit choice (`routers/__init__.py:9-12`) — **preserve each provider's special args via a passthrough, abstracting only the truly common ones** (`locations`, `profile`).

```ts
// src/routing/provider.ts
// port of: adopt/routingpy/routingpy/routers/__init__.py:1-16
//        + direction.py:63-146 + isochrone.py:57-105 + matrix.py
//        + client_base.py:91-198 + client_default.py:99-250

export type LngLat = readonly [lon: number, lat: number]

// ── normalised return types ─────────────────────────────────────────────────

export interface Route {
  /** [[lon,lat], ...] — decoded polyline or GeoJSON coords (direction.py:91-97) */
  geometry: LngLat[]
  /** SECONDS (direction.py:99-106). GH /route returns ms — divide! */
  durationS: number
  /** METRES (direction.py:108-115) */
  distanceM: number
  /** verbatim provider response — routingpy keeps `.raw` on every type */
  raw: unknown
}
export interface RouteSet { routes: Route[]; raw: unknown }   // Directions, direction.py:23-61

export interface Isochrone {
  /** [[lon,lat], ...] — outer ring for polygons (isochrone.py:67-74) */
  geometry: LngLat[]
  /** seconds if intervalType==='time', metres if 'distance' (isochrone.py:87-94) */
  interval: number
  intervalType: 'time' | 'distance'
  /** [lon, lat]; "might deviate from the input coordinate" (isochrone.py:76-85) */
  center: LngLat
  raw: unknown
}
export interface IsochroneSet { isochrones: Isochrone[]; raw: unknown }

export interface TravelMatrix {
  /** seconds, row=origin; null for unreachable (matrix.py docstring) */
  durationsS: Array<Array<number | null>>
  /** METRES, same shape. Valhalla returns km — convert! (valhalla.py:721-738) */
  distancesM: Array<Array<number | null>>
  raw: unknown
}

// ── the facade ──────────────────────────────────────────────────────────────

export type Profile = string
// routingpy keeps this a bare per-provider string:
//   GH/Valhalla: 'car'|'foot'|'bike' ; ORS: 'driving-car'|'foot-walking' ; OSRM: in the baseUrl

export interface CustomModel {
  // docs/core/custom-models.md:188-190 (operators), :157-181 (full example)
  speed?: Array<CustomModelStatement>
  priority?: Array<CustomModelStatement>
  distance_influence?: number
  turn_penalty?: Array<{ if: string; add: string }>
}
export interface CustomModelStatement {
  if?: string
  else?: string
  else_if?: string
  multiply_by?: string
  limit_to?: string
  do?: CustomModelStatement[]
}

export interface RoutingProvider {
  readonly name: string
  /** e.g. https://routing.openstreetmap.de/routed-car — ENCODES the profile (osrm.py:30, :317-320) */
  readonly baseUrl: string
  /** undefined => no key required (valhalla.py, osrm.py have no api_key param) */
  readonly requiresApiKey: boolean

  directions(
    locations: LngLat[],
    profile: Profile,
    opts?: {
      /** north-clockwise 0..360, one per point (api-doc.md:75) */
      headings?: number[]
      /** seconds of accepted delay for omitting a heading (api-doc.md:76; default 300) */
      headingPenalty?: number
      /** avoid u-turns at via points (api-doc.md:77) */
      passThrough?: boolean
      /** 'left'|'right'|'any'|'auto'; 'auto' avoids crossing PRIMARY/SECONDARY in
       *  right-hand traffic (Parameters.java:141-149) */
      curbsides?: Array<'left' | 'right' | 'any' | 'auto'>
      curbsideStrictness?: 'strict' | 'soft'
      /** GH: required for any flexible param (api-doc.md:65-73) */
      chDisable?: boolean
      /** GH: the Mumbai congestion multiplier (custom-models.md:157-181).
       *  POST /route ONLY (custom-models.md:169-170) */
      customModel?: CustomModel
      /** OSRM: bearings=[[deg, deviation], ...] */
      bearings?: Array<[number, number?]>
      radiuses?: number[]
      annotations?: Array<'duration' | 'distance'>
      steps?: boolean
      /** Valhalla: heading_tolerance is GH's heading_penalty (valhalla.py:88-113) */
      options?: Record<string, unknown>
      /** provider-specific passthrough — routingpy's documented dogma */
      [k: string]: unknown
    },
  ): Promise<Route | RouteSet>

  isochrones(
    center: LngLat,
    profile: Profile,
    intervals: number[],
    opts?: {
      intervalType?: 'time' | 'distance'
      /** GH: nested isochrones, `time_limit - n*time_limit/buckets` (api-doc.md:264) */
      buckets?: number
      /** GH: false=point→polygon, true=polygon→point (api-doc.md:265).
       *  ORS spells this locationType 'start'|'destination' */
      reverseFlow?: boolean
      /** Valhalla: 1 = only the largest contour; 0.5 = drop contours smaller than
       *  half the largest for that time value (valhalla.py:353-357) */
      denoise?: number
      /** Valhalla: Douglas-Peucker tolerance in metres (valhalla.py:359) */
      generalize?: number
      /** ORS: 0..1, closer to 1 = more generalised (openrouteservice.py:395-397) */
      smoothing?: number
      attributes?: Array<'area' | 'reachfactor' | 'total_pop'>
      avoidLocations?: LngLat[]
      avoidPolygons?: GeoJSON.Polygon[]
      [k: string]: unknown
    },
  ): Promise<IsochroneSet>

  matrix(
    locations: LngLat[],
    profile: Profile,
    opts?: {
      /** 0-based indices into `locations` (graphhopper.py:549-554) */
      sources?: number[]
      destinations?: number[]
      outArray?: Array<'times' | 'distances' | 'weights'>
      resolveLocations?: boolean
      [k: string]: unknown
    },
  ): Promise<TravelMatrix>
}

// ── the client seam (client_base.py:91-198, client_default.py:99-250) ───────

export type RouterErrorKind =
  | 'timeout'        // exceptions.Timeout        (client_default.py:145-146)
  | 'overQueryLimit' // exceptions.OverQueryLimit  (:236-237)
  | 'apiError'       // exceptions.RouterApiError  (:238-239)  4xx
  | 'serverError'    // exceptions.RouterServerError (:240-241) 5xx
  | 'jsonParse'      // exceptions.JSONParseError (:231-234)
  | 'transport'      // exceptions.TransportError  (client_base.py:192-193)

export class RouterError extends Error {
  constructor(
    readonly kind: RouterErrorKind,
    readonly status: number | undefined,
    readonly body: string,
    message?: string,
  ) { super(message ?? body) }
}

export interface RoutingClient {
  request<T>(opts: {
    url: string
    method?: 'GET' | 'POST'
    /** for GET */
    getParams?: Record<string, string | number | boolean | Array<string | number>>
    /** for POST; sent as JSON when Content-Type is application/json
     *  (client_default.py:163-169) */
    postParams?: unknown
    /** wall-clock budget across ALL retries (client_default.py:144-146) */
    retryTimeoutMs?: number
    dryRun?: boolean
  }): Promise<T>
  /** identical to request() but returns the body instead of throwing on 4xx
   *  (client_default.py:194-200). Mandatory for batch matrix calls. */
  requestAllowingApiError?<T>(opts: Parameters<RoutingClient['request']>[0]): Promise<T | null>
}
```

### 8.2 The two rules that make the facade work

1. **Unit normalisation at the adapter boundary, always.** Convert to seconds/metres/lon-lat *in the provider file*, never in the caller. The traps: GraphHopper `/route` returns **ms** but `/matrix` returns **seconds** (`api-doc.md:109` vs `graphhopper.py:627`); Valhalla returns **km** (`valhalla.py:730-734`); GraphHopper `/isochrone` takes `lat,lon` but `/route` POST takes `[lon,lat]` (`api-doc.md:26`, `:266`).
2. **Provider-specific vocabulary is preserved, not flattened.** Valhalla's `heading_tolerance` ≡ GraphHopper's `heading_penalty`; Valhalla's `denoise` ≡ ORS's `smoothing` in spirit; GH's `buckets` has no ORS equivalent. Model them as named options with a shared *meaning*, and let the adapter translate. That is precisely routingpy's stated approach and it is the reason their 8 providers share one signature.

---

## 9. MapLibre UX + perf config

`adopt/maplibre-gl-js` is sparse to `src/`. Layer-type definitions live in `@maplibre/maplibre-gl-style-spec` (imported at `src/source/geojson_source.ts:20`), so the authoritative layer spec is external; what *is* in the clone is the GeoJSON source implementation, the diff/worker plumbing, and the feature-state machinery — which is where all the interesting perf levers are.

### 9.1 (a) 5k–50k points: `circle` layer + GeoJSON source, not `symbol`

**What the source actually does with your options** — `src/source/geojson_source.ts:216-239`:
```ts
this.workerOptions = extend({
  source: this.id,
  geojsonVtOptions: {
    buffer: this._pixelsToTileUnits(options.buffer !== undefined ? options.buffer : 128),
    tolerance: this._pixelsToTileUnits(options.tolerance !== undefined ? options.tolerance : 0.375),
    extent: EXTENT,
    maxZoom: this.maxzoom,
    lineMetrics: options.lineMetrics || false,
    generateId: options.generateId || false,
    promoteId: this._promoteIdKey,
    cluster: options.cluster || false,
    clusterOptions: {
      maxZoom: this._getClusterMaxZoom(options.clusterMaxZoom),
      minPoints: Math.max(2, options.clusterMinPoints || 2),
      extent: EXTENT,
      radius: this._pixelsToTileUnits(options.clusterRadius || 50),
      log: false,
      generateId: options.generateId || false
    },
  },
  clusterProperties: options.clusterProperties,
  filter: options.filter
}, options.workerOptions);
```
Key facts:
* Data is **tiled in a worker** via `@maplibre/geojson-vt` + `@maplibre/vt-pbf` (`src/source/geojson_worker_source.ts:3-5`), then wrapped as a `GeoJSONWrapper` and encoded to a real vector tile (`:92-96`). So a 50k-point FeatureCollection is *tiled*, not a single buffer — 50k is genuinely fine.
* `_pixelsToTileUnits` (`:250-252`) converts px → tile units by `pixelValue * (EXTENT / this.tileSize)` with `tileSize = 512` (`:188`). **`buffer` defaults to 128 px and `tolerance` to 0.375 px** (`:219-220`) — for a pure-point dataset `tolerance` is irrelevant, and `buffer: 128` is generous (it makes each tile's features render outside the tile edge). For POIs, `buffer: 32` cuts work with no visual loss.
* `maxzoom` defaults to `18` (`:189`) and `minzoom` to `0` (`:187`).
* Data can be a literal `FeatureCollection` **or a URL** (`:202`: `this._data = typeof options.data === 'string' ? {url: options.data} : {geojson: options.data}`). **Pass a URL** — the parsing then happens off the main thread and the main thread never holds the 50k features.

**Config for 5k–50k points:**
```json
{
  "sources": {
    "pois": {
      "type": "geojson",
      "data": "/api/v1/tiles/pois.mvt.json",   // a URL, not a literal
      "promoteId": "osmId",                     // "id": 240109189
      "maxzoom": 15,                            // we only cluster to ~z15
      "buffer": 32,
      "tolerance": 0.375,
      "filter": ["all", ["!=", ["get", "hidden"], true]]   // source-side filter
    }
  },
  "layers": [
    { "id": "pois-halo", "type": "circle", "source": "pois",
      "filter": ["!", ["has", "point_count"]],
      "paint": {
        "circle-radius": ["interpolate", ["linear"], ["zoom"],
                          11, 5, 15, 8, 17, 12],
        "circle-color": "rgba(0,0,0,0.18)",
        "circle-blur": 0.4
      } },
    { "id": "pois-dot", "type": "circle", "source": "pois",
      "filter": ["!", ["has", "point_count"]],
      "paint": {
        "circle-radius": ["interpolate", ["linear"], ["zoom"],
                          11, 3, 15, 5, 17, 8],
        "circle-color": ["case",
                          ["==", ["feature-state", "selected"], true], "#F5A524",
                          ["==", ["feature-state", "hover"], true], "#F5A524",
                          "#1B7F5A"],
        "circle-stroke-width": ["case",
                          ["==", ["feature-state", "selected"], true], 2.5, 1],
        "circle-stroke-color": "#fff"
      } }
  ]
}
```
**`circle` vs `symbol` vs `icon` — the decision rule for ATHITI:**
* **`circle`** — one WebGL instanced quad per point, no glyph atlas, no collision detection, no placement pass. At 50k points this is the only layer type that is free. Cost scales with *visible* points (tiles outside the viewport are not drawn), not total. **Use `circle` for all POI markers at every zoom ≥ 11.**
* **`heatmap`** — same instanced-quad machinery, adds a `heatmap-density` + colour LUT, and aggregates to a screen-space texture. Cheap, but it *destroys* click/hover identity (features are not individually queryable). Use only for a low-zoom "heat" view, layered *under* the circles, and switch it off above z13. Note the repo ships the example link at `src/source/geojson_source.ts:143` ("Create a heatmap from points").
* **`symbol` (text only)** — runs the **placement pass** every frame the view changes. `src/style/style.ts:1426` and `:1275` and `:1914`, `:1973` all guard on `layer.type === 'symbol'` before `triggerSymbolPlacement()`. Placement is the single biggest symbol-specific cost. **Text labels for 5k–50k POIs is a bad trade.**
* **`symbol` (icon-image)** — same placement pass, plus SDF/8-bit alpha atlas and sprite upload cost. Also a bad trade at this scale.
* ⇒ **The recommended pattern: `circle` at all zooms, plus ONE `symbol` layer that is added/removed (`visibility`) only for the ~10–20 features currently in the result list.** That is a real MapLibre idiom: a single "labels" layer bound to a tiny source containing just the current hits. 20 symbol placements is free.

Evidence for the placement-pass cost: `src/style/style.ts:1414-1430` in `setPaintProperty`:
```ts
this._changed = true;
this._updatedPaintProps[layer.id] = true;
if (layer.type === 'symbol') this.triggerSymbolPlacement();
```
Every `setPaintProperty` on a symbol layer re-triggers placement. Another reason to keep the "labels" layer tiny and stable.

**Documented perf caveats we must design around** — `src/ui/map.ts:2519-2524` (inside `queryRenderedFeatures` docs):
> "Only features that are currently rendered are included. Some features will **not** be included, like:
> - Features from layers whose `visibility` property is `"none"`.
> - Features from layers whose zoom range excludes the current zoom level.
> - **Symbol features that have been hidden due to text or icon collision.**"
> (`:2525-2528`) "Features from all other layers are included, including features that may have no visible contribution…"

and `:2536-2545`:
> "Because features come from tiled vector data or GeoJSON data that is converted to tiles internally, feature geometries **may be split or duplicated across tile boundaries** and, as a result, features may appear multiple times in query results. … a point feature near a tile boundary may appear in multiple tiles due to tile buffering."

⇒ **Two hard rules for our click handling:**
1. **Hit-testing must be against a `circle` layer**, never a `symbol` layer — collision-hidden symbols are not returned by `queryRenderedFeatures`, so a label you can see may be unclickable. Circles are always returned.
2. **De-duplicate by `feature.id` in every click handler** — the tile-buffering duplication is guaranteed at tile boundaries, which is exactly where a user is most likely to click.

### 9.2 (b) Clustering

`src/source/geojson_source.ts:30-40` (the option surface) and `:54-88` (the resolved view returned by `getClusterOptions`):
```ts
export type GeoJSONSourceOptions = GeoJSONSourceSpecification & {
    cluster?: boolean;
    clusterMaxZoom?: number;
    clusterRadius?: number;
    clusterMinPoints?: number;
    generateId?: boolean;
};
```
Defaults and gotchas:
* `clusterRadius` default **50 px** (`:231`), converted to tile units.
* `clusterMinPoints` default `2`, and is **floored at 2** (`:229`: `Math.max(2, options.clusterMinPoints || 2)`). You cannot get single-point clusters.
* `clusterMaxZoom` defaults to `maxzoom - 1` (`:258-259`) and is **rounded to an integer** (`:260-261`, `warnOnce("Integer expected for option 'clusterMaxZoom'…")`) because of supercluster's integer requirement.
* ⚠ **Validation warning you should heed** — `:208-210`:
```ts
if (options.clusterMaxZoom !== undefined && this.maxzoom <= options.clusterMaxZoom) {
    warnOnce(`The maxzoom value "${this.maxzoom}" is expected to be greater than the clusterMaxZoom value "${options.clusterMaxZoom}".`);
}
```
⇒ set `maxzoom` strictly greater than `clusterMaxZoom`.
* `clusterProperties` (`:236`) is the aggregate-expression hook: `src/source/geojson_worker_source.ts:327-362` shows it compiled into a supercluster `map`/`reduce` pair:
```ts
geojsonVtOptions.clusterOptions.map = (pointProperties) => { ... }        // :347
geojsonVtOptions.clusterOptions.reduce = (accumulated, clusterProperties) => {  // :355
    feature.properties = clusterProperties;
}
```
So `clusterProperties: { openNowCount: ['+', ['case', ['==', ['get','openNow'], true], 1, 0]] }` is how you get a "12 of 40 open now" label on a cluster. **This is the single best MapLibre feature for ATHITI** — it turns a dead grey blob into a live availability summary.
* Live re-clustering without re-sending data: `setClusterOptions` (`:333-352`) and `getClusterOptions` (`:354-369`), plus the worker's `updateCluster` message (`src/source/geojson_worker_source.ts:51-53`, applied at `:263`).

```json
{
  "sources": {
    "pois": {
      "type": "geojson", "data": "/api/v1/tiles/pois.mvt.json",
      "promoteId": "osmId", "maxzoom": 16, "buffer": 32,
      "cluster": true, "clusterMaxZoom": 12, "clusterRadius": 60, "clusterMinPoints": 3,
      "clusterProperties": {
        "openCount":   ["+", ["case", ["==", ["get", "openNow"], true], 1, 0]],
        "freeCount":   ["+", ["case", ["==", ["get", "feeKnown"], true],
                                   ["==", ["get", "fee"], false], 1, 0]],
        "wheelchairOK":["max", ["case", ["==", ["get","wheelchair"], "yes"], 1, 0]]
      }
    }
  },
  "layers": [
    { "id": "clusters", "type": "circle", "source": "pois",
      "filter": ["has", "point_count"],
      "paint": {
        "circle-color": ["step", ["get", "point_count"],
                         "#B7E4C7", 25, "#7FC8A9", 100, "#40916C", 500, "#1B4332"],
        "circle-radius": ["step", ["get", "point_count"], 14, 25, 19, 100, 25, 500, 32],
        "circle-stroke-width": 2, "circle-stroke-color": "#fff" } },
    { "id": "cluster-count", "type": "symbol", "source": "pois",
      "filter": ["has", "point_count"],
      "layout": { "text-field": ["get","point_count_abbreviated"],
                  "text-font": ["DIN Offc Pro Medium","Arial Unicode MS Bold"],
                  "text-size": 12 },
      "paint": { "text-color": "#081C15" } },
    { "id": "cluster-open", "type": "symbol", "source": "pois",
      "filter": ["all", ["has","point_count"], [">", ["get","openCount"], 0]],
      "layout": { "text-field": ["concat", ["get","openCount"], " open"],
                  "text-size": 10, "text-offset": [0, 1.4] },
      "paint": { "text-color": "#1B4332" } }
  ]
}
```
**Note the layer ordering constraint that falls out of §9.1:** the two `symbol` cluster layers are *fine* (few clusters), but they must be the **only** symbol layers over this source, and per-cluster label count is bounded by the number of clusters (hundreds, not 50 000).

### 9.3 (c) Route line

Two sources, one for geometry, one for the casing/halo. Route geometry is 1 LineString, so this is trivially cheap — the only real decisions are paint order and simplification.

```json
{
  "sources": {
    "route": { "type": "geojson", "data": "/api/v1/route/123" }
  },
  "layers": [
    { "id": "route-casing", "type": "line", "source": "route",
      "layout": { "line-cap": "round", "line-join": "round" },
      "paint": { "line-color": "#FFFFFF", "line-width": ["interpolate",["linear"],["zoom"],10,5,16,9], "line-opacity": 0.9 } },
    { "id": "route-line", "type": "line", "source": "route",
      "layout": { "line-cap": "round", "line-join": "round" },
      "paint": {
        "line-color": ["match", ["get", "legMode"], "walk", "#7C6F64", "transit", "#3D5A80", "#1B4332"],
        "line-width": ["interpolate",["linear"],["zoom"],10,3,16,6]
      } }
  ]
}
```
`lineMetrics: false` is the default (`geojson_source.ts:223`) and is only needed for `line-gradient` / `symbol` placement along a line — leave it off. Ask the routing provider for `points_encoded=false` (GraphHopper `api-doc.md:43`) or decode the polyline server-side; `elevation=true` requires `points_encoded=false` (`api-doc.md:42`).

### 9.4 (d) Click-to-expand on clusters (real code)

`src/source/geojson_source.ts:370-424`:
```ts
async getClusterExpansionZoom(clusterId: number): Promise<number> {
    return (await this.actorPromise).sendAsync({type: MessageType.getClusterExpansionZoom,
        data: {type: this.type, clusterId, source: this.id}});
}
...
/**
 * ... (docs at :400-416 show getClusterLeaves)
 */
async getClusterLeaves(clusterId: number, limit: number, offset: number): Promise<GeoJSON.Feature[]> {
    return (await this.actorPromise).sendAsync({type: MessageType.getClusterLeaves, data: {
```
and `getClusterChildren` (`:388-390`). Worker side: `src/source/geojson_worker_source.ts:302-314`.

⚠ **`getClusterExpansionZoom` returns the zoom *level* to zoom to — it does not set the map's centre.** You must call `map.easeTo({ center, zoom })` yourself. And **`getClusterLeaves` needs a `limit` + `offset`** (supercluster pages), so a "show everything in this cluster" sheet must paginate.

```ts
// click-to-expand
map.on('click', 'clusters', async (e) => {
  const f = e.features?.[0]
  if (!f) return
  const src = map.getSource('pois') as maplibregl.GeoJSONSource
  const clusterId = Number(f.properties!.cluster_id)
  const zoom = await src.getClusterExpansionZoom(clusterId)
  const [lng, lat] = (f.geometry as GeoJSON.Point).coordinates as [number, number]
  map.easeTo({ center: [lng, lat], zoom, duration: 400 })
})

// "show me the leaves" sheet (paged)
map.on('click', 'clusters', async (e) => {
  const f = e.features?.[0]; if (!f) return
  const src = map.getSource('pois') as maplibregl.GeoJSONSource
  const id = Number(f.properties!.cluster_id)
  const leaves = await src.getClusterLeaves(id, 50, 0)   // hard limit + offset
  openSheet(leaves)
})
```
⇒ **De-duplicate `e.features` by `id` before using it** (the tile-buffering caveat, §9.1). A click on a cluster straddling a tile boundary yields two features.

### 9.5 (e) Hover / selected state WITHOUT re-rendering the style

This is the important one. `src/ui/map.ts:3913-3933` — the *canonical* documented pattern, quoted verbatim from the source:
```ts
map.on('mousemove', 'my-layer', (e) => {
  if (e.features.length > 0) {
    map.setFeatureState({
      source: 'my-source',
      sourceLayer: 'my-source-layer',
      id: e.features[0].id,
    }, {
      hover: true
    });
  }
});
```
and the removal counterpart, `src/ui/map.ts:3963-3977`:
```ts
map.on('mouseleave', 'my-layer', (e) => {
  map.removeFeatureState({
    source: 'my-source', sourceLayer: 'my-source-layer', id: e.features[0].id
  }, 'hover');   // 'hover' only, not the whole state object
});
```
Prerequisites, `src/ui/map.ts:3900-3905`:
> "- For vector or GeoJSON sources, including an `id` attribute in the original data file.
>  - For vector or GeoJSON sources, using the `promoteId` option to specify which property should be used as the ID.
>  - For GeoJSON sources, using the `generateId` option to auto-assign an `id` based on the feature's index in the source data. **If you change feature data using `map.getSource('some id').setData(..)`, you may need to re-apply state taking into account updated `id` values.**"

**⇒ Use `promoteId: "osmId"`. Do NOT use `generateId`** — feature-state keyed on a generation index is destroyed by the next `setData`, and that is exactly the "hover flickers after a search" bug.

The validation rules in `src/style/style.ts:1435-1465`:
```ts
setFeatureState(target: FeatureIdentifier, state: any): void {
  ...
  const sourceType = tileManager.getSource().type;
  if (sourceType === 'geojson' && sourceLayer) {
    this.fire(new ErrorEvent(new Error('GeoJSON sources cannot have a sourceLayer parameter.')));
    return;
  }
  if (sourceType === 'vector' && !sourceLayer) {
    this.fire(new ErrorEvent(new Error('The sourceLayer parameter must be provided for vector source types.')));
    return;
  }
  if (target.id === undefined) {
    this.fire(new ErrorEvent(new Error('The feature id parameter must be provided.')));
    return;
  }
  const forbiddenStateKeys = ['__proto__', 'constructor', 'prototype'];
  if (state && Object.keys(state).some((stateKey: string) => forbiddenStateKeys.includes(stateKey))){
    this.fire(new ErrorEvent(new Error(`The feature state should not include one of the following keys: ${forbiddenStateKeys}`)));
    return;
  }
  tileManager.setFeatureState(sourceLayer, target.id, state);
}
```
⇒ **For a GeoJSON source, pass NO `sourceLayer`, and ALWAYS pass `id`.** `setFeatureState` **throws an `ErrorEvent` (not an exception)** on violation — it does not reject, so a missing `id` fails silently unless you listen for `error`. Add a `map.on('error', ...)` logger in dev.

**And the thing that makes this cheap:** `src/ui/map.ts:3930-3933`:
```ts
setFeatureState(feature: FeatureIdentifier, state: any): this {
    this.style.setFeatureState(feature, state);
    return this._update();
}
```
It goes straight to the tile manager and calls `_update()` — **no `setPaintProperty`, no layer re-add, no style re-serialisation.** Compare `setPaintProperty` (`src/style/style.ts:1400-1412`), which does `deepEqual` check → `_updatePaintProperty` → possibly `_updateLayer(layer)` → `this._serializedLayers = null` (`:1429`). **Never re-style a layer for hover/selection. Use feature-state + the `["feature-state", "hover"]` expression.** The repo documents the whole thing at `src/ui/map.ts:3928` ("[Create a hover effect]") and `:2303`, and the cursor pattern at `:2122-2158` (`_setCursor`-style handlers on `mousemove`/`mouseout`).

**Performance rule for ATHITI:** track the currently-hovered id in a variable and `removeFeatureState` the previous one *before* `setFeatureState` the new one. Without that you accumulate state on every point the cursor crosses, and every affected feature keeps a dirty bucket. Also throttle `mousemove` to one `requestAnimationFrame` — `queryRenderedFeatures` is a CPU hit-test over the rendered tiles.

### 9.6 (f) Incremental data updates — `updateData`, not `setData`

`src/source/geojson_source.ts:286-302`:
```ts
/**
 * Updates the source's GeoJSON, and re-renders the map.
 *
 * For sources with lots of features, this method can be used to make updates more quickly.
 *
 * This approach requires unique IDs for every feature in the source. The IDs can either be specified on
 * the feature, or by using the promoteId option to specify which property should be used as the ID.
 *
 * It is an error to call updateData on a source that did not have unique IDs for each of its features already.
 *
 * Updates are applied on a best-effort basis, updating an ID that does not exist will not result in an error.
 */
updateData(diff: GeoJSONSourceDiff): Promise<void> {
    this._pendingWorkerUpdate.diff = mergeSourceDiffs(this._pendingWorkerUpdate.diff, diff, this._promoteIdKey);
    return this._updateWorkerData();
}
```
vs `setData` (`:280-284`) which replaces the whole thing. And the crucial performance detail — `_applyDiffToSource` (`:552-579`):
```ts
const affectedGeometries = applySourceDiff(this._data.updateable, diff, promoteId);

if (diff.removeAll || this._options.cluster) {
    return undefined;      // <-- clustering disables partial tile reload
}

return affectedGeometries;
```
followed by `_getShouldReloadTileOptions` (`:584-593`), which maps only the *affected* geometries' bounds to `affectedBounds` so only overlapping tiles are re-parsed.

⇒ **Two consequences:**
1. **Use `updateData` for incremental changes** (a POI's `openNow` flipping, a new result entering the list) — only the touched tiles reload.
2. ⚠ **`cluster: true` defeats partial reload entirely** (`if (diff.removeAll || this._options.cluster) return undefined`). So the clustered layer and the un-clustered layer must be **two separate sources** if you want incremental updates on the dots. Pattern: `pois-clusters` (clustered, refresh wholesale) + `pois-selected` (un-clustered, `updateData` for the ~20 live hits).

Diff semantics, `src/source/geojson_source_diff.ts:56-152`: `GeoJSONSourceDiff` with `removeAll`, per-id `add`/`update`/`remove`; operations processed in a fixed order for predictability (`:115`); IDs from `feature.id` or `promoteId` (`:66-73`).

### 9.7 Performance guidance actually documented in the clone

There is no `docs/` or `PERFORMANCE.md` in this sparse clone (the only `.md` is `src/shaders/README.md`). The guidance we can cite is all in code comments and JSDoc:
* `geojson_source.ts:286-295` — `updateData` is "for sources with lots of features… makes updates more quickly".
* `geojson_source.ts:207-210` — `maxzoom` must exceed `clusterMaxZoom`.
* `geojson_source.ts:258-262` — `clusterMaxZoom` must be an integer.
* `geojson_source.ts:227-234` + `geojson_worker_source.ts:327-362` — `clusterProperties` is an expression into supercluster's `map`/`reduce`.
* `style.ts:1426`, `:1275`, `:1914`, `:1973` — symbol placement is the thing that re-triggers on every paint change and every style change.
* `ui/map.ts:2519-2545` — `queryRenderedFeatures` sees only rendered features and can return duplicates across tiles.
* `ui/map.ts:3930-3933` vs `style.ts:1400-1412` — feature-state is the cheap path; `setPaintProperty` is the expensive path.
* `geojson_source.ts:376` — `GeoJSONWorkerSource` "designed to be easily reused to support custom source types" (the `createGeoJSONIndexFunc` seam at `:76-79`) if we ever want a server-side-flattened or pre-tiled source.

**The five numbers for ATHITI:** 50 000 points / `circle` / `buffer: 32` / `clusterRadius: 60` / one small `symbol` layer for ≤20 labels. That configuration needs no custom layer, no worker code, and no style re-serialisation on interaction.

---

## 10. Geocoding fallback

**One paragraph, as requested.** Both geocoders resolve free text to coordinates by the same two-step shape: an Elasticsearch/OpenSearch **multi-field match query with a location-bias decay function**, returning **GeocodeJSON**. Photon (`data/photon`, `src/main/java/de/komoot/photon/`) is the cheaper of the two for ATHITI: its whole design is search-as-you-type with typo tolerance and location bias — `src/main/java/de/komoot/photon/opensearch/SearchQueryBuilder.java:20-37` branches on query length (`if (!suggestAddresses && (stripped.length() < 4 || stripped.matches("^\\p{IsAlphabetic}+$")))` → `setupShortQuery` vs `setupFullQuery`), short queries use a `bool.should` over `name.prefix` + `field.name.full` with `fuzziness(qlen < 4 ? "0" : "AUTO")` and `prefixLength(1..2)` (`:39-84`), and full queries require an n-gram match with `minimumShouldMatch("2<-1 6<-2")` plus `fuzziness("AUTO")` (`:86-160`); non-`other` object types get a `demotePoi` weight of `0.4` (`:85-91`). HTTP surface: `/api?q=…&lon=&lat=&zoom=12&location_bias_scale=0.4&bbox=minLon,minLat,maxLon,maxLat&countrycode=IN&limit=&lang=` plus `osm_tag=key:value` / `layer=` / `include=`/`exclude=` category filters and `dedupe=0` to disable duplicate collapsing (`docs/api-v1.md:1-269`), and `/reverse?lon=&lat=&radius=km` for the reverse direction. Because it is backed by Nominatim, **Photon understands Mumbai localities, ghat names and Marathi aliases for free** — which is exactly why it is our fallback and not a bare Nominatim call. Running our own is cheap in Mumbai terms: the **India extract** is a fraction of the 95 GB planet database (`README.md:50-52`), needs Java 21+, ships as a downloadable dump from GraphHopper, and starts as `java -jar photon-*.jar serve` on port 2322. Pelias is the heavier, more accurate alternative — the `pelias/api` service over Elasticsearch with a 10-service pipeline (OSM, OA, WOF, GeoNames, polylines, CSV importers + `placeholder`, `PIP`, `libpostal`, `interpolation`) per `data/pelias/README.md:60-100`, best deployed with the official `pelias/docker` compose which defaults to a small area (Portland) and can be re-pointed to Mumbai (`README.md:202`). **We do not need either today:** use Nominatim for the primary geocode, and run a self-hosted **Photon (India extract, ~2 GB, one container)** as the typo-tolerant, location-biased fallback that also gives us a reverse geocoder for free. Do not run Pelias — a 10-service Elasticsearch pipeline is not justified while OSM already names the places.

---

## MUST-IMPLEMENT CHECKLIST (ordered by dependency)

### Phase 0 — unblock everything else (1 day)
0.1. Get a **full `id-tagging-schema` clone with `data/presets/`** (only `data/fields/` is in our sparse copy). Read `data/presets/amenity/restaurant.json`, `cafe.json`, `bar.json`, `marketplace.json`, `place_of_worship.json`, `theatre.json`, `tourism/museum.json`, `tourism/attraction.json`, `shop/craft.json`, `craft/*.json`, `leisure/park.json`. Extract each preset's `addTags` + `fields` + `moreFields` (`SCHEMA.md:120-190`) into a machine-readable `category_field_checklist.json`. **Blocks 1.x.**
0.2. Decide which `opening_hours` implementation we actually wrap — `spatie/opening-hours` is **not** an OSM grammar parser (`README.md:702-708` defers to `ujamii/osm-opening-hours`). The npm `opening_hours` package is a different codebase. Pin one. **Blocks 3.x.**
0.3. Decide routing topology: **Valhalla (free, isochrone) + self-hosted GraphHopper (free, matrix + custom_model)**. Both are keyless with a custom `base_url` (`valhalla.py:36-47`; `graphhopper.py:86-88`). **Blocks 4.x.**

### Phase 1 — the tag contract (2 days, no external deps)
1.1. Land `src/domain/tags.ts` exactly as drafted in §1.2. Every `check` field is `boolean | null` (`SCHEMA.md:418`); `takeaway`/`organic`/`wheelchair`/`smoking`/`internetAccess` are closed enums; `cuisine` is `string[]`.
1.2. Add a unit test that walks the **actual JSON** in `data/fields/` and asserts our enum membership — so the schema clone and our code can never drift.
1.3. Add a `CuisineExt = 'mughlai' | 'maharashtrian' | ...` *extension* map. `cuisine.json:7-109` is a suggestion list, not a closed set; **rejecting unknown cuisines would silently drop the most Mumbai-specific data we have.**
1.4. Add `hoursStatus: 'ok'|'partial'|'unparsable'|'absent'` and `coverageKnown: boolean`. **Never** adopt `covered_no` semantics (`covered_no.json:7` — "Assumed to be No").
1.5. Add `access: enum|null` from `access.json:19-45` + `accessKnown`. **A privatised ghat is not an experience we can sell.**

### Phase 2 — the harvest (3 days)
2.1. Port `_create_overpass_features_query` (`_overpass.py:286-354`) and the `poly:` ring builder (`:250-283`) **including the 6-dp rounding** — the rounding is load-bearing for cache-key stability.
2.2. Port `_get_overpass_pause` (`_overpass.py:145-233`) verbatim: 3 token shapes, 5 s re-poll, 60 s fallback. Do **not** run parallel harvesters (`getting-started.rst:141`).
2.3. Port the SHA-1-of-canonical-URL cache (`_http.py:88`) and the **"never cache a `remark`"** rule (`:56-58`). Use `[timeout:60]`, not OSMnx's 180 (`settings.py:165`).
2.4. Add a `cache_only_mode` job (`settings.py:17-24`) that seeds all Mumbai + Navi Mumbai bboxes sequentially. Development then runs entirely off the cache.
2.5. Ship the §3.5 QL. `out center` only — never OSMnx's `>;` down-recursion for POIs. `["name"]` existence filter. Drop `opening_hours` from filters (16% coverage ⇒ would return nothing).
2.6. Split bboxes > 2.5 km² (`settings.py:157`). Use `poly:` for the coastline.
2.7. Project raw Overpass JSON through `src/domain/tags.ts` with `safeParse`. Every field is nullable. **Count the parse-failure rate per field and log it** — that is our data-quality dashboard.

### Phase 3 — opening hours (4 days, the riskiest phase)
3.1. Build the tokenizer: `Mo-Fr`, `Mo-Su 09:00-13:00,15:00-20:00`, overnight `20:00-02:00`, `24/7`, `off`, `sunrise`/`sunset` (defer — resolve via an ephemeris or mark unsupported), comments, `PH off` (map to a Mumbai public-holiday table, or emit `unparsable`).
3.2. Normalise into the shape `OpeningHours::create()` wants, always with `overflow: true` (`README.md:99-107`; `:136-137` for the schema.org path).
3.3. **Always run `mergeOverlappingRanges` first** (`OpeningHours.php:151-196`). Otherwise `Mo-Fr 09:00-13:00,12:00-14:00` throws `OverlappingTimeRanges` at construction (`:260-267`).
3.4. **Always** construct with `timezone: 'Asia/Kolkata'` and pass `outputTimezone` (`:736-744`, `:896-912`). `Day::onDateTime` uses the *local* day name (`Day.php:19-22`).
3.5. Catch, in one wrapper: `InvalidTimeString`, `InvalidTimeRangeString`, `InvalidTimeRangeArray`, `InvalidTimeRangeList`, `InvalidDayName`, `InvalidDateRange`, `InvalidDate`, `InvalidDateTimeClass`, `InvalidTimezone`, `OverlappingTimeRanges`, `MaximumLimitExceeded`, `SearchLimitReached`, `NonMutableOffsets`, `InvalidOpeningHoursSpecification`, **`ValueError`**, and `JsonException`. Any of them ⇒ `status:'unparsable'`, `open:null`. **Never drop the POI.**
3.6. When calling `nextOpen`/`nextClose`, **always pass `$searchUntil` or `$cap`** (`:496-502`) — otherwise an always-closed POI throws `MaximumLimitExceeded` after `DEFAULT_DAY_LIMIT = 8` days (`:26`).
3.7. Surface `checkDate` (from `check_date`) as a staleness badge. Absent `check_date` + present `opening_hours` ⇒ "hours unverified since unknown".
3.8. Reject `opening_hours:covid` and every `opening_hours:*` sub-key except `drive_through` on ingest (`opening_hours.json`, `opening_hours/drive_through.json` are the only two in the schema).

### Phase 4 — travel time (3 days)
4.1. Land `src/routing/provider.ts` (§8.1) with `Route` / `Isochrone` / `TravelMatrix`, all with `raw`.
4.2. Implement `ValhallaProvider` (`valhalla1.openstreetmap.de`, no key) and `OsrmProvider` (`routing.openstreetmap.de/routed-car`, no key) first — these are what we can call today.
4.3. Implement `GraphhopperProvider` against **our own** server. `ch.disable=true` on any request that uses `heading`/`custom_model`/`alternative_route` (`api-doc.md:65-73`; `Parameters.java:161`). **Never write `routing.ch.disabling_allowed` in `config.yml` — it is a hard startup error in GH ≥ 3.0** (`GraphHopper.java:462-466`).
4.4. Add `car_mumbai_peak.json` as a **second profile** (not a time condition — custom models have no time-of-day predicate, `custom-models.md:169-170`). Client picks the profile from the IST clock.
4.5. **Unit-normalise in the adapter, never the caller.** GH `/route` = ms, GH `/matrix` = s, Valhalla = km, GH `/isochrone` = `lat,lon`, GH `/route` POST = `[lon,lat]`.
4.6. Port the client seam: 1.5^i backoff with ±50% jitter, a wall-clock `retryTimeoutMs` budget, 503 retriable, 429 fatal unless `retryOverQueryLimit` (`client_default.py:34, 144-155, 222-250`).
4.7. Batch matrix with `skipApiError` semantics (`client_default.py:194-200`) so one unroutable POI does not kill a 50-source matrix.
4.8. Pre-cluster with `@turf/clusters-kmeans` to keep matrices ≤ 50 sources.
4.9. Fall back to a haversine 2-sphere estimate when a provider is down, and **label the result `estimated: true`**.

### Phase 5 — retrieval (2 days)
5.1. SQLite FTS5 is the source of truth. Facets = `GROUP BY` on real columns. Geo = an R*Tree.
5.2. **Store a normalised hours projection** alongside `hoursRaw` so FTS5 can answer "open at 19:00 Saturday" with a B-tree predicate, not a re-parse. Materialise it on ingest; refresh when `openNow` flips.
5.3. **Orama: only if** typo'd queries measure as a real failure. Then it is an in-process side index over `name`/`description`, merged on id, rebuilt from SQLite. See §7.7 for the full cost list.
5.4. If Orama: transliterate Devanagari on ingest *and* query (`languages.ts:8-40` has Hindi/Nepali, **not Marathi**; only the English stemmer ships in-tree).
5.5. **Never** enable Orama vector/hybrid modes. Zero embeddings, zero use.

### Phase 6 — the map (3 days)
6.1. One clustered GeoJSON source (`cluster: true`, `clusterMaxZoom: 12`, `clusterRadius: 60`, `clusterMinPoints: 3`, `maxzoom: 16`, `buffer: 32`) with `promoteId: "osmId"`. `maxzoom` must be `> clusterMaxZoom` (`geojson_source.ts:208-210`).
6.2. **`circle` layers for all POI markers.** `symbol` only for ≤20 live-result labels. Zero `symbol` layers over the 50k-point source.
6.3. `clusterProperties` with `openCount` / `freeCount` / `wheelchairOK` (`geojson_worker_source.ts:327-362`). This is the feature that makes clusters worth looking at.
6.4. Hover + selected via `setFeatureState` / `removeFeatureState(target,'hover')` (`ui/map.ts:3913-3933`, `:3963-3977`). **Never** via `setPaintProperty`. Track the previous hovered id and clear it *before* setting the new one. Throttle `mousemove` to one rAF.
6.5. `promoteId`, **not** `generateId` — otherwise hover state is destroyed by the next `setData` (`ui/map.ts:3900-3905`).
6.6. **No `sourceLayer` for GeoJSON sources**; always pass `id`. `setFeatureState` fires an `ErrorEvent` rather than throwing (`style.ts:1444-1457`) — install a `map.on('error')` logger.
6.7. Click-to-expand: `getClusterExpansionZoom` + `map.easeTo` (`geojson_source.ts:378-379`). `getClusterLeaves(id, limit, offset)` — it is **paged**, so the "everything in this cluster" sheet must paginate (`:400-424`).
6.8. **De-duplicate `e.features` by `id` in every click/mouse handler** — tile buffering guarantees duplicates at tile boundaries (`ui/map.ts:2536-2545`).
6.9. **Hit-test against `circle`, never `symbol`** — collision-hidden symbols are not returned by `queryRenderedFeatures` (`ui/map.ts:2519-2524`).
6.10. Two sources: `pois-clusters` (clustered, refreshed wholesale) and `pois-selected` (un-clustered, uses `updateData` for incremental updates — `geojson_source.ts:552-579` shows `cluster: true` disables partial tile reload).

### Phase 7 — geo + geocode (2 days)
7.1. Land only the small turf set (§6.2). **Skip `@turf/buffer`** for circles (JSTS + d3-geo); hand-roll a 64-gon. Keep `@turf/buffer` only for negative-radius differences.
7.2. `@turf/nearest-point-on-line` for "180 m off your route" — use the **new** property names (`lineStringIndex`, `segmentIndex`, `totalDistance`, `lineDistance`, `segmentDistance`, `pointDistance`), not the deprecated `index`/`location`/`dist` (`nearest-point-on-line/index.ts:20-30`).
7.3. `@turf/along` silently clamps to the last vertex past the line end (`along/index.ts:35-56`) — assert the returned index.
7.4. Use `@turf/bbox` for the 6-dp bbox canonicalisation **shared** with the Overpass cache key, so both layers share one canonical string.
7.5. Geocode: Nominatim primary. Spin a **self-hosted Photon (India extract)** as the typo-tolerant, location-biased fallback — it gets locality/ghat/Marathi handling free via its Nominatim base. Skip Pelias (10-service Elasticsearch pipeline; unjustified while OSM already names the places).

### Phase 8 — observability (do not skip)
8.1. Per-field OSM coverage %, recomputed each harvest. Our baseline (Bandra West, 199 POIs): `name` 91%, `cuisine` 39%, `opening_hours` 16%, `wheelchair` 1%, `fee` 0%, ratings none. **If a field drops below 5% coverage, it must not appear as a filter in the UI** — an always-empty filter is worse than no filter.
8.2. Hours-parse success rate, split by `ok`/`partial`/`unparsable`. If `unparsable` > 10%, fix the tokenizer before shipping.
8.3. `check_date` staleness histogram. Anything older than 12 months with an `opening_hours` value is bad data and must be labelled.
8.4. Routing latency + provider error rate per provider, and the fraction of requests served by the haversine fallback. If that fraction is ever > 1%, we have a provider-availability problem, not a data problem.
8.5. Overpass slot utilisation from the `/status` parse — a rising "Slot available after" delay means we need a self-hosted Overpass instance (`getting-started.rst:141`: >1k queries/day ⇒ host your own).

---
