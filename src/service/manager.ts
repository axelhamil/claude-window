import { platform } from "node:os";
import { resolve } from "node:path";
import { launchdManager } from "./launchd.js";
import { schtasksManager } from "./schtasks.js";
import { systemdManager } from "./systemd.js";

export interface ServiceManager {
  readonly name: string;
  install(): void;
  uninstall(): void;
  status(): string;
}

function daemonCommand(): { executable: string; args: string[] } {
  const entrypoint = process.argv[1];
  if (!entrypoint) {
    throw new Error("cannot resolve the claude-window entrypoint to register a service");
  }
  return { executable: process.execPath, args: [resolve(entrypoint), "daemon"] };
}

export function serviceManager(): ServiceManager {
  const { executable, args } = daemonCommand();

  switch (platform()) {
    case "darwin":
      return launchdManager(executable, args);
    case "win32":
      return schtasksManager(executable, args);
    case "linux":
      return systemdManager(executable, args);
    default:
      throw new Error(`unsupported platform: ${platform()}`);
  }
}
