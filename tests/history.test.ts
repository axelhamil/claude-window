import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  appendRecord,
  type HistoryRecord,
  HISTORY_LIMIT,
  readRecords,
} from "../src/history.js";
import { historyFile } from "../src/paths.js";

let dir: string;
let previous: string | undefined;

beforeEach(() => {
  previous = process.env.XDG_STATE_HOME;
  dir = mkdtempSync(join(tmpdir(), "claude-window-history-"));
  process.env.XDG_STATE_HOME = dir;
  mkdirSync(join(dir, "claude-window"));
});

afterEach(() => {
  if (previous === undefined) delete process.env.XDG_STATE_HOME;
  else process.env.XDG_STATE_HOME = previous;
  rmSync(dir, { recursive: true, force: true });
});

function anchorAt(at: number): HistoryRecord {
  return { event: "anchor", at, resetAt: at + 18000, usage5h: 0.1, usage7d: 0.02, drift: 0 };
}

describe("readRecords", () => {
  it("returns nothing before the first append", () => {
    expect(readRecords()).toEqual([]);
  });

  it("returns records oldest first", () => {
    appendRecord(anchorAt(1000));
    appendRecord(anchorAt(2000));
    expect(readRecords().map((record) => record.at)).toEqual([1000, 2000]);
  });

  it("skips a corrupted line instead of throwing", () => {
    appendRecord(anchorAt(1000));
    writeFileSync(historyFile(), `${readFileSync(historyFile(), "utf8")}{ not json\n`, "utf8");
    appendRecord(anchorAt(3000));
    expect(readRecords().map((record) => record.at)).toEqual([1000, 3000]);
  });

  it("skips a well-formed line whose shape is wrong", () => {
    writeFileSync(historyFile(), `${JSON.stringify({ event: "anchor" })}\n`, "utf8");
    expect(readRecords()).toEqual([]);
  });
});

describe("appendRecord", () => {
  it("creates the state directory on first write", () => {
    appendRecord(anchorAt(1000));
    expect(readRecords()).toHaveLength(1);
  });

  it("keeps failure records with their reason and severity", () => {
    appendRecord({ event: "failure", at: 1000, reason: "probe rejected with HTTP 401", fatal: true });
    expect(readRecords()[0]).toMatchObject({ event: "failure", fatal: true });
  });

  it("writes one line per record", () => {
    appendRecord(anchorAt(1000));
    appendRecord(anchorAt(2000));
    expect(readFileSync(historyFile(), "utf8").trimEnd().split("\n")).toHaveLength(2);
  });

  it("caps the file at the limit, dropping the oldest records", () => {
    for (let index = 0; index < HISTORY_LIMIT + 10; index += 1) appendRecord(anchorAt(index));
    const records = readRecords();
    expect(records).toHaveLength(HISTORY_LIMIT);
    expect(records[0]?.at).toBe(10);
    expect(records.at(-1)?.at).toBe(HISTORY_LIMIT + 9);
  });
});
