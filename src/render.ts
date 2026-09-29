import type { Config } from "./config.js";
import type { HistoryRecord } from "./history.js";
import { describePlan, formatMinutes } from "./planner.js";
import { clock, driftSeconds, gridTolerance, onGrid } from "./scheduling.js";
import type { Snapshot } from "./state.js";

export const STATUS_SCHEMA = 1;

export interface ServiceView {
  name: string;
  status: string;
}

function describeDrift(drift: number | null, config: Config): string {
  if (drift === null) return "off schedule";
  if (Math.abs(drift) <= gridTolerance(config)) return "on grid";
  const minutes = Math.round(Math.abs(drift) / 60);
  return `drifted ${drift > 0 ? "+" : "-"}${minutes} min off grid`;
}

function dateClock(epochSeconds: number): string {
  const date = new Date(epochSeconds * 1000);
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${month}-${day} ${clock(epochSeconds)}`;
}

export function scheduleLine(config: Config): string {
  if (config.schedule === null) {
    const plan = config.week.weekdays;
    const hours =
      plan === null
        ? "none"
        : `anchor ${formatMinutes(plan.anchorMinute)}, active until ${formatMinutes(plan.activeUntilMinute)}`;
    return `schedule (environment) every day: ${hours}`;
  }

  return (
    `schedule weekdays ${describePlan(config.schedule.weekdays)} | ` +
    `weekend ${describePlan(config.schedule.weekend)}`
  );
}

export function statusJson(
  snapshot: Snapshot | null,
  service: ServiceView,
  config: Config,
): string {
  const drift = snapshot === null ? null : driftSeconds(snapshot.resetAt, config);
  return JSON.stringify({
    schema: STATUS_SCHEMA,
    service,
    window: snapshot,
    onGrid: snapshot === null ? null : onGrid(snapshot.resetAt, config),
    drift,
    schedule: config.schedule,
  });
}

export function statusLines(
  snapshot: Snapshot | null,
  service: ServiceView,
  config: Config,
): string[] {
  const lines = [`service (${service.name}): ${service.status}`, scheduleLine(config)];

  if (snapshot === null) {
    lines.push("no probe recorded yet");
    return lines;
  }

  const minutes = Math.round((snapshot.resetAt - Date.now() / 1000) / 60);
  const when = minutes >= 0 ? `in ${minutes} min` : `${-minutes} min ago`;
  lines.push(
    `window -> reset ${clock(snapshot.resetAt)} (${when}), ` +
      describeDrift(driftSeconds(snapshot.resetAt, config), config),
  );
  lines.push(`usage 5h ${snapshot.usage5h} | 7d ${snapshot.usage7d}`);
  return lines;
}

export function historyLines(records: HistoryRecord[], config: Config): string[] {
  if (records.length === 0) return ["no anchor recorded yet"];

  return records.map((record) =>
    record.event === "anchor"
      ? `${dateClock(record.at)}  anchor   reset ${clock(record.resetAt)}  ` +
        `usage5=${record.usage5h}  ${describeDrift(record.drift, config)}`
      : `${dateClock(record.at)}  ${record.fatal ? "FATAL   " : "failure "} ${record.reason}`,
  );
}
