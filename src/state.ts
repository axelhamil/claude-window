import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { z } from "zod";
import { stateFile } from "./paths.js";
import type { RateLimitWindow } from "./window.js";

const snapshotSchema = z.object({
  resetAt: z.number().int().positive(),
  usage5h: z.number(),
  usage7d: z.number(),
  probedAt: z.number().int().positive(),
});

export type Snapshot = z.infer<typeof snapshotSchema>;

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

  const parsed = snapshotSchema.safeParse(JSON.parse(raw));
  if (!parsed.success) {
    throw new Error(`${path} is corrupted, delete it and let the daemon rebuild it`);
  }
  return parsed.data;
}
