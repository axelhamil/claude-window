import { describe, expect, it } from "vitest";
import type { Config } from "../src/config.js";
import { clock, nextStartOfDay, secondsUntilNextProbe, withinActiveHours } from "../src/daemon.js";

const config: Config = {
  startHour: 7,
  endHour: 23,
  offsetSeconds: 120,
  model: "claude-haiku-4-5-20251001",
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
    const target = new Date(nextStartOfDay(7, at(3)) * 1000);
    expect(target.getDate()).toBe(14);
    expect(target.getHours()).toBe(7);
  });

  it("rolls over to tomorrow once the anchor has passed", () => {
    const target = new Date(nextStartOfDay(7, at(18)) * 1000);
    expect(target.getDate()).toBe(15);
    expect(target.getHours()).toBe(7);
  });

  it("rolls over when called exactly on the anchor", () => {
    const target = new Date(nextStartOfDay(7, at(7)) * 1000);
    expect(target.getDate()).toBe(15);
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
