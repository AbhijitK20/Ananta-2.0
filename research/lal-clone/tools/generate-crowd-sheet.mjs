/* ==========================================================================
   CROWD SPRITE SHEET — generates the 105 busts the home-page crowd walks.

   Why this exists instead of a hand-drawn sheet: the reference effect slices
   one wide image into a 15x7 grid and animates each cell. That sheet was drawn
   for that site, so it is not ours to ship. The *engine* is the reusable part
   and is reimplemented in CrowdCanvas.tsx; the artwork is ours, so it is
   generated here from a seeded PRNG.

   Consequences worth knowing:

   1. Seeded, not random. mulberry32 with a fixed seed means the committed
      sheet is byte-stable across machines and runs, so a rebuild never churns
      a 100-figure file. Change SEED and the whole crowd changes.

   2. Busts, not full bodies. The engine's depth logic deliberately skews most
      figures below the stage edge, so anything below the chest is cropped by
      the cell anyway. Drawing legs would be drawing pixels nobody sees.

   3. SVG, not PNG. Keeps the artwork reviewable as text, scales to any
      density, and `drawImage` handles it as long as width/height are explicit
      attributes on the root element (which is why they are not percentages).

   Run: node tools/generate-crowd-sheet.mjs
   ========================================================================== */

import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const SEED = 0x1a1b2c;

/* Grid geometry. The engine derives cell size from the sheet's own pixel
   dimensions, so these only have to be internally consistent. */
const COLS = 15; // cells across
const ROWS = 7; // cells down
const CELL_W = 160;
const CELL_H = 260;
const SHEET_W = COLS * CELL_W; // 2400
const SHEET_H = ROWS * CELL_H; // 1820

/* The clone's own tokens, so the crowd is native to the page rather than a
   foreign illustration dropped onto it. */
const INK = "#251e20";
const INK_2 = "#52474a";
const INK_5 = "#a89ea1";
const ACCENT = "#b833ab";
const ACCENT_SOFT = "#f5e6f2";
const TEAL = "#2f4a52";
const LINE = "#e2e8ef";
const SHELL = "#f1f2f3";

const OUT = join(dirname(fileURLToPath(import.meta.url)), "..", "public", "crowd", "peeps-sheet.svg");

/* UTIL ------------------------------------------------------------------- */

function mulberry32(seed) {
  let a = seed >>> 0;
  return function next() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const rnd = mulberry32(SEED);
const range = (min, max) => min + rnd() * (max - min);
const int = (min, max) => Math.floor(range(min, max + 1));
const chance = (p) => rnd() < p;
const pick = (list) => list[Math.floor(rnd() * list.length)];

/* Weighted choice. The sheet is mostly neutral on purpose: an even spread of
   the accent turned 105 figures into a brand-ambassador crowd, which is a very
   different read from a crowd of people. Accent is a seasoning, not a base. */
const weighted = (pairs) => {
  let total = 0;
  for (const [, w] of pairs) total += w;
  let r = rnd() * total;
  for (const [value, w] of pairs) {
    r -= w;
    if (r <= 0) return value;
  }
  return pairs[0][0];
};
const n = (value) => Math.round(value * 100) / 100;

/* HAIR --------------------------------------------------------------------
   Each style receives the head box and returns svg. They are written against
   a head centred at (0,0) with radii (rx, ry) and translated into place, so a
   style is reusable across every head size in the sheet. */

const HAIR = {
  buzz: (rx, ry, color) => `<path d="M${n(-rx)} 2 A ${n(rx)} ${n(ry)} 0 0 1 ${n(rx)} 2 L ${n(rx - 4)} -4 A ${n(rx - 4)} ${n(ry - 6)} 0 0 0 ${n(-rx + 4)} -4 Z" fill="${color}"/>`,

  shortCrop: (rx, ry, color) => `<path d="M${n(-rx - 3)} 4 A ${n(rx + 3)} ${n(ry + 3)} 0 0 1 ${n(rx + 3)} 4 L ${n(rx - 2)} -6 A ${n(rx)} ${n(ry)} 0 0 0 ${n(-rx + 2)} -6 Z" fill="${color}"/>`,

  sidePart: (rx, ry, color) =>
    `<path d="M${n(-rx - 4)} 6 A ${n(rx + 4)} ${n(ry + 2)} 0 0 1 ${n(rx + 4)} 6 L ${n(rx - 1)} -8 A ${n(rx - 1)} ${n(ry - 2)} 0 0 0 ${n(-rx + 14)} -10 Z" fill="${color}"/>`,

  bob: (rx, ry, color) =>
    `<path d="M${n(-rx - 5)} 14 A ${n(rx + 5)} ${n(ry + 4)} 0 0 1 ${n(rx + 5)} 14 L ${n(rx + 5)} ${n(ry + 6)} A 10 10 0 0 1 ${n(rx - 5)} ${n(ry + 6)} L ${n(-rx + 5)} ${n(ry + 6)} A 10 10 0 0 1 ${n(-rx - 5)} ${n(ry + 6)} Z" fill="${color}"/>`,

  longStraight: (rx, ry, color) =>
    `<path d="M${n(-rx - 6)} 16 A ${n(rx + 6)} ${n(ry + 4)} 0 0 1 ${n(rx + 6)} 16 L ${n(rx + 6)} ${n(ry + 34)} L ${n(rx - 2)} ${n(ry + 30)} L ${n(-rx + 2)} ${n(ry + 30)} L ${n(-rx - 6)} ${n(ry + 34)} Z" fill="${color}"/>`,

  ponytail: (rx, ry, color) =>
    `<path d="M${n(-rx - 4)} 2 A ${n(rx + 4)} ${n(ry + 3)} 0 0 1 ${n(rx + 4)} 2 L ${n(rx - 2)} -6 A ${n(rx - 2)} ${n(ry - 3)} 0 0 0 ${n(-rx + 2)} -6 Z" fill="${color}"/>` +
    `<ellipse cx="${n(-rx - 8)}" cy="${n(ry * 0.35)}" rx="9" ry="16" fill="${color}"/>`,

  bun: (rx, ry, color) =>
    `<path d="M${n(-rx - 3)} 0 A ${n(rx + 3)} ${n(ry + 2)} 0 0 1 ${n(rx + 3)} 0 L ${n(rx - 2)} -7 A ${n(rx - 2)} ${n(ry - 3)} 0 0 0 ${n(-rx + 2)} -7 Z" fill="${color}"/>` +
    `<circle cx="0" cy="${n(-ry - 7)}" r="11" fill="${color}"/>`,

  curly: (rx, ry, color) => {
    let out = "";
    for (let i = 0; i < 7; i += 1) {
      const t = (i / 6) * Math.PI;
      out += `<circle cx="${n(Math.cos(t) * (rx + 2))}" cy="${n(-Math.sin(t) * (ry + 2))}" r="${n(range(9, 13))}" fill="${color}"/>`;
    }
    return out;
  },

  /* Travel guide: a lot of these people point at things for a living. */
  cap: (rx, ry, color) =>
    `<path d="M${n(-rx - 2)} -2 A ${n(rx + 2)} ${n(ry)} 0 0 1 ${n(rx + 2)} -2 L ${n(rx + 2)} -8 L ${n(-rx + 2)} -8 Z" fill="${color}"/>` +
    `<path d="M${n(-rx - 2)} -8 L ${n(rx + 2)} -8 L ${n(rx + 2)} -3 L ${n(-rx + 2)} -3 Z" fill="${color}"/>` +
    `<path d="M${n(-rx - 2)} -8 q ${n(-26)} 3 ${n(-30)} 14 q 16 5 32 2 Z" fill="${color}"/>`,

  beanie: (rx, ry, color) =>
    `<path d="M${n(-rx - 4)} -4 A ${n(rx + 4)} ${n(ry + 6)} 0 0 1 ${n(rx + 4)} -4 Z" fill="${color}"/>` +
    `<rect x="${n(-rx - 5)}" y="-8" width="${n((rx + 5) * 2)}" height="11" rx="5" fill="${color}"/>`,

  headscarf: (rx, ry, color) =>
    `<path d="M${n(-rx - 5)} 6 A ${n(rx + 5)} ${n(ry + 5)} 0 0 1 ${n(rx + 5)} 6 L ${n(rx + 4)} ${n(ry + 22)} L ${n(-rx - 4)} ${n(ry + 22)} Z" fill="${color}"/>` +
    `<path d="M${n(-rx - 5)} 2 A ${n(rx + 5)} ${n(ry + 5)} 0 0 1 ${n(rx + 5)} 2 L ${n(rx - 3)} -3 A ${n(rx - 3)} ${n(ry)} 0 0 0 ${n(-rx + 3)} -3 Z" fill="${color}"/>`,

  bald: () => "",
};

const HAIR_KEYS = Object.keys(HAIR);

/* SKIN / SHIRT ------------------------------------------------------------ */

const SKIN = ["#e8c9a8", "#d9ab86", "#c98d63", "#a86a45", "#7d4a2c", "#f0d8bd", "#b57a52"];
const SHIRT = [INK, INK_2, ACCENT, SHELL, LINE, INK_5, ACCENT_SOFT, "#2f4a52"];

function glasses(rx) {
  const r = rx * 0.3;
  const dx = rx * 0.42;
  return (
    `<g fill="none" stroke="${INK}" stroke-width="2.6" stroke-linecap="round">` +
    `<circle cx="${n(-dx)}" cy="2" r="${n(r)}"/><circle cx="${n(dx)}" cy="2" r="${n(r)}"/>` +
    `<path d="M${n(-dx + r)} 2 L ${n(dx - r)} 2"/><path d="M${n(-dx - r)} 0 L ${n(-rx - 2)} -3"/>` +
    `<path d="M${n(dx + r)} 0 L ${n(rx + 2)} -3"/></g>`
  );
}

function face(cx, cy, rx, ry) {
  const skin = pick(SKIN);
  const look = range(-0.22, 0.22);
  const ex = rx * 0.4;
  const ey = ry * 0.08;
  const glassesOn = chance(0.34);
  const beard = chance(0.18);
  const smile = chance(0.7);

  let out = `<ellipse cx="0" cy="0" rx="${n(rx)}" ry="${n(ry)}" fill="${skin}"/>`;
  /* Ears. Sits behind the hair layer, so no z-order juggling per style. */
  out += `<ellipse cx="${n(-rx + 1)}" cy="${n(ry * 0.1)}" rx="5" ry="7" fill="${skin}"/>`;
  out += `<ellipse cx="${n(rx - 1)}" cy="${n(ry * 0.1)}" rx="5" ry="7" fill="${skin}"/>`;
  if (beard) {
    out += `<path d="M${n(-rx * 0.82)} ${n(ry * 0.2)} A ${n(rx * 0.82)} ${n(ry * 0.8)} 0 0 0 ${n(rx * 0.82)} ${n(ry * 0.2)} L ${n(rx * 0.6)} ${n(ry * 0.1)} A ${n(rx * 0.6)} ${n(ry * 0.4)} 0 0 1 ${n(-rx * 0.6)} ${n(ry * 0.1)} Z" fill="${INK}" opacity="0.82"/>`;
  }
  out += `<g fill="${INK}"><circle cx="${n(-ex + look * rx)}" cy="${n(ey)}" r="3.1"/><circle cx="${n(ex + look * rx)}" cy="${n(ey)}" r="3.1"/></g>`;
  out += smile
    ? `<path d="M${n(-rx * 0.3)} ${n(ry * 0.42)} q ${n(rx * 0.3)} ${n(ry * 0.22)} ${n(rx * 0.6)} 0" fill="none" stroke="${INK}" stroke-width="2.6" stroke-linecap="round"/>`
    : "";
  if (glassesOn) out += glasses(rx);
  return `<g transform="translate(${n(cx)} ${n(cy)})">${out}</g>`;
}

/* The hem deliberately overshoots the cell (see CELL_HEM) and relies on the
   per-cell clip. Overshooting rather than stopping exactly at the edge keeps
   the hem off the clipping boundary, so no figure shows a cut-off hem line. */
const CELL_HEM = CELL_H + 60;

function torso(topY, halfShoulder, halfHem, color) {
  return (
    `<path d="M${n(-halfShoulder)} ${n(topY)} ` +
    `q ${n(halfShoulder * 0.55)} ${n(-halfShoulder * 0.62)} ${n(halfShoulder)} ${n(-halfShoulder * 0.5)} ` +
    `l ${n(halfShoulder * 0.9)} 0 ` +
    `q ${n(halfShoulder * 0.45)} ${n(-halfShoulder * 0.12)} ${n(halfShoulder)} ${n(halfShoulder * 0.5)} ` +
    `L ${n(halfHem)} ${CELL_HEM} L ${n(-halfHem)} ${CELL_HEM} Z" fill="${color}"/>`
  );
}

function outfit(shirtColor) {
  const kind = pick(["plain", "plain", "collar", "jacket", "hoodie", "scarf", "lanyard", "tee"]);
  const topY = 132;
  let out = torso(topY, 44, 55, shirtColor);

  if (kind === "collar") {
    out += `<path d="M-15 130 l15 19 l15 -19 l9 8 l-24 25 l-24 -25 Z" fill="#fff" opacity="0.92"/>`;
  }
  if (kind === "jacket") {
    out += `<path d="M-15 130 L0 152 L15 130 l8 7 L6 200 L-6 200 L-23 137 Z" fill="${INK}" opacity="0.28"/>`;
  }
  if (kind === "hoodie") {
    out += `<path d="M-27 136 q27 -24 54 0 q-27 13 -54 0 Z" fill="${INK}" opacity="0.3"/>`;
    out += `<path d="M-31 152 q9 40 6 60 M31 152 q-9 40 -6 60" fill="none" stroke="${INK}" stroke-width="3" opacity="0.45"/>`;
  }
  if (kind === "scarf") {
    out += `<rect x="-31" y="126" width="62" height="19" rx="9" fill="${ACCENT}"/>`;
    out += `<rect x="7" y="141" width="19" height="54" rx="9" fill="${ACCENT}"/>`;
  }
  if (kind === "lanyard") {
    /* The house style: everyone is carrying a badge to a place. */
    out += `<path d="M-13 132 L-6 194 M13 132 L6 194" fill="none" stroke="${ACCENT}" stroke-width="5"/>`;
    out += `<rect x="-18" y="194" width="36" height="44" rx="5" fill="#fff" stroke="${ACCENT}" stroke-width="3"/>`;
    out += `<rect x="-12" y="203" width="24" height="7" rx="3" fill="${INK_5}"/>`;
    out += `<rect x="-12" y="216" width="17" height="5" rx="2" fill="${LINE}"/>`;
  }
  if (kind === "tee") {
    out += `<path d="M-44 132 q13 25 7 38 M44 132 q-13 25 -7 38" fill="none" stroke="${INK}" stroke-width="3" opacity="0.22"/>`;
  }
  return out;
}

function peep() {
  const cx = CELL_W / 2 + range(-3, 3);
  const headRy = range(35, 42);
  const headRx = headRy * range(0.76, 0.88);
  const headCy = 80;
  const skin = pick(SKIN);
  const shirtColor = weighted([
    [INK, 5], [INK_2, 4], [INK_5, 3], [SHELL, 3], [LINE, 3],
    ["#fff", 2], [TEAL, 2], [ACCENT, 1.1], [ACCENT_SOFT, 1],
  ]);
  const hairColor = weighted([[INK, 7], [INK_2, 2], [TEAL, 1.2], [ACCENT, 1]]);
  const hairKey = pick(HAIR_KEYS);
  const solid = chance(0.42);

  let out = "";

  /* Hair behind the shoulders for the styles that fall past the jaw. */
  if (["longStraight", "ponytail", "bob", "headscarf"].includes(hairKey)) {
    out += `<g transform="translate(${n(cx)} ${n(headCy)})">${HAIR[hairKey](headRx, headRy, hairColor)}</g>`;
  }

  /* Neck then body, so the collar overlaps the neck the way a collar does.
     The neck is placed in absolute cell coords because it has to meet the
     head; outfit() is drawn around its own origin and so is translated onto
     the same centre line. */
  out += `<rect x="${n(cx - 13)}" y="${n(headCy + headRy - 6)}" width="26" height="34" rx="10" fill="${skin}"/>`;
  out += `<g transform="translate(${n(cx)} 0)">${outfit(shirtColor)}</g>`;

  /* Head, then the front hair layer. */
  out += face(cx, headCy, headRx, headRy);
  if (!["longStraight", "ponytail", "bob", "headscarf"].includes(hairKey)) {
    out += `<g transform="translate(${n(cx)} ${n(headCy)})">${HAIR[hairKey](headRx, headRy, hairColor)}</g>`;
  }

  /* Outline pass. A few figures are pure line-art; the rest read as flat
     shapes. Mixing the two is what stops 105 busts looking like a swatch. */
  if (!solid) {
    out += `<ellipse cx="${n(cx)}" cy="${n(headCy)}" rx="${n(headRx)}" ry="${n(headRy)}" fill="none" stroke="${INK}" stroke-width="2.4" opacity="0.5"/>`;
  }
  return out;
}

/* BUILD ------------------------------------------------------------------- */

let clips = "";
let cells = "";
for (let i = 0; i < COLS * ROWS; i += 1) {
  const col = i % COLS;
  const row = (i / COLS) | 0;
  const x = n(col * CELL_W);
  const y = n(row * CELL_H);
  /* Every cell gets its own clip rect. Without it the hem (which overshoots to
     hide its edge) would paint over the neighbouring cell, and the engine
     slices by cell — so each slice would carry a sliver of someone else. */
  clips += `<clipPath id="c${i}"><rect x="${x}" y="${y}" width="${CELL_W}" height="${CELL_H}"/></clipPath>`;
  cells += `<g clip-path="url(#c${i})"><g transform="translate(${x} ${y})">${peep()}</g></g>`;
}

const svg =
  `<svg xmlns="http://www.w3.org/2000/svg" width="${SHEET_W}" height="${SHEET_H}" ` +
  `viewBox="0 0 ${SHEET_W} ${SHEET_H}"><defs>${clips}</defs>${cells}</svg>`;

await mkdir(dirname(OUT), { recursive: true });
await writeFile(OUT, `${svg}\n`);

console.log(`crowd sheet: ${COLS * ROWS} busts -> public/crowd/peeps-sheet.svg (${SHEET_W}x${SHEET_H})`);
