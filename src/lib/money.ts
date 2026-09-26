/**
 * MONEY — integer minor units only. Never floats.
 *
 * Rationale (docs/ARCHITECTURE.md §5, DECISIONS D2): 0.1 + 0.2 !== 0.3, and a
 * money bug in a travel product is a trust bug. Every amount in this codebase
 * is `{ minor: integer, currency: "INR" }`. 1500 rupees = 150000 paise.
 *
 * India-specific: the paise is the minor unit. Note that `₹1,499` and
 * `₹1,500` are the two numbers a traveller actually sees, and GST/service
 * charges are frequently added at the counter rather than in the listed price
 * — see `PRICE_IS_PRE_TAX` below, which the UI must surface rather than hide.
 */

import { Money } from "../contracts";
import { z } from "zod";

/** Currencies the app supports in v1. INR is the only one we curate. */
export const SUPPORTED_CURRENCIES = ["INR"] as const;
export type SupportedCurrency = (typeof SUPPORTED_CURRENCIES)[number];

/**
 * Minor-unit exponent per currency. Powers of ten only — if a currency ever
 * needs 3 decimals this becomes a lookup, and that day we revisit the design.
   */
  const MoneySchema = z.object({
  minor: z.number().int().nonnegative(),
  currency: z.string().length(3),
});

export class MoneyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MoneyError";
  }
}

function assertCurrency(currency: string): asserts currency is SupportedCurrency {
  if (!(SUPPORTED_CURRENCIES as readonly string[]).includes(currency)) {
    throw new MoneyError(
      `Unsupported currency ${JSON.stringify(currency)}. Supported: ${SUPPORTED_CURRENCIES.join(", ")}.`,
    );
  }
}

/** Reject floats BEFORE they become a Money. This is the guard rail. */
function assertWhole(amount: number, method: string): void {
  if (typeof amount !== "number" || !Number.isFinite(amount)) {
    throw new MoneyError(`${method}: amount must be a finite number, got ${String(amount)}`);
  }
  if (!Number.isInteger(amount)) {
    throw new MoneyError(
      `${method}: refusing to convert a non-integer major-unit amount (${amount}). ` +
        `Pass a value already in minor units, or round deliberately.`,
    );
  }
}

/**
 * Build Money from MAJOR units as an integer.
 *
 *   inr(1500)        -> { minor: 150000, currency: "INR" }
 *   inr(1500.5)      -> throws. Deliberate.
 *
 * If you genuinely need a fractional rupee, that is a real business decision
 * and it should be visible in review, not a rounding artefact of an addition.
 */
export function inr(major: number): Money {
  assertWhole(major, "inr()");
  return { minor: major * 100, currency: "INR" };
}

/** Build Money directly from minor units. The preferred entry point at the edges. */
export function fromMinor(minor: number, currency: SupportedCurrency = "INR"): Money {
  assertWhole(minor, "fromMinor()");
  if (minor < 0) throw new MoneyError(`fromMinor(): minor units must be non-negative, got ${minor}`);
  return { minor, currency };
}

/** Zero, for "free". `null` is the correct value for "price unknown". */
export function zero(currency: SupportedCurrency = "INR"): Money {
  return { minor: 0, currency };
}

export function isZero(money: Money | null): boolean {
  return money !== null && money.minor === 0;
}

export function addMoney(a: Money, b: Money): Money {
  assertSameCurrency(a, b, "addMoney()");
  return { minor: a.minor + b.minor, currency: a.currency };
}

export function subtractMoney(a: Money, b: Money): Money {
  assertSameCurrency(a, b, "subtractMoney()");
  const minor = a.minor - b.minor;
  if (minor < 0) {
    throw new MoneyError(`subtractMoney(): ${formatMoney(a)} - ${formatMoney(b)} goes negative`);
  }
  return { minor, currency: a.currency };
}

/** Multiply for a party. `quantity` must be a non-negative integer. */
export function multiplyMoney(money: Money, quantity: number): Money {
  if (!Number.isInteger(quantity)) {
    throw new MoneyError(`multiplyMoney(): quantity must be an integer, got ${quantity}`);
  }
  if (quantity < 0) {
    throw new MoneyError(`multiplyMoney(): quantity must be non-negative, got ${quantity}`);
  }
  return { minor: money.minor * quantity, currency: money.currency };
}

/** Per-person total for a party of `size`. This is the budget gate's input. */
export function totalForParty(perPerson: Money, size: number): Money {
  return multiplyMoney(perPerson, size);
}

function assertSameCurrency(a: Money, b: Money, method: string): void {
  assertCurrency(a.currency);
  assertCurrency(b.currency);
  if (a.currency !== b.currency) {
    throw new MoneyError(
      `${method}: currency mismatch — ${a.currency} vs ${b.currency}. No implicit conversion.`,
    );
  }
}

export function compareMoney(a: Money, b: Money): number {
  assertSameCurrency(a, b, "compareMoney()");
  return a.minor - b.minor;
}

export function moneyEquals(a: Money | null, b: Money | null): boolean {
  if (a === null || b === null) return a === b;
  return a.minor === b.minor && a.currency === b.currency;
}

/** The Indian numbering system, because "1,50,000" not "150,000". */
const INR_GROUPING = new Intl.NumberFormat("en-IN", {
  style: "currency",
  currency: "INR",
  maximumFractionDigits: 0,
});

const INR_PRECISE = new Intl.NumberFormat("en-IN", {
  style: "currency",
  currency: "INR",
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

/** "₹1,500" — drops paise when zero, which is the common case. */
export function formatMoney(money: Money | null): string {
  if (money === null) return "Price not listed";
  assertCurrency(money.currency);
  const major = money.minor / 100;
  const hasPaise = money.minor % 100 !== 0;
  return hasPaise ? INR_PRECISE.format(major) : INR_GROUPING.format(major);
}

/** "₹1,500 per person", for card subtitles. */
export function formatPerPerson(money: Money | null): string {
  if (money === null) return "Free";
  return `${formatMoney(money)} per person`;
}

/** Convert to major units as a number. For display and charts ONLY. */
export function toMajor(money: Money): number {
  return money.minor / 100;
}

/**
 * Menu prices in India are overwhelmingly pre-GST-inclusive for tourists, and
 * service charges are usually added at the bill. The engine must not pretend
 * otherwise, so the UI carries this flag.
 */
export const PRICE_IS_PRE_TAX = true;

/** Validate at a boundary. Returns a fresh object; never returns the input. */
export function parseMoney(value: unknown): Money {
  return MoneySchema.parse(value) as Money;
}
