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

function reasonOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function safeRecord(ports: DaemonPorts, entry: HistoryRecord): void {
  try {
    ports.record(entry);
  } catch (error) {
    ports.report(`history write failed: ${reasonOf(error)}`);
  }
}

async function safePing(ports: DaemonPorts, outcome: "success" | "fail"): Promise<void> {
  try {
    const pingError = await ports.ping(outcome);
    if (pingError) ports.report(pingError);
  } catch (error) {
    ports.report(`heartbeat ping failed: ${reasonOf(error)}`);
  }
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
  safeRecord(ports, {
    event: "anchor",
    at: ports.nowSeconds(),
    resetAt: window.resetAt,
    usage5h: window.usage5h,
    usage7d: window.usage7d,
    drift,
  });
  const driftLabel = drift === null ? "off schedule" : `${drift}s`;
  ports.report(
    `anchored ${clock(windowStart(window))}->${clock(window.resetAt)} ` +
      `usage5=${window.usage5h} usage7=${window.usage7d} drift=${driftLabel}`,
  );

  await safePing(ports, "success");

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
    const now = new Date(ports.nowSeconds() * 1000);
    if (!withinActiveHours(config, now)) {
      const wakeAt = nextStartOfDay(config, now);
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

      safeRecord(ports, { event: "failure", at: ports.nowSeconds(), reason, fatal });
      ports.report(`probe failed: ${reason}`);

      await safePing(ports, "fail");

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
