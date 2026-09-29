export const WINDOW_MINUTES = 300;
export const MINUTES_PER_DAY = 1440;
export const MIN_EDGE_MINUTES = 15;
export const ACTIVE_SLACK_MINUTES = 90;

export interface Range {
  start: number;
  end: number;
}

export interface DayPlan {
  anchorMinute: number;
  activeUntilMinute: number;
}

export interface WorkPlan extends DayPlan {
  resets: number[];
  freshWindows: number;
  clamped: boolean;
  partial: boolean;
}

const OFF = new Set(["off", "none", "no", ""]);
const TIME = /^(\d{1,2})(?:[:h](\d{2})?)?$/;

function parseTime(raw: string, input: string): number {
  const match = TIME.exec(raw.trim().toLowerCase());
  if (!match) throw new Error(`invalid time "${raw}" in "${input}", expected e.g. 9, 9:30 or 9h30`);

  const hours = Number(match[1]);
  const minutes = Number(match[2] ?? 0);
  if (hours > 24 || minutes > 59 || (hours === 24 && minutes > 0)) {
    throw new Error(`invalid time "${raw}" in "${input}"`);
  }
  return hours * 60 + minutes;
}

export function parseRange(input: string): Range | null {
  const value = input.trim().toLowerCase();
  if (OFF.has(value)) return null;

  const [from, to, ...extra] = value.split("-");
  if (from === undefined || to === undefined || extra.length > 0) {
    throw new Error(`invalid range "${input}", expected e.g. 9-17, 9:30-17:45 or off`);
  }

  const range = { start: parseTime(from, input), end: parseTime(to, input) };
  if (range.end <= range.start) {
    throw new Error(`invalid range "${input}": the end must come after the start, on the same day`);
  }
  return range;
}

function resetsInside(anchorMinute: number, range: Range): number[] {
  const resets: number[] = [];

  for (let reset = anchorMinute + WINDOW_MINUTES; reset < range.end; reset += WINDOW_MINUTES) {
    if (reset > range.start) resets.push(reset);
  }
  return resets;
}

// Each hop of the chain lands `offset` late, and the window opened on the last reset must
// close before the next morning's anchor: (resets + 1) hops have to fit inside one day.
export function maxResets(offsetSeconds: number): number {
  const hop = WINDOW_MINUTES + offsetSeconds / 60;
  return Math.max(0, Math.ceil(MINUTES_PER_DAY / hop) - 2);
}

export function planDay(range: Range, offsetSeconds: number): WorkPlan {
  const duration = range.end - range.start;
  const offsetMinutes = offsetSeconds / 60;

  let resetCount = Math.min(Math.ceil(duration / WINDOW_MINUTES), maxResets(offsetSeconds));
  let edge = (duration - WINDOW_MINUTES * (resetCount - 1)) / 2;
  while (resetCount > 1 && edge < MIN_EDGE_MINUTES) {
    resetCount -= 1;
    edge = (duration - WINDOW_MINUTES * (resetCount - 1)) / 2;
  }

  const ideal = Math.round(range.start + edge) - WINDOW_MINUTES;
  const anchorMinute = Math.max(0, ideal);
  const resets = resetsInside(anchorMinute, range).slice(0, Math.max(0, resetCount));

  const lastOpening = resets.at(-1) ?? anchorMinute;
  const lateness = Math.ceil(resets.length * offsetMinutes);
  const activeUntilMinute = Math.min(
    MINUTES_PER_DAY,
    lastOpening + lateness + ACTIVE_SLACK_MINUTES,
  );

  return {
    anchorMinute,
    activeUntilMinute,
    resets,
    freshWindows: resets.length + 1,
    clamped: anchorMinute !== ideal,
    partial: anchorMinute > range.start || lastOpening + WINDOW_MINUTES < range.end,
  };
}

export function formatMinutes(minutes: number): string {
  const hours = String(Math.floor(minutes / 60)).padStart(2, "0");
  const rest = String(minutes % 60).padStart(2, "0");
  return `${hours}:${rest}`;
}

export function formatRange(range: Range): string {
  return `${formatMinutes(range.start)}-${formatMinutes(range.end)}`;
}

export function describePlan(range: Range | null, offsetSeconds: number): string {
  if (range === null) return "off";

  const plan = planDay(range, offsetSeconds);
  const resets = plan.resets.map(formatMinutes).join(", ");
  const resetPart = resets === "" ? "" : `, resets ${resets}`;
  const windows = plan.freshWindows === 1 ? "1 fresh window" : `${plan.freshWindows} fresh windows`;
  return `${formatRange(range)} -> anchor ${formatMinutes(plan.anchorMinute)}${resetPart}, ${windows}`;
}
