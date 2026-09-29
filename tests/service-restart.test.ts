import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const home = mkdtempSync(join(tmpdir(), "claude-window-home-"));

vi.mock("node:child_process", () => ({ execFileSync: vi.fn(() => "") }));
vi.mock("node:os", async () => {
  const actual = await vi.importActual<typeof import("node:os")>("node:os");
  return { ...actual, homedir: () => home };
});

const { launchdManager } = await import("../src/service/launchd.js");
const { schtasksManager } = await import("../src/service/schtasks.js");

const agents = join(home, "Library", "LaunchAgents");
const args = ["/opt/claude-window/cli.js", "daemon"];

function calls(): string[][] {
  return vi
    .mocked(execFileSync)
    .mock.calls.map(([command, rest]) => [String(command), ...((rest as string[]) ?? [])]);
}

beforeEach(() => {
  vi.mocked(execFileSync).mockReset();
  vi.mocked(execFileSync).mockReturnValue("");
});

afterEach(() => {
  rmSync(agents, { recursive: true, force: true });
});

afterAll(() => {
  rmSync(home, { recursive: true, force: true });
});

describe("launchdManager.restart", () => {
  it("does nothing when the agent was never installed", () => {
    expect(launchdManager("/usr/bin/node", args).restart()).toBe(false);
    expect(execFileSync).not.toHaveBeenCalled();
  });

  it("kills and restarts the loaded agent", () => {
    mkdirSync(agents, { recursive: true });
    writeFileSync(join(agents, "com.axelhamil.claude-window.plist"), "", "utf8");

    expect(launchdManager("/usr/bin/node", args).restart()).toBe(true);
    const [call] = calls();
    expect(call?.slice(0, 3)).toEqual(["launchctl", "kickstart", "-k"]);
    expect(call?.[3]).toMatch(/\/com\.axelhamil\.claude-window$/);
  });
});

describe("schtasksManager.restart", () => {
  it("does nothing when the task does not exist", () => {
    vi.mocked(execFileSync).mockImplementationOnce(() => {
      throw new Error("not found");
    });
    expect(schtasksManager("node.exe", args).restart()).toBe(false);
    expect(calls()).toHaveLength(1);
  });

  it("starts the task again even when it was not running", () => {
    vi.mocked(execFileSync)
      .mockImplementationOnce(() => "")
      .mockImplementationOnce(() => {
        throw new Error("not running");
      });

    expect(schtasksManager("node.exe", args).restart()).toBe(true);
    expect(calls().map((call) => call[1])).toEqual(["/query", "/end", "/run"]);
  });
});
