import { readFileSync } from "node:fs";
import { tokenFile } from "./paths.js";
import { type DayPlan, planDay } from "./planner.js";
import { loadSchedule, type Schedule } from "./schedule.js";

export interface WeekPlan {
  weekdays: DayPlan | null;
  weekend: DayPlan | null;
}

export interface Config {
  week: WeekPlan;
  schedule: Schedule | null;
  offsetSeconds: number;
  model: string;
  pingUrl: string | null;
}

const DEFAULTS = {
  startHour: 7,
  endHour: 23,
  offsetSeconds: 120,
  model: "claude-haiku-4-5-20251001",
  pingUrl: null,
};

function readInteger(
  name: string,
  raw: string | undefined,
  min: number,
  max: number,
): number | null {
  if (raw === undefined || raw.trim() === "") return null;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(
      `invalid configuration (${name}: expected an integer between ${min} and ${max}, got "${raw}")`,
    );
  }
  return value;
}

function readUrl(name: string, raw: string | undefined): string | null {
  if (raw === undefined || raw.trim() === "") return null;

  const value = raw.trim();
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`invalid configuration (${name}: expected an http(s) url, got "${raw}")`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(`invalid configuration (${name}: expected an http(s) url, got "${raw}")`);
  }
  return value;
}

function legacyWeek(): WeekPlan {
  const startHour =
    readInteger("CLAUDE_WINDOW_START", process.env.CLAUDE_WINDOW_START, 0, 23) ??
    DEFAULTS.startHour;
  const endHour =
    readInteger("CLAUDE_WINDOW_END", process.env.CLAUDE_WINDOW_END, 1, 24) ?? DEFAULTS.endHour;

  if (endHour <= startHour) {
    throw new Error("CLAUDE_WINDOW_END must be greater than CLAUDE_WINDOW_START");
  }

  const everyDay = { anchorMinute: startHour * 60, activeUntilMinute: endHour * 60 };
  return { weekdays: everyDay, weekend: everyDay };
}

function scheduledWeek(schedule: Schedule): WeekPlan {
  return {
    weekdays: schedule.weekdays && planDay(schedule.weekdays),
    weekend: schedule.weekend && planDay(schedule.weekend),
  };
}

export function loadConfig(schedule: Schedule | null = loadSchedule()): Config {
  const offsetSeconds = readInteger(
    "CLAUDE_WINDOW_OFFSET",
    process.env.CLAUDE_WINDOW_OFFSET,
    0,
    3600,
  );
  const model = process.env.CLAUDE_WINDOW_MODEL?.trim();
  const pingUrl = readUrl("CLAUDE_WINDOW_PING_URL", process.env.CLAUDE_WINDOW_PING_URL);

  return {
    week: schedule === null ? legacyWeek() : scheduledWeek(schedule),
    schedule,
    offsetSeconds: offsetSeconds ?? DEFAULTS.offsetSeconds,
    model: model || DEFAULTS.model,
    pingUrl: pingUrl ?? DEFAULTS.pingUrl,
  };
}

export function loadToken(): string {
  const fromEnv = process.env.CLAUDE_CODE_OAUTH_TOKEN?.trim();
  if (fromEnv) return fromEnv;

  const path = tokenFile();
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (cause) {
    throw new Error('no token found. run "claude-window login" or set CLAUDE_CODE_OAUTH_TOKEN', {
      cause,
    });
  }

  const token = raw.replace(/\s+/g, "");
  if (!token.startsWith("sk-ant-oat")) {
    throw new Error(`${path} does not contain a valid token (expected sk-ant-oat...)`);
  }
  return token;
}
