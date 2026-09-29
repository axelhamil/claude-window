import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadSchedule, saveSchedule, validateSchedule } from "../src/schedule.js";

let dir: string;
let path: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "claude-window-"));
  path = join(dir, "nested", "schedule.json");
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const schedule = { weekdays: { start: 540, end: 1020 }, weekend: null };

describe("saveSchedule", () => {
  it("writes readable ranges a human can edit", () => {
    saveSchedule(schedule, path);
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({
      weekdays: "09:00-17:00",
      weekend: null,
    });
  });

  it("round-trips through loadSchedule", () => {
    saveSchedule(schedule, path);
    expect(loadSchedule(path)).toEqual(schedule);
  });
});

describe("loadSchedule", () => {
  it("returns null when nothing was scheduled yet", () => {
    expect(loadSchedule(join(dir, "missing.json"))).toBeNull();
  });

  it("accepts off and a missing key as a day off", () => {
    const file = join(dir, "schedule.json");
    writeFileSync(file, JSON.stringify({ weekdays: "9-17", weekend: "off" }), "utf8");
    expect(loadSchedule(file)).toEqual(schedule);

    writeFileSync(file, JSON.stringify({ weekdays: "9-17" }), "utf8");
    expect(loadSchedule(file)).toEqual(schedule);
  });

  it("names the file and the key when a range is wrong", () => {
    const file = join(dir, "schedule.json");
    writeFileSync(file, JSON.stringify({ weekdays: "17-9", weekend: null }), "utf8");
    expect(() => loadSchedule(file)).toThrow(`${file} is invalid (weekdays:`);
  });

  it("rejects a range that is not a string", () => {
    const file = join(dir, "schedule.json");
    writeFileSync(file, JSON.stringify({ weekdays: 9, weekend: null }), "utf8");
    expect(() => loadSchedule(file)).toThrow("expected a range");
  });

  it("explains how to fix a corrupted file", () => {
    const file = join(dir, "schedule.json");
    writeFileSync(file, "{ nope", "utf8");
    expect(() => loadSchedule(file)).toThrow('run "claude-window schedule"');
  });

  it("rejects a schedule without any working hours", () => {
    const file = join(dir, "schedule.json");
    writeFileSync(file, JSON.stringify({ weekdays: "off", weekend: "off" }), "utf8");
    expect(() => loadSchedule(file)).toThrow("needs working hours");
  });
});

describe("validateSchedule", () => {
  it("lets a weekend-only schedule through", () => {
    const weekendOnly = { weekdays: null, weekend: { start: 600, end: 1080 } };
    expect(validateSchedule(weekendOnly)).toBe(weekendOnly);
  });
});
