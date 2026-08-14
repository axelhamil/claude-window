import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { stateFile } from "../src/paths.js";
import { readSnapshot, saveSnapshot } from "../src/state.js";

let dir: string;
let previous: string | undefined;

beforeEach(() => {
  previous = process.env.XDG_STATE_HOME;
  dir = mkdtempSync(join(tmpdir(), "claude-window-state-"));
  process.env.XDG_STATE_HOME = dir;
});

afterEach(() => {
  if (previous === undefined) delete process.env.XDG_STATE_HOME;
  else process.env.XDG_STATE_HOME = previous;
  rmSync(dir, { recursive: true, force: true });
});

describe("readSnapshot", () => {
  it("returns null before anything has been written", () => {
    expect(readSnapshot()).toBeNull();
  });

  it("throws on a corrupted file rather than silently starting over", () => {
    saveSnapshot({ resetAt: 1786732200, usage5h: 0.5, usage7d: 0.1 });
    writeFileSync(stateFile(), "{ not json", "utf8");
    expect(() => readSnapshot()).toThrow();
  });

  it("rejects a well-formed file whose shape is wrong", () => {
    saveSnapshot({ resetAt: 1786732200, usage5h: 0.5, usage7d: 0.1 });
    writeFileSync(stateFile(), JSON.stringify({ resetAt: "soon" }), "utf8");
    expect(() => readSnapshot()).toThrow("corrupted");
  });
});

describe("saveSnapshot", () => {
  it("creates the state directory on first write", () => {
    saveSnapshot({ resetAt: 1786732200, usage5h: 0.34, usage7d: 0.03 });
    expect(readSnapshot()).toMatchObject({ resetAt: 1786732200, usage5h: 0.34, usage7d: 0.03 });
  });

  it("stamps the moment of the probe", () => {
    const before = Math.floor(Date.now() / 1000);
    saveSnapshot({ resetAt: 1786732200, usage5h: 0, usage7d: 0 });
    const snapshot = readSnapshot();
    expect(snapshot?.probedAt).toBeGreaterThanOrEqual(before);
  });

  it("overwrites the previous snapshot", () => {
    saveSnapshot({ resetAt: 1786732200, usage5h: 0.1, usage7d: 0 });
    saveSnapshot({ resetAt: 1786750200, usage5h: 0.9, usage7d: 0.2 });
    expect(readSnapshot()?.resetAt).toBe(1786750200);
  });
});
