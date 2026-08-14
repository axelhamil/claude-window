import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { stateFile } from "./paths.js";
import type { RateLimitWindow } from "./window.js";

export interface Snapshot {
  resetAt: number;
  usage5h: number;
  usage7d: number;
  probedAt: number;
}

function isSnapshot(value: unknown): value is Snapshot {
  if (typeof value !== "object" || value === null) return false;
  const { resetAt, usage5h, usage7d, probedAt } = value as Record<string, unknown>;
  return (
    Number.isInteger(resetAt) &&
    (resetAt as number) > 0 &&
    Number.isInteger(probedAt) &&
    (probedAt as number) > 0 &&
    typeof usage5h === "number" &&
    typeof usage7d === "number"
  );
}

export function saveSnapshot(window: RateLimitWindow): void {
  const path = stateFile();
  mkdirSync(dirname(path), { recursive: true });
  const snapshot: Snapshot = { ...window, probedAt: Math.floor(Date.now() / 1000) };
  writeFileSync(path, `${JSON.stringify(snapshot, null, 2)}\n`, "utf8");
}

export function readSnapshot(): Snapshot | null {
  const path = stateFile();

  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }

  const parsed: unknown = JSON.parse(raw);
  if (!isSnapshot(parsed)) {
    throw new Error(`${path} is corrupted, delete it and let the daemon rebuild it`);
  }
  return parsed;
}
