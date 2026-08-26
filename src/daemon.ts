import type { Config } from "./config.js";
import { ping } from "./heartbeat.js";
import { appendRecord, type HistoryRecord } from "./history.js";
import {
  backoffSeconds,
  clock,
  driftSeconds,
  nextStartOfDay,
  secondsUntilNextProbe,
  withinActiveHours,
} from "./scheduling.js";
import { saveSnapshot } from "./state.js";
import { fetchWindow, ProbeError, type RateLimitWindow, windowStart } from "./window.js";

export interface DaemonPorts {
  probe(token: string, model: string): Promise<RateLimitWindow>;
  persist(window: RateLimitWindow): void;
  record(entry: HistoryRecord): void;
  ping(outcome: "success" | "fail"): Promise<string | null>;
  report(message: string): void;
  wait(seconds: number, signal: AbortSignal): Promise<void>;
  nowSeconds(): number;
  random(): number;
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

export function createPorts(config: Config): DaemonPorts {
  return {
    probe: fetchWindow,
    persist: saveSnapshot,
    record: appendRecord,
    ping: (outcome) => ping(config.pingUrl, outcome),
    report: writeToStderr,
    wait: waitWithTimer,
    nowSeconds: () => Math.floor(Date.now() / 1000),
    random: Math.random,
  };
}

export async function anchor(
  token: string,
  config: Config,
  ports: DaemonPorts,
): Promise<RateLimitWindow> {
  const window = await ports.probe(token, config.model);
  ports.persist(window);

  const drift = driftSeconds(window.resetAt, config);
  ports.record({
    event: "anchor",
    at: ports.nowSeconds(),
    resetAt: window.resetAt,
    usage5h: window.usage5h,
    usage7d: window.usage7d,
    drift,
  });
  ports.report(
    `anchored ${clock(windowStart(window))}->${clock(window.resetAt)} ` +
      `usage5=${window.usage5h} usage7=${window.usage7d} drift=${drift}s`,
  );

  const pingError = await ports.ping("success");
  if (pingError) ports.report(pingError);

  return window;
}

export async function runDaemon(
  token: string,
  config: Config,
  signal: AbortSignal,
  ports: DaemonPorts,
): Promise<void> {
  let attempt = 0;

  while (!signal.aborted) {
    if (!withinActiveHours(config)) {
      const wakeAt = nextStartOfDay(config.startHour);
      ports.report(`outside active hours, sleeping until ${clock(wakeAt)}`);
      await ports.wait(wakeAt - ports.nowSeconds(), signal);
      continue;
    }

    try {
      const window = await anchor(token, config, ports);
      attempt = 0;
      const seconds = secondsUntilNextProbe(window, config, ports.nowSeconds() * 1000);
      ports.report(`sleeping ${seconds}s until ${clock(ports.nowSeconds() + seconds)}`);
      await ports.wait(seconds, signal);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      const fatal = error instanceof ProbeError && error.fatal;

      ports.record({ event: "failure", at: ports.nowSeconds(), reason, fatal });
      ports.report(`probe failed: ${reason}`);

      const pingError = await ports.ping("fail");
      if (pingError) ports.report(pingError);

      if (fatal) {
        ports.report("this will not fix itself, refresh the token with: claude setup-token");
        throw error;
      }

      attempt += 1;
      const retryAfter = error instanceof ProbeError ? error.retryAfterSeconds : null;
      const seconds = backoffSeconds(attempt, retryAfter, ports.random);
      ports.report(`retrying in ${seconds}s`);
      await ports.wait(seconds, signal);
    }
  }
}
