import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchWindow, windowStart } from "../src/window.js";

const MODEL = "claude-haiku-4-5-20251001";

function respond(status: number, headers: Record<string, string>): Response {
  return new Response(null, { status, headers });
}

const validHeaders = {
  "anthropic-ratelimit-unified-5h-reset": "1786732200",
  "anthropic-ratelimit-unified-5h-utilization": "0.34",
  "anthropic-ratelimit-unified-7d-utilization": "0.03",
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("windowStart", () => {
  it("places the start five hours before the reset", () => {
    expect(windowStart({ resetAt: 1786732200, usage5h: 0, usage7d: 0 })).toBe(1786732200 - 18000);
  });
});

describe("fetchWindow", () => {
  it("parses the rate-limit headers of a 200", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => respond(200, validHeaders)),
    );
    const window = await fetchWindow("sk-ant-oat01-test", MODEL);
    expect(window).toEqual({ resetAt: 1786732200, usage5h: 0.34, usage7d: 0.03 });
  });

  it("still parses a 429, which carries the reset we need", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => respond(429, validHeaders)),
    );
    await expect(fetchWindow("sk-ant-oat01-test", MODEL)).resolves.toMatchObject({
      resetAt: 1786732200,
    });
  });

  it("rejects an unauthorized response", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => respond(401, {})),
    );
    await expect(fetchWindow("bad", MODEL)).rejects.toThrow("HTTP 401");
  });

  it("rejects a 200 whose rate-limit headers are missing", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => respond(200, {})),
    );
    await expect(fetchWindow("sk-ant-oat01-test", MODEL)).rejects.toThrow(
      "missing rate-limit headers",
    );
  });

  it("defaults utilization to zero when only the reset is present", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => respond(200, { "anthropic-ratelimit-unified-5h-reset": "1786732200" })),
    );
    const window = await fetchWindow("sk-ant-oat01-test", MODEL);
    expect(window.usage5h).toBe(0);
    expect(window.usage7d).toBe(0);
  });

  it("sends the oauth beta header and a one-token body", async () => {
    const spy = vi.fn<typeof fetch>(async () => respond(200, validHeaders));
    vi.stubGlobal("fetch", spy);
    await fetchWindow("sk-ant-oat01-test", MODEL);

    const init = spy.mock.calls[0]?.[1];
    if (!init) throw new Error("fetch was never called");
    const headers = init.headers as Record<string, string>;
    expect(headers["anthropic-beta"]).toBe("oauth-2025-04-20");
    expect(headers.authorization).toBe("Bearer sk-ant-oat01-test");
    expect(JSON.parse(init.body as string).max_tokens).toBe(1);
  });
});
