import type { Config } from "./config.js";
import type { RateLimitWindow } from "./window.js";

export const MIN_SLEEP_SECONDS = 60;
export const RETRY_SECONDS = 300;

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
