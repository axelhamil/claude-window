import { describe, expect, it } from "vitest";
import type { Config } from "../src/config.js";
import {
  BACKOFF_BASE_SECONDS,
  BACKOFF_CAP_SECONDS,
  backoffSeconds,
  clock,
  driftSeconds,
  gridTolerance,
  MIN_GRID_TOLERANCE_SECONDS,
  MIN_SLEEP_SECONDS,
  nextStartOfDay,
  onGrid,
  planFor,
  secondsUntilNextProbe,
  withinActiveHours,
} from "../src/scheduling.js";

const everyDay = { anchorMinute: 7 * 60, activeUntilMinute: 23 * 60 };

const config: Config = {
  week: { weekdays: everyDay, weekend: everyDay },
  schedule: null,
  offsetSeconds: 120,
  model: "claude-haiku-4-5-20251001",
  pingUrl: null,
};

function at(hour: number, minute = 0): Date {
  const date = new Date(2026, 7, 14, hour, minute, 0, 0);
  return date;
}

describe("clock", () => {
  it("formats an epoch as zero-padded local HH:MM", () => {
    expect(clock(Math.floor(at(9, 5).getTime() / 1000))).toBe("09:05");
  });

  it("uses 24-hour notation past noon", () => {
    expect(clock(Math.floor(at(22, 30).getTime() / 1000))).toBe("22:30");
  });
});

describe("withinActiveHours", () => {
  it("accepts the exact start hour", () => {
    expect(withinActiveHours(config, at(7))).toBe(true);
  });

  it("rejects the exact end hour", () => {
    expect(withinActiveHours(config, at(23))).toBe(false);
  });

  it("rejects the small hours", () => {
    expect(withinActiveHours(config, at(3))).toBe(false);
  });

  it("accepts a moment inside the range", () => {
    expect(withinActiveHours(config, at(15, 34))).toBe(true);
  });
});

describe("nextStartOfDay", () => {
  it("targets today when the anchor is still ahead", () => {
    const target = new Date(nextStartOfDay(config, at(3)) * 1000);
    expect(target.getDate()).toBe(14);
    expect(target.getHours()).toBe(7);
  });

  it("rolls over to tomorrow once the anchor has passed", () => {
    const target = new Date(nextStartOfDay(config, at(18)) * 1000);
    expect(target.getDate()).toBe(15);
    expect(target.getHours()).toBe(7);
  });

  it("rolls over when called exactly on the anchor", () => {
    const target = new Date(nextStartOfDay(config, at(7)) * 1000);
    expect(target.getDate()).toBe(15);
  });
});

describe("with working hours on weekdays only", () => {
  const workday = { anchorMinute: 5 * 60 + 30, activeUntilMinute: 17 * 60 };
  const office: Config = { ...config, week: { weekdays: workday, weekend: null } };
  const saturday = new Date(2026, 7, 15, 10, 0, 0, 0);

  it("uses the weekday plan on a friday and none on a saturday", () => {
    expect(planFor(office, at(10))).toBe(workday);
    expect(planFor(office, saturday)).toBeNull();
  });

  it("anchors at the planned minute", () => {
    const target = new Date(nextStartOfDay(office, at(3)) * 1000);
    expect(target.getHours()).toBe(5);
    expect(target.getMinutes()).toBe(30);
  });

  it("sleeps through the weekend from friday evening to monday morning", () => {
    const target = new Date(nextStartOfDay(office, at(18)) * 1000);
    expect(target.getDay()).toBe(1);
    expect(target.getDate()).toBe(17);
    expect(target.getHours()).toBe(5);
    expect(target.getMinutes()).toBe(30);
  });

  it("is never active on a day off", () => {
    expect(withinActiveHours(office, saturday)).toBe(false);
  });

  it("stops being active once the last planned reset has been opened", () => {
    expect(withinActiveHours(office, at(16, 59))).toBe(true);
    expect(withinActiveHours(office, at(17))).toBe(false);
  });

  it("measures drift against the minute-level anchor", () => {
    expect(driftSeconds(epoch(10, 30), office)).toBe(0);
    expect(driftSeconds(epoch(15, 34), office)).toBe(240);
  });

  it("has no grid when no nearby day has working hours", () => {
    const weekendOnly: Config = { ...config, week: { weekdays: null, weekend: workday } };
    const wednesday = Math.floor(new Date(2026, 7, 19, 12, 0, 0, 0).getTime() / 1000);
    expect(driftSeconds(wednesday, weekendOnly)).toBeNull();
    expect(onGrid(wednesday, weekendOnly)).toBeNull();
  });

  it("refuses to plan a week without any working day", () => {
    const never: Config = { ...config, week: { weekdays: null, weekend: null } };
    expect(() => nextStartOfDay(never, at(3))).toThrow("no active day");
  });
});

describe("secondsUntilNextProbe", () => {
  const window = { resetAt: 1786732200, usage5h: 0.3, usage7d: 0.05 };

  it("waits until the reset plus the configured offset", () => {
    const now = (window.resetAt - 3600) * 1000;
    expect(secondsUntilNextProbe(window, config, now)).toBe(3600 + config.offsetSeconds);
  });

  it("never returns less than a minute when the reset is already past", () => {
    const now = (window.resetAt + 7200) * 1000;
    expect(secondsUntilNextProbe(window, config, now)).toBe(60);
  });

  it("never returns a negative delay on a skewed clock", () => {
    const now = (window.resetAt + 86400) * 1000;
    expect(secondsUntilNextProbe(window, config, now)).toBeGreaterThan(0);
  });

  it("returns the real remaining delay while it stays above the floor", () => {
    const now = (window.resetAt + 30) * 1000;
    expect(secondsUntilNextProbe(window, config, now)).toBe(90);
  });

  it("clamps once less than a minute remains", () => {
    const now = (window.resetAt + 90) * 1000;
    expect(secondsUntilNextProbe(window, config, now)).toBe(60);
  });
});

function epoch(hour: number, minute = 0): number {
  return Math.floor(at(hour, minute).getTime() / 1000);
}

describe("driftSeconds", () => {
  it("is zero on an exact grid slot", () => {
    expect(driftSeconds(epoch(12, 0), config)).toBe(0);
  });

  it("is positive when the reset runs late", () => {
    expect(driftSeconds(epoch(12, 5), config)).toBe(300);
  });

  it("is negative when the reset runs early", () => {
    expect(driftSeconds(epoch(11, 55), config)).toBe(-300);
  });

  it("measures against the nearest slot, not the first one", () => {
    expect(driftSeconds(epoch(17, 1), config)).toBe(60);
  });

  it("ignores the probe offset, which delays the probe and not the reset", () => {
    const shifted = { ...config, offsetSeconds: 600 };
    expect(driftSeconds(epoch(12, 0), shifted)).toBe(0);
  });

  it("compares a reset just after midnight to the evening slot", () => {
    const justAfterMidnight = Math.floor(new Date(2026, 7, 15, 0, 2, 0, 0).getTime() / 1000);
    expect(driftSeconds(justAfterMidnight, config)).toBe(7320);
  });

  it("follows the configured start hour", () => {
    const nine = { anchorMinute: 9 * 60, activeUntilMinute: 23 * 60 };
    const shifted = { ...config, week: { weekdays: nine, weekend: nine } };
    expect(driftSeconds(epoch(14, 0), shifted)).toBe(0);
  });
});

describe("onGrid", () => {
  it("accepts a reset inside the tolerance", () => {
    expect(onGrid(epoch(12, 6), config)).toBe(true);
  });

  it("accepts the reset observed in production, a probe at 17:02 resetting at 22:00", () => {
    expect(onGrid(epoch(22, 0), config)).toBe(true);
  });

  it("accepts the tolerance boundary itself", () => {
    expect(onGrid(epoch(12, 15), config)).toBe(true);
  });

  it("rejects a reset past the tolerance", () => {
    expect(onGrid(epoch(12, 40), config)).toBe(false);
  });

  it("rejects a reset that drifted early past the tolerance", () => {
    expect(onGrid(epoch(11, 20), config)).toBe(false);
  });

  it("widens the tolerance for a large offset so accumulated drift is not a false positive", () => {
    const wideOffset: Config = { ...config, offsetSeconds: 600 };
    expect(onGrid(epoch(12, 30), wideOffset)).toBe(true);
  });
});

describe("gridTolerance", () => {
  it("stays at the 15-minute floor for the default offset", () => {
    expect(gridTolerance(config)).toBe(MIN_GRID_TOLERANCE_SECONDS);
  });

  it("widens to four times the offset once that exceeds the floor", () => {
    const wideOffset: Config = { ...config, offsetSeconds: 600 };
    expect(gridTolerance(wideOffset)).toBe(2400);
  });
});

describe("backoffSeconds", () => {
  const always = (value: number) => () => value;

  it("never sleeps less than the floor", () => {
    expect(backoffSeconds(1, null, always(0))).toBe(MIN_SLEEP_SECONDS);
  });

  it("spreads the first attempt over the base delay", () => {
    expect(backoffSeconds(1, null, always(1))).toBe(BACKOFF_BASE_SECONDS * 2);
  });

  it("doubles the ceiling on every attempt", () => {
    expect(backoffSeconds(3, null, always(1))).toBe(BACKOFF_BASE_SECONDS * 8);
  });

  it("stops growing at the cap", () => {
    expect(backoffSeconds(20, null, always(1))).toBe(BACKOFF_CAP_SECONDS);
  });

  it("jitters between the floor and the ceiling", () => {
    const value = backoffSeconds(4, null, always(0.5));
    expect(value).toBeGreaterThanOrEqual(MIN_SLEEP_SECONDS);
    expect(value).toBeLessThanOrEqual(BACKOFF_CAP_SECONDS);
  });

  it("obeys Retry-After when it asks for longer", () => {
    expect(backoffSeconds(1, 3600, always(0))).toBe(3600);
  });

  it("ignores Retry-After when the backoff already waits longer", () => {
    expect(backoffSeconds(20, 10, always(1))).toBe(BACKOFF_CAP_SECONDS);
  });
});
