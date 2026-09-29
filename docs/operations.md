# Operations

## Reading status and history

```bash
claude-window status
claude-window history
```

`status` shows the service state, the schedule, and the last probed window with its grid verdict. `history` replays what the daemon did. Output formats and fields are in the [CLI reference](cli.md#status).

For scripts, both have `--json`: `status --json` is one object with `schema: 1`; `history --json` is one record per line, so `jq` works line by line:

```bash
claude-window status --json | jq '{onGrid, drift, service: .service.status}'
claude-window history --json --limit 500 | jq -c 'select(.event == "failure")'
```

`history` keeps at most 500 records, oldest dropped first ([Architecture](architecture.md#historyjsonl)). Diagnostics go to stderr, so a pipe stays clean.

What to look for: `anchor` lines marked `on grid`; `failure` lines and their reason; `FATAL` means the daemon exited. Note that `status` compares the stored reset with the current configuration; if you changed the schedule, older records are judged against the new one.

## Logs

The daemon writes its log lines to stderr, each prefixed with the local `HH:MM` ([the messages](cli.md#daemon)).

| OS | Where |
|---|---|
| Linux | The journal: `journalctl --user -u claude-window` (add `-f` to follow, `--since today` to narrow) |
| macOS | `<state dir>/daemon.log`, i.e. `~/Library/Application Support/claude-window/daemon.log` (stdout and stderr of the agent) |
| Windows | None. The task does not redirect output, so stderr lines are lost. Use `status` and `history`, which come from files |

`history.jsonl` and `state.json` are the durable record on every OS.

## Token expiry and refresh

An expired or revoked token answers HTTP 401. That is fatal, not transient: the daemon records a `FATAL` entry, pings `<heartbeat url>/fail` if configured, logs `this will not fix itself, refresh the token with: claude setup-token`, and exits with code 1. It does not retry every few minutes forever.

On Linux the unit then restarts it after 60 s, it fails the same way, and after three starts within an hour systemd stops and shows the unit as `failed` (`StartLimitBurst=3`, `StartLimitIntervalSec=3600`). On macOS `KeepAlive` and on Windows the 5-minute `RestartOnFailure` keep restarting it; neither has the start limit.

Refresh:

```bash
claude-window login "$(claude setup-token)"
claude-window schedule --weekdays 9-17 --weekend off   # any restart works
```

The daemon reads the token only at start, so the service has to be restarted for the new token to be used. `schedule` restarts it (systemd: `reset-failed` then `restart`, which also clears a `failed` unit); the direct equivalent on Linux is:

```bash
systemctl --user reset-failed claude-window
systemctl --user restart claude-window
```

If you use `CLAUDE_CODE_OAUTH_TOKEN` instead of the file, update it where the service reads it and restart.

## Upgrading

```bash
npm update -g claude-window
claude-window install
```

`npm update` replaces the binary but never touches the service definition, for example `~/.config/systemd/user/claude-window.service`. An installation from before 0.5.0 keeps the old unit, without `StartLimitIntervalSec` and `StartLimitBurst`, and restart-loops every 60 s forever on a fatal token error instead of giving up. Re-run `claude-window install` after upgrading to regenerate the unit; it is idempotent and safe to run again. It also records the current Node path, which fixes a unit pointing at a Node version you removed (NVM) and a Bun-based unit after a global install moved. Run it the same way as the first time (for the Bun setup: `bun "$(npm root -g)/claude-window/dist/cli.js" install`, see [Getting started](getting-started.md#running-under-bun-on-memory-tight-hosts)).

The running daemon keeps the old code until restarted. `install` rewrites the unit and runs `systemctl --user enable --now`, which does not restart an already-running service; run `systemctl --user restart claude-window` to load the new version immediately.

## Troubleshooting

### Unit in failed state

`claude-window status` shows `service (systemd): failed`.

1. Read why: `journalctl --user -u claude-window -n 50`.
2. `probe rejected with HTTP 401` / `400` / `404` (fatal): refresh the token as above, or check `CLAUDE_WINDOW_MODEL` if it is set (a wrong model can answer 404).
3. `invalid configuration (...)` or a `schedule.json` error does not put the unit in `failed`: the daemon stays up, logs the error with `retrying in 600s, fix it with: claude-window schedule`, and loads the configuration again every 10 minutes. Fix the value (see below); no restart is needed.
4. `no token found`: run `login`.
5. Then `systemctl --user reset-failed claude-window && systemctl --user restart claude-window` (or re-run `schedule`).
6. A unit that fails to start at all, with no daemon output: the recorded Node or script path no longer exists. Re-run `claude-window install`.

### 403s

A 403 is treated as transient, on purpose ([why](architecture.md#http-status-classification)): the daemon logs `probe failed: probe rejected with HTTP 403`, records a non-fatal `failure` and retries with backoff (60 s to 30 min, jittered). If `history` shows nothing but 403 for hours, the token is probably revoked or your account lost access: mint a new one with `claude setup-token` and `login`. The heartbeat `/fail` ping fires on each failed attempt, so a monitor sees it.

### Drifted off grid

`window -> reset 20:35 (in 90 min), drifted +20 min off grid` means the window's reset is more than the tolerance (`max(15 min, 4 * offset)`) from the planned grid. Usual causes:

- A window was already open at the anchor (you were using Claude, or ran `once`), and the daemon cannot move an open window. It chains from that window's reset.
- The daemon was started or restarted mid-day, while a window was already open.
- The machine was asleep or off across a reset, so the next probe came late and opened a window then.
- The schedule changed and old records are judged against the new grid.

The chain realigns itself: the daemon stops probing after the day's last reset, the last window expires, and the next anchor opens a fresh grid if you are idle at the anchor time. To realign sooner, stop using Claude until the drifted window expires and let the daemon open the next one. See [Scheduling](scheduling.md#drift-and-on-grid).

### schedule.json invalid

`status` shows `schedule INVALID: <reason>` and `history` prints the same line on stderr; neither fails. The daemon does not exit either: it logs the reason and `retrying in 600s, fix it with: claude-window schedule` every 10 minutes and anchors nothing until the file loads. `once` fails with the message. The reasons:

```
<path> is not valid json, run "claude-window schedule" to rewrite it
<path> is invalid, run "claude-window schedule" to rewrite it
<path> is invalid (weekdays: invalid range "18-9": ...)
```

Run `claude-window schedule --weekdays ... --weekend ...` to overwrite it: the command ignores a broken current file (with a warning), so it works, but the side you do not pass becomes `off`; pass both. Or delete the file to fall back to the [legacy environment schedule](scheduling.md#legacy-environment-schedule). The message names the file and the key. Because the daemon retries, fixing the file is enough; `schedule` also restarts the service.

### "service not installed yet"

`claude-window schedule` prints `service not installed yet, run "claude-window install" to start anchoring` when there is no unit file (Linux), plist (macOS) or task (Windows). The schedule is saved; run `claude-window install`. If you did install and still see it on Linux, `install` and `schedule` used a different `XDG_CONFIG_HOME`, so they looked at different unit paths.

### Other messages

| Message | Meaning |
|---|---|
| `no probe recorded yet` | No `state.json` exists yet: the daemon has not completed a probe. Wait for the anchor or run `once` |
| `outside active hours, sleeping until HH:MM` | Normal: past the day's last reset, or a day off |
| `missing rate-limit headers on a HTTP 200 response` | The API answered without the reset header; retried. If persistent, the header contract may have changed |
| `heartbeat ping returned HTTP <n>` / `heartbeat ping failed: ...` | The monitor is unreachable or rejects the URL; anchoring is unaffected |
| `history write failed: ...` | The state directory is not writable; anchoring continues without history |
| `the schedule has no active day, run claude-window schedule` | The daemon looked 8 days ahead and no day has working hours |
| `could not enable linger, the daemon stops when you log out` | `loginctl enable-linger` failed at install; fix it or the service stops at logout |
| `<path> is corrupted, delete it and let the daemon rebuild it` | `state.json` has an invalid shape; delete it |
