import type { Config } from "./config.js";
import {
  clock,
  nextStartOfDay,
  RETRY_SECONDS,
  secondsUntilNextProbe,
  withinActiveHours,
} from "./scheduling.js";
import { saveSnapshot } from "./state.js";
import { fetchWindow, type RateLimitWindow, windowStart } from "./window.js";

export interface DaemonPorts {
  probe(token: string, model: string): Promise<RateLimitWindow>;
  persist(window: RateLimitWindow): void;
  report(message: string): void;
  wait(seconds: number, signal: AbortSignal): Promise<void>;
  nowSeconds(): number;
}

function writeToStderr(message: string): void {
  process.stderr.write(`${clock(Math.floor(Date.now() / 1000))} ${message}\n`);
}

function waitWithTimer(seconds: number, signal: AbortSignal): Promise<void> {
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

export const defaultPorts: DaemonPorts = {
  probe: fetchWindow,
  persist: saveSnapshot,
  report: writeToStderr,
  wait: waitWithTimer,
  nowSeconds: () => Math.floor(Date.now() / 1000),
};

export async function anchor(
  token: string,
  config: Config,
  ports: DaemonPorts = defaultPorts,
): Promise<RateLimitWindow> {
  const window = await ports.probe(token, config.model);
  ports.persist(window);
  ports.report(
    `anchored ${clock(windowStart(window))}->${clock(window.resetAt)} ` +
      `usage5=${window.usage5h} usage7=${window.usage7d}`,
  );
  return window;
}

export async function runDaemon(
  token: string,
  config: Config,
  signal: AbortSignal,
  ports: DaemonPorts = defaultPorts,
): Promise<void> {
  while (!signal.aborted) {
    if (!withinActiveHours(config)) {
      const wakeAt = nextStartOfDay(config.startHour);
      ports.report(`outside active hours, sleeping until ${clock(wakeAt)}`);
      await ports.wait(wakeAt - ports.nowSeconds(), signal);
      continue;
    }

    try {
      const window = await anchor(token, config, ports);
      const seconds = secondsUntilNextProbe(window, config, ports.nowSeconds() * 1000);
      ports.report(`sleeping ${seconds}s until ${clock(ports.nowSeconds() + seconds)}`);
      await ports.wait(seconds, signal);
    } catch (error) {
      ports.report(`probe failed: ${error instanceof Error ? error.message : String(error)}`);
      ports.report(`retrying in ${RETRY_SECONDS}s`);
      await ports.wait(RETRY_SECONDS, signal);
    }
  }
}
