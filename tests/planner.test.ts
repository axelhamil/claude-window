import { describe, expect, it } from "vitest";
import {
  ACTIVE_SLACK_MINUTES,
  describePlan,
  formatMinutes,
  MINUTES_PER_DAY,
  maxResets,
  parseRange,
  planDay,
  WINDOW_MINUTES,
} from "../src/planner.js";

const OFFSET = 120;

function hours(value: number): number {
  return value * 60;
}

describe("parseRange", () => {
  it("reads whole hours", () => {
    expect(parseRange("9-17")).toEqual({ start: hours(9), end: hours(17) });
  });

  it("reads minutes with a colon or an h", () => {
    expect(parseRange("9:30-17h45")).toEqual({ start: hours(9) + 30, end: hours(17) + 45 });
  });

  it("reads a trailing h and surrounding spaces", () => {
    expect(parseRange(" 9h - 17h ")).toEqual({ start: hours(9), end: hours(17) });
  });

  it("accepts midnight as the end of the day", () => {
    expect(parseRange("20-24")).toEqual({ start: hours(20), end: hours(24) });
  });

  it("reads off and an empty answer as no working hours", () => {
    expect(parseRange("off")).toBeNull();
    expect(parseRange("OFF")).toBeNull();
    expect(parseRange("")).toBeNull();
  });

  it("rejects a range that ends before it starts", () => {
    expect(() => parseRange("17-9")).toThrow("end must come after the start");
  });

  it("rejects an empty range", () => {
    expect(() => parseRange("9-9")).toThrow("end must come after the start");
  });

  it("rejects an hour outside the clock", () => {
    expect(() => parseRange("9-25")).toThrow("invalid time");
    expect(() => parseRange("9:75-17")).toThrow("invalid time");
    expect(() => parseRange("9-24:30")).toThrow("invalid time");
  });

  it("rejects something that is not a range", () => {
    expect(() => parseRange("nine to five")).toThrow("invalid range");
    expect(() => parseRange("9-12-17")).toThrow("invalid range");
  });
});

describe("planDay", () => {
  it("gives three fresh windows to a 9-17 day, anchoring at 05:30", () => {
    const plan = planDay({ start: hours(9), end: hours(17) }, OFFSET);
    expect(plan.anchorMinute).toBe(hours(5) + 30);
    expect(plan.resets).toEqual([hours(10) + 30, hours(15) + 30]);
    expect(plan.freshWindows).toBe(3);
    expect(plan.clamped).toBe(false);
  });

  it("stays active a little past the last reset so a late probe still opens it", () => {
    const plan = planDay({ start: hours(9), end: hours(17) }, OFFSET);
    expect(plan.activeUntilMinute).toBe(hours(15) + 30 + 2 * (OFFSET / 60) + ACTIVE_SLACK_MINUTES);
  });

  it("stops chaining before the next morning's anchor", () => {
    const plan = planDay({ start: hours(9), end: hours(17) }, OFFSET);
    const lastWindowEnds = (plan.resets.at(-1) ?? 0) + 300;
    expect(lastWindowEnds).toBeLessThan(hours(24) + plan.anchorMinute);
  });

  it("splits a short day with one reset in the middle", () => {
    const plan = planDay({ start: hours(14), end: hours(17) }, OFFSET);
    expect(plan.resets).toEqual([hours(15) + 30]);
    expect(plan.freshWindows).toBe(2);
  });

  it("cannot fit a third window in exactly ten hours", () => {
    const plan = planDay({ start: hours(8), end: hours(18) }, OFFSET);
    expect(plan.resets).toEqual([hours(10) + 30, hours(15) + 30]);
    expect(plan.freshWindows).toBe(3);
  });

  it("drops a reset that would leave a sliver of a few minutes at an edge", () => {
    const plan = planDay({ start: hours(8), end: hours(18) + 10 }, OFFSET);
    expect(plan.freshWindows).toBe(3);
    expect(plan.resets[0]).toBe(hours(10) + 35);
  });

  it("keeps every reset strictly inside the working hours", () => {
    for (let start = 0; start < hours(23); start += 37) {
      for (let end = start + 1; end <= hours(24); end += 53) {
        const plan = planDay({ start, end }, OFFSET);
        for (const reset of plan.resets) {
          expect(reset).toBeGreaterThan(start);
          expect(reset).toBeLessThan(end);
        }
      }
    }
  });

  it("anchors at midnight when the ideal anchor falls the day before", () => {
    const plan = planDay({ start: hours(2), end: hours(6) }, OFFSET);
    expect(plan.anchorMinute).toBe(0);
    expect(plan.clamped).toBe(true);
    expect(plan.resets).toEqual([hours(5)]);
  });

  it("rounds an odd duration to the minute", () => {
    const plan = planDay({ start: hours(9), end: hours(16) + 59 }, OFFSET);
    expect(Number.isInteger(plan.anchorMinute)).toBe(true);
  });
});

describe("planDay across a whole day", () => {
  function nextProbeAfterLastWindow(anchor: number, resets: number, offsetSeconds: number): number {
    return anchor + (resets + 1) * (WINDOW_MINUTES + offsetSeconds / 60);
  }

  it("never chains into the next morning's anchor, whatever the range and offset", () => {
    for (const offsetSeconds of [0, 120, 600, 1800, 3600]) {
      for (let start = 0; start < hours(23); start += 30) {
        for (let end = start + 30; end <= hours(24); end += 30) {
          const plan = planDay({ start, end }, offsetSeconds);
          const probe = nextProbeAfterLastWindow(
            plan.anchorMinute,
            plan.resets.length,
            offsetSeconds,
          );
          expect(probe).toBeLessThan(plan.anchorMinute + MINUTES_PER_DAY);
        }
      }
    }
  });

  it("stays active long enough to open the last planned window despite the offset", () => {
    for (const offsetSeconds of [0, 120, 600, 1800, 3600]) {
      const plan = planDay({ start: hours(9), end: hours(17) }, offsetSeconds);
      const lastOpening =
        plan.anchorMinute + plan.resets.length * (WINDOW_MINUTES + offsetSeconds / 60);
      expect(lastOpening).toBeLessThan(plan.activeUntilMinute);
    }
  });

  it("stops being active before the probe after the last window", () => {
    for (const offsetSeconds of [0, 120, 600, 1800, 3600]) {
      const plan = planDay({ start: hours(6), end: hours(24) }, offsetSeconds);
      const probe = nextProbeAfterLastWindow(plan.anchorMinute, plan.resets.length, offsetSeconds);
      expect(Math.min(probe, MINUTES_PER_DAY)).toBeGreaterThanOrEqual(
        Math.min(plan.activeUntilMinute, MINUTES_PER_DAY),
      );
    }
  });

  it("caps a long day at three resets with the default offset", () => {
    const plan = planDay({ start: hours(6), end: hours(24) }, OFFSET);
    expect(plan.resets).toHaveLength(3);
    expect(plan.freshWindows).toBe(4);
  });

  it("flags a range longer than one day of chained windows", () => {
    expect(planDay({ start: 0, end: hours(24) }, OFFSET).partial).toBe(true);
    expect(planDay({ start: hours(9), end: hours(17) }, OFFSET).partial).toBe(false);
  });

  it("allows fewer resets as the offset grows", () => {
    expect(maxResets(0)).toBe(3);
    expect(maxResets(120)).toBe(3);
    expect(maxResets(3600)).toBe(2);
  });
});

describe("formatMinutes", () => {
  it("pads hours and minutes", () => {
    expect(formatMinutes(hours(5) + 30)).toBe("05:30");
    expect(formatMinutes(hours(24))).toBe("24:00");
  });
});

describe("describePlan", () => {
  it("summarises the anchor, the resets and the fresh windows", () => {
    expect(describePlan({ start: hours(9), end: hours(17) }, OFFSET)).toBe(
      "09:00-17:00 -> anchor 05:30, resets 10:30, 15:30, 3 fresh windows",
    );
  });

  it("uses the singular for a single window", () => {
    expect(describePlan({ start: 0, end: hours(1) }, OFFSET)).toMatch(/1 fresh window$/);
  });

  it("says off for a day without working hours", () => {
    expect(describePlan(null, OFFSET)).toBe("off");
  });
});
