import { z } from "zod";

const ENDPOINT = "https://api.anthropic.com/v1/messages";
const WINDOW_SECONDS = 5 * 60 * 60;

const HEADER = {
  resetAt: "anthropic-ratelimit-unified-5h-reset",
  usage5h: "anthropic-ratelimit-unified-5h-utilization",
  usage7d: "anthropic-ratelimit-unified-7d-utilization",
} as const;

const windowSchema = z.object({
  resetAt: z.coerce.number().int().positive(),
  usage5h: z.coerce.number().min(0).catch(0),
  usage7d: z.coerce.number().min(0).catch(0),
});

export type RateLimitWindow = z.infer<typeof windowSchema>;

export function windowStart(window: RateLimitWindow): number {
  return window.resetAt - WINDOW_SECONDS;
}

export async function fetchWindow(token: string, model: string): Promise<RateLimitWindow> {
  const response = await fetch(ENDPOINT, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "anthropic-version": "2023-06-01",
      "anthropic-beta": "oauth-2025-04-20",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model,
      max_tokens: 1,
      system: [{ type: "text", text: "You are Claude Code, Anthropic's official CLI for Claude." }],
      messages: [{ role: "user", content: "hi" }],
    }),
    signal: AbortSignal.timeout(30_000),
  });

  if (response.status !== 200 && response.status !== 429) {
    throw new Error(`probe rejected with HTTP ${response.status}`);
  }

  const parsed = windowSchema.safeParse({
    resetAt: response.headers.get(HEADER.resetAt),
    usage5h: response.headers.get(HEADER.usage5h),
    usage7d: response.headers.get(HEADER.usage7d),
  });

  if (!parsed.success) {
    throw new Error(`missing rate-limit headers on a HTTP ${response.status} response`);
  }

  return parsed.data;
}
