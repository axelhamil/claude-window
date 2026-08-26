import { appendFileSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { historyFile } from "./paths.js";

export const HISTORY_LIMIT = 500;

export interface AnchorRecord {
  event: "anchor";
  at: number;
  resetAt: number;
  usage5h: number;
  usage7d: number;
  drift: number;
}

export interface FailureRecord {
  event: "failure";
  at: number;
  reason: string;
  fatal: boolean;
}

export type HistoryRecord = AnchorRecord | FailureRecord;

function isRecord(value: unknown): value is HistoryRecord {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Record<string, unknown>;
  if (!Number.isInteger(candidate.at)) return false;

  if (candidate.event === "anchor") {
    return (
      Number.isInteger(candidate.resetAt) &&
      typeof candidate.usage5h === "number" &&
      typeof candidate.usage7d === "number" &&
      typeof candidate.drift === "number"
    );
  }
  return (
    candidate.event === "failure" &&
    typeof candidate.reason === "string" &&
    typeof candidate.fatal === "boolean"
  );
}

function parse(contents: string): HistoryRecord[] {
  const records: HistoryRecord[] = [];
  for (const line of contents.split("\n")) {
    if (line.trim() === "") continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    if (isRecord(parsed)) records.push(parsed);
  }
  return records;
}

function read(path: string): string | null {
  try {
    return readFileSync(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

function truncate(path: string): void {
  const records = parse(read(path) ?? "");
  if (records.length <= HISTORY_LIMIT) return;

  const kept = records.slice(-HISTORY_LIMIT);
  const temporary = `${path}.tmp`;
  writeFileSync(temporary, `${kept.map((record) => JSON.stringify(record)).join("\n")}\n`, "utf8");
  renameSync(temporary, path);
}

export function appendRecord(record: HistoryRecord): void {
  const path = historyFile();
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, `${JSON.stringify(record)}\n`, "utf8");
  truncate(path);
}

export function readRecords(): HistoryRecord[] {
  return parse(read(historyFile()) ?? "");
}
