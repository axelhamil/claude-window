import { createInterface } from "node:readline/promises";
import { parseRange, type Range } from "./planner.js";
import type { Schedule } from "./schedule.js";

async function askRange(
  ask: (question: string) => Promise<string>,
  question: string,
): Promise<Range | null> {
  for (;;) {
    const answer = await ask(question);
    try {
      return parseRange(answer);
    } catch (error) {
      process.stderr.write(`${(error as Error).message}\n`);
    }
  }
}

export async function askSchedule(): Promise<Schedule> {
  const prompt = createInterface({ input: process.stdin, output: process.stdout });

  try {
    const ask = (question: string) => prompt.question(question);
    console.log("When do you use Claude? Answer with a range like 9-17 or 9:30-18, or off.");

    const weekdays = await askRange(ask, "Weekday working hours (Mon-Fri): ");
    const weekend = await askRange(ask, "Weekend working hours (Sat-Sun, empty for off): ");
    return { weekdays, weekend };
  } finally {
    prompt.close();
  }
}
