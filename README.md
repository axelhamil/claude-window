# claude-window

Pin your Claude Code 5-hour rate-limit window to the clock, so your reset always lands when you actually need it.

## The problem

Claude Code's usage limit runs on a rolling 5-hour window. That window does **not** start at a fixed hour — it starts on your *first message after the previous window expired*.

Start work at 15:34 and your windows are 15:30–20:30, then 20:30–01:30. Start at 09:12 the next day and everything shifts. Your reset time drifts a little more every day, and it always seems to cut out mid-session.

Worse: because a long session only ever *chains* windows, a 9-hour evening covers **two** windows. If a window had already been open before you sat down, the same 9 hours would span **three**.

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

Fire a cron job at 6am that runs `claude -p "hi"`. That opens *one* window and then stops helping — the moment that window expires while you are away from the keyboard, the chain breaks and the next one starts whenever you happen to type. The grid drifts again.

## What this does differently

Claude's API returns your exact rate-limit state in the response headers:

```
anthropic-ratelimit-unified-5h-reset: 1786732200
anthropic-ratelimit-unified-5h-utilization: 0.36
anthropic-ratelimit-unified-7d-reset: 1787302800
anthropic-ratelimit-unified-7d-utilization: 0.04
```

So `claude-window` runs one tiny request, reads the real reset timestamp, sleeps until exactly that moment plus a small offset, and repeats. Every window opens the instant the previous one closes — the chain never breaks, and the whole grid stays pinned to your anchor hour.

Between pings it is a sleeping bash process. No polling, no cron spam: **4 wakeups a day, ~6 MB RSS**. It runs happily on a Raspberry Pi Zero 2 W next to Pi-hole.

## Install

Needs `bash`, `curl`, and a systemd host that stays on 24/7.

```bash
git clone https://github.com/axelhamil/claude-window
cd claude-window
./install.sh
```

Then generate a long-lived token **on your workstation** (this is the same command CI setups use):

```bash
claude setup-token
```

and drop it on the host running the daemon:

```bash
printf 'CLAUDE_CODE_OAUTH_TOKEN=%s\n' 'sk-ant-oat01-...' > ~/.config/claude-window/env
chmod 600 ~/.config/claude-window/env
sudo systemctl restart claude-window
```

> Paste the token carefully. If your terminal wraps it across two lines or slips in a space, you get a silent `401`.

## Usage

```bash
claude-window status                       # last known window state, costs nothing
sudo journalctl -u claude-window -f -o cat # live
```

```
16:09:48 ancre ok http=200 fenetre 15:30->20:30 util5=0.36 util7=0.04
16:09:48 dodo 15732s -> 20:32
```

## Configuration

Set these in `~/.config/claude-window/env`, then `systemctl restart claude-window`.

| Variable | Default | Meaning |
|---|---|---|
| `CLAUDE_WINDOW_START` | `7` | Hour the daily anchor fires |
| `CLAUDE_WINDOW_END` | `23` | Stop re-anchoring after this hour |
| `CLAUDE_WINDOW_OFFSET` | `120` | Seconds to wait past a reset before pinging |
| `CLAUDE_WINDOW_MODEL` | `claude-haiku-4-5-20251001` | Model used for the 1-token ping |

Pick `CLAUDE_WINDOW_START` by counting back from the reset you want, in 5-hour steps. Want a fresh window at 22:00? Anchor at **07:00** (07 → 12 → 17 → 22).

## Honest limitations

- **It cannot move a window that is already open.** If you are typing at 06:55, the 07:00 anchor lands inside a live window and does nothing. The grid only holds if you are idle at your anchor hour.
- **Late nights break the chain.** The daemon stops at `CLAUDE_WINDOW_END`, so a 22:00–03:00 window expires unattended. Code at 03:15 and you open 03:00–08:00, shifting the grid by an hour. 24 is not divisible by 5, so no schedule loops cleanly across a day.
- **The headers are not a documented public API.** They are what the client already receives on every call. They could change without notice.
- **This does not create quota.** It moves window boundaries so fewer of them land mid-session. It does nothing for the weekly cap.

## Security

The token grants full access to your Claude account. It lives in a `chmod 600` file read by systemd's `EnvironmentFile`, and never leaves your machine — which is the whole reason this exists instead of a GitHub Actions cron holding your credentials. Revoke with `claude setup-token` again if it leaks.

## License

MIT
