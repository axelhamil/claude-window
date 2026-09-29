import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
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
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(`${path} is invalid, run "claude-window schedule" to rewrite it`);
  }

  const { weekdays, weekend } = parsed as Record<string, unknown>;
  return validateSchedule({
    weekdays: readRange("weekdays", weekdays ?? null, path),
    weekend: readRange("weekend", weekend ?? null, path),
  });
}

export function serialiseSchedule(schedule: Schedule): Record<keyof Schedule, string | null> {
  return {
    weekdays: schedule.weekdays && formatRange(schedule.weekdays),
    weekend: schedule.weekend && formatRange(schedule.weekend),
  };
}

export function saveSchedule(schedule: Schedule, path = scheduleFile()): void {
  mkdirSync(dirname(path), { recursive: true });

  const temporary = `${path}.${process.pid}.tmp`;
  try {
    writeFileSync(temporary, `${JSON.stringify(serialiseSchedule(schedule), null, 2)}\n`, "utf8");
    renameSync(temporary, path);
  } catch (error) {
    rmSync(temporary, { force: true });
    throw error;
  }
}

const SCHEDULE_FLAGS = new Set(["--weekdays", "--weekend"]);

export function scheduleFromArgs(args: string[], current: Schedule | null): Schedule | null {
  const given: Partial<Record<keyof Schedule, Range | null>> = {};

  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index] ?? "";
    if (!SCHEDULE_FLAGS.has(flag)) {
      throw new Error(
        `unexpected argument "${flag}", expected --weekdays <range> or --weekend <range>`,
      );
    }

    const value = args[index + 1];
    if (value === undefined || value.startsWith("--")) throw new Error(`${flag} expects a value`);

    given[flag === "--weekdays" ? "weekdays" : "weekend"] = parseRange(value);
  }

  if (args.length === 0) return null;

  return validateSchedule({
    weekdays: given.weekdays !== undefined ? given.weekdays : (current?.weekdays ?? null),
    weekend: given.weekend !== undefined ? given.weekend : (current?.weekend ?? null),
  });
}
