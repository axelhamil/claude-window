import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ServiceManager } from "./manager.js";

const UNIT = "claude-window.service";

function unitPath(): string {
  const base = process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config");
  return join(base, "systemd", "user", UNIT);
}

function systemctl(...args: string[]): string {
  return execFileSync("systemctl", ["--user", ...args], { encoding: "utf8" }).trim();
}

export function systemdManager(executable: string, args: string[]): ServiceManager {
  return {
    name: "systemd",

    install() {
      const path = unitPath();
      mkdirSync(join(path, ".."), { recursive: true });
      writeFileSync(
        path,
        [
          "[Unit]",
          "Description=Pin the Claude Code 5h rate-limit window",
          "After=network-online.target",
          "",
          "[Service]",
          "Type=simple",
          `ExecStart=${[executable, ...args].join(" ")}`,
          "Restart=always",
          "RestartSec=60",
          "Nice=10",
          "",
          "[Install]",
          "WantedBy=default.target",
          "",
        ].join("\n"),
        "utf8",
      );

      try {
        execFileSync("loginctl", ["enable-linger", process.env.USER ?? ""], { stdio: "ignore" });
      } catch {
        process.stderr.write("warning: could not enable linger, the daemon stops when you log out\n");
      }

      systemctl("daemon-reload");
      systemctl("enable", "--now", UNIT);
    },

    uninstall() {
      try {
        systemctl("disable", "--now", UNIT);
      } catch {
        process.stderr.write("warning: unit was not running\n");
      }
      rmSync(unitPath(), { force: true });
      systemctl("daemon-reload");
    },

    status() {
      try {
        return systemctl("is-active", UNIT);
      } catch {
        return "inactive";
      }
    },
  };
}
