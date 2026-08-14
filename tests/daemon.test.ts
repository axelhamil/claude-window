import { describe, expect, it } from "vitest";
import type { Config } from "../src/config.js";
import { clock, nextStartOfDay, withinActiveHours } from "../src/daemon.js";

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
