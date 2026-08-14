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

Between probes it is a sleeping process. No polling, no cron: **4 wakeups a day**.

## Install

Needs **Node 22 or later** on a machine that stays on. Bun alone is not enough: the published binary starts with `#!/usr/bin/env node`, so a Bun-only host fails with `env: 'node': No such file or directory`. Bun is fine for working on the source, not for running the installed package.

```bash
npm install -g claude-window
claude-window login "$(claude setup-token)"
claude-window install
```

Expect around 85 MB of resident memory under Node.

On a memory-tight host, run the installed package under Bun instead and you drop to about 48 MB. Install through npm as usual, then register the service with Bun so the generated unit points at it:

```bash
bun "$(npm root -g)/claude-window/dist/cli.js" install
```

`npm update -g claude-window` keeps working, and the daemon keeps running under Bun. Measured on a Raspberry Pi Zero 2 W: 84 MB under Node, 47 MB under Bun, out of 464 MB total shared with Pi-hole.

`install` registers a background service using whatever your OS provides:

| Platform | Mechanism | Registered as |
|---|---|---|
| Linux | systemd user unit + linger | `~/.config/systemd/user/claude-window.service` |
| macOS | launchd LaunchAgent | `~/Library/LaunchAgents/com.axelhamil.claude-window.plist` |
| Windows | Task Scheduler, logon trigger | task `claude-window` |

All three restart the daemon if it dies and start it at boot or logon.

## Usage

```bash
claude-window status      # service state + last known window, costs nothing
claude-window once        # probe now and exit
claude-window daemon      # run in the foreground
claude-window uninstall
```

```
service (systemd): active
window -> reset 20:30 (in 236 min)
usage 5h 0.79 | 7d 0.08
```

## Configuration

Environment variables, read at daemon start:

| Variable | Default | Meaning |
|---|---|---|
| `CLAUDE_WINDOW_START` | `7` | Hour the daily anchor fires |
| `CLAUDE_WINDOW_END` | `23` | Stop re-anchoring after this hour |
| `CLAUDE_WINDOW_OFFSET` | `120` | Seconds to wait past a reset before probing |
| `CLAUDE_WINDOW_MODEL` | `claude-haiku-4-5-20251001` | Model used for the probe |

Pick `CLAUDE_WINDOW_START` by counting back from the reset you want, in 5-hour steps. Want a fresh window at 22:00? Anchor at **07:00** (07 → 12 → 17 → 22).

## Measure it on your own data

Before trusting any of this, run the numbers against your own history:

```bash
git clone https://github.com/axelhamil/claude-window
cd claude-window && pnpm install
pnpm analyze
```

It reads `~/.claude/history.jsonl` locally, sends nothing anywhere, and replays your days under three strategies. On my own 137 days:

| Strategy | Useful windows | Gain |
|---|---|---|
| Do nothing | 296 | reference |
| Single 7am ping | 315 | +6 % |
| Ping on every expiry | 359 | +21 % |

A window counts as useful only if a prompt was actually sent inside it. Chaining improved 62 of my 137 days. Your mileage depends entirely on when you work, which is exactly why you should measure rather than believe the table above.

`history.jsonl` survives the ~30 day pruning applied to transcripts, so it usually covers far more days than `~/.claude/projects`.

## Honest limitations

- **It cannot move a window that is already open.** If you are typing at 06:55, the 07:00 anchor lands inside a live window and does nothing. The grid only holds if you are idle at your anchor hour.
- **Late nights break the chain.** The daemon stops at `CLAUDE_WINDOW_END`, so a 22:00–03:00 window expires unattended. Code at 03:15 and you open 03:00–08:00, shifting the grid by an hour. 24 is not divisible by 5, so no schedule loops cleanly across a day.
- **The headers are not a documented public API.** They are what the client already receives on every call, and they could change without notice.
- **This does not create quota.** It moves window boundaries so fewer of them land mid-session. It does nothing for the weekly cap.
- **Only the Linux path is verified in the wild.** The launchd and Task Scheduler backends are written to spec but untested — issues and reports welcome.

## Security

The token grants full access to your Claude account. `login` writes it to your config directory with `0600`, and it never leaves your machine — which is the whole point of running this yourself instead of handing credentials to a CI cron. Rotate it with `claude setup-token` if it leaks.

Config lives in `~/.config/claude-window` (Linux), `~/Library/Application Support/claude-window` (macOS), `%APPDATA%\claude-window` (Windows).

## License

MIT
