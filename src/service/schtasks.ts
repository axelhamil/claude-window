import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ServiceManager } from "./manager.js";
import { escapeXml } from "./xml.js";

const TASK = "claude-window";

function schtasks(...args: string[]): string {
  return execFileSync("schtasks", args, { encoding: "utf8" }).trim();
}

function taskXml(executable: string, args: string[]): string {
  return [
    '<?xml version="1.0" encoding="UTF-16"?>',
    '<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">',
    "  <RegistrationInfo>",
    "    <Description>Pin the Claude Code 5h rate-limit window</Description>",
    "  </RegistrationInfo>",
    "  <Triggers>",
    "    <LogonTrigger><Enabled>true</Enabled></LogonTrigger>",
    "  </Triggers>",
    "  <Principals>",
    '    <Principal id="Author">',
    "      <LogonType>InteractiveToken</LogonType>",
    "      <RunLevel>LeastPrivilege</RunLevel>",
    "    </Principal>",
    "  </Principals>",
    "  <Settings>",
    "    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>",
    "    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>",
    "    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>",
    "    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>",
    "    <Hidden>true</Hidden>",
    "    <RestartOnFailure>",
    "      <Interval>PT5M</Interval>",
    "      <Count>999</Count>",
    "    </RestartOnFailure>",
    "  </Settings>",
    '  <Actions Context="Author">',
    "    <Exec>",
    `      <Command>${escapeXml(executable)}</Command>`,
    `      <Arguments>${escapeXml(args.map((a) => `"${a}"`).join(" "))}</Arguments>`,
    "    </Exec>",
    "  </Actions>",
    "</Task>",
    "",
  ].join("\r\n");
}

export function schtasksManager(executable: string, args: string[]): ServiceManager {
  return {
    name: "Task Scheduler",

    install() {
      const dir = mkdtempSync(join(tmpdir(), "claude-window-"));
      const xml = join(dir, "task.xml");
      try {
        writeFileSync(xml, taskXml(executable, args), "utf16le");
        schtasks("/create", "/tn", TASK, "/xml", xml, "/f");
        schtasks("/run", "/tn", TASK);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },

    uninstall() {
      try {
        schtasks("/end", "/tn", TASK);
      } catch {
        process.stderr.write("warning: task was not running\n");
      }
      schtasks("/delete", "/tn", TASK, "/f");
    },

    status() {
      try {
        const output = schtasks("/query", "/tn", TASK, "/fo", "list");
        return /Status:\s*Running/i.test(output) ? "active" : "inactive";
      } catch {
        return "not installed";
      }
    },
  };
}
