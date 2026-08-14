#!/usr/bin/env node
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import pkg from "../package.json" with { type: "json" };
import { loadConfig, loadToken } from "./config.js";
import { anchor, runDaemon } from "./daemon.js";
import { configDir, stateFile, tokenFile } from "./paths.js";
import { clock } from "./scheduling.js";
import { serviceManager } from "./service/manager.js";
import { readSnapshot } from "./state.js";

const VERSION = pkg.version;

const USAGE = `claude-window ${VERSION}

  claude-window login <token>   store a sk-ant-oat token
  claude-window install         register the background service
  claude-window uninstall       remove it
  claude-window status          last known window, costs nothing
  claude-window once            probe now and exit
  claude-window daemon          run in the foreground
  claude-window version
`;

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

function showStatus(): void {
  const service = serviceManager();
  console.log(`service (${service.name}): ${service.status()}`);

  const snapshot = readSnapshot();
  if (!snapshot) {
    console.log(`no probe recorded yet (${stateFile()})`);
    return;
  }

  const minutes = Math.round((snapshot.resetAt - Date.now() / 1000) / 60);
  const when = minutes >= 0 ? `in ${minutes} min` : `${-minutes} min ago`;
  console.log(`window -> reset ${clock(snapshot.resetAt)} (${when})`);
  console.log(`usage 5h ${snapshot.usage5h} | 7d ${snapshot.usage7d}`);
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
      showStatus();
      return 0;

    case "once":
      await anchor(loadToken(), loadConfig());
      return 0;

    case "daemon": {
      const controller = new AbortController();
      for (const signal of ["SIGINT", "SIGTERM"] as const) {
        process.on(signal, () => controller.abort());
      }
      await runDaemon(loadToken(), loadConfig(), controller.signal);
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
