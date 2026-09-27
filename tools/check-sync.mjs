/**
 * Assertions for the sync reconciliation — the one place where the local save
 * and the cloud save can disagree and a wrong answer destroys a player's
 * progress.
 *
 * The cases that matter are the ones a browser cannot reach: what happens on a
 * fresh device with no local save, what happens when a signed-out player signs
 * in with progress the cloud has never seen, and what happens when both copies
 * are identical. Each of those silently produces the wrong result in a way that
 * still *looks* fine on screen.
 *
 * Imports the real function, so this is a test of the shipped code rather than
 * a restatement of it.
 *
 * Run: `npm run check:sync`
 */

import { reconcile } from "../lib/auth/reconcile.ts";

let failures = 0;
const results = [];

const check = (name, pass, detail = "") => {
  results.push(`${pass ? "ok  " : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
  if (!pass) failures++;
};

const local = { stamps: { a: "2026-01-01T00:00:00.000Z" }, claimedQuests: [] };
const other = { stamps: { b: "2026-01-02T00:00:00.000Z" }, claimedQuests: [] };
const cloud = (data, at = "2026-02-01T00:00:00.000Z") => ({ data, at });

/* ---- no cloud copy ------------------------------------------------------- */

check(
  "no cloud save: do nothing, push nothing",
  (() => {
    const r = reconcile("game", local, null, false);
    return r.adopt === null && r.push === false;
  })(),
  "a first-time player must not be sent a push for an empty cloud",
);

/* ---- unsynced local work ------------------------------------------------ */

check(
  "unsynced local work is never overwritten by the cloud copy",
  (() => {
    const r = reconcile("game", local, cloud(other), true);
    return r.adopt === null && r.push === true;
  })(),
  "this is the data-loss case: playing unsigned, then signing in",
);

check(
  "unsynced local work wins even when the cloud copy is newer by timestamp",
  (() => {
    const r = reconcile("game", local, cloud(other, "2099-01-01T00:00:00.000Z"), true);
    return r.adopt === null && r.push === true;
  })(),
  "the pending flag outranks the timestamp; see reconcile.ts for why",
);

/* ---- agreement ---------------------------------------------------------- */

check(
  "identical copies: no adopt, no push",
  (() => {
    const r = reconcile("game", local, cloud(local), false);
    return r.adopt === null && r.push === false;
  })(),
  "the case that fires on every ordinary page load",
);

/* ---- clean local, different cloud ---------------------------------------- */

check(
  "a synced device adopts the newer cloud copy",
  (() => {
    const r = reconcile("game", local, cloud(other), false);
    return r.push === false && JSON.stringify(r.adopt) === JSON.stringify(other);
  })(),
  "the case that makes progress follow you to a second device",
);

/* ---- key order ----------------------------------------------------------- */

check(
  "same content in a different key order is treated as a change",
  (() => {
    const reordered = { claimedQuests: [], stamps: { a: "2026-01-01T00:00:00.000Z" } };
    const r = reconcile("game", local, cloud(reordered), false);
    return r.adopt !== null;
  })(),
  "documents the known ceiling: the comparison is textual, not a deep equal",
);

/* ---- kind is not load-bearing ------------------------------------------- */

check(
  "the decision does not depend on which kind it is",
  reconcile("trip", local, cloud(other), true).push === true &&
    reconcile("trip", local, null, false).push === false,
  "one function serving both stores cannot quietly differ between them",
);

/* -------------------------------------------------------------------------- */

for (const line of results) console.log(line);
console.log(`\n${results.length - failures}/${results.length} passed`);

if (failures > 0) process.exit(1);
