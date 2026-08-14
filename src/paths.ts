import { homedir, platform } from "node:os";
import { join } from "node:path";

const APP = "claude-window";

export function configDir(): string {
  switch (platform()) {
    case "win32":
      return join(process.env.APPDATA ?? join(homedir(), "AppData", "Roaming"), APP);
    case "darwin":
      return join(homedir(), "Library", "Application Support", APP);
    default:
      return join(process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), APP);
  }
}

export function stateDir(): string {
  switch (platform()) {
    case "win32":
      return join(process.env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local"), APP);
    case "darwin":
      return join(homedir(), "Library", "Application Support", APP);
    default:
      return join(process.env.XDG_STATE_HOME ?? join(homedir(), ".local", "state"), APP);
  }
}

export function tokenFile(): string {
  return join(configDir(), "token");
}

export function stateFile(): string {
  return join(stateDir(), "state.json");
}

export function logFile(): string {
  return join(stateDir(), "daemon.log");
}
