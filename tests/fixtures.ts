/**
 * Shared test fixtures. Kept in one place so the boundary test, the seed
 * validator and the unit tests cannot drift apart on what a price or a
 * duration is allowed to be.
 */

export interface MoneyFixture {
  rupees: number;
  expectedMinor: number;
  note: string;
}

export const MONEY_FIXTURES: MoneyFixture[] = [
  { rupees: 0, expectedMinor: 0, note: "genuinely free" },
  { rupees: 30, expectedMinor: 3_000, note: "vada pav" },
  { rupees: 80, expectedMinor: 8_000, note: "filter coffee" },
  { rupees: 250, expectedMinor: 25_000, note: "Colaba Causeway chai" },
  { rupees: 450, expectedMinor: 45_000, note: "Heritage walking tour" },
  { rupees: 750, expectedMinor: 75_000, note: "studio pottery session" },
  { rupees: 1_500, expectedMinor: 150_000, note: "a nicer dinner" },
  { rupees: 2_500, expectedMinor: 250_000, note: "drinking dinner, Bandra West" },
  { rupees: 150_000, expectedMinor: 15_000_000, note: "largest value we would ever print" },
];

export interface DurationFixture {
  minutes: number;
  note: string;
}

export const DURATION_FIXTURES: DurationFixture[] = [
  { minutes: 10, note: "a vada pav, genuinely" },
  { minutes: 20, note: "a taproom round" },
  { minutes: 45, note: "a beach walk, not a swim" },
  { minutes: 60, note: "a market with intent" },
  { minutes: 90, note: "a museum done properly" },
  { minutes: 120, note: "a temple, including shoe removal" },
  { minutes: 180, note: "a cooking class start to finish" },
  { minutes: 240, note: "a full day trip to the hills" },
];
