import { describe, expect, it, vi } from "vitest";
import { ping } from "../src/heartbeat.js";

describe("ping", () => {
  it("does nothing when no url is configured", async () => {
    const fetchImpl = vi.fn();
    expect(await ping(null, "success", fetchImpl as unknown as typeof fetch)).toBeNull();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("calls the url as-is on success", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => new Response("OK"));
    await ping("https://hc-ping.com/abc", "success", fetchImpl);
    expect(fetchImpl.mock.calls[0]?.[0]).toBe("https://hc-ping.com/abc");
  });

  it("appends /fail on failure", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => new Response("OK"));
    await ping("https://hc-ping.com/abc", "fail", fetchImpl);
    expect(fetchImpl.mock.calls[0]?.[0]).toBe("https://hc-ping.com/abc/fail");
  });

  it("does not double the slash when the url already ends with one", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => new Response("OK"));
    await ping("https://hc-ping.com/abc/", "fail", fetchImpl);
    expect(fetchImpl.mock.calls[0]?.[0]).toBe("https://hc-ping.com/abc/fail");
  });

  it("reports a rejected ping instead of throwing", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error("getaddrinfo ENOTFOUND");
    });
    const message = await ping("https://hc-ping.com/abc", "success", fetchImpl as unknown as typeof fetch);
    expect(message).toContain("heartbeat");
  });

  it("reports a non-2xx response instead of throwing", async () => {
    const fetchImpl = vi.fn(async () => new Response("nope", { status: 500 }));
    const message = await ping("https://hc-ping.com/abc", "success", fetchImpl as unknown as typeof fetch);
    expect(message).toContain("500");
  });
});
