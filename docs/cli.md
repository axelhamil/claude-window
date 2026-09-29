# CLI reference

```
claude-window <command> [flags]
```

Running with no command, `help`, `--help` or `-h` prints the usage. An unknown command prints `unknown command: <name>` and the usage on stderr, and exits with 2. Any other error prints its message on stderr and exits with 1. Output examples below are real.

```
$ claude-window help
claude-window <version>

  claude-window login <token>   store a sk-ant-oat token
  claude-window schedule        set your working hours, asks interactively
  claude-window schedule --weekdays <range> --weekend <range|off>
                                same without questions, e.g. --weekdays 9-17 --weekend off
  claude-window install         register the background service
  claude-window uninstall       remove it
  claude-window status [--json] last known window, costs nothing
  claude-window history [--limit <n>] [--json]
                                what the daemon has anchored so far
  claude-window once            probe now and exit
  claude-window daemon          run in the foreground
  claude-window version
```

Flags are matched literally: `--weekdays 9-17` works, `--weekdays=9-17` does not. `schedule` rejects anything it does not know; `status` and `history` ignore unknown flags. Environment variables that affect every command are in [Configuration](configuration.md#environment-variables).

## login

```
claude-window login <token>
```

Stores an OAuth token. All whitespace is removed from the argument, then it must start with `sk-ant-oat`. The token is written to `<config dir>/token` (mode `0600`).

```
$ claude-window login "$(claude setup-token)"
token stored in /home/you/.config/claude-window/token
```

```
$ claude-window login abc
expected a token starting with "sk-ant-oat", get one with: claude setup-token
```

Only the first argument is read. See [Token](configuration.md#token).

## schedule

```
claude-window schedule
claude-window schedule --weekdays <range> --weekend <range>
```

Saves your working hours to `schedule.json`, prints the plan computed by the [planner](scheduling.md#the-anchor-algorithm) (which depends on `CLAUDE_WINDOW_OFFSET`), and restarts the service so the schedule applies at once.

| Flag | Meaning |
|---|---|
| `--weekdays <range>` | Monday to Friday working hours |
| `--weekend <range>` | Saturday and Sunday working hours |

A range is `9-17`, `9:30-17:45`, `9h-17h30`, or `off` ([syntax](configuration.md#range-syntax)). Arguments are strict: only these two flags, each followed by a value, in either order. If at least one is given there are no questions, and the side you leave out keeps its value from the current `schedule.json` (`off` when there is no usable file; a broken file is ignored with `warning: ignoring the current schedule, <reason>`). Setting both sides to `off` is rejected.

```
$ claude-window schedule --weekdays 9-17 --weekend off
schedule saved to /home/you/.config/claude-window/schedule.json
weekdays 09:00-17:00 -> anchor 05:30, resets 10:30, 15:30, 3 fresh windows
weekend  off
systemd service restarted with the new schedule
```

The last line depends on the service: `<name> service restarted with the new schedule` (`systemd`, `launchd`, `Task Scheduler`), or, when the service is not installed:

```
service not installed yet, run "claude-window install" to start anchoring
```

If the service is installed but the restart fails, the schedule stays saved and the command exits 1:

```
schedule saved, but restarting the systemd service failed: <reason>
restart it by hand, or run "claude-window install" again
```

Warnings go to stderr, after the plan. A range that starts too early to anchor before midnight is clamped:

```
$ claude-window schedule --weekdays 2-6 --weekend off
schedule saved to /home/you/.config/claude-window/schedule.json
weekdays 02:00-06:00 -> anchor 00:00, resets 05:00, 2 fresh windows
weekend  off
warning: weekday hours start too early to anchor the day before, anchoring at 00:00
```

A range longer than one day of chained windows can cover (the plan is capped, see [Scheduling](scheduling.md#the-anchor-algorithm)):

```
$ claude-window schedule --weekdays 0-24 --weekend off
weekdays 00:00-24:00 -> anchor 02:00, resets 07:00, 12:00, 17:00, 4 fresh windows
weekend  off
warning: weekday hours are longer than the windows one day can chain, the edges of the range are not covered
```

`weekend` replaces `weekday` in these warnings for the weekend range.

Without flags the command asks on stdin. An invalid answer prints the parse error on stderr and asks the same question again; an empty answer, `off`, `none` and `no` mean no working hours. If both answers are off, the message `the schedule needs working hours on weekdays, on the weekend, or both` is printed and both questions are asked again.

```
When do you use Claude? Answer with a range like 9-17 or 9:30-18, or off.
Weekday hours, Mon-Fri (off if none): 9-17
Weekend hours, Sat-Sun (empty for off):
```

Without flags and without a terminal (stdin is not a TTY):

```
no terminal to ask questions, pass the hours instead: claude-window schedule --weekdays 9-17 --weekend off
```

Other errors (exit 1):

```
unexpected argument "--weekdays=9-17", expected --weekdays <range> or --weekend <range>
unexpected argument "9-17", expected --weekdays <range> or --weekend <range>
--weekend expects a value
invalid range "18-9": the end must come after the start, on the same day
invalid range "9-10-11", expected e.g. 9-17, 9:30-17:45 or off
invalid time "x" in "9-x", expected e.g. 9, 9:30 or 9h30
the schedule needs working hours on weekdays, on the weekend, or both
```

The file is written before the service restart, so a failing restart still leaves the new schedule saved. The write goes through a temporary file, removed if the write fails.

## install

```
claude-window install
```

Registers and starts the background service ([what each backend writes](architecture.md#service-backends)).

```
$ claude-window install
registered with systemd, status: active
```

The command line stored in the service is the current `process.execPath` followed by the resolved path of the running script and `daemon`. Run it from the installed command, not from a throwaway location. It is idempotent: it overwrites the service definition and enables and starts it. On systemd an already running daemon is not restarted; run `systemctl --user restart claude-window` to load new code or a new unit. Re-run it after upgrading ([Operations](operations.md#upgrading)).

## uninstall

```
claude-window uninstall
```

Stops the service and removes its definition. It keeps the token, schedule, state and history files.

```
$ claude-window uninstall
removed from systemd
```

On a service that was not running, a warning goes to stderr (`warning: unit was not running`, `warning: agent was not loaded`, `warning: task was not running`) and the removal continues.

## status

```
claude-window status [--json]
```

Reads the service state, the [configuration](configuration.md) and `state.json`. It never calls the API and always exits 0 when it can read its inputs.

```
$ claude-window status
service (systemd): active
schedule weekdays 09:00-17:00 -> anchor 05:30, resets 10:30, 15:30, 3 fresh windows | weekend off
window -> reset 15:30 (in 211 min), on grid
usage 5h 0.34 | 7d 0.03
```

| Line | Meaning |
|---|---|
| `service (<backend>): <status>` | `systemd` reports `is-active` output (`active`, `inactive`, `failed`, `activating`); `launchd` and `Task Scheduler` report `active` or `inactive`; `Task Scheduler` also `not installed` |
| `schedule ...` | The plan for each part of the week, `schedule (environment) every day: anchor 07:00, active until 23:00` in [legacy mode](scheduling.md#legacy-environment-schedule), or `schedule INVALID: <reason>` when `schedule.json` cannot be loaded |
| `window -> reset HH:MM (in N min), <grid>` | Reset time of the last probed window; `N min ago` if already past. `<grid>` is `on grid`, `drifted +N min off grid` (or `-N`) or `off schedule` ([tolerance](scheduling.md#drift-and-on-grid)) |
| `usage 5h X \| 7d Y` | Utilization values from the last probe's headers |

Without a probe recorded yet:

```
service (systemd): inactive
schedule (environment) every day: anchor 07:00, active until 23:00
no probe recorded yet
(/home/you/.local/state/claude-window/state.json)
```

`--json` prints one versioned object:

```
$ claude-window status --json
{"schema":1,"service":{"name":"systemd","status":"active"},"window":{"resetAt":1790688602,"usage5h":0.34,"usage7d":0.03,"probedAt":1790670724},"onGrid":true,"drift":2,"schedule":{"weekdays":"09:00-17:00","weekend":null},"scheduleError":null}
```

| Field | Type |
|---|---|
| `schema` | `1` |
| `service` | `{ name, status }` as in the text output |
| `window` | Contents of `state.json` (epoch seconds, see [Architecture](architecture.md#data-files)), or `null` before the first probe |
| `onGrid` | `true`, `false`, or `null` (no snapshot, or no plan nearby) |
| `drift` | Signed seconds to the nearest grid slot, or `null` |
| `schedule` | `{ weekdays, weekend }`, serialised like the file: `"09:00-17:00"` or `null`; `null` in legacy mode or when the file is invalid |
| `scheduleError` | The error message when `schedule.json` cannot be loaded, else `null` |

A broken `schedule.json` does not make `status` fail. The line reads `schedule INVALID: <reason>`, no plan applies (so the window shows `off schedule`), and in JSON `schedule` is `null`, `onGrid` and `drift` are `null` and `scheduleError` holds the reason:

```
$ claude-window status
service (systemd): inactive
schedule INVALID: /home/you/.config/claude-window/schedule.json is not valid json, run "claude-window schedule" to rewrite it
window -> reset 15:30 (in 205 min), off schedule
usage 5h 0.34 | 7d 0.03
```

Errors that still exit 1, on stderr: an invalid environment variable, a `state.json` with the wrong shape, or a `state.json` that is not JSON at all (the raw parse error):

```
invalid configuration (CLAUDE_WINDOW_OFFSET: expected an integer between 0 and 3600, got "abc")
/home/you/.local/state/claude-window/state.json is corrupted, delete it and let the daemon rebuild it
Unexpected token 'o', "not\n" is not valid JSON
```

## history

```
claude-window history [--limit <n>] [--json]
```

Replays `history.jsonl`, oldest first, showing the last `n` records (default 20, positive integer).

```
$ claude-window history
09-28 05:32  anchor   reset 10:30  usage5=0  on grid
09-28 10:32  anchor   reset 15:30  usage5=0.41  on grid
09-28 15:32  failure  probe rejected with HTTP 503
09-28 15:35  anchor   reset 20:35  usage5=0.12  drifted +20 min off grid
09-29 05:32  FATAL    probe rejected with HTTP 401
```

Each line is `MM-DD HH:MM`, the event, then details. A fatal failure shows `FATAL`. With an empty or missing history: `no anchor recorded yet`.

`--json` prints one record per line (NDJSON), taken from `history.jsonl`; lines that do not parse or do not validate are skipped, as in the text mode:

```
$ claude-window history --json --limit 2
{"event":"anchor","at":1790602509,"resetAt":1790620505,"usage5h":0.12,"usage7d":0.04,"drift":1205}
{"event":"failure","at":1790652720,"reason":"probe rejected with HTTP 401","fatal":true}
```

Record fields are in [Architecture](architecture.md#data-files). An invalid limit fails with `--limit expects a positive integer`. In text mode, a broken `schedule.json` is reported first on stderr as `schedule INVALID: <reason>` and the records are still printed (each one keeps the drift stored when it was written); `--json` does not read the schedule at all. Diagnostics go to stderr, so piping into `jq` is safe.

## once

```
claude-window once
```

Sends one probe now and exits. It loads the configuration (an invalid `schedule.json` or environment variable fails it with exit 1) and the token, stores the snapshot to `state.json`, appends an `anchor` record, pings the heartbeat URL if set, and reports on stderr:

```
11:58 anchored 06:35->11:35 usage5=0.12 usage7=0.04 drift=off schedule
```

The prefix is the current time; `drift=` is `<seconds>s` or `off schedule`. `once` does not retry and does not record failures: a rejected probe prints its message and exits 1. It can open a window, which shifts your grid if one was not already open. Use it to test a token, not as a habit.

## daemon

```
claude-window daemon
```

Runs the loop in the foreground; this is what the service executes. `SIGINT` and `SIGTERM` end it cleanly (exit 0). A fatal probe failure ends it with exit 1. An invalid `schedule.json` or environment variable does not end it: it retries loading every 600 seconds ([details](architecture.md#daemon-loop)). Loop details: [Architecture](architecture.md#daemon-loop). Stderr lines:

```
11:58 anchored 05:30->10:30 usage5=0 usage7=0 drift=0s
11:58 sleeping 18120s until 10:32
11:58 outside active hours, sleeping until 05:30
11:58 probe failed: probe rejected with HTTP 503
11:58 retrying in 97s
```

While the configuration is invalid, the daemon writes, without a clock prefix:

```
<reason>
retrying in 600s, fix it with: claude-window schedule
```

The `anchored`, `sleeping`, `outside active hours`, `probe failed` and `retrying` lines are prefixed with the local `HH:MM` (the times above are placeholders).

## version

```
$ claude-window version
claude-window <version>
```
