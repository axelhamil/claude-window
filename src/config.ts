import { readFileSync } from "node:fs";
import { tokenFile } from "./paths.js";

export interface Config {
  startHour: number;
  endHour: number;
  offsetSeconds: number;
  model: string;
}

const DEFAULTS: Config = {
  startHour: 7,
  endHour: 23,
  offsetSeconds: 120,
  model: "claude-haiku-4-5-20251001",
};

function readInteger(
  name: string,
  raw: string | undefined,
  min: number,
  max: number,
): number | null {
  if (raw === undefined || raw.trim() === "") return null;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(
      `invalid configuration (${name}: expected an integer between ${min} and ${max}, got "${raw}")`,
    );
  }
  return value;
}

export function loadConfig(): Config {
  const startHour = readInteger("CLAUDE_WINDOW_START", process.env.CLAUDE_WINDOW_START, 0, 23);
  const endHour = readInteger("CLAUDE_WINDOW_END", process.env.CLAUDE_WINDOW_END, 1, 24);
  const offsetSeconds = readInteger(
    "CLAUDE_WINDOW_OFFSET",
    process.env.CLAUDE_WINDOW_OFFSET,
    0,
    3600,
  );
  const model = process.env.CLAUDE_WINDOW_MODEL?.trim();

  const config: Config = {
    startHour: startHour ?? DEFAULTS.startHour,
    endHour: endHour ?? DEFAULTS.endHour,
    offsetSeconds: offsetSeconds ?? DEFAULTS.offsetSeconds,
    model: model || DEFAULTS.model,
  };

  if (config.endHour <= config.startHour) {
    throw new Error("CLAUDE_WINDOW_END must be greater than CLAUDE_WINDOW_START");
  }
  return config;
}

export function loadToken(): string {
  const fromEnv = process.env.CLAUDE_CODE_OAUTH_TOKEN?.trim();
  if (fromEnv) return fromEnv;

  const path = tokenFile();
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (cause) {
    throw new Error('no token found. run "claude-window login" or set CLAUDE_CODE_OAUTH_TOKEN', {
      cause,
    });
  }

  const token = raw.replace(/\s+/g, "");
  if (!token.startsWith("sk-ant-oat")) {
    throw new Error(`${path} does not contain a valid token (expected sk-ant-oat...)`);
  }
  return token;
}
