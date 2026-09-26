# EVENTS — the demo calendar

**40 event rows.** Every one carries `synthetic: true` and a `__meta.synthetic:
true` note. **None of them is a real current or upcoming event.** They are
authored fixtures for the calendar surface, the availability gate and the
replanner.

The distinction the brief asked for, and the one the file enforces:

- `provenance: "curated"` on all 40 — a human wrote them, they were not
  harvested. The checker rejects `provenance: "osm"` on an event, because an
  event is not a thing in the OSM tag space and claiming otherwise is a lie
  about where it came from.
- `synthetic: true` on all 40 — the instance, the date, the venue and the
  capacity are invented. Sixteen notes say which specific real thing the
  instance is modelled on, because "synthetic" alone does not tell a reader
  whether the underlying phenomenon is real.

## Shape

There is no `Event` schema in the contract, so this is our shape. It borrows
`Slot`'s vocabulary deliberately — `openMin`/`closeMin` as minutes from local
midnight, `capacity` as the only capacity number, no `remaining` — because the
availability derivation in `src/contracts` is built around it.

```ts
{
  id: string                    // evt-NNN
  title: string
  experienceId: string | ""     // the catalogue record it belongs to
  category: Category            // the contract enum
  neighbourhood: string
  location: GeoPoint
  startDate: string             // YYYY-MM-DD, validated
  endDate: string               // YYYY-MM-DD, validated, >= startDate
  recurrence: string | "one-off"   // "Fr,Sa", "last Fri", "daily", "Mo-Su"
  openMin: number               // minutes from midnight
  closeMin: number              // > openMin, validated
  durationMin: number           // must fit inside closeMin - openMin
  capacity: number | null
  pricePerPerson: Money | null
  indoorOutdoor: IndoorOutdoor
  weatherSensitive: "none"|"rain"|"heat"|"wind"|"any"
  cancellationNote: string      // never empty. A real product must be able to say it
  provenance: "curated"
  synthetic: true
  __meta: { synthetic: true, note: string }
}
```

The checker validates the date format, `endDate >= startDate`,
`closeMin > openMin`, `durationMin <= closeMin - openMin`, positive capacity,
`experienceId` resolution, and that no row claims `osm` provenance. It caught
three real errors while the file was being written: three malformed `endDate`
strings containing a `/`, one 70-minute event inside a 60-minute window, and a
`capacity` that was not a number.

## The three that are modelled on something real, and the three that are fixtures

**Modelled on a real phenomenon, invented instance.** These are the useful ones,
because a demo calendar full of fictional things teaches the reviewer nothing:

| row | real thing | what is invented |
|---|---|---|
| `evt-016` Hill Road Sunday market | a real Sunday street market on a real road | nothing — weekly, so this is a schedule rather than a fiction |
| `evt-017` Walkers Street flea | a real Sunday flea behind Marine Drive | nothing |
| `evt-019` Crawford Market late-afternoon trading | a real market with a real weekly rhythm | the programme listing |
| `evt-001` kite festival | kite festivals at this scale happen in Mumbai | dates, field, capacity |
| `evt-021` Koli community morning | Koli communities and the Versova landing are real | the family's participation. **This is the row to be most careful with** — a real community, invited to host a fictional programme, is the kind of thing that reads as exploitative if it leaks out of the demo framing. Its `__meta.note` says so explicitly |
| `evt-022` Versova harbour boat | boats leave Versova in real life | route, vessel, price |
| `evt-037` lamps lane | a real seasonal density spike in a real place | the festival framing |
| `evt-034` Metro INOX | a real cinema | the programme listing |

**Pure fixtures.** 32 rows with no real-world referent: a basement gallery, a
ghazal hall, a print room, a ceramicist's kiln, a vinyl room, a lantern maker, a
rickshaw painter's bench, a dhow-themed music room, a Farsi reading room with no
sign. Each is modelled on a real *kind* of thing in that part of the city and
invented in every particular.

## Rows that exist to make the engine's hardest paths testable

| row | what it forces |
|---|---|
| `evt-040` Christmas Eve cinema, 300 capacity, 45,000 paise | deliberately near-full. The `sold_out` rejection code needs something to be sold out of, and scenario 28 needs a real evidence base rather than a hypothetical one |
| `evt-015` monsoon film walk, `covered`, `weatherSensitive: rain` | a `covered` record that survives the monsoon weather gate. Without it, the rain replan in scenario 27 has nowhere to send anybody except a hotel cafe |
| `evt-028` lantern making, October to mid-November only | a narrow season, so `seasonal_mismatch` has something real to reject. Ask for lanterns in January and this must not surface |
| `evt-009` basement gallery opening, capacity 30 | its own reviews say about seventy people turn up. The `capacity_exceeded` and `sold_out` codes against a real number |
| `evt-020` covered market hall, open daily through June to September | the Bandra rain answer. Not exciting and completely reliable, which is the point |
| `evt-002`, `evt-005`, `evt-006`, `evt-034`, `evt-035` | `weatherSensitive: none` indoor rows, so the "never cancelled; it is the rain plan" copy is a real operational claim about a real schedule |

## Cancellation notes are mandatory

Every row has a non-empty `cancellationNote`, and this is the field that stops
the calendar from being a fantasy. Kites need wind, so a still day cancels as
readily as a wet one. The boat trip is checked the night before and refunded in
full, and it happens more often than you would expect between May and September.
The flower markets thin out in rain. The play is cancelled more often than venues
admit and you should ask. The Wada room has a caretaker or it is shut, with no
published schedule and no way to check in advance — and one of its three reviews
complains about exactly that, so at least the data is internally consistent.

A traveller planning around a row that can vanish silently is the failure this
product exists to prevent. The note is the difference between an event and a
promise.
