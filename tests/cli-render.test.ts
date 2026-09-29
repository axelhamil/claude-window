import { describe, expect, it } from "vitest";
import type { Config } from "../src/config.js";
import type { HistoryRecord } from "../src/history.js";
import { historyLines, scheduleLine, statusJson, statusLines } from "../src/render.js";
import type { Snapshot } from "../src/state.js";

const everyDay = { anchorMinute: 7 * 60, activeUntilMinute: 23 * 60 };

const config: Config = {
  week: { weekdays: everyDay, weekend: everyDay },
  schedule: null,
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
    expect(historyLines(records, config)).toHaveLength(2);
  });

  it("marks an on-grid anchor", () => {
    expect(historyLines(records, config)[0]).toContain("on grid");
  });

  it("surfaces the failure reason", () => {
    expect(historyLines(records, config)[1]).toContain("503");
  });

  it("says so when there is nothing to show", () => {
    expect(historyLines([], config).join("")).toContain("no anchor recorded");
  });

  it("includes the date so lines spanning several days can be told apart", () => {
    const at = new Date(1786700000 * 1000);
    const month = String(at.getMonth() + 1).padStart(2, "0");
    const day = String(at.getDate()).padStart(2, "0");
    expect(historyLines(records, config)[0]).toContain(`${month}-${day}`);
  });

  it("widens on-grid tolerance for a large offset, keeping accumulated drift readable", () => {
    const wideOffset: Config = { ...config, offsetSeconds: 600 };
    const drifted: HistoryRecord[] = [
      {
        event: "anchor",
        at: 1786700000,
        resetAt: 1786732200,
        usage5h: 0.3,
        usage7d: 0.02,
        drift: 1200,
      },
    ];
    expect(historyLines(drifted, wideOffset)[0]).toContain("on grid");
  });
});

describe("scheduleLine", () => {
  it("describes the legacy environment schedule", () => {
    expect(scheduleLine(config)).toBe(
      "schedule (environment) every day: anchor 07:00, active until 23:00",
    );
  });

  it("describes working hours with their anchor and fresh windows", () => {
    const office: Config = {
      ...config,
      schedule: { weekdays: { start: 540, end: 1020 }, weekend: null },
    };
    expect(scheduleLine(office)).toBe(
      "schedule weekdays 09:00-17:00 -> anchor 05:30, resets 10:30, 15:30, 3 fresh windows" +
        " | weekend off",
    );
  });

  it("appears in the status output", () => {
    expect(statusLines(null, service, config)[1]).toMatch(/^schedule /);
  });

  it("carries no schedule in the json status on the legacy environment", () => {
    expect(JSON.parse(statusJson(null, service, config)).schedule).toBeNull();
  });

  it("serialises the schedule in the same format as schedule.json", () => {
    const office: Config = {
      ...config,
      schedule: { weekdays: { start: 540, end: 1020 }, weekend: null },
    };
    expect(JSON.parse(statusJson(null, service, office)).schedule).toEqual({
      weekdays: "09:00-17:00",
      weekend: null,
    });
  });

  it("reports a broken schedule instead of failing", () => {
    expect(statusLines(null, service, config, "schedule.json is not valid json")[1]).toBe(
      "schedule INVALID: schedule.json is not valid json",
    );
    expect(JSON.parse(statusJson(null, service, config, "broken")).scheduleError).toBe("broken");
  });

  it("reports a null drift when the reset falls far from any working day", () => {
    const idle: Config = { ...config, week: { weekdays: null, weekend: null } };
    const parsed = JSON.parse(statusJson(snapshotAt(12, 2), service, idle));
    expect(parsed.drift).toBeNull();
    expect(parsed.onGrid).toBeNull();
  });
});

describe("historyLines off schedule", () => {
  it("labels an anchor taken on a day without working hours", () => {
    const record: HistoryRecord = {
      event: "anchor",
      at: snapshotAt(12, 2).probedAt,
      resetAt: snapshotAt(12, 2).resetAt,
      usage5h: 0,
      usage7d: 0,
      drift: null,
    };
    expect(historyLines([record], config)[0]).toMatch(/off schedule$/);
  });
});
