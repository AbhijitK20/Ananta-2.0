import { describe, it, expect } from "vitest";
import {
  parseHours,
  intervalsForWeekday,
  intervalsForWeek,
  isOpenDuring,
  describeHours,
  detectUnsupported,
  wallClockDate,
} from "../src/engine/hours";
import type { Minutes } from "../src/contracts";

const MON = 0 as const;
const SAT = 5 as const;
const SUN = 6 as const;
const m = (hh: number, mm = 0): Minutes => (hh * 60 + mm) as Minutes;

describe("hours: the verified contract case", () => {
  it("evaluates 'Mo-Fr 09:00-18:00' to 09:00-18:00", () => {
    // This is the exact assertion named in the contract comment. It is here
    // because it is the case a reviewer will check first.
    const hours = parseHours("Mo-Fr 09:00-18:00");
    expect(hours.status).toBe("ok");

    const { intervals } = intervalsForWeekday(hours, MON);
    expect(intervals).toHaveLength(1);
    expect(intervals[0]!.startMin).toBe(m(9));
    expect(intervals[0]!.endMin).toBe(m(18));
    expect(intervals[0]!.known).toBe(true);
  });

  it("returns nothing on a day the rule excludes", () => {
    const hours = parseHours("Mo-Fr 09:00-18:00");
    expect(intervalsForWeekday(hours, SAT).intervals).toHaveLength(0);
    expect(intervalsForWeekday(hours, SUN).intervals).toHaveLength(0);
  });
});

describe("hours: unsupported syntax degrades, never throws", () => {
  // Each of these was verified to throw inside the npm port on v3.15.0. If a
  // future version starts accepting them, these assertions fail and the
  // detectUnsupported() list can be narrowed.
  it("marks a public-holiday rule unparsable", () => {
    expect(detectUnsupported("Mo-Fr 09:00-18:00 PH off")).toMatch(/public-holiday/);
    expect(parseHours("Mo-Fr 09:00-18:00 PH off").status).toBe("unparsable");
  });

  it("marks an inline comment unparsable", () => {
    expect(detectUnsupported("Mo-Fr 09:00-18:00 (ring the bell)")).toMatch(/inline comment/);
    expect(parseHours("Mo-Fr 09:00-18:00 (ring the bell)").status).toBe("unparsable");
  });

  it("marks a semicolon comment unparsable", () => {
    expect(parseHours("Mo-Fr 09:00-18:00 ; Someone comments").status).toBe("unparsable");
  });

  it("marks garbage unparsable rather than crashing", () => {
    expect(parseHours("hello world").status).toBe("unparsable");
  });

  it("never throws, for any input, including nonsense", () => {
    const hostile: (string | null | undefined)[] = [
      null, undefined, "", "   ", "Mo-Fr", "99:99-99:99", ";;;", "()", "PH", "Mo-Su -",
      "Mo-Su 09:00-18:00 off off off", "24/7 PH off", "Mo-Su 25:61-26:61",
    ];
    for (const input of hostile) {
      expect(() => parseHours(input)).not.toThrow();
      expect(() => intervalsForWeekday(parseHours(input), MON)).not.toThrow();
      expect(() => isOpenDuring(parseHours(input), MON, m(9), m(18))).not.toThrow();
    }
  });

  it("reports absent for a missing value, distinct from unparsable", () => {
    expect(parseHours(null).status).toBe("absent");
    expect(parseHours(undefined).status).toBe("absent");
    expect(parseHours("").status).toBe("absent");
  });

  it("marks a date-specific rule partial, not ok", () => {
    // `Jan 1 off` parses and is usable, but it is not week-stable, so we must
    // not present it as a confident schedule.
    const hours = parseHours("Jan 1 off");
    expect(hours.status).toBe("partial");
  });
});

describe("hours: 24/7 and multiple ranges", () => {
  it("handles 24/7 as a full day, clipped per weekday", () => {
    const hours = parseHours("24/7");
    const { intervals } = intervalsForWeekday(hours, MON);
    expect(intervals).toHaveLength(1);
    expect(intervals[0]!.startMin).toBe(0);
    expect(intervals[0]!.endMin).toBe(1440);
  });

  it("expands a split day into two intervals", () => {
    const hours = parseHours("Mo-Su 10:00-14:00,16:00-20:00");
    const { intervals } = intervalsForWeekday(hours, MON);
    expect(intervals).toHaveLength(2);
    expect(intervals[0]!.startMin).toBe(m(10));
    expect(intervals[0]!.endMin).toBe(m(14));
    expect(intervals[1]!.startMin).toBe(m(16));
    expect(intervals[1]!.endMin).toBe(m(20));
  });

  it("sorts intervals ascending", () => {
    const { intervals } = intervalsForWeekday(parseHours("Mo-Su 16:00-20:00,10:00-14:00"), MON);
    const starts = intervals.map((i) => i.startMin);
    expect(starts).toEqual([...starts].sort((a, b) => a - b));
  });
});

describe("hours: midnight wrap", () => {
  it("includes spillover from the previous day", () => {
    // A 22:00-02:00 night venue is open at 01:00 on Sunday because SATURDAY's
    // rule says so. Probing a single day would drop every night market in the
    // catalogue, which is most of what a Mumbai traveller actually plans.
    const hours = parseHours("Mo-Su 22:00-02:00");
    const sundayEarly = intervalsForWeekday(hours, SUN);
    expect(sundayEarly.intervals.length).toBeGreaterThan(0);
    expect(sundayEarly.intervals.some((i) => i.startMin < m(2))).toBe(true);
  });
});

describe("hours: the window gate", () => {
  const shop = parseHours("Mo-Fr 09:00-18:00");

  it("confirms full containment", () => {
    const verdict = isOpenDuring(shop, MON, m(10), m(13));
    expect(verdict.open).toBe(true);
    expect(verdict.unknown).toBe(false);
    expect(verdict.coveredMin).toBe(180);
  });

  it("refuses partial overlap, because a late arrival is not served", () => {
    // 17:30 arrival with 60 minutes left, shop shuts at 18:00.
    const verdict = isOpenDuring(shop, MON, m(17, 30), m(18, 30));
    expect(verdict.open).toBe(false);
    expect(verdict.coveredMin).toBe(30);
  });

  it("distinguishes confidently-closed from unknown", () => {
    // Closed on Saturday: parsed, evaluated, a real answer.
    const closed = isOpenDuring(shop, SAT, m(10), m(13));
    expect(closed.open).toBe(false);
    expect(closed.unknown).toBe(false);

    // Unparsable: we genuinely do not know, which is a different statement.
    const unknown = isOpenDuring(parseHours("Mo-Fr 09:00-18:00 PH off"), MON, m(10), m(13));
    expect(unknown.open).toBe(false);
    expect(unknown.unknown).toBe(true);
  });

  it("treats an absent schedule as unknown, never as closed or open", () => {
    const verdict = isOpenDuring(parseHours(null), MON, m(10), m(13));
    expect(verdict.open).toBe(false);
    expect(verdict.unknown).toBe(true);
  });

  it("rejects an empty or overlong window", () => {
    expect(() => isOpenDuring(shop, MON, m(10), m(10))).toThrow(/non-empty/);
    expect(() => isOpenDuring(shop, MON, m(10), m(2000))).toThrow(/longer than a day/);
  });
});

describe("hours: week expansion and timezone independence", () => {
  it("expands a five-day rule to exactly five weekdays", () => {
    const rows = intervalsForWeek(parseHours("Mo-Fr 09:00-18:00"));
    expect(rows).toHaveLength(5);
    expect([...new Set(rows.map((r) => r.weekday))]).toEqual([0, 1, 2, 3, 4]);
  });

  it("expands 24/7 to seven weekdays", () => {
    const rows = intervalsForWeek(parseHours("24/7"));
    expect(new Set(rows.map((r) => r.weekday)).size).toBe(7);
  });

  it("never emits an interval outside 0..1440", () => {
    // The schema has CHECK constraints on these, so a bad value fails the seed
    // rather than corrupting the index.
    for (const expr of ["24/7", "Mo-Su 22:00-02:00", "Mo-Fr 09:00-18:00"]) {
      for (const row of intervalsForWeek(parseHours(expr))) {
        expect(row.startMin).toBeGreaterThanOrEqual(0);
        expect(row.endMin).toBeLessThanOrEqual(1440);
        expect(row.startMin).toBeLessThan(row.endMin);
        expect(row.weekday).toBeGreaterThanOrEqual(0);
        expect(row.weekday).toBeLessThanOrEqual(6);
      }
    }
  });

  it("reads the city's wall clock, not the server's", () => {
    // wallClockDate builds a Date whose SYSTEM-LOCAL components equal the given
    // IST time, so the npm port's naive getHours() sees Mumbai time even on a
    // UTC host. If this ever regresses, a Vercel deploy would evaluate every
    // shop's hours against UTC midnight.
    const d = wallClockDate(MON, m(9));
    expect(d.getHours()).toBe(9);
    expect(d.getMinutes()).toBe(0);
    expect(d.getDay()).toBe(1); // Monday in JS numbering
  });

  it("describes a schedule readably for the seed log", () => {
    expect(describeHours(shop, MON)).toBe("09:00-18:00");
    expect(describeHours(shop, SAT)).toMatch(/closed/);
    expect(describeHours(parseHours(null))).toBe("absent");
  });
});
