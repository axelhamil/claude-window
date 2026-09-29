# Getting started

## Requirements

- Node 22 or later, on a machine that stays on (`engines.node` is `>=22`).
- A Claude subscription and the `claude` CLI, to mint a long-lived token with `claude setup-token`.
- Linux (systemd user services), macOS (launchd) or Windows (Task Scheduler). Only the Linux path is verified in the wild.

Bun alone cannot run the installed package. `dist/cli.js` starts with `#!/usr/bin/env node`, so a host that only has Bun fails with `env: 'node': No such file or directory`. Bun is fine for working on the source and for running the daemon after a Node-based install (see [below](#running-under-bun-on-memory-tight-hosts)).

## Install

```bash
npm install -g claude-window
```

## Log in

```bash
claude-window login "$(claude setup-token)"
```

`login` strips all whitespace from its argument, requires the `sk-ant-oat` prefix and writes the token to `token` in the config directory with mode `0600`. See [Configuration](configuration.md#token).

## Set your working hours

```bash
claude-window schedule --weekdays 9-17 --weekend off
```

```
schedule saved to /home/you/.config/claude-window/schedule.json
weekdays 09:00-17:00 -> anchor 05:30, resets 10:30, 15:30, 3 fresh windows
weekend  off
service not installed yet, run "claude-window install" to start anchoring
```

Without flags the command asks one question per line and needs a terminal. `--weekdays <range>` and `--weekend <range>` are the only accepted arguments; passing just one keeps the other side of the current `schedule.json` (off when there is none). If you skip `schedule` entirely, the daemon falls back to the [legacy environment schedule](scheduling.md#legacy-environment-schedule) (anchor at 07:00, chain until 23:00, every day). How the anchor is computed is in [Scheduling](scheduling.md).

## Register the service

```bash
claude-window install
```

```
registered with systemd, status: active
```

| Platform | Mechanism | Registered as |
|---|---|---|
| Linux | systemd user unit + linger | `~/.config/systemd/user/claude-window.service` |
| macOS | launchd LaunchAgent | `~/Library/LaunchAgents/com.axelhamil.claude-window.plist` |
| Windows | Task Scheduler, logon trigger | task `claude-window` |

All three restart the daemon if it dies and start it at boot (Linux, with linger) or at logon (macOS, Windows). Details of what each backend writes: [Architecture](architecture.md#service-backends).

`install` records the Node binary (`process.execPath`) and the CLI path (`process.argv[1]`) that ran it. Run it from the globally installed command, and re-run it after moving or upgrading Node (for example with NVM).

## Check that it works

```bash
claude-window status
```

```
service (systemd): active
schedule weekdays 09:00-17:00 -> anchor 05:30, resets 10:30, 15:30, 3 fresh windows | weekend off
window -> reset 15:30 (in 211 min), on grid
usage 5h 0.34 | 7d 0.03
```

Before the first probe it prints `no probe recorded yet` and the path of the state file. `status` never calls the API; it reads `state.json` written by the daemon. To probe right now and see whether the token works:

```bash
claude-window once
```

`once` sends one probe, stores the snapshot, appends to the history, pings the heartbeat URL if set, prints a line such as `05:30 anchored 05:30->10:30 usage5=0 usage7=0 drift=0s` on stderr and exits. It does not retry. Then `claude-window history` shows the anchors and failures the daemon recorded ([Operations](operations.md#reading-status-and-history)).

## Running under Bun on memory-tight hosts

Expect around 85 MB of resident memory under Node. On a memory-tight host, run the installed package under Bun instead and you drop to about 48 MB. Install through npm as usual, then register the service with Bun so the generated unit points at Bun:

```bash
bun "$(npm root -g)/claude-window/dist/cli.js" install
```

This works because the unit stores `process.execPath` (the Bun binary) and the script path. `npm update -g claude-window` keeps working and the daemon keeps running under Bun; re-run the command above after an upgrade to regenerate the unit ([Operations](operations.md#upgrading)). Measured on a Raspberry Pi Zero 2 W: 84 MB under Node, 47 MB under Bun, out of 464 MB total shared with Pi-hole.
