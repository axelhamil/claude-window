#!/usr/bin/env node
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import pkg from "../package.json" with { type: "json" };
import { loadConfig, loadToken } from "./config.js";
import { anchor, createPorts, runDaemon } from "./daemon.js";
import { readRecords } from "./history.js";
import { configDir, stateFile, tokenFile } from "./paths.js";
import { historyLines, statusJson, statusLines } from "./render.js";
import { serviceManager } from "./service/manager.js";
import { readSnapshot } from "./state.js";

const VERSION = pkg.version;

const USAGE = `claude-window ${VERSION}

  claude-window login <token>   store a sk-ant-oat token
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
