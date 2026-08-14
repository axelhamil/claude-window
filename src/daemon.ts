import type { Config } from "./config.js";
import { saveSnapshot } from "./state.js";
import { fetchWindow, type RateLimitWindow, windowStart } from "./window.js";

const RETRY_SECONDS = 300;

export function clock(epochSeconds: number): string {
  return new Date(epochSeconds * 1000).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
}

export function log(message: string): void {
  process.stderr.write(`${clock(Math.floor(Date.now() / 1000))} ${message}\n`);
}

function sleep(seconds: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, seconds * 1000);
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
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

export async function anchor(token: string, config: Config): Promise<RateLimitWindow> {
  const window = await fetchWindow(token, config.model);
  saveSnapshot(window);
  log(
    `anchored ${clock(windowStart(window))}->${clock(window.resetAt)} ` +
      `usage5=${window.usage5h} usage7=${window.usage7d}`,
  );
  return window;
}

export async function runDaemon(token: string, config: Config, signal: AbortSignal): Promise<void> {
  while (!signal.aborted) {
    if (!withinActiveHours(config)) {
      const wakeAt = nextStartOfDay(config.startHour);
      log(`outside active hours, sleeping until ${clock(wakeAt)}`);
      await sleep(wakeAt - Math.floor(Date.now() / 1000), signal);
      continue;
    }

    try {
      const window = await anchor(token, config);
      const wakeAt = window.resetAt + config.offsetSeconds;
      log(`sleeping until ${clock(wakeAt)}`);
      await sleep(wakeAt - Math.floor(Date.now() / 1000), signal);
    } catch (error) {
      log(`probe failed: ${error instanceof Error ? error.message : String(error)}`);
      log(`retrying in ${RETRY_SECONDS}s`);
      await sleep(RETRY_SECONDS, signal);
    }
  }
}
