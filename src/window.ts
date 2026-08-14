const ENDPOINT = "https://api.anthropic.com/v1/messages";
const WINDOW_SECONDS = 5 * 60 * 60;

const HEADER = {
  resetAt: "anthropic-ratelimit-unified-5h-reset",
  usage5h: "anthropic-ratelimit-unified-5h-utilization",
  usage7d: "anthropic-ratelimit-unified-7d-utilization",
} as const;

export interface RateLimitWindow {
  resetAt: number;
  usage5h: number;
  usage7d: number;
}

function readUtilization(raw: string | null): number {
  const value = Number(raw);
  return Number.isFinite(value) && value >= 0 ? value : 0;
}

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

  const resetAt = Number(response.headers.get(HEADER.resetAt));
  if (!Number.isInteger(resetAt) || resetAt <= 0) {
    throw new Error(`missing rate-limit headers on a HTTP ${response.status} response`);
  }

  return {
    resetAt,
    usage5h: readUtilization(response.headers.get(HEADER.usage5h)),
    usage7d: readUtilization(response.headers.get(HEADER.usage7d)),
  };
}
