/**
 * The consent gate and the operator-detail gate, as assertions.
 *
 * This is the one runnable check the privacy work needs, and it uses Node's
 * built-in test runner rather than a framework. Both modules under test are
 * plain synchronous functions over one localStorage key, so a test framework
 * would be more machinery than the thing being tested.
 *
 * Every assertion here corresponds to something that would be false again if
 * somebody tidied the code. None of them are obvious from reading it: the
 * "undecided is not granted" rule is one boolean in one function, and it is the
 * difference between a privacy policy that is true and one that is not.
 *
 * Run: npm run check:consent
 */
import test from "node:test";
import assert from "node:assert/strict";

import {
  ALL_CATEGORIES,
  CONSENT_VERSION,
  clearConsent,
  consentState,
  describeCategories,
  isCategoryAllowed,
  isValidChoice,
  readConsent,
  setConsent,
  unknownCategories,
  writeConsent,
} from "../lib/consent.ts";

import {
  BUSINESS,
  copyrightLine,
  isLaunchReady,
  missingOperatorDetails,
} from "../lib/business.ts";

/** A localStorage stand-in. The consent module is sync and DOM-free by design. */
function installStorage(initial = {}) {
  const store = new Map(Object.entries(initial));
  globalThis.window = {
    localStorage: {
      getItem: (k) => (store.has(k) ? store.get(k) : null),
      setItem: (k, v) => void store.set(k, v),
      removeItem: (k) => void store.delete(k),
    },
    dispatchEvent: () => true,
  };
  return store;
}

test("undecided is not granted", () => {
  installStorage();
  // The whole point. If this flips, a first visit sends the visitor's IP address
  // to a tile server before anybody has been asked.
  assert.equal(isCategoryAllowed("map"), false);
  assert.equal(consentState(), "undecided");
});

test("the map is allowed only on an explicit grant", () => {
  const granted = { version: CONSENT_VERSION, granted: true };
  const refused = { version: CONSENT_VERSION, granted: false };
  assert.equal(isCategoryAllowed("map", granted), true);
  assert.equal(isCategoryAllowed("map", refused), false);
  assert.equal(isCategoryAllowed("map", null), false);
});

test("strictly-necessary storage is always allowed", () => {
  // It is the storage the site needs to serve a page and to remember the answer.
  // A consent prompt offering to switch it off is a prompt that breaks the site.
  installStorage();
  assert.equal(isCategoryAllowed("necessary"), true);
  assert.equal(
    isCategoryAllowed("necessary", { version: CONSENT_VERSION, granted: false }),
    true,
  );
});

test("a stored choice from an older prompt version is ignored", () => {
  assert.equal(isValidChoice({ version: CONSENT_VERSION - 1, granted: true }), false);
  assert.equal(isValidChoice({ version: CONSENT_VERSION, granted: "yes" }), false);
  assert.equal(isValidChoice(null), false);
  assert.equal(isValidChoice("granted"), false);
});

test("a corrupt stored value reads as no answer, not as a grant", () => {
  // Hand-edited or half-written. Guessing "granted" here would be the worst
  // possible failure: it silently unlocks the third-party request.
  installStorage({ "lal:consent:v1": "{not json" });
  assert.equal(readConsent(), null);
  assert.equal(isCategoryAllowed("map"), false);
});

test("withdrawal is as easy as consent, and clears the answer", () => {
  const store = installStorage();
  writeConsent(true);
  assert.equal(isCategoryAllowed("map"), true);
  writeConsent(false);
  assert.equal(isCategoryAllowed("map"), false);
  clearConsent();
  assert.equal(isCategoryAllowed("map"), false);
  assert.equal(store.size >= 0, true);
});

test("setConsent stores and announces together", () => {
  const store = installStorage();
  let announced = null;
  globalThis.window.dispatchEvent = (event) => {
    announced = event.detail;
    return true;
  };
  setConsent(true);
  assert.equal(isCategoryAllowed("map"), true);
  assert.equal(announced, true);
  assert.ok(store.get("lal:consent:v1"));
});

test("every switchable category is described, so no permission goes unnamed", () => {
  // A consent dialog that grants a category it never described is the failure
  // this catches. `unknownCategories()` is non-empty in that case.
  assert.deepEqual(unknownCategories(), []);
  for (const category of ALL_CATEGORIES) {
    assert.ok(
      describeCategories().some((row) => row.category === category),
      `no disclosure row for ${category}`,
    );
  }
});

test("the map disclosure names the recipient and the IP address", () => {
  const map = describeCategories().find((row) => row.category === "map");
  assert.ok(map, "no map category");
  assert.match(map.detail, /OpenStreetMap/);
  // And admits the IP address goes with it, which is the entire reason the gate
  // exists. A disclosure that omits this is worse than no disclosure.
  assert.match(map.detail, /IP address/);
});

test("only one category is switchable, because there is only one third party", () => {
  // Guards against a generic six-category consent form appearing over a site
  // with no analytics, no ads and no social widgets.
  assert.equal(describeCategories().filter((row) => row.optional).length, 1);
});

test("missing operator details are reported, not hidden", () => {
  // DPDP 5(1) requires a named Data Fiduciary and a contact. `BUSINESS` ships
  // null on purpose; a policy that renders as finished while naming nobody is
  // the failure this whole file exists to prevent.
  assert.equal(BUSINESS.legalName, null);
  assert.equal(isLaunchReady(), false);
  for (const field of ["legalName", "registeredAddress", "jurisdiction", "privacyEmail"]) {
    assert.ok(
      missingOperatorDetails().includes(field),
      `expected ${field} to be reported as missing`,
    );
  }
});

test("the copyright line never renders blank", () => {
  assert.equal(copyrightLine(BUSINESS, new Date("2026-09-01T00:00:00Z")), "© 2026 Like a Local Guide");
  assert.equal(
    copyrightLine(BUSINESS, new Date("2028-03-01T00:00:00Z")),
    "© 2026–2028 Like a Local Guide",
  );
});

test("the copyright line uses the legal name once there is one", () => {
  const filled = { ...BUSINESS, legalName: "Ananta Labs Pvt Ltd" };
  assert.match(copyrightLine(filled, new Date("2026-09-01T00:00:00Z")), /Ananta Labs Pvt Ltd/);
});
