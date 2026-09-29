import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { askSchedule } from "../src/wizard.js";

function answering(lines: string[]) {
  const input = new PassThrough();
  const output = new PassThrough();
  const errors = new PassThrough();
  let written = "";
  errors.on("data", (chunk) => {
    written += String(chunk);
  });

  let next = 0;
  output.on("data", (chunk) => {
    if (String(chunk).endsWith(": ") && next < lines.length) input.write(`${lines[next++]}\n`);
  });

  return { input, output, errors, errorsText: () => written };
}

describe("askSchedule", () => {
  it("reads weekday and weekend hours", async () => {
    const io = answering(["9-17", ""]);
    const schedule = await askSchedule(io.input, io.output, io.errors);
    expect(schedule).toEqual({ weekdays: { start: 540, end: 1020 }, weekend: null });
  });

  it("asks again after an answer it cannot read", async () => {
    const io = answering(["nine to five", "9-17", "off"]);
    const schedule = await askSchedule(io.input, io.output, io.errors);
    expect(schedule.weekdays).toEqual({ start: 540, end: 1020 });
    expect(io.errorsText()).toContain('invalid range "nine to five"');
  });

  it("starts over when both answers are off", async () => {
    const io = answering(["off", "off", "9-17", "off"]);
    const schedule = await askSchedule(io.input, io.output, io.errors);
    expect(schedule.weekdays).toEqual({ start: 540, end: 1020 });
    expect(io.errorsText()).toContain("needs working hours");
  });
});
