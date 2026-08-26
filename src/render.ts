import type { Config } from "./config.js";
import type { HistoryRecord } from "./history.js";
import { clock, driftSeconds, GRID_TOLERANCE_SECONDS, onGrid } from "./scheduling.js";
import type { Snapshot } from "./state.js";

export const STATUS_SCHEMA = 1;

export interface ServiceView {
  name: string;
  status: string;
}

function describeDrift(drift: number): string {
  if (Math.abs(drift) <= GRID_TOLERANCE_SECONDS) return "on grid";
  const minutes = Math.round(Math.abs(drift) / 60);
  return `drifted ${drift > 0 ? "+" : "-"}${minutes} min off grid`;
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
  });
}

export function statusLines(
  snapshot: Snapshot | null,
  service: ServiceView,
  config: Config,
): string[] {
  const lines = [`service (${service.name}): ${service.status}`];

  if (snapshot === null) {
    lines.push("no probe recorded yet");
    return lines;
  }

  const minutes = Math.round((snapshot.resetAt - Date.now() / 1000) / 60);
  const when = minutes >= 0 ? `in ${minutes} min` : `${-minutes} min ago`;
  lines.push(
    `window -> reset ${clock(snapshot.resetAt)} (${when}), ` +
      describeDrift(driftSeconds(snapshot.resetAt, config)),
  );
  lines.push(`usage 5h ${snapshot.usage5h} | 7d ${snapshot.usage7d}`);
  return lines;
}

export function historyLines(records: HistoryRecord[]): string[] {
  if (records.length === 0) return ["no anchor recorded yet"];

  return records.map((record) =>
    record.event === "anchor"
      ? `${clock(record.at)}  anchor   reset ${clock(record.resetAt)}  ` +
        `usage5=${record.usage5h}  ${describeDrift(record.drift)}`
      : `${clock(record.at)}  ${record.fatal ? "FATAL   " : "failure "} ${record.reason}`,
  );
}
