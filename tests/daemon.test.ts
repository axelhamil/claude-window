import { describe, expect, it, vi } from "vitest";
import type { Config } from "../src/config.js";
import { anchor, type DaemonPorts, runDaemon } from "../src/daemon.js";
import type { RateLimitWindow } from "../src/window.js";

const config: Config = {
  startHour: 7,
  endHour: 23,
  offsetSeconds: 120,
  model: "claude-haiku-4-5-20251001",
};

const window: RateLimitWindow = { resetAt: 1786732200, usage5h: 0.34, usage7d: 0.03 };

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
    expect(p.messages[0]).toMatch(/^anchored \d{2}:\d{2}->\d{2}:\d{2} usage5=0.34 usage7=0.03$/);
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

describe("runDaemon", () => {
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
    expect(p.wait).toHaveBeenCalledWith(300, signal);
  });

  it("never probes outside the active hours", async () => {
    const { signal } = abortAfter(1);
    const p = ports();
    const nightConfig: Config = { ...config, startHour: 23, endHour: 24 };
    await runDaemon("t", nightConfig, signal, p);
    expect(p.probe).not.toHaveBeenCalled();
    expect(p.messages[0]).toMatch(/^outside active hours/);
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
