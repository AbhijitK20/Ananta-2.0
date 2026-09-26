import { describe, it, expect } from "vitest";
import {
  inr,
  fromMinor,
  zero,
  isZero,
  addMoney,
  subtractMoney,
  multiplyMoney,
  totalForParty,
  compareMoney,
  moneyEquals,
  formatMoney,
  formatPerPerson,
  toMajor,
  parseMoney,
  MoneyError,
} from "../src/lib/money";
import { MONEY_FIXTURES } from "./fixtures";

describe("money: integer minor units only", () => {
  it("converts whole rupees to paise", () => {
    expect(inr(1500)).toEqual({ minor: 150_000, currency: "INR" });
    expect(inr(0)).toEqual({ minor: 0, currency: "INR" });
  });

  it("REFUSES a fractional rupee rather than silently rounding", () => {
    // This is the whole point of the module. 0.1 + 0.2 !== 0.3 means a float
    // money bug is a trust bug, and rounding it away hides the bug.
    expect(() => inr(1500.5)).toThrow(MoneyError);
    expect(() => inr(1500.5)).toThrow(/non-integer/);
    expect(() => inr(0.1 + 0.2)).toThrow(MoneyError);
  });

  it("builds directly from minor units", () => {
    expect(fromMinor(150_000)).toEqual({ minor: 150_000, currency: "INR" });
    expect(() => fromMinor(-1)).toThrow(/non-negative/);
  });

  it("distinguishes free (0) from unknown (null)", () => {
    // The distinction the schema depends on: price_minor = 0 means genuinely
    // free, NULL means nobody filled the field in.
    expect(isZero(zero())).toBe(true);
    expect(isZero(null)).toBe(false);
    expect(isZero(fromMinor(50_000))).toBe(false);
  });

  it("adds without float drift", () => {
    const a = inr(1499);
    const b = inr(1);
    expect(addMoney(a, b).minor).toBe(150_000);
    expect(addMoney(a, b)).toEqual(inr(1500));
  });

  it("accumulates 100 paise additions exactly", () => {
    // The classic float failure, done properly.
    let total = zero();
    for (let i = 0; i < 100; i++) total = addMoney(total, fromMinor(1));
    expect(total.minor).toBe(100);
    expect(toMajor(total)).toBe(1);
  });

  it("refuses to subtract into negative", () => {
    expect(() => subtractMoney(inr(100), inr(500))).toThrow(/negative/);
    expect(subtractMoney(inr(500), inr(100)).minor).toBe(40_000);
  });

  it("refuses a negative result from subtraction", () => {
    expect(MoneyError).toBeDefined();
    expect(() => subtractMoney(inr(1), inr(2))).toThrow(MoneyError);
  });

  it("multiplies by an integer party size only", () => {
    expect(multiplyMoney(inr(500), 4)).toEqual(inr(2000));
    expect(() => multiplyMoney(inr(500), 2.5)).toThrow(/integer/);
    expect(() => multiplyMoney(inr(500), -1)).toThrow(/non-negative/);
  });

  it("computes the party total the budget gate needs", () => {
    expect(totalForParty(inr(450), 4)).toEqual(inr(1800));
    expect(totalForParty(inr(450), 1)).toEqual(inr(450));
  });

  it("never converts currency implicitly", () => {
    // INR is the only supported currency in v1, so a USD amount is rejected at
    // the guard rather than silently added to a rupee total.
    const usd = { minor: 1000, currency: "USD" };
    expect(() => addMoney(inr(10), usd as never)).toThrow(MoneyError);
    expect(() => addMoney(inr(10), usd as never)).toThrow(/Unsupported currency/);
    expect(() => compareMoney(inr(10), usd as never)).toThrow(MoneyError);
  });

  it("explains which currencies it supports", () => {
    expect(() => addMoney(inr(10), { minor: 1000, currency: "USD" } as never)).toThrow(/INR/);
  });

  it("compares by minor units", () => {
    expect(compareMoney(inr(100), inr(200))).toBeLessThan(0);
    expect(compareMoney(inr(200), inr(200))).toBe(0);
    expect(compareMoney(inr(300), inr(200))).toBeGreaterThan(0);
  });

  it("compares null only against null", () => {
    expect(moneyEquals(null, null)).toBe(true);
    expect(moneyEquals(null, zero())).toBe(false);
    expect(moneyEquals(zero(), null)).toBe(false);
    expect(moneyEquals(inr(10), inr(10))).toBe(true);
  });

  it("formats with Indian digit grouping", () => {
    // 1,50,000 not 150,000. Small detail, and Indian users notice immediately.
    expect(formatMoney(inr(1500))).toBe("₹1,500");
    expect(formatMoney(inr(150_000))).toBe("₹1,50,000");
    expect(formatMoney(zero())).toBe("₹0");
  });

  it("shows paise only when they exist", () => {
    expect(formatMoney(fromMinor(150_050))).toBe("₹1,500.50");
    expect(formatMoney(fromMinor(150_000))).toBe("₹1,500");
  });

  it("says so when the price is unknown rather than showing zero", () => {
    // Showing "₹0" for an unknown price is a lie a traveller would act on.
    expect(formatMoney(null)).toBe("Price not listed");
    expect(formatPerPerson(null)).toBe("Free");
  });

  it("labels a per-person price as such", () => {
    expect(formatPerPerson(inr(450))).toBe("₹450 per person");
  });

  it("validates at the boundary", () => {
    expect(parseMoney({ minor: 150_000, currency: "INR" })).toEqual(inr(1500));
    expect(() => parseMoney({ minor: 1.5, currency: "INR" })).toThrow();
    expect(() => parseMoney({ minor: -1, currency: "INR" })).toThrow();
    expect(() => parseMoney({ minor: 100, currency: "INRU" })).toThrow();
  });

  it("holds every fixture from the shared table", () => {
    for (const fixture of MONEY_FIXTURES) {
      expect(fixture.expectedMinor).toBe(Math.trunc(fixture.rupees * 100));
    }
  });
});
