import { homedir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { configDir, logFile, stateDir, stateFile, tokenFile } from "../src/paths.js";

const saved = { ...process.env };

afterEach(() => {
  vi.doUnmock("node:os");
  vi.resetModules();
  process.env = { ...saved };
});

async function onPlatform(name: NodeJS.Platform, env: Record<string, string | undefined> = {}) {
  vi.resetModules();
  vi.doMock("node:os", async () => {
    const actual = await vi.importActual<typeof import("node:os")>("node:os");
    return { ...actual, platform: () => name };
  });
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  return await import("../src/paths.js");
}

describe("configDir", () => {
  it("honours XDG_CONFIG_HOME on linux", () => {
    process.env.XDG_CONFIG_HOME = "/custom/config";
    expect(configDir()).toBe(join("/custom/config", "claude-window"));
  });

  it("falls back to ~/.config when XDG is unset", () => {
    delete process.env.XDG_CONFIG_HOME;
    expect(configDir()).toBe(join(homedir(), ".config", "claude-window"));
  });
});

describe("stateDir", () => {
  it("honours XDG_STATE_HOME", () => {
    process.env.XDG_STATE_HOME = "/custom/state";
    expect(stateDir()).toBe(join("/custom/state", "claude-window"));
  });

  it("falls back to ~/.local/state", () => {
    delete process.env.XDG_STATE_HOME;
    expect(stateDir()).toBe(join(homedir(), ".local", "state", "claude-window"));
  });
});

describe("derived paths", () => {
  it("puts the token next to the config", () => {
    process.env.XDG_CONFIG_HOME = "/c";
    expect(tokenFile()).toBe(join("/c", "claude-window", "token"));
  });

  it("puts the snapshot and the log in the state directory", () => {
    process.env.XDG_STATE_HOME = "/s";
    expect(stateFile()).toBe(join("/s", "claude-window", "state.json"));
    expect(logFile()).toBe(join("/s", "claude-window", "daemon.log"));
  });
});

describe("platform specific roots", () => {
  it("uses Application Support on macOS", async () => {
    const paths = await onPlatform("darwin");
    expect(paths.configDir()).toBe(
      join(homedir(), "Library", "Application Support", "claude-window"),
    );
    expect(paths.stateDir()).toBe(
      join(homedir(), "Library", "Application Support", "claude-window"),
    );
  });

  it("uses APPDATA and LOCALAPPDATA on Windows", async () => {
    const paths = await onPlatform("win32", {
      APPDATA: "C:\\Users\\a\\AppData\\Roaming",
      LOCALAPPDATA: "C:\\Users\\a\\AppData\\Local",
    });
    expect(paths.configDir()).toBe(join("C:\\Users\\a\\AppData\\Roaming", "claude-window"));
    expect(paths.stateDir()).toBe(join("C:\\Users\\a\\AppData\\Local", "claude-window"));
  });

  it("falls back to the home directory when Windows vars are missing", async () => {
    const paths = await onPlatform("win32", { APPDATA: undefined, LOCALAPPDATA: undefined });
    expect(paths.configDir()).toBe(join(homedir(), "AppData", "Roaming", "claude-window"));
    expect(paths.stateDir()).toBe(join(homedir(), "AppData", "Local", "claude-window"));
  });
});
