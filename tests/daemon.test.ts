import { describe, expect, it, vi } from "vitest";
import type { Config } from "../src/config.js";
import { anchor, type DaemonPorts, runDaemon } from "../src/daemon.js";
import { ProbeError, type RateLimitWindow } from "../src/window.js";

const config: Config = {
  startHour: 7,
  endHour: 23,
  offsetSeconds: 120,
  model: "claude-haiku-4-5-20251001",
  pingUrl: null,
};

const window: RateLimitWindow = { resetAt: 1786732200, usage5h: 0.34, usage7d: 0.03 };

function atHour(hour: number, minute = 0): number {
  return Math.floor(new Date(2026, 7, 14, hour, minute, 0, 0).getTime() / 1000);
}

function ports(overrides: Partial<DaemonPorts> = {}): DaemonPorts & { messages: string[] } {
  const messages: string[] = [];
  return {
    messages,
    probe: vi.fn(async () => window),
    persist: vi.fn(),
    report: (message: string) => {
      messages.push(message);
    },
    wait: vi.fn(async () => undefined),
    nowSeconds: () => window.resetAt - 3600,
    record: vi.fn(),
    ping: vi.fn(async () => null),
    random: () => 1,
    ...overrides,
  };
}

describe("anchor", () => {
  it("persists what the probe returned", async () => {
    const p = ports();
    await anchor("sk-ant-oat01-x", config, p);
    expect(p.persist).toHaveBeenCalledWith(window);
  });

  it("reports the window boundaries and usage", async () => {
    const p = ports();
    await anchor("sk-ant-oat01-x", config, p);
    expect(p.messages[0]).toMatch(
      /^anchored \d{2}:\d{2}->\d{2}:\d{2} usage5=0.34 usage7=0.03 drift=-?\d+s$/,
    );
  });

  it("lets a probe failure bubble up so the caller can retry", async () => {
    const p = ports({
      probe: vi.fn(async () => {
        throw new Error("HTTP 401");
      }),
    });
    await expect(anchor("bad", config, p)).rejects.toThrow("HTTP 401");
    expect(p.persist).not.toHaveBeenCalled();
  });
});

function abortAfter(calls: number): { signal: AbortSignal; controller: AbortController } {
  const controller = new AbortController();
  let seen = 0;
  return {
    controller,
    signal: new Proxy(controller.signal, {
      get(target, key, receiver) {
        if (key === "aborted") {
          if (seen >= calls) return true;
          seen += 1;
          return false;
        }
        return Reflect.get(target, key, receiver);
      },
    }),
  };
}

describe("runDaemon", () => {
  it("stops immediately when the signal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    const p = ports();
    await runDaemon("t", config, controller.signal, p);
    expect(p.probe).not.toHaveBeenCalled();
  });

  it("probes then sleeps until the next reset", async () => {
    const { signal } = abortAfter(1);
    const p = ports();
    await runDaemon("t", config, signal, p);
    expect(p.probe).toHaveBeenCalledTimes(1);
    expect(p.wait).toHaveBeenCalledWith(3600 + config.offsetSeconds, signal);
  });

  it("retries after a failed probe instead of giving up", async () => {
    const { signal } = abortAfter(1);
    const p = ports({
      probe: vi.fn(async () => {
        throw new Error("network down");
      }),
    });
    await runDaemon("t", config, signal, p);
    expect(p.messages).toContain("probe failed: network down");
    expect(p.wait).toHaveBeenCalledWith(120, signal);
  });

  it("never probes outside the active hours", async () => {
    const { signal } = abortAfter(1);
    const p = ports();
    const nightConfig: Config = { ...config, startHour: 23, endHour: 24 };
    await runDaemon("t", nightConfig, signal, p);
    expect(p.probe).not.toHaveBeenCalled();
    expect(p.messages[0]).toMatch(/^outside active hours/);
  });

  it("probes when the clock port reports an hour inside the active window, regardless of the real clock", async () => {
    const { signal } = abortAfter(1);
    const p = ports({ nowSeconds: () => atHour(10) });
    await runDaemon("t", config, signal, p);
    expect(p.probe).toHaveBeenCalledTimes(1);
  });

  it("sleeps until the next start of day when the clock port reports an hour outside the active window, regardless of the real clock", async () => {
    const { signal } = abortAfter(1);
    const p = ports({ nowSeconds: () => atHour(2) });
    await runDaemon("t", config, signal, p);
    expect(p.probe).not.toHaveBeenCalled();
    expect(p.messages[0]).toMatch(/^outside active hours, sleeping until 07:00/);
    expect(p.wait).toHaveBeenCalledWith(5 * 3600, signal);
  });

  it("reports a non-Error rejection without crashing", async () => {
    const { signal } = abortAfter(1);
    const p = ports({
      probe: vi.fn(async () => {
        throw "socket hang up";
      }),
    });
    await runDaemon("t", config, signal, p);
    expect(p.messages).toContain("probe failed: socket hang up");
  });
});

describe("runDaemon history and resilience", () => {
  it("records every anchor with its drift", async () => {
    const { signal } = abortAfter(1);
    const port = ports();
    await runDaemon("token", config, signal, port);
    expect(port.record).toHaveBeenCalledWith(
      expect.objectContaining({ event: "anchor", resetAt: window.resetAt }),
    );
  });

  it("records a transient failure without stopping", async () => {
    const { signal } = abortAfter(1);
    const port = ports({
      probe: vi.fn(async () => {
        throw new ProbeError("probe rejected with HTTP 503", false);
      }),
    });
    await runDaemon("token", config, signal, port);
    expect(port.record).toHaveBeenCalledWith(
      expect.objectContaining({ event: "failure", fatal: false }),
    );
  });

  it("stops on a fatal failure instead of retrying forever", async () => {
    const controller = new AbortController();
    const port = ports({
      probe: vi.fn(async () => {
        throw new ProbeError("probe rejected with HTTP 401", true);
      }),
    });
    await expect(runDaemon("token", config, controller.signal, port)).rejects.toThrow("401");
    expect(port.record).toHaveBeenCalledWith(
      expect.objectContaining({ event: "failure", fatal: true }),
    );
  });

  it("pings the heartbeat after a successful anchor", async () => {
    const { signal } = abortAfter(1);
    const port = ports();
    await runDaemon("token", config, signal, port);
    expect(port.ping).toHaveBeenCalledWith("success");
  });

  it("pings the failure endpoint when the probe fails", async () => {
    const { signal } = abortAfter(1);
    const port = ports({
      probe: vi.fn(async () => {
        throw new ProbeError("probe rejected with HTTP 503", false);
      }),
    });
    await runDaemon("token", config, signal, port);
    expect(port.ping).toHaveBeenCalledWith("fail");
  });

  it("reports a broken heartbeat but keeps anchoring", async () => {
    const { signal } = abortAfter(1);
    const port = ports({ ping: vi.fn(async () => "heartbeat ping failed: down") });
    await runDaemon("token", config, signal, port);
    expect(port.messages.some((message) => message.includes("heartbeat"))).toBe(true);
  });

  it("backs off further on each consecutive failure", async () => {
    const { signal } = abortAfter(3);
    const waits: number[] = [];
    const port = ports({
      probe: vi.fn(async () => {
        throw new ProbeError("probe rejected with HTTP 503", false);
      }),
      wait: vi.fn(async (seconds: number) => {
        waits.push(seconds);
      }),
    });
    await runDaemon("token", config, signal, port);
    expect(waits[1]).toBeGreaterThan(waits[0] ?? 0);
  });

  it("still pings the fail heartbeat when the history port throws", async () => {
    const { signal } = abortAfter(1);
    const port = ports({
      probe: vi.fn(async () => {
        throw new ProbeError("probe rejected with HTTP 503", false);
      }),
      record: vi.fn(() => {
        throw new Error("ENOSPC: no space left on device");
      }),
    });
    await runDaemon("token", config, signal, port);
    expect(port.ping).toHaveBeenCalledWith("fail");
  });

  it("does not let a throwing history port kill the loop", async () => {
    const { signal } = abortAfter(2);
    const port = ports({
      probe: vi.fn(async () => {
        throw new ProbeError("probe rejected with HTTP 503", false);
      }),
      record: vi.fn(() => {
        throw new Error("ENOSPC: no space left on device");
      }),
    });
    await runDaemon("token", config, signal, port);
    expect(port.probe).toHaveBeenCalledTimes(2);
  });

  it("reports a throwing heartbeat port instead of letting it kill the loop", async () => {
    const { signal } = abortAfter(2);
    const port = ports({
      probe: vi.fn(async () => {
        throw new ProbeError("probe rejected with HTTP 503", false);
      }),
      ping: vi.fn(async () => {
        throw new Error("getaddrinfo ENOTFOUND");
      }),
    });
    await runDaemon("token", config, signal, port);
    expect(port.probe).toHaveBeenCalledTimes(2);
    expect(port.messages.some((message) => message.includes("ENOTFOUND"))).toBe(true);
  });

  it("reports a history write failure instead of swallowing it", async () => {
    const { signal } = abortAfter(1);
    const port = ports({
      probe: vi.fn(async () => {
        throw new ProbeError("probe rejected with HTTP 503", false);
      }),
      record: vi.fn(() => {
        throw new Error("ENOSPC: no space left on device");
      }),
    });
    await runDaemon("token", config, signal, port);
    expect(port.messages.some((message) => message.includes("ENOSPC"))).toBe(true);
  });
});

describe("anchor resilience", () => {
  it("still pings success and does not throw when the history port fails", async () => {
    const p = ports({
      record: vi.fn(() => {
        throw new Error("ENOSPC: no space left on device");
      }),
    });
    await expect(anchor("sk-ant-oat01-x", config, p)).resolves.toEqual(window);
    expect(p.ping).toHaveBeenCalledWith("success");
    expect(p.messages.some((message) => message.includes("ENOSPC"))).toBe(true);
  });
});
