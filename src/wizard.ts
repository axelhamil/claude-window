import { createInterface } from "node:readline/promises";
import type { Readable, Writable } from "node:stream";
import { parseRange, type Range } from "./planner.js";
import { type Schedule, validateSchedule } from "./schedule.js";

type Ask = (question: string) => Promise<string>;

async function askRange(ask: Ask, question: string, errors: Writable): Promise<Range | null> {
  for (;;) {
    const answer = await ask(question);
    try {
      return parseRange(answer);
    } catch (error) {
      errors.write(`${(error as Error).message}\n`);
    }
  }
}

export async function askSchedule(
  input: Readable = process.stdin,
  output: Writable = process.stdout,
  errors: Writable = process.stderr,
): Promise<Schedule> {
  const prompt = createInterface({ input, output });
  const ask: Ask = (question) => prompt.question(question);

  try {
    output.write("When do you use Claude? Answer with a range like 9-17 or 9:30-18, or off.\n");

    for (;;) {
      const weekdays = await askRange(ask, "Weekday hours, Mon-Fri (off if none): ", errors);
      const weekend = await askRange(ask, "Weekend hours, Sat-Sun (empty for off): ", errors);
      try {
        return validateSchedule({ weekdays, weekend });
      } catch (error) {
        errors.write(`${(error as Error).message}\n`);
      }
    }
  } finally {
    prompt.close();
  }
}
