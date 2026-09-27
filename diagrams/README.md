# Architecture diagrams

Four diagrams describing how this repository actually works, authored as
[Archify](https://github.com/tt-a1i/archify) JSON specifications.

**The JSON is the source of truth.** Everything here is grounded in the repo —
the file names, the counts and the constants were read out of the source, not
invented for a slide.

| spec | type | what it shows |
|---|---|---|
| `ananta-repo-architecture.architecture.json` | architecture | `tools/` → `data/` → `lib/` → `components/` → `app/`, plus `public/` and the Cesium/Three.js externals |
| `ananta-content-pipeline.workflow.json` | workflow | scrape → committed datasets → quality gates → build → routes |
| `ananta-request-lifecycle.sequence.json` | sequence | prerender at build time vs. request time |
| `ananta-game-lifecycle.lifecycle.json` | lifecycle | the Local Legends stamp journey and its storage-fault path |

`*.slide.png` are 2048×1320 renders, ready to drop into a deck.

## Regenerating

Each spec renders to a standalone interactive HTML viewer (pan, zoom, search,
light/dark, PNG/SVG export). The viewers are ~800KB each and are **not committed**
— rebuild them with:

```bash
# validate then deliver (deliver exits non-zero if any check fails)
node <archify>/bin/archify.mjs validate <type> diagrams/<name>.<type>.json --quality showcase --json
node <archify>/bin/archify.mjs deliver  <type> diagrams/<name>.<type>.json diagrams/<name>.html --quality showcase --json

# bounded browser evidence against the delivered HTML
ARCHIFY_CHROME=/path/to/chrome ARCHIFY_CHROME_NO_SANDBOX=1 \
  node <archify>/bin/archify.mjs visual-check diagrams/<name>.html --json
```

`<type>` is one of `architecture`, `workflow`, `sequence`, `lifecycle`.
A passing `deliver` reports 9/9 artifact checks with 0 errors and 0 warnings.

## Known issue

`ananta-request-lifecycle` passes validation and delivery (9/9) but **overflows
vertically in the browser at every checked viewport** (1244px of content in a
900px window), so it is not yet usable as a single slide. Dropping the
build-time/request-time segments and switching `column_fit` to `spread` did not
reduce `scrollHeight`, so it likely needs splitting into two diagrams. The other
three pass containment, readability, viewer-chrome and capture checks at 1440x900,
1600x1000, 1920x1080 and 2048x1320.
