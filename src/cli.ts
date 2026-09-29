#!/usr/bin/env node
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import pkg from "../package.json" with { type: "json" };
import { loadConfig, loadToken } from "./config.js";
import { anchor, createPorts, runDaemon } from "./daemon.js";
import { readRecords } from "./history.js";
import { configDir, scheduleFile, stateFile, tokenFile } from "./paths.js";
import { describePlan, parseRange, planDay, type Range } from "./planner.js";
import { historyLines, statusJson, statusLines } from "./render.js";
import { type Schedule, saveSchedule, validateSchedule } from "./schedule.js";
import { serviceManager } from "./service/manager.js";
import { readSnapshot } from "./state.js";
import { askSchedule } from "./wizard.js";

const VERSION = pkg.version;

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

function showStatus(args: string[]): void {
  const manager = serviceManager();
  const service = { name: manager.name, status: manager.status() };
  const snapshot = readSnapshot();
  const config = loadConfig();

  if (hasFlag(args, "--json")) {
    console.log(statusJson(snapshot, service, config));
    return;
  }
  for (const line of statusLines(snapshot, service, config)) console.log(line);
  if (snapshot === null) console.log(`(${stateFile()})`);
}

function flagValue(args: string[], flag: string): string | null {
  const index = args.indexOf(flag);
  if (index === -1) return null;

  const value = args[index + 1];
  if (value === undefined || value.startsWith("--")) throw new Error(`${flag} expects a value`);
  return value;
}

function scheduleFromFlags(args: string[]): Schedule | null {
  const weekdays = flagValue(args, "--weekdays");
  const weekend = flagValue(args, "--weekend");
  if (weekdays === null && weekend === null) return null;

  return {
    weekdays: parseRange(weekdays ?? "off"),
    weekend: parseRange(weekend ?? "off"),
  };
}

function warnIfClamped(label: string, range: Range | null): void {
  if (range === null || !planDay(range).clamped) return;

  process.stderr.write(
    `warning: ${label} start too early to anchor before midnight, anchoring at 00:00 instead\n`,
  );
}

async function setSchedule(args: string[]): Promise<void> {
  const fromFlags = scheduleFromFlags(args);
  if (fromFlags === null && !process.stdin.isTTY) {
    throw new Error(
      "no terminal to ask questions, pass the hours instead: " +
        "claude-window schedule --weekdays 9-17 --weekend off",
    );
  }

  const schedule = validateSchedule(fromFlags ?? (await askSchedule()));
  saveSchedule(schedule);

  console.log(`schedule saved to ${scheduleFile()}`);
  console.log(`weekdays ${describePlan(schedule.weekdays)}`);
  console.log(`weekend  ${describePlan(schedule.weekend)}`);
  warnIfClamped("weekday", schedule.weekdays);
  warnIfClamped("weekend", schedule.weekend);

  const service = serviceManager();
  const restarted = service.restart();
  console.log(
    restarted
      ? `${service.name} service restarted with the new schedule`
      : 'service not installed yet, run "claude-window install" to start anchoring',
  );
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
  for (const line of historyLines(records, loadConfig())) console.log(line);
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
      const config = loadConfig();
      await anchor(loadToken(), config, createPorts(config));
      return 0;
    }

    case "daemon": {
      const config = loadConfig();
      const controller = new AbortController();
      for (const signal of ["SIGINT", "SIGTERM"] as const) {
        process.on(signal, () => controller.abort());
      }
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
