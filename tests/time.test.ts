import { describe, it, expect } from "vitest";
import {
  MINUTES_PER_DAY,
  CityClock,
  MUMBAI,
  parseClock,
  bucketOf,
  windowsOverlap,
  windowFitsWithin,
  windowLength,
  spanMinutes,
  formatDuration,
  weekdayOf,
  assertMinutes,
} from "../src/lib/time";
import { DURATION_FIXTURES } from "./fixtures";

describe("time: integer minutes from local midnight", () => {
  it("parses HH:MM", () => {
    expect(parseClock("09:30")).toBe(570);
    expect(parseClock("00:00")).toBe(0);
    expect(parseClock("23:59")).toBe(1439);
    expect(parseClock("9:05")).toBe(545);
  });

  it("rejects malformed clock strings rather than guessing", () => {
    expect(() => parseClock("930")).toThrow(/HH:MM/);
    expect(() => parseClock("09:60")).toThrow(/out of range/);
    expect(() => parseClock("25:00")).toThrow(/out of range/);
    expect(() => parseClock("")).toThrow();
  });

  it("pins Mumbai at UTC+05:30 with no DST", () => {
    expect(MUMBAI.utcOffsetMinutes).toBe(330);
    expect(MUMBAI.timezone).toBe("Asia/Kolkata");
  });

  it("converts a UTC instant to Mumbai wall-clock minutes", () => {
    // 03:30 UTC is 09:00 IST. This is the assertion that would break if we ever
    // accidentally used the server's timezone instead of the city's.
    const clock = new CityClock("Asia/Kolkata", 330);
    const utcInstant = new Date("2026-01-05T03:30:00.000Z");
    expect(clock.fromDate(utcInstant)).toBe(9 * 60);
  });

  it("gives the same answer regardless of where the code runs", () => {
    // The whole point of CityClock: a traveller in London and a shop in Colaba
    // must agree on when the door is open.
    const clock = new CityClock("Asia/Kolkata", 330);
    const istNoon = clock.toDate(12 * 60, new Date("2026-01-05T00:00:00.000Z"));
    expect(istNoon.toISOString()).toBe("2026-01-05T06:30:00.000Z");
    expect(clock.fromDate(istNoon)).toBe(12 * 60);
  });

  it("formats back to HH:MM", () => {
    expect(MUMBAI.format(570)).toBe("09:30");
    expect(MUMBAI.format(0)).toBe("00:00");
  });

  it("buckets a wall-clock time for congestion lookup", () => {
    expect(bucketOf(5 * 60)).toBe("early_morning");
    expect(bucketOf(8 * 60)).toBe("morning");
    expect(bucketOf(14 * 60)).toBe("afternoon");
    expect(bucketOf(19 * 60)).toBe("evening");
    expect(bucketOf(22 * 60)).toBe("night");
  });

  it("detects overlap, which is weaker than containment", () => {
    // Overlap is NOT sufficient for the gate. A 17:30 arrival with 60 minutes
    // left overlaps a 09:00-18:00 shop but is not served by it.
    expect(windowsOverlap(9 * 60, 18 * 60, 10 * 60, 13 * 60)).toBe(true);
    expect(windowsOverlap(9 * 60, 18 * 60, 17 * 60 + 30, 18 * 60 + 30)).toBe(true);
    expect(windowsOverlap(9 * 60, 18 * 60, 19 * 60, 20 * 60)).toBe(false);
  });

  it("requires FULL containment, rejecting a late arrival", () => {
    // This is the assertion the gate depends on.
    expect(windowFitsWithin(9 * 60, 18 * 60, 10 * 60, 13 * 60)).toBe(true);
    expect(windowFitsWithin(9 * 60, 18 * 60, 17 * 60 + 30, 18 * 60 + 30)).toBe(false);
    expect(windowFitsWithin(9 * 60, 18 * 60, 8 * 60, 13 * 60)).toBe(false);
  });

  it("treats an empty window as fitting nothing", () => {
    expect(windowFitsWithin(0, 1440, 600, 600)).toBe(false);
    expect(windowsOverlap(0, 1440, 600, 600)).toBe(false);
  });

  it("handles a window that wraps past midnight", () => {
    // A night-out plan starting 23:00 and ending 01:00. Both halves must be
    // covered by the venue, not just the first.
    expect(windowFitsWithin(22 * 60, 2 * 60, 23 * 60, 60)).toBe(true);
    expect(windowFitsWithin(22 * 60, 2 * 60, 23 * 60, 3 * 60)).toBe(false); // runs 1h past the 02:00 close
    expect(windowsOverlap(22 * 60, 2 * 60, 1 * 60, 3 * 60)).toBe(true);
    expect(windowsOverlap(22 * 60, 2 * 60, 3 * 60, 4 * 60)).toBe(false);
  });

  it("measures the length of a wrapping window", () => {
    expect(windowLength(9 * 60, 18 * 60)).toBe(540);
    expect(windowLength(23 * 60, 60)).toBe(120);
    expect(windowLength(22 * 60, 2 * 60)).toBe(240);
  });

  it("measures the span of a wrapping interval", () => {
    expect(spanMinutes(9 * 60, 18 * 60)).toBe(540);
    expect(spanMinutes(22 * 60, 2 * 60)).toBe(240);
  });

  it("formats durations the way a human would say them", () => {
    expect(formatDuration(45)).toBe("45 min");
    expect(formatDuration(60)).toBe("1 hr");
    expect(formatDuration(90)).toBe("1 hr 30 min");
    expect(formatDuration(0)).toBe("0 min");
  });

  it("maps a date to an OSM-ordered weekday index", () => {
    // OSM is Mo..Su, JS is Su..Sa. An off-by-one here silently breaks every
    // weekday's hours.
    expect(weekdayOf(new Date("2026-01-05T00:00:00Z"))).toBe(0); // Monday
    expect(weekdayOf(new Date("2026-01-11T00:00:00Z"))).toBe(6); // Sunday
  });

  it("rejects out-of-range and non-integer minutes", () => {
    expect(() => assertMinutes(-1)).toThrow();
    expect(() => assertMinutes(MINUTES_PER_DAY + 1)).toThrow();
    expect(() => assertMinutes(90.5)).toThrow(/integer/);
    expect(() => assertMinutes(90)).not.toThrow();
  });

  it("accepts every curated duration fixture", () => {
    for (const fixture of DURATION_FIXTURES) {
      expect(Number.isInteger(fixture.minutes)).toBe(true);
      expect(fixture.minutes).toBeGreaterThan(0);
    }
  });
});
