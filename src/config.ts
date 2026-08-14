import { readFileSync } from "node:fs";
import { z } from "zod";
import { tokenFile } from "./paths.js";

const configSchema = z.object({
  startHour: z.coerce.number().int().min(0).max(23).default(7),
  endHour: z.coerce.number().int().min(1).max(24).default(23),
  offsetSeconds: z.coerce.number().int().min(0).max(3600).default(120),
  model: z.string().min(1).default("claude-haiku-4-5-20251001"),
});

export type Config = z.infer<typeof configSchema>;

export function loadConfig(): Config {
  const parsed = configSchema.safeParse({
    startHour: process.env.CLAUDE_WINDOW_START,
    endHour: process.env.CLAUDE_WINDOW_END,
    offsetSeconds: process.env.CLAUDE_WINDOW_OFFSET,
    model: process.env.CLAUDE_WINDOW_MODEL,
  });

  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join(", ");
    throw new Error(`invalid configuration (${issues})`);
  }

  if (parsed.data.endHour <= parsed.data.startHour) {
    throw new Error("CLAUDE_WINDOW_END must be greater than CLAUDE_WINDOW_START");
  }

  return parsed.data;
}

export function loadToken(): string {
  const fromEnv = process.env.CLAUDE_CODE_OAUTH_TOKEN?.trim();
  if (fromEnv) return fromEnv;

  const path = tokenFile();
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (cause) {
    throw new Error(`no token found. run "claude-window login" or set CLAUDE_CODE_OAUTH_TOKEN`, {
      cause,
    });
  }

  const token = raw.replace(/\s+/g, "");
  if (!token.startsWith("sk-ant-oat")) {
    throw new Error(`${path} does not contain a valid token (expected sk-ant-oat...)`);
  }
  return token;
}
