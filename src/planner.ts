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

export function planDay(range: Range): WorkPlan {
  const duration = range.end - range.start;

  let resetCount = Math.ceil(duration / WINDOW_MINUTES);
  let edge = (duration - WINDOW_MINUTES * (resetCount - 1)) / 2;
  while (resetCount > 1 && edge < MIN_EDGE_MINUTES) {
    resetCount -= 1;
    edge = (duration - WINDOW_MINUTES * (resetCount - 1)) / 2;
  }

  const ideal = Math.round(range.start + edge) - WINDOW_MINUTES;
  const anchorMinute = Math.max(0, ideal);
  const resets = resetsInside(anchorMinute, range);

  const lastOpening = resets.at(-1) ?? anchorMinute;
  const activeUntilMinute = Math.min(MINUTES_PER_DAY, lastOpening + ACTIVE_SLACK_MINUTES);

  return {
    anchorMinute,
    activeUntilMinute,
    resets,
    freshWindows: resets.length + 1,
    clamped: anchorMinute !== ideal,
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

export function describePlan(range: Range | null): string {
  if (range === null) return "off";

  const plan = planDay(range);
  const resets = plan.resets.map(formatMinutes).join(", ");
  const resetPart = resets === "" ? "" : `, resets ${resets}`;
  return (
    `${formatRange(range)} -> anchor ${formatMinutes(plan.anchorMinute)}${resetPart}, ` +
    `${plan.freshWindows} fresh windows`
  );
}
