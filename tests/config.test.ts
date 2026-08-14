import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadConfig, loadToken } from "../src/config.js";

const KEYS = [
  "CLAUDE_WINDOW_START",
  "CLAUDE_WINDOW_END",
  "CLAUDE_WINDOW_OFFSET",
  "CLAUDE_WINDOW_MODEL",
  "CLAUDE_CODE_OAUTH_TOKEN",
  "XDG_CONFIG_HOME",
] as const;

const saved = new Map<string, string | undefined>();

beforeEach(() => {
  for (const key of KEYS) {
    saved.set(key, process.env[key]);
    delete process.env[key];
  }
});

afterEach(() => {
  for (const [key, value] of saved) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe("loadConfig", () => {
  it("falls back to the documented defaults", () => {
    expect(loadConfig()).toEqual({
      startHour: 7,
      endHour: 23,
      offsetSeconds: 120,
      model: "claude-haiku-4-5-20251001",
    });
  });

  it("reads overrides from the environment", () => {
    process.env.CLAUDE_WINDOW_START = "9";
    process.env.CLAUDE_WINDOW_END = "21";
    process.env.CLAUDE_WINDOW_OFFSET = "300";
    process.env.CLAUDE_WINDOW_MODEL = "claude-sonnet-5";

    expect(loadConfig()).toEqual({
      startHour: 9,
      endHour: 21,
      offsetSeconds: 300,
      model: "claude-sonnet-5",
    });
  });

  it("rejects an end hour that precedes the start", () => {
    process.env.CLAUDE_WINDOW_START = "20";
    process.env.CLAUDE_WINDOW_END = "8";
    expect(() => loadConfig()).toThrow("must be greater than");
  });

  it("rejects an hour outside the clock", () => {
    process.env.CLAUDE_WINDOW_START = "42";
    expect(() => loadConfig()).toThrow("invalid configuration");
  });

  it("rejects a negative offset", () => {
    process.env.CLAUDE_WINDOW_OFFSET = "-1";
    expect(() => loadConfig()).toThrow("invalid configuration");
  });
});

describe("loadToken", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "claude-window-"));
    process.env.XDG_CONFIG_HOME = dir;
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("prefers the environment variable", () => {
    process.env.CLAUDE_CODE_OAUTH_TOKEN = "sk-ant-oat01-from-env";
    expect(loadToken()).toBe("sk-ant-oat01-from-env");
  });

  it("explains how to obtain a token when none exists", () => {
    expect(() => loadToken()).toThrow("claude-window login");
  });

  it("reads the token file and strips stray whitespace", () => {
    const path = join(dir, "claude-window");
    writeFileSync(join(mkdirp(path), "token"), "sk-ant-oat01-abc\n", "utf8");
    expect(loadToken()).toBe("sk-ant-oat01-abc");
  });

  it("rejects a file that does not hold a token", () => {
    const path = join(dir, "claude-window");
    writeFileSync(join(mkdirp(path), "token"), "hunter2\n", "utf8");
    expect(() => loadToken()).toThrow("valid token");
  });
});

function mkdirp(path: string): string {
  mkdirSync(path, { recursive: true });
  return path;
}
