import { readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const WINDOW_MS = 5 * 60 * 60 * 1000;
const OFFSET_MS = 120 * 1000;
const START_HOUR = 7;
const END_HOUR = 23;

const TIMESTAMP = /"timestamp":"(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})/;
const OUTPUT_TOKENS = /"output_tokens":(\d+)/;

const includeToday = process.argv.includes("--include-today");
const home = process.argv.find((a) => a.startsWith("--home="))?.slice(7) ?? join(homedir(), ".claude");

function dayKey(date: Date): string {
  return date.toLocaleDateString("sv-SE");
}

function readPrompts(path: string): Date[] {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return [];
  }

  const prompts: Date[] = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    let parsed: { timestamp?: unknown };
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    const stamp = parsed.timestamp;
    if (typeof stamp !== "number") continue;
    prompts.push(new Date(stamp > 1e11 ? stamp : stamp * 1000));
  }
  return prompts.sort((a, b) => a.getTime() - b.getTime());
}

function walk(dir: string): string[] {
  const found: string[] = [];
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return found;
  }
  for (const entry of entries) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) found.push(...walk(path));
    else if (entry.endsWith(".jsonl")) found.push(path);
  }
  return found;
}

function readTokens(root: string): { days: Set<string>; total: number } {
  const days = new Set<string>();
  let total = 0;
  for (const file of walk(root)) {
    for (const line of readFileSync(file, "utf8").split("\n")) {
      if (!line.includes('"type":"assistant"')) continue;
      const stamp = TIMESTAMP.exec(line);
      if (!stamp?.[1]) continue;
      const tokens = OUTPUT_TOKENS.exec(line);
      total += tokens?.[1] ? Number(tokens[1]) : 0;
      days.add(dayKey(new Date(`${stamp[1]}Z`)));
    }
  }
  return { days, total };
}

function openedNaturally(events: Date[]): Date[] {
  const starts: Date[] = [];
  let end = 0;
  for (const event of events) {
    if (event.getTime() >= end) {
      starts.push(event);
      end = event.getTime() + WINDOW_MS;
    }
  }
  return starts;
}

function openedWithMorningPing(events: Date[], day: string): Date[] {
  const anchor = new Date(`${day}T00:00:00`);
  anchor.setHours(START_HOUR, 0, 0, 0);
  const merged = [...events, anchor].sort((a, b) => a.getTime() - b.getTime());
  return openedNaturally(merged);
}

function openedWithDaemon(events: Date[], day: string): Date[] {
  const lower = new Date(`${day}T00:00:00`);
  lower.setHours(START_HOUR, 0, 0, 0);
  const upper = new Date(`${day}T00:00:00`);
  upper.setHours(END_HOUR, 0, 0, 0);

  const queue = events.map((e) => e.getTime());
  const starts: Date[] = [];
  let end = 0;
  let wake: number | null = lower.getTime();
  let index = 0;

  while (index < queue.length || wake !== null) {
    const nextEvent = index < queue.length ? queue[index]! : Number.POSITIVE_INFINITY;
    const nextWake = wake ?? Number.POSITIVE_INFINITY;
    const moment = Math.min(nextEvent, nextWake);
    if (!Number.isFinite(moment)) break;

    if (moment >= end) {
      starts.push(new Date(moment));
      end = moment + WINDOW_MS;
    }
    if (moment === nextWake) {
      const next = end + OFFSET_MS;
      wake = next < upper.getTime() ? next : null;
    }
    if (moment === nextEvent) index++;
  }
  return starts;
}

function usefulWindows(starts: Date[], events: Date[]): number {
  return starts.filter((s) =>
    events.some((e) => e >= s && e.getTime() < s.getTime() + WINDOW_MS),
  ).length;
}

const prompts = readPrompts(join(home, "history.jsonl"));
if (prompts.length === 0) {
  console.error(`no prompts found in ${join(home, "history.jsonl")}`);
  process.exit(1);
}

const today = dayKey(new Date());
const byDay = new Map<string, Date[]>();
for (const at of prompts) {
  const key = dayKey(at);
  if (!includeToday && key === today) continue;
  const list = byDay.get(key) ?? [];
  list.push(at);
  byDay.set(key, list);
}

const days = [...byDay.keys()].sort();
const hourly = new Array<number>(24).fill(0);
for (const list of byDay.values()) {
  for (const at of list) hourly[at.getHours()] = (hourly[at.getHours()] ?? 0) + 1;
}
const totalPrompts = [...byDay.values()].reduce((n, l) => n + l.length, 0);

console.log(`period        ${days[0]} -> ${days[days.length - 1]}`);
console.log(`active days   ${byDay.size}`);
console.log(`prompts sent  ${totalPrompts.toLocaleString("en-US")}`);

const tokens = readTokens(join(home, "projects"));
if (tokens.total > 0) {
  console.log(
    `output tokens ${tokens.total.toLocaleString("en-US")} over ${tokens.days.size} days ` +
      "(transcripts are pruned after ~30 days)",
  );
}
console.log();

const bands: Array<[string, number, number]> = [
  ["02h-07h", 2, 7],
  ["07h-12h", 7, 12],
  ["12h-15h", 12, 15],
  ["15h-22h", 15, 22],
  ["22h-02h", 22, 26],
];
console.log("band      share of prompts");
for (const [label, from, to] of bands) {
  let sum = 0;
  for (let h = from; h < to; h++) sum += hourly[h % 24] ?? 0;
  console.log(`${label}   ${((100 * sum) / totalPrompts).toFixed(1).padStart(5)} %`);
}

let peak = 0;
for (let h = 0; h < 24; h++) if ((hourly[h] ?? 0) > (hourly[peak] ?? 0)) peak = h;
const firstHours = [...byDay.values()].map((l) => l[0]!.getHours());
console.log(`peak hour     ${String(peak).padStart(2, "0")}h`);
console.log(`first prompt  ${Math.min(...firstHours)}h to ${Math.max(...firstHours)}h across days`);
console.log();

let none = 0;
let morning = 0;
let chained = 0;
let improved = 0;

for (const day of days) {
  const events = byDay.get(day)!;
  const a = usefulWindows(openedNaturally(events), events);
  const b = usefulWindows(openedWithMorningPing(events, day), events);
  const c = usefulWindows(openedWithDaemon(events, day), events);
  none += a;
  morning += b;
  chained += c;
  if (c > a) improved++;
}

const gain = (v: number) => `+${(((v - none) / none) * 100).toFixed(0)} %`;
console.log("strategy                useful windows   gain");
console.log(`do nothing              ${String(none).padStart(14)}   reference`);
console.log(`single ${START_HOUR}h ping          ${String(morning).padStart(14)}   ${gain(morning)}`);
console.log(`ping on every expiry    ${String(chained).padStart(14)}   ${gain(chained)}`);
console.log();
console.log(`days improved by chaining   ${improved}/${byDay.size}`);
