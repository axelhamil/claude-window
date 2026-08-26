import type { Config } from "./config.js";
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

export function nextStartOfDay(startHour: number, now = new Date()): number {
  const target = new Date(now);
  target.setHours(startHour, 0, 0, 0);
  if (target <= now) target.setDate(target.getDate() + 1);
  return Math.floor(target.getTime() / 1000);
}

export function withinActiveHours(config: Config, now = new Date()): boolean {
  const hour = now.getHours();
  return hour >= config.startHour && hour < config.endHour;
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
    day.setHours(config.startHour, 0, 0, 0);
    const start = Math.floor(day.getTime() / 1000);

    for (let index = 0; index < SLOTS_PER_DAY; index += 1) {
      slots.push(start + index * WINDOW_SECONDS_5H);
    }
  }
  return slots;
}

export function driftSeconds(resetAt: number, config: Config): number {
  let nearest = 0;
  for (const slot of gridSlots(resetAt, config)) {
    const candidate = resetAt - slot;
    if (nearest === 0 || Math.abs(candidate) < Math.abs(nearest)) nearest = candidate;
    if (nearest === 0) break;
  }
  return nearest;
}

export function gridTolerance(config: Config): number {
  return Math.max(MIN_GRID_TOLERANCE_SECONDS, 4 * config.offsetSeconds);
}

export function onGrid(resetAt: number, config: Config): boolean {
  return Math.abs(driftSeconds(resetAt, config)) <= gridTolerance(config);
}
