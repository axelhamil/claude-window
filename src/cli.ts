#!/usr/bin/env node
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import pkg from "../package.json" with { type: "json" };
import { type Config, loadConfig, loadToken } from "./config.js";
import { anchor, createPorts, runDaemon } from "./daemon.js";
import { readRecords } from "./history.js";
import { configDir, scheduleFile, stateFile, tokenFile } from "./paths.js";
import { describePlan, planDay, type Range } from "./planner.js";
import { historyLines, statusJson, statusLines } from "./render.js";
import { loadSchedule, type Schedule, saveSchedule, scheduleFromArgs } from "./schedule.js";
import { serviceManager } from "./service/manager.js";
import { readSnapshot } from "./state.js";
import { askSchedule } from "./wizard.js";

const VERSION = pkg.version;
const CONFIG_RETRY_SECONDS = 600;

const USAGE = `claude-window ${VERSION}

  claude-window login <token>   store a sk-ant-oat token
  claude-window schedule        set your working hours, asks interactively
  claude-window schedule --weekdays <range> --weekend <range|off>
                                same without questions, e.g. --weekdays 9-17 --weekend off
  claude-window install         register the background service
  claude-window uninstall       remove it
  claude-window status [--json] last known window, costs nothing
  claude-window history [--limit <n>] [--json]
                                what the daemon has anchored so far
  claude-window once            probe now and exit
  claude-window daemon          run in the foreground
  claude-window version
`;

function hasFlag(args: string[], flag: string): boolean {
  return args.includes(flag);
}

function login(token: string | undefined): void {
  const value = token?.replace(/\s+/g, "");
  if (!value?.startsWith("sk-ant-oat")) {
    throw new Error(
      'expected a token starting with "sk-ant-oat", get one with: claude setup-token',
    );
  }

  const path = tokenFile();
  mkdirSync(configDir(), { recursive: true });
  writeFileSync(path, `${value}\n`, { encoding: "utf8", mode: 0o600 });
  chmodSync(path, 0o600);
  console.log(`token stored in ${path}`);
}

function reasonOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function loadSettings(): { config: Config; scheduleError: string | null } {
  try {
    return { config: loadConfig(loadSchedule()), scheduleError: null };
  } catch (error) {
    const unscheduled = loadConfig(null);
    return {
      config: { ...unscheduled, week: { weekdays: null, weekend: null } },
      scheduleError: reasonOf(error),
    };
  }
}

async function loadDaemonConfig(signal: AbortSignal): Promise<Config | null> {
  while (!signal.aborted) {
    try {
      return loadConfig(loadSchedule());
    } catch (error) {
      process.stderr.write(
        `${reasonOf(error)}\nretrying in ${CONFIG_RETRY_SECONDS}s, fix it with: claude-window schedule\n`,
      );
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, CONFIG_RETRY_SECONDS * 1000);
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
  }
  return null;
}

function showStatus(args: string[]): void {
  const manager = serviceManager();
  const service = { name: manager.name, status: manager.status() };
  const snapshot = readSnapshot();
  const { config, scheduleError } = loadSettings();

  if (hasFlag(args, "--json")) {
    console.log(statusJson(snapshot, service, config, scheduleError));
    return;
  }
  for (const line of statusLines(snapshot, service, config, scheduleError)) console.log(line);
  if (snapshot === null) console.log(`(${stateFile()})`);
}

function warnAbout(label: string, range: Range | null, offsetSeconds: number): void {
  if (range === null) return;

  const plan = planDay(range, offsetSeconds);
  if (plan.clamped) {
    process.stderr.write(
      `warning: ${label} hours start too early to anchor the day before, anchoring at 00:00\n`,
    );
  }
  if (plan.partial) {
    process.stderr.write(
      `warning: ${label} hours are longer than the windows one day can chain, ` +
        "the edges of the range are not covered\n",
    );
  }
}

function currentSchedule(): Schedule | null {
  try {
    return loadSchedule();
  } catch (error) {
    process.stderr.write(`warning: ignoring the current schedule, ${reasonOf(error)}\n`);
    return null;
  }
}

function restartService(): void {
  const service = serviceManager();

  let restarted: boolean;
  try {
    restarted = service.restart();
  } catch (error) {
    throw new Error(
      `schedule saved, but restarting the ${service.name} service failed: ${reasonOf(error)}\n` +
        'restart it by hand, or run "claude-window install" again',
    );
  }

  console.log(
    restarted
      ? `${service.name} service restarted with the new schedule`
      : 'service not installed yet, run "claude-window install" to start anchoring',
  );
}

async function setSchedule(args: string[]): Promise<void> {
  const fromArgs = scheduleFromArgs(args, currentSchedule());
  if (fromArgs === null && !process.stdin.isTTY) {
    throw new Error(
      "no terminal to ask questions, pass the hours instead: " +
        "claude-window schedule --weekdays 9-17 --weekend off",
    );
  }

  const schedule = fromArgs ?? (await askSchedule());
  const { offsetSeconds } = loadConfig(schedule);
  saveSchedule(schedule);

  console.log(`schedule saved to ${scheduleFile()}`);
  console.log(`weekdays ${describePlan(schedule.weekdays, offsetSeconds)}`);
  console.log(`weekend  ${describePlan(schedule.weekend, offsetSeconds)}`);
  warnAbout("weekday", schedule.weekdays, offsetSeconds);
  warnAbout("weekend", schedule.weekend, offsetSeconds);

  restartService();
}

function showHistory(args: string[]): void {
  const limitIndex = args.indexOf("--limit");
  const limit = limitIndex === -1 ? 20 : Number(args[limitIndex + 1]);
  if (!Number.isInteger(limit) || limit <= 0) {
    throw new Error("--limit expects a positive integer");
  }

  const records = readRecords().slice(-limit);

  if (hasFlag(args, "--json")) {
    for (const record of records) console.log(JSON.stringify(record));
    return;
  }
  const { config, scheduleError } = loadSettings();
  if (scheduleError !== null) process.stderr.write(`schedule INVALID: ${scheduleError}\n`);
  for (const line of historyLines(records, config)) console.log(line);
}

async function main(argv: string[]): Promise<number> {
  const [command = "help", ...rest] = argv;

  switch (command) {
    case "login":
      login(rest[0]);
      return 0;

    case "install": {
      const service = serviceManager();
      service.install();
      console.log(`registered with ${service.name}, status: ${service.status()}`);
      return 0;
    }

    case "uninstall": {
      const service = serviceManager();
      service.uninstall();
      console.log(`removed from ${service.name}`);
      return 0;
    }

    case "schedule":
      await setSchedule(rest);
      return 0;

    case "status":
      showStatus(rest);
      return 0;

    case "history":
      showHistory(rest);
      return 0;

    case "once": {
      const config = loadConfig(loadSchedule());
      await anchor(loadToken(), config, createPorts(config));
      return 0;
    }

    case "daemon": {
      const controller = new AbortController();
      for (const signal of ["SIGINT", "SIGTERM"] as const) {
        process.on(signal, () => controller.abort());
      }
      const config = await loadDaemonConfig(controller.signal);
      if (config === null) return 0;
      await runDaemon(loadToken(), config, controller.signal, createPorts(config));
      return 0;
    }

    case "version":
      console.log(`claude-window ${VERSION}`);
      return 0;

    case "help":
    case "--help":
    case "-h":
      console.log(USAGE);
      return 0;

    default:
      process.stderr.write(`unknown command: ${command}\n\n${USAGE}`);
      return 2;
  }
}

main(process.argv.slice(2))
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
