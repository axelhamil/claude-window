# Architecture

Zero runtime dependencies. `bun build` bundles `src/cli.ts` (and `package.json`, for the version) into a single minified `dist/cli.js` targeting Node.

## Module map

| Module | Responsibility |
|---|---|
| `src/cli.ts` | Entry point and command dispatch (`login`, `schedule`, `install`, `uninstall`, `status`, `history`, `once`, `daemon`, `version`), exit codes, tolerant settings loading for `status`/`history`, the daemon's config retry loop |
| `src/config.ts` | `loadConfig(schedule)` (environment variables, plans for each part of the week, validation) and `loadToken`; builds the `Config` with a `WeekPlan` |
| `src/planner.ts` | Pure planning: `parseRange`, `maxResets`, `planDay(range, offsetSeconds)` (anchor algorithm), `describePlan`, time formatting |
| `src/schedule.ts` | `schedule.json` load, validation and atomic save, `serialiseSchedule`, strict parsing of the `schedule` flags (`scheduleFromArgs`) |
| `src/scheduling.ts` | Clock-dependent decisions: `planFor`, `withinActiveHours`, `nextStartOfDay`, `secondsUntilNextProbe`, `backoffSeconds`, drift and grid tolerance, `clock` |
| `src/window.ts` | The probe: HTTP request, header parsing, status classification, `ProbeError`, `parseRetryAfter` |
| `src/daemon.ts` | `anchor` (one probe plus bookkeeping), `runDaemon` (the loop), `DaemonPorts` and `createPorts` |
| `src/state.ts` | `state.json`: snapshot of the last probe |
| `src/history.ts` | `history.jsonl`: capped, append-only record of anchors and failures |
| `src/heartbeat.ts` | Optional heartbeat GET |
| `src/render.ts` | Text and JSON rendering of `status` and `history`, including the `schedule INVALID` line |
| `src/wizard.ts` | Interactive questions for `schedule` (readline, injectable streams); asks again if both answers are off |
| `src/paths.ts` | Config and state locations per OS |
| `src/service/manager.ts` | `ServiceManager` interface and platform selection |
| `src/service/systemd.ts` | Linux backend |
| `src/service/launchd.ts` | macOS backend |
| `src/service/schtasks.ts` | Windows backend |
| `src/service/xml.ts` | XML escaping shared by the launchd and Task Scheduler backends |
| `scripts/analyze-usage.ts` | Offline analysis of your own Claude history, see [Development](development.md#pnpm-analyze) |

Dependencies flow one way: `cli` uses everything; `daemon` uses `scheduling`, `window`, `state`, `history`, `heartbeat`; `config` uses `planner`, `schedule`, `paths`; `planner` imports nothing.

## The probe

`fetchWindow(token, model)` in `src/window.ts` sends `POST https://api.anthropic.com/v1/messages` with `authorization: Bearer <token>`, `anthropic-version: 2023-06-01`, `anthropic-beta: oauth-2025-04-20`, and a body of `max_tokens: 1`, the Claude Code identity system prompt and one user message, `hi`. Timeout: 30 s. It reads three response headers:

| Header | Field |
|---|---|
| `anthropic-ratelimit-unified-5h-reset` | `resetAt`, epoch seconds; must be a positive integer |
| `anthropic-ratelimit-unified-5h-utilization` | `usage5h`; missing or invalid becomes `0` |
| `anthropic-ratelimit-unified-7d-utilization` | `usage7d`; same |

The window started at `resetAt - 5h` (`windowStart`). These headers are not a documented public API; see the README limitations.

## HTTP status classification

`classifyStatus(status)`:

| Class | Statuses | Effect |
|---|---|---|
| success | `200`, `429` | Headers are parsed. A `429` still carries the reset we need, so a rate-limited account is not an error |
| fatal | `400`, `401`, `404` | `ProbeError` with `fatal = true`; the daemon gives up (typically a bad request, an expired or revoked token, or an unknown model) |
| transient | everything else: `403`, `408`, `425`, `5xx`, ... | `ProbeError` with `fatal = false`; retried with backoff |

`403` is transient since 0.5.1 (commit `fix: retry a 403 probe instead of stopping the daemon`): it used to be fatal and stopped the daemon. The code cannot tell a permanent 403 from a temporary one, so it retries with backoff instead of ending the daemon, which would otherwise stay down until someone noticed. The cost is that a truly revoked token that answers 403 keeps being retried, with a backoff ceiling of 30 minutes; watch for it via the heartbeat and [`history`](operations.md#403s).

Also transient: a network error or timeout (`fetch` throws, not a `ProbeError`), and a `200`/`429` without a valid reset header (`missing rate-limit headers on a HTTP <status> response`). Every `ProbeError` carries `retryAfterSeconds`, parsed from `Retry-After` (integer seconds, or an HTTP date turned into a delay from now; `null` when absent, invalid or in the past).

## Daemon loop

`runDaemon(token, config, signal, ports)`:

```
while not aborted:
    now = ports.nowSeconds()
    if not withinActiveHours(config, now):
        wakeAt = nextStartOfDay(config, now)          # next anchor, scanning up to 8 days
        report "outside active hours, sleeping until HH:MM"
        wait(wakeAt - now); continue
    try:
        window = anchor(...)                          # probe, persist, record, report, ping
        attempt = 0
        seconds = max(window.resetAt + offset - now, 60)
        report "sleeping <seconds>s until HH:MM"
        wait(seconds)
    catch error:
        record failure (event, at, reason, fatal); report "probe failed: <reason>"
        ping "fail"
        if fatal: report "this will not fix itself, refresh the token with: claude setup-token"; rethrow
        attempt += 1
        seconds = backoffSeconds(attempt, error.retryAfterSeconds, random)
        report "retrying in <seconds>s"; wait(seconds)
```

`anchor(token, config, ports)` is one iteration and also what `once` runs: probe, `persist` the snapshot, compute the drift, `record` an `anchor` entry, `report` the `anchored ...` line, `ping` success. Its result is returned to the loop.

Points worth knowing:

- Active hours are `anchorMinute <= minute < activeUntilMinute` of the plan for the current local day ([Scheduling](scheduling.md#the-anchor-algorithm)). Starting the daemon inside them probes immediately.
- The daemon reads the schedule and environment once, at start. It has no file watcher; `schedule` restarts the service.
- If `schedule.json` (or an environment variable) is invalid at start, the daemon does not exit: it writes the error and `retrying in 600s, fix it with: claude-window schedule` to stderr (no clock prefix) and tries to load the configuration again every 600 seconds, so fixing the file is enough. The token is loaded only after the configuration is valid. A signal during that wait ends the process with exit 0. (`status` and `history` are tolerant in the same way, see [Operations](operations.md#schedulejson-invalid).)
- `SIGINT`/`SIGTERM` abort the signal: the pending `wait` resolves at once and the loop ends, exit 0.
- Failures of the bookkeeping never stop the loop: a history write error is reported (`history write failed: <reason>`), a ping error is reported, and the daemon continues. The heartbeat pings even when the history write failed.
- A fatal error rethrows out of `runDaemon`, `cli.ts` prints the message and the process exits 1.

### Backoff and Retry-After

`backoffSeconds(attempt, retryAfter, random)`:

```
ceiling  = min(1800, 60 * 2^attempt)
jittered = round(random() * ceiling)          # full jitter
backoff  = max(60, jittered)
result   = max(backoff, retryAfter ?? 0)
```

`attempt` starts at 1 after the first failure and resets to 0 after a success. The upper bound of the delay per attempt is 120 s, 240 s, 480 s, 960 s, then 1800 s from the fifth failure on; the delay is never below 60 s. A `Retry-After` larger than the jittered delay wins and is not capped.

### DaemonPorts

Everything with a side effect or a clock in the loop goes through `DaemonPorts`, so tests drive `runDaemon` with fakes and no timers:

| Port | Production implementation |
|---|---|
| `probe(token, model)` | `fetchWindow` |
| `persist(window)` | `saveSnapshot` (state.json) |
| `record(entry)` | `appendRecord` (history.jsonl) |
| `ping(outcome)` | `heartbeat.ping(config.pingUrl, outcome)`; resolves to an error message or `null` |
| `report(message)` | stderr, prefixed with the local `HH:MM` |
| `wait(seconds, signal)` | `setTimeout` promise, cleared and resolved when the signal aborts |
| `nowSeconds()` | `Date.now() / 1000`, floored |
| `random()` | `Math.random` |

`createPorts(config)` builds the production set. `tests/daemon.test.ts` builds a fake one.

## Data files

Both live in the [state directory](configuration.md#file-locations).

### state.json

The snapshot of the last successful probe, pretty-printed JSON, overwritten in place (not through a temporary file):

```json
{
  "resetAt": 1790688602,
  "usage5h": 0.34,
  "usage7d": 0.03,
  "probedAt": 1790670724
}
```

`resetAt` and `probedAt` are epoch seconds and must be positive integers; `usage5h`, `usage7d` numbers. Missing file reads as `null`; a file that is not valid JSON throws a raw parse error, and an invalid shape throws `<path> is corrupted, delete it and let the daemon rebuild it`. It is safe to delete.

### history.jsonl

One JSON object per line, appended after each event. After every append, if the file holds more than `HISTORY_LIMIT = 500` valid records, it is rewritten with the newest 500 (temporary file plus rename), so the oldest are dropped first.

```
{"event":"anchor","at":1790602509,"resetAt":1790620505,"usage5h":0.12,"usage7d":0.04,"drift":1205}
{"event":"failure","at":1790652720,"reason":"probe rejected with HTTP 401","fatal":true}
```

| Event | Fields |
|---|---|
| `anchor` | `at` (epoch s), `resetAt`, `usage5h`, `usage7d`, `drift` (signed seconds to the nearest grid slot, or `null` when off schedule) |
| `failure` | `at`, `reason` (the error message), `fatal` (boolean) |

Reading is lenient: blank lines, invalid JSON and records that fail validation are skipped, so a torn write cannot break `history`. Only the daemon writes failures; `once` records anchors only.

## Service backends

`serviceManager()` picks the backend from `os.platform()` (`linux`, `darwin`, `win32`; anything else throws `unsupported platform: <name>`) and passes it `process.execPath` and `[resolve(process.argv[1]), "daemon"]`. The interface:

| Method | Contract |
|---|---|
| `install()` | Write the definition, start the service |
| `uninstall()` | Stop the service, remove the definition |
| `status()` | A short string: `active`, `inactive`, or the backend's own state |
| `restart()` | Restart if installed and return `true`; return `false` when the service is not installed |

### systemd (Linux)

Writes `$XDG_CONFIG_HOME/systemd/user/claude-window.service` (default `~/.config/systemd/user/`):

```ini
[Unit]
Description=Pin the Claude Code 5h rate-limit window
After=network-online.target
StartLimitIntervalSec=3600
StartLimitBurst=3

[Service]
Type=simple
ExecStart=/usr/bin/node /usr/lib/node_modules/claude-window/dist/cli.js daemon
Restart=always
RestartSec=60
Nice=10

[Install]
WantedBy=default.target
```

`ExecStart` is the real `execPath` and script path, joined with spaces without quoting: a path containing spaces would not work. `install` then runs `loginctl enable-linger $USER` (on failure it warns `could not enable linger, the daemon stops when you log out` and continues), `systemctl --user daemon-reload` and `systemctl --user enable --now claude-window.service`. `uninstall` runs `disable --now` (warning `unit was not running` on failure), deletes the unit, and reloads.

`Restart=always` with `RestartSec=60` restarts the daemon after any exit, and the start limit stops it after three starts within an hour: a token that keeps failing fatally ends up with the unit in `failed` state instead of restarting forever. `status()` returns the output of `systemctl --user is-active`; when that exits non-zero it still uses the printed state (`failed`, `inactive`, `activating`), falling back to `inactive`.

### launchd (macOS)

Writes `~/Library/LaunchAgents/com.axelhamil.claude-window.plist` with label `com.axelhamil.claude-window`, `ProgramArguments` = execPath, script, `daemon`, `RunAtLoad` true, `KeepAlive` true, `ProcessType` `Background`, and `StandardOutPath`/`StandardErrorPath` both set to `<state dir>/daemon.log`. Values are XML-escaped. `install` boots out any existing agent (ignoring errors) then runs `launchctl bootstrap gui/<uid> <plist>`. `uninstall` runs `bootout` (warning `agent was not loaded`) and deletes the plist. `status()` is `active` if `launchctl print gui/<uid>/<label>` succeeds (the agent is loaded), otherwise `inactive`. The plist has no start limit, so the three-exits guard of the systemd unit has no equivalent here.

### Task Scheduler (Windows)

Creates task `claude-window` from a temporary UTF-16 XML file (deleted afterwards) with `schtasks /create /tn claude-window /xml <file> /f`, then starts it with `schtasks /run`. The XML defines: a logon trigger; `InteractiveToken` principal with `LeastPrivilege`; `MultipleInstancesPolicy` `IgnoreNew`; no battery restrictions; no execution time limit (`PT0S`); `Hidden`; `RestartOnFailure` every 5 minutes, up to 999 times; the action runs execPath with the quoted script path and `daemon`. `uninstall` runs `/end` (warning `task was not running`) then `/delete /f`. `status()` is `active` when `/query /fo list` reports `Status: Running`, `inactive` otherwise, and `not installed` when the query fails. The task does not redirect output, so the daemon's stderr lines are not persisted anywhere on Windows.

### restart() semantics

`claude-window schedule` calls `restart()` after saving so the new schedule is read.

- systemd: if the unit file does not exist, return `false` without touching systemd. Otherwise `systemctl --user reset-failed claude-window.service` (so a unit that hit its start limit can start again; best effort: if it fails, `warning: could not clear the failed state, <reason>` goes to stderr and the restart still happens) then `systemctl --user restart claude-window.service`, return `true`. If the restart itself throws, `schedule` exits 1 with `schedule saved, but restarting the <name> service failed: <reason>` followed by `restart it by hand, or run "claude-window install" again`; the schedule file is already written.
- launchd: if the plist does not exist, `false`. Otherwise `launchctl kickstart -k gui/<uid>/<label>`, `true`.
- Task Scheduler: if `/query` fails, `false`. Otherwise `/end` (warning if not running), `/run`, `true`.

`false` is what makes `schedule` print `service not installed yet, run "claude-window install" to start anchoring`.
