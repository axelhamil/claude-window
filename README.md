# claude-window

Pin your Claude Code 5-hour rate-limit window to a fixed hour, so your reset always lands when you actually need it.

## The problem

Claude Code's usage limit runs on a rolling 5-hour window. That window does **not** start at a fixed hour — it starts on your *first message after the previous window expired*.

Start work at 15:34 and your windows are 15:30–20:30, then 20:30–01:30. Start at 09:12 the next day and everything shifts. Your reset drifts a little more every day, and it always seems to cut out mid-session.

Worse: a long session only ever *chains* windows, so a 9-hour evening covers **two**. If a window had already been open before you sat down, the same 9 hours would span **three**.

```
You code 15:30 -> 00:30, nothing anchored:

  15:30 ───────────────── 20:30 ───────────────── 01:30
        [    window 1    ][    window 2    ]
        └─ 2 windows for 9 hours of work

Same session, anchored at 07:00:

  07:00 ──── 12:00 ──── 17:00 ──── 22:00 ──── 03:00
       [ w1 ][   w2    ][   w3    ][   w4    ]
                  ▲ you start here
             └─ 3 windows touch your session, and reset lands at 22:00
```

## What everyone else does

Fire a cron job at 6am that runs `claude -p "hi"`. That opens *one* window and then stops helping — the moment it expires while you are away from the keyboard, the chain breaks and the next window starts whenever you happen to type. The grid drifts again.

## What this does differently

Claude's API returns your exact rate-limit state in the response headers:

```
anthropic-ratelimit-unified-5h-reset: 1786732200
anthropic-ratelimit-unified-5h-utilization: 0.36
anthropic-ratelimit-unified-7d-utilization: 0.04
```

So `claude-window` sends one 1-token request, reads the real reset timestamp, sleeps until exactly that moment plus a small offset, and repeats. Every window opens the instant the previous one closes — the chain never breaks, and the grid stays pinned to your anchor hour.

Between probes it is a sleeping process. No polling, no cron: a handful of wakeups a day (four with the default 07:00-23:00 chain, three for a 9-17 schedule).

## Install

Needs **Node 22 or later** on a machine that stays on. Bun alone is not enough: the published binary starts with `#!/usr/bin/env node`, so a Bun-only host fails with `env: 'node': No such file or directory`. Bun is fine for working on the source, not for running the installed package.

```bash
npm install -g claude-window
claude-window login "$(claude setup-token)"
claude-window schedule --weekdays 9-17 --weekend off
claude-window install
```

Expect around 85 MB of resident memory under Node. On a memory-tight host the daemon can run under Bun instead (about 48 MB): see [Getting started](docs/getting-started.md#running-under-bun-on-memory-tight-hosts).

`install` registers a background service using whatever your OS provides, and all three restart the daemon if it dies and start it at boot or logon:

| Platform | Mechanism | Registered as |
|---|---|---|
| Linux | systemd user unit + linger | `~/.config/systemd/user/claude-window.service` |
| macOS | launchd LaunchAgent | `~/Library/LaunchAgents/com.axelhamil.claude-window.plist` |
| Windows | Task Scheduler, logon trigger | task `claude-window` |

## Usage

```bash
claude-window schedule                  # set your working hours, asks interactively
claude-window status                    # service state + last known window, costs nothing
claude-window history                   # replay past anchors and failures
claude-window once                      # probe now and exit
claude-window daemon                    # run in the foreground
claude-window uninstall
```

```
$ claude-window status
service (systemd): active
schedule weekdays 09:00-17:00 -> anchor 05:30, resets 10:30, 15:30, 3 fresh windows | weekend off
window -> reset 15:30 (in 211 min), on grid
usage 5h 0.34 | 7d 0.03
```

`schedule` takes your working hours and computes the anchor that gives the most fresh windows inside them. A 9-17 day gets three fresh windows instead of two: the daemon opens one at 05:30, still fresh when you sit down at 9, then chains at 10:30 and 15:30 and stops after the last reset. `status` says whether the window sits on the grid it is supposed to, and `history` replays what the daemon did (`--limit <n>`, `--json` on both commands where applicable). Set `CLAUDE_WINDOW_PING_URL` to a healthchecks.io or Better Stack URL to be alerted when the daemon dies.

## Documentation

| Page | Contents |
|---|---|
| [Getting started](docs/getting-started.md) | Requirements, install, login, first schedule, running under Bun |
| [Scheduling](docs/scheduling.md) | The window model, the anchor algorithm, worked examples, weekdays vs weekend, drift |
| [CLI reference](docs/cli.md) | Every command and flag with real output |
| [Configuration](docs/configuration.md) | `schedule.json`, environment variables, precedence, file locations, token, heartbeat |
| [Architecture](docs/architecture.md) | Modules, daemon loop, backoff, status classification, service backends |
| [Operations](docs/operations.md) | Status and history, logs, token expiry, upgrading (re-run `install` after upgrading), troubleshooting |
| [Development](docs/development.md) | Setup, tests, `pnpm analyze` (measure it on your own data), release flow |

Environment variables (`CLAUDE_WINDOW_OFFSET`, `CLAUDE_WINDOW_MODEL`, `CLAUDE_WINDOW_PING_URL`, and the legacy `CLAUDE_WINDOW_START` / `CLAUDE_WINDOW_END`) are listed with defaults and ranges in [Configuration](docs/configuration.md#environment-variables). An expired or revoked token is fatal, not transient: the daemon exits instead of retrying forever, and refreshing it is `claude-window login "$(claude setup-token)"` ([Operations](docs/operations.md#token-expiry-and-refresh)).

## Honest limitations

- **It cannot move a window that is already open.** If you are typing at 05:25, the 05:30 anchor lands inside a live window and does nothing. The grid only holds if you are idle at your anchor time.
- **Late nights break the chain.** Code past midnight and the window you open can still be live at the next morning's anchor, which then lands inside it and shifts your day. 24 is not divisible by 5, so no schedule loops cleanly across a day.
- **Working hours stay within one day.** A range cannot cross midnight, and a very early one (say 2-6) anchors at 00:00 instead of the evening before. A range longer than one day of chained windows can cover is capped at four fresh windows, and `schedule` warns that the edges are not covered.
- **The headers are not a documented public API.** They are what the client already receives on every call, and they could change without notice.
- **This does not create quota.** It moves window boundaries so fewer of them land mid-session. It does nothing for the weekly cap.
- **Only the Linux path is verified in the wild.** The launchd and Task Scheduler backends are written to spec but untested — issues and reports welcome.

## Security

The token grants full access to your Claude account. `login` writes it to your config directory with `0600`, and it never leaves your machine, which is the whole point of running this yourself instead of handing credentials to a CI cron. Rotate it with `claude setup-token` if it leaks.

Config lives in `~/.config/claude-window` (Linux), `~/Library/Application Support/claude-window` (macOS), `%APPDATA%\claude-window` (Windows). State and history live in `~/.local/state/claude-window` on Linux, next to the config on macOS, and in `%LOCALAPPDATA%\claude-window` on Windows ([all locations](docs/configuration.md#file-locations)).

## License

MIT
