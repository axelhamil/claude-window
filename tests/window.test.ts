import { afterEach, describe, expect, it, vi } from "vitest";
import { classifyStatus, fetchWindow, parseRetryAfter, windowStart } from "../src/window.js";

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

describe("classifyStatus", () => {
  it("treats 200 as a success", () => {
    expect(classifyStatus(200)).toBe("success");
  });

  it("treats a rate-limited 429 as a success, because the headers are what we came for", () => {
    expect(classifyStatus(429)).toBe("success");
  });

  it.each([400, 401, 403, 404])("treats %i as fatal", (status) => {
    expect(classifyStatus(status)).toBe("fatal");
  });

  it.each([408, 425, 500, 502, 503, 504])("treats %i as transient", (status) => {
    expect(classifyStatus(status)).toBe("transient");
  });
});

describe("parseRetryAfter", () => {
  it("reads a delay in whole seconds", () => {
    expect(parseRetryAfter("120")).toBe(120);
  });

  it("reads an HTTP-date as a delay from now", () => {
    const now = Date.parse("2026-08-14T12:00:00Z");
    expect(parseRetryAfter("Fri, 14 Aug 2026 12:02:00 GMT", now)).toBe(120);
  });

  it("returns null when the header is absent", () => {
    expect(parseRetryAfter(null)).toBeNull();
  });

  it("returns null on garbage", () => {
    expect(parseRetryAfter("soon")).toBeNull();
  });

  it("returns null on a date already in the past", () => {
    const now = Date.parse("2026-08-14T12:00:00Z");
    expect(parseRetryAfter("Fri, 14 Aug 2026 11:00:00 GMT", now)).toBeNull();
  });
});

describe("fetchWindow failures", () => {
  it("marks an expired token as fatal", async () => {
    const response = new Response("", { status: 401 });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => response),
    );
    await expect(fetchWindow("sk-ant-oat-x", "model")).rejects.toMatchObject({ fatal: true });
  });

  it("marks a server error as transient", async () => {
    const response = new Response("", { status: 503 });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => response),
    );
    await expect(fetchWindow("sk-ant-oat-x", "model")).rejects.toMatchObject({ fatal: false });
  });

  it("carries Retry-After through to the caller", async () => {
    const response = new Response("", { status: 503, headers: { "retry-after": "900" } });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => response),
    );
    await expect(fetchWindow("sk-ant-oat-x", "model")).rejects.toMatchObject({
      retryAfterSeconds: 900,
    });
  });

  it("treats missing rate-limit headers on a 200 as transient", async () => {
    const response = new Response("", { status: 200 });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => response),
    );
    await expect(fetchWindow("sk-ant-oat-x", "model")).rejects.toMatchObject({ fatal: false });
  });
});
