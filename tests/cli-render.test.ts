import { describe, expect, it } from "vitest";
import type { Config } from "../src/config.js";
import type { HistoryRecord } from "../src/history.js";
import { historyLines, statusJson, statusLines } from "../src/render.js";
import type { Snapshot } from "../src/state.js";

const config: Config = {
  startHour: 7,
  endHour: 23,
  offsetSeconds: 120,
  model: "claude-haiku-4-5-20251001",
  pingUrl: null,
};

const service = { name: "systemd", status: "active" };

function snapshotAt(hour: number, minute: number): Snapshot {
  const resetAt = Math.floor(new Date(2026, 7, 14, hour, minute, 0, 0).getTime() / 1000);
  return { resetAt, usage5h: 0.34, usage7d: 0.03, probedAt: resetAt - 18000 };
}

describe("statusJson", () => {
  it("is a single line of parseable json", () => {
    const line = statusJson(snapshotAt(12, 2), service, config);
    expect(line.includes("\n")).toBe(false);
    expect(() => JSON.parse(line)).not.toThrow();
  });

  it("carries a schema version", () => {
    expect(JSON.parse(statusJson(snapshotAt(12, 2), service, config)).schema).toBe(1);
  });

  it("reports an on-grid window", () => {
    const parsed = JSON.parse(statusJson(snapshotAt(12, 2), service, config));
    expect(parsed.onGrid).toBe(true);
    expect(parsed.drift).toBe(120);
  });

  it("reports a drifted window", () => {
    const parsed = JSON.parse(statusJson(snapshotAt(12, 40), service, config));
    expect(parsed.onGrid).toBe(false);
    expect(parsed.drift).toBe(2400);
  });

  it("nulls the window fields before the first probe", () => {
    const parsed = JSON.parse(statusJson(null, service, config));
    expect(parsed.window).toBeNull();
    expect(parsed.onGrid).toBeNull();
    expect(parsed.drift).toBeNull();
  });
});

describe("statusLines", () => {
  it("says when the window sits on the grid", () => {
    expect(statusLines(snapshotAt(12, 2), service, config).join("\n")).toContain("on grid");
  });

  it("quantifies the drift when it has slipped", () => {
    expect(statusLines(snapshotAt(12, 40), service, config).join("\n")).toContain("40 min");
  });

  it("explains that nothing has been probed yet", () => {
    expect(statusLines(null, service, config).join("\n")).toContain("no probe");
  });
});

describe("historyLines", () => {
  const records: HistoryRecord[] = [
    { event: "anchor", at: 1786700000, resetAt: 1786732200, usage5h: 0.3, usage7d: 0.02, drift: 0 },
    { event: "failure", at: 1786700100, reason: "probe rejected with HTTP 503", fatal: false },
  ];

  it("renders one line per record", () => {
    expect(historyLines(records)).toHaveLength(2);
  });

  it("marks an on-grid anchor", () => {
    expect(historyLines(records)[0]).toContain("on grid");
  });

  it("surfaces the failure reason", () => {
    expect(historyLines(records)[1]).toContain("503");
  });

  it("says so when there is nothing to show", () => {
    expect(historyLines([]).join("")).toContain("no anchor recorded");
  });
});
