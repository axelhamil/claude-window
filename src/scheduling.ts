import type { Config } from "./config.js";
import type { DayPlan } from "./planner.js";
import type { RateLimitWindow } from "./window.js";

export const MIN_SLEEP_SECONDS = 60;
export const MIN_GRID_TOLERANCE_SECONDS = 900;
export const BACKOFF_BASE_SECONDS = 60;
export const BACKOFF_CAP_SECONDS = 1800;

export function backoffSeconds(
  attempt: number,
  retryAfterSeconds: number | null,
  random: () => number = Math.random,
): number {
  const ceiling = Math.min(BACKOFF_CAP_SECONDS, BACKOFF_BASE_SECONDS * 2 ** attempt);
  const jittered = Math.round(random() * ceiling);
  const backoff = Math.max(MIN_SLEEP_SECONDS, jittered);
  return Math.max(backoff, retryAfterSeconds ?? 0);
}

export function clock(epochSeconds: number): string {
  return new Date(epochSeconds * 1000).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
}

const SEARCH_DAYS = 8;

function isWeekend(date: Date): boolean {
  const day = date.getDay();
  return day === 0 || day === 6;
}

export function planFor(config: Config, date: Date): DayPlan | null {
  return isWeekend(date) ? config.week.weekend : config.week.weekdays;
}

function atMinute(date: Date, minuteOfDay: number): Date {
  const target = new Date(date);
  target.setHours(Math.floor(minuteOfDay / 60), minuteOfDay % 60, 0, 0);
  return target;
}

export function nextStartOfDay(config: Config, now = new Date()): number {
  for (let offset = 0; offset < SEARCH_DAYS; offset += 1) {
    const day = new Date(now);
    day.setDate(day.getDate() + offset);

    const plan = planFor(config, day);
    if (plan === null) continue;

    const target = atMinute(day, plan.anchorMinute);
    if (target > now) return Math.floor(target.getTime() / 1000);
  }
  throw new Error("the schedule has no active day, run claude-window schedule");
}

export function withinActiveHours(config: Config, now = new Date()): boolean {
  const plan = planFor(config, now);
  if (plan === null) return false;

  const minute = now.getHours() * 60 + now.getMinutes();
  return minute >= plan.anchorMinute && minute < plan.activeUntilMinute;
}

export function secondsUntilNextProbe(
  window: RateLimitWindow,
  config: Config,
  now = Date.now(),
): number {
  const wakeAt = window.resetAt + config.offsetSeconds;
  return Math.max(wakeAt - Math.floor(now / 1000), MIN_SLEEP_SECONDS);
}

const WINDOW_SECONDS_5H = 5 * 3600;
const SLOTS_PER_DAY = 5;
const DAY_MS = 86_400_000;

function gridSlots(resetAt: number, config: Config): number[] {
  const slots: number[] = [];

  for (const dayOffset of [-1, 0, 1]) {
    const day = new Date(resetAt * 1000 + dayOffset * DAY_MS);
    const plan = planFor(config, day);
    if (plan === null) continue;

    const start = Math.floor(atMinute(day, plan.anchorMinute).getTime() / 1000);

    for (let index = 0; index < SLOTS_PER_DAY; index += 1) {
      slots.push(start + index * WINDOW_SECONDS_5H);
    }
  }
  return slots;
}

export function driftSeconds(resetAt: number, config: Config): number | null {
  let nearest: number | null = null;

  for (const slot of gridSlots(resetAt, config)) {
    const candidate = resetAt - slot;
    if (nearest === null || Math.abs(candidate) < Math.abs(nearest)) nearest = candidate;
  }
  return nearest;
}

export function gridTolerance(config: Config): number {
  return Math.max(MIN_GRID_TOLERANCE_SECONDS, 4 * config.offsetSeconds);
}

export function onGrid(resetAt: number, config: Config): boolean | null {
  const drift = driftSeconds(resetAt, config);
  if (drift === null) return null;

  return Math.abs(drift) <= gridTolerance(config);
}
