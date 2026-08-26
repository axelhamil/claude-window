import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("node:child_process", () => ({ execFileSync: vi.fn(() => "active") }));

const { systemdManager } = await import("../src/service/systemd.js");

let dir: string;
let previous: string | undefined;

beforeEach(() => {
  previous = process.env.XDG_CONFIG_HOME;
  dir = mkdtempSync(join(tmpdir(), "claude-window-systemd-"));
  process.env.XDG_CONFIG_HOME = dir;
});

afterEach(() => {
  if (previous === undefined) delete process.env.XDG_CONFIG_HOME;
  else process.env.XDG_CONFIG_HOME = previous;
  rmSync(dir, { recursive: true, force: true });
});

function install(): string {
  systemdManager("/usr/bin/node", ["/opt/claude-window/cli.js", "daemon"]).install();
  return readFileSync(join(dir, "systemd", "user", "claude-window.service"), "utf8");
}

describe("systemdManager.install", () => {
  it("gives up after three fatal exits in an hour", () => {
    const unit = install();
    expect(unit).toContain("StartLimitIntervalSec=3600");
    expect(unit).toContain("StartLimitBurst=3");
  });

  it("puts the start limit in the unit section, where systemd reads it", () => {
    const unit = install();
    const unitSection = unit.slice(unit.indexOf("[Unit]"), unit.indexOf("[Service]"));
    expect(unitSection).toContain("StartLimitIntervalSec=3600");
  });

  it("still restarts on ordinary failures", () => {
    expect(install()).toContain("Restart=always");
  });
});

describe("systemdManager.status", () => {
  afterEach(() => {
    vi.mocked(execFileSync).mockReset();
    vi.mocked(execFileSync).mockImplementation(() => "active");
  });

  it("returns the failed unit's stdout when systemctl exits non-zero", () => {
    vi.mocked(execFileSync).mockImplementationOnce(() => {
      const error = new Error("Command failed") as NodeJS.ErrnoException & { stdout?: string };
      error.stdout = "failed\n";
      throw error;
    });
    const manager = systemdManager("/usr/bin/node", ["/opt/claude-window/cli.js", "daemon"]);
    expect(manager.status()).toBe("failed");
  });

  it("falls back to inactive when the failure carries no usable stdout", () => {
    vi.mocked(execFileSync).mockImplementationOnce(() => {
      throw new Error("systemctl: command not found");
    });
    const manager = systemdManager("/usr/bin/node", ["/opt/claude-window/cli.js", "daemon"]);
    expect(manager.status()).toBe("inactive");
  });
});
