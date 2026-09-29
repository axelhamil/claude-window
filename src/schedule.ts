import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { scheduleFile } from "./paths.js";
import { formatRange, parseRange, type Range } from "./planner.js";

export interface Schedule {
  weekdays: Range | null;
  weekend: Range | null;
}

function readRange(key: keyof Schedule, raw: unknown, path: string): Range | null {
  if (raw === null) return null;

  if (typeof raw !== "string") {
    throw new Error(`${path} is invalid (${key}: expected a range like "09:00-17:00" or null)`);
  }
  try {
    return parseRange(raw);
  } catch (cause) {
    throw new Error(`${path} is invalid (${key}: ${(cause as Error).message})`, { cause });
  }
}

export function validateSchedule(schedule: Schedule): Schedule {
  if (schedule.weekdays === null && schedule.weekend === null) {
    throw new Error("the schedule needs working hours on weekdays, on the weekend, or both");
  }
  return schedule;
}

export function loadSchedule(path = scheduleFile()): Schedule | null {
  let contents: string;
  try {
    contents = readFileSync(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(contents);
  } catch (cause) {
    throw new Error(`${path} is not valid json, run "claude-window schedule" to rewrite it`, {
      cause,
    });
  }
  if (typeof parsed !== "object" || parsed === null) {
    throw new Error(`${path} is invalid, run "claude-window schedule" to rewrite it`);
  }

  const { weekdays, weekend } = parsed as Record<string, unknown>;
  return validateSchedule({
    weekdays: readRange("weekdays", weekdays ?? null, path),
    weekend: readRange("weekend", weekend ?? null, path),
  });
}

export function saveSchedule(schedule: Schedule, path = scheduleFile()): void {
  const serialised = {
    weekdays: schedule.weekdays && formatRange(schedule.weekdays),
    weekend: schedule.weekend && formatRange(schedule.weekend),
  };

  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(serialised, null, 2)}\n`, "utf8");
  renameSync(temporary, path);
}
