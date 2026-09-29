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
claude-window schedule --weekdays 9-17 --weekend off
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
claude-window schedule                  # set your working hours, asks interactively
claude-window status                    # service state + last known window, costs nothing
claude-window history                   # replay past anchors and failures
claude-window history --limit 50        # show more (or fewer) than the default 20 lines
claude-window history --json            # one JSON object per line, from history.jsonl
claude-window once                      # probe now and exit
claude-window daemon                    # run in the foreground
claude-window uninstall
```

```
service (systemd): active
window -> reset 20:30 (in 236 min)
usage 5h 0.79 | 7d 0.08
```

### Checking that it works

`claude-window status` now says whether the window sits on the grid it is supposed to:

    service (systemd): active
    window -> reset 22:02 (in 184 min), on grid
    usage 5h 0.34 | 7d 0.03

`claude-window history` replays what the daemon has done, from `history.jsonl` in your state
directory — 500 records, oldest dropped first, each line dated so a run spanning several days
stays readable:

    08-14 07:02  anchor   reset 12:02  usage5=0  on grid
    08-14 12:02  anchor   reset 17:02  usage5=0.34  on grid
    08-14 17:04  failure  probe rejected with HTTP 503

`--limit <n>` controls how many lines to show (default 20). Both commands also take `--json`:
`status --json` prints one versioned object, `history --json` prints one object per line, taken
straight from `history.jsonl`. Diagnostics go to stderr, so piping into `jq` is always safe.

### Knowing when it dies

Set `CLAUDE_WINDOW_PING_URL` to a healthchecks.io or Better Stack heartbeat URL. The daemon
pings it after every anchor and pings `<url>/fail` when a probe fails, so a dead daemon raises
an alert instead of quietly not anchoring. A monitoring outage never interrupts anchoring.

### When the token expires

An expired or revoked token is fatal, not transient: the daemon says so and exits instead of
retrying every five minutes forever. On Linux the unit gives up after three such exits in an
hour and shows as `failed`. Refresh with `claude-window login "$(claude setup-token)"`.

### Upgrading from before 0.5.0

The `StartLimitIntervalSec`/`StartLimitBurst` guard above only exists in unit files written by
`claude-window install`. `npm update -g claude-window` updates the binary but never touches
`~/.config/systemd/user/claude-window.service`, so an existing install keeps the old unit and
restart-loops every 60s forever on a fatal token error instead of giving up. Re-run
`claude-window install` after upgrading to regenerate the unit — it is idempotent and safe to
run again.

## Configuration

### Your working hours

Tell it when you work and it computes the anchor for you:

```bash
claude-window schedule                                   # asks, one question per line
claude-window schedule --weekdays 9-17 --weekend off     # same, without questions
```

```
weekdays 09:00-17:00 -> anchor 05:30, resets 10:30, 15:30, 3 fresh windows
weekend  off
systemd service restarted with the new schedule
```

It places as many resets as possible strictly inside your hours, then centres them so the first
and last windows get the same share of your day. A 9-17 day gets three fresh windows instead of
two: the daemon opens one at 05:30, which is still fresh when you sit down at 9, then chains at
10:30 and 15:30. After the last reset it stops chaining, so the evening window has expired before
the next morning's anchor.

Ranges accept `9-17`, `9:30-17:45`, `9h-17h30` or `off`. Weekdays are Monday to Friday; on a day
marked `off` the daemon sleeps. The choice lands in `schedule.json` in your config directory,
and the command restarts the service so it applies at once.

### Environment

Environment variables, read at daemon start:

| Variable | Default | Meaning |
|---|---|---|
| `CLAUDE_WINDOW_START` | `7` | Legacy, ignored once `schedule.json` exists. Hour the daily anchor fires |
| `CLAUDE_WINDOW_END` | `23` | Legacy, ignored once `schedule.json` exists. Stop re-anchoring after this hour |
| `CLAUDE_WINDOW_OFFSET` | `120` | Seconds to wait past a reset before probing |
| `CLAUDE_WINDOW_MODEL` | `claude-haiku-4-5-20251001` | Model used for the probe |
| `CLAUDE_WINDOW_PING_URL` | _(none)_ | Heartbeat URL pinged after each anchor, `<url>/fail` on failure |

Without a schedule, the daemon anchors at `CLAUDE_WINDOW_START` every day and keeps chaining until `CLAUDE_WINDOW_END`, as it did before `schedule` existed.

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

- **It cannot move a window that is already open.** If you are typing at 05:25, the 05:30 anchor lands inside a live window and does nothing. The grid only holds if you are idle at your anchor time.
- **Late nights break the chain.** Code past midnight and the window you open can still be live at the next morning's anchor, which then lands inside it and shifts your day. 24 is not divisible by 5, so no schedule loops cleanly across a day.
- **Working hours stay within one day.** A range cannot cross midnight, and a very early one (say 2-6) anchors at 00:00 instead of the evening before.
- **The headers are not a documented public API.** They are what the client already receives on every call, and they could change without notice.
- **This does not create quota.** It moves window boundaries so fewer of them land mid-session. It does nothing for the weekly cap.
- **Only the Linux path is verified in the wild.** The launchd and Task Scheduler backends are written to spec but untested — issues and reports welcome.

## Security

The token grants full access to your Claude account. `login` writes it to your config directory with `0600`, and it never leaves your machine — which is the whole point of running this yourself instead of handing credentials to a CI cron. Rotate it with `claude setup-token` if it leaks.

Config lives in `~/.config/claude-window` (Linux), `~/Library/Application Support/claude-window` (macOS), `%APPDATA%\claude-window` (Windows).

## License

MIT
