import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { logFile } from "../paths.js";
import type { ServiceManager } from "./manager.js";
import { escapeXml } from "./xml.js";

const LABEL = "com.axelhamil.claude-window";

function plistPath(): string {
  return join(homedir(), "Library", "LaunchAgents", `${LABEL}.plist`);
}

function launchctl(...args: string[]): string {
  return execFileSync("launchctl", args, { encoding: "utf8" }).trim();
}

function plist(executable: string, args: string[]): string {
  const program = [executable, ...args]
    .map((value) => `      <string>${escapeXml(value)}</string>`)
    .join("\n");

  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    "  <dict>",
    "    <key>Label</key>",
    `    <string>${LABEL}</string>`,
    "    <key>ProgramArguments</key>",
    "    <array>",
    program,
    "    </array>",
    "    <key>RunAtLoad</key>",
    "    <true/>",
    "    <key>KeepAlive</key>",
    "    <true/>",
    "    <key>ProcessType</key>",
    "    <string>Background</string>",
    "    <key>StandardErrorPath</key>",
    `    <string>${escapeXml(logFile())}</string>`,
    "    <key>StandardOutPath</key>",
    `    <string>${escapeXml(logFile())}</string>`,
    "  </dict>",
    "</plist>",
    "",
  ].join("\n");
}

export function launchdManager(executable: string, args: string[]): ServiceManager {
  return {
    name: "launchd",

    install() {
      const path = plistPath();
      mkdirSync(join(path, ".."), { recursive: true });
      mkdirSync(join(logFile(), ".."), { recursive: true });
      writeFileSync(path, plist(executable, args), "utf8");

      try {
        launchctl("bootout", `gui/${process.getuid?.() ?? ""}/${LABEL}`);
      } catch {
        // not loaded yet
      }
      launchctl("bootstrap", `gui/${process.getuid?.() ?? ""}`, path);
    },

    uninstall() {
      try {
        launchctl("bootout", `gui/${process.getuid?.() ?? ""}/${LABEL}`);
      } catch {
        process.stderr.write("warning: agent was not loaded\n");
      }
      rmSync(plistPath(), { force: true });
    },

    status() {
      try {
        launchctl("print", `gui/${process.getuid?.() ?? ""}/${LABEL}`);
        return "active";
      } catch {
        return "inactive";
      }
    },
  };
}
