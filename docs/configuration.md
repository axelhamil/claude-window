# Configuration

## schedule.json

Written by `claude-window schedule`, read by the daemon at start and by `status`/`history`.

```json
{
  "weekdays": "09:00-17:00",
  "weekend": null
}
```

- `weekdays` (Monday to Friday) and `weekend` (Saturday and Sunday) are each a range string or `null`.
- `saveSchedule` always writes zero-padded `HH:MM-HH:MM`, or `null` for off, with two-space indentation and a trailing newline. The write goes through a per-process temporary file (`schedule.json.<pid>.tmp`), renamed over the target and removed if the write fails.
- You can edit the file by hand. On load, each value goes through the same parser as the command line, so `"9-17"` is accepted, and `null` or an absent key means off. A value that is neither a string nor `null` is rejected.
- At least one of the two must be a range.
- Changes apply when the daemon restarts. `claude-window schedule` restarts the service for you; after a manual edit, restart it yourself (`systemctl --user restart claude-window`). The plan is computed from the ranges and `CLAUDE_WINDOW_OFFSET` at that moment; it is not stored in the file.

Load errors. `status` and `history` report them (`schedule INVALID: <message>`) and keep going; the daemon logs the message and retries every 600 s; `once` and `schedule`'s own checks fail with the message (`schedule` ignores a broken current file with a warning):

| Situation | Message |
|---|---|
| Not JSON | `<path> is not valid json, run "claude-window schedule" to rewrite it` |
| JSON but not an object (`null`, a number, an array, ...) | `<path> is invalid, run "claude-window schedule" to rewrite it` |
| Non-string, non-null value | `<path> is invalid (weekdays: expected a range like "09:00-17:00" or null)` |
| Bad range | `<path> is invalid (weekdays: invalid range "18-9": ...)` |
| Both off | `the schedule needs working hours on weekdays, on the weekend, or both` |

### Range syntax

`parseRange` (case-insensitive, surrounding spaces ignored):

| Input | Meaning |
|---|---|
| `9-17` | 09:00 to 17:00 |
| `9:30-17:45` | 09:30 to 17:45 |
| `9h-17h30` | 09:00 to 17:30 |
| `9h30-18` | 09:30 to 18:00 |
| `off`, `none`, `no`, empty | no working hours (`null`) |

Times are `H`, `HH`, `H:MM`, `H:` (minutes 00), `HhMM` or `Hh`, with one or two hour digits and exactly two minute digits. Hours run 0-24 and minutes 0-59; `24` is only valid as `24` or `24:00` and is how a range ends at midnight. The end must be strictly after the start, on the same day, so ranges cannot cross midnight. Anything else (a missing dash, more than one dash, non-numeric parts) fails with a message that shows the input.

## Environment variables

Read at process start by `loadConfig`. An unset or blank value means the default. An invalid value makes the command that reads it fail with `invalid configuration (<NAME>: expected ..., got "<value>")`; that includes `status`, `history` in text mode and `schedule` (which needs the offset); `history --json` reads no configuration, not just the daemon. The daemon does not exit on it: it retries every 600 s.

| Variable | Default | Valid | Meaning |
|---|---|---|---|
| `CLAUDE_WINDOW_START` | `7` | integer 0-23 | Legacy. Hour the daily anchor fires. Ignored, and not validated, while a valid `schedule.json` exists; if that file is broken, `status` and `history` fall back to these and validate them |
| `CLAUDE_WINDOW_END` | `23` | integer 1-24, greater than `START` | Legacy. Stop re-anchoring after this hour. Same conditions. A violation reads `CLAUDE_WINDOW_END must be greater than CLAUDE_WINDOW_START` |
| `CLAUDE_WINDOW_OFFSET` | `120` | integer 0-3600 | Seconds to wait past a reset before probing. Also feeds the [planner](scheduling.md#the-anchor-algorithm) (reset cap and active slack) and sets the [grid tolerance](scheduling.md#drift-and-on-grid): `max(900, 4 * offset)` seconds |
| `CLAUDE_WINDOW_MODEL` | `claude-haiku-4-5-20251001` | any non-blank string | Model used for the probe. Trimmed; not checked against a list |
| `CLAUDE_WINDOW_PING_URL` | none | `http:` or `https:` URL | Heartbeat URL. See [below](#heartbeat-url) |
| `CLAUDE_CODE_OAUTH_TOKEN` | none | token string | Overrides the token file. See [Token](#token) |
| `XDG_CONFIG_HOME`, `XDG_STATE_HOME` | `~/.config`, `~/.local/state` | path | Linux only, move the config and state directories ([locations](#file-locations)) |
| `APPDATA`, `LOCALAPPDATA` | Windows defaults | path | Windows only, same purpose |

Numbers must be integers: `120.5` and `2m` are rejected.

The service does not carry your shell environment. The generated units and tasks define no environment variables, so a variable exported in your shell reaches `status` and `history` (which read it when you run them) but not the daemon. To set one for the daemon on Linux, use a systemd drop-in, for example `systemctl --user edit claude-window` with:

```ini
[Service]
Environment=CLAUDE_WINDOW_OFFSET=180
```

then `systemctl --user restart claude-window`. A drop-in survives `install`, which only rewrites `claude-window.service`. On macOS the plist is regenerated by every `install`, so a hand-added `EnvironmentVariables` key is overwritten. Run `status` with the same variables to keep its on-grid verdict consistent with the daemon.

## Precedence

1. `schedule.json`, when the file exists: the plan comes from it, and `CLAUDE_WINDOW_START` and `CLAUDE_WINDOW_END` are ignored.
2. Otherwise the legacy variables, with their defaults (7 and 23): every day anchors at `START:00` and is active until `END:00`, weekdays and weekend alike ([details](scheduling.md#legacy-environment-schedule)).

`CLAUDE_WINDOW_OFFSET`, `CLAUDE_WINDOW_MODEL` and `CLAUDE_WINDOW_PING_URL` apply in both cases. For the token: `CLAUDE_CODE_OAUTH_TOKEN` first, then the token file.

## File locations

| File | Linux | macOS | Windows |
|---|---|---|---|
| Config directory | `$XDG_CONFIG_HOME/claude-window`, default `~/.config/claude-window` | `~/Library/Application Support/claude-window` | `%APPDATA%\claude-window` (default `~\AppData\Roaming\claude-window`) |
| State directory | `$XDG_STATE_HOME/claude-window`, default `~/.local/state/claude-window` | `~/Library/Application Support/claude-window` | `%LOCALAPPDATA%\claude-window` (default `~\AppData\Local\claude-window`) |
| `token` | config | config | config |
| `schedule.json` | config | config | config |
| `state.json` | state | state | state |
| `history.jsonl` | state | state | state |
| `daemon.log` | not used | state, written by launchd | not used |

On macOS both directories are the same. Service definitions live elsewhere: see [Architecture](architecture.md#service-backends).

## Token

- `claude-window login <token>` writes `<config dir>/token` containing the token and a newline, creating the directory if needed, with mode `0600` (an explicit `chmod` follows the write, so an existing file with looser permissions is tightened; on Windows POSIX modes have little effect).
- The token grants full access to your Claude account. It never leaves your machine except in the `Authorization` header of the probe to `https://api.anthropic.com/v1/messages`. Rotate it with `claude setup-token` if it leaks.
- Lookup order at daemon start and for `once`: `CLAUDE_CODE_OAUTH_TOKEN` (trimmed, if non-empty), then the file. All whitespace is stripped from the file content, which must start with `sk-ant-oat`.
- Errors: `no token found. run "claude-window login" or set CLAUDE_CODE_OAUTH_TOKEN` and `<path> does not contain a valid token (expected sk-ant-oat...)`.
- The token is read once when the daemon starts. After `login` with a fresh token, restart the service ([Operations](operations.md#token-expiry-and-refresh)).
- With `CLAUDE_CODE_OAUTH_TOKEN`, the value is not validated for the `sk-ant-oat` prefix.

## Heartbeat URL

Set `CLAUDE_WINDOW_PING_URL` to a healthchecks.io or Better Stack heartbeat URL to be alerted when the daemon stops anchoring.

- After every successful anchor (`daemon` loop and `once`): `GET <url>`.
- After every failed probe, transient or fatal: `GET <url>/fail`, built by stripping trailing slashes from the URL and appending `/fail`. A URL carrying a query string therefore ends up as `...?x=1/fail`.
- 10-second timeout per ping. Redirects follow the fetch default.
- A non-2xx response is reported on stderr as `heartbeat ping returned HTTP <status>`; a network error as `heartbeat ping failed: <reason>`. Neither interrupts anchoring or changes the loop's behaviour.
- The value must parse as an `http:` or `https:` URL, else `invalid configuration (CLAUDE_WINDOW_PING_URL: expected an http(s) url, got "...")`.
- When the daemon is dead nothing pings, which is the point: the monitor raises the alert when the expected ping does not arrive. Set the monitor's period above the longest expected sleep (about five hours, plus a day-long gap overnight and on days off).
