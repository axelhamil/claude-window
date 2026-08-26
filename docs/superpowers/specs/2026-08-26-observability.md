# Spec — claude-window observability & resilience

**Status:** approved (Axel, 2026-08-26)
**Version target:** 0.5.0

## Problem

The daemon has been running on a Raspberry Pi for 12 days without a single restart, and the
anchor holds (reset pinned at 22:00). None of that could be *verified* from the tool itself:

- `report()` writes to stderr. Under `systemd --user` with no persistent journal, that output is
  discarded. There is no record of the last 12 anchors — the only evidence was the mtime of
  `state.json`.
- `status` prints the last known reset but never says whether that reset is *where it should be*.
  A window that has drifted 40 minutes off the grid looks exactly like one that is on it.
- A fatal credential error (the `sk-ant-oat` token expires) is retried every 300s forever, silently.
  The daemon looks healthy while doing nothing useful.
- If the daemon dies on a headless machine, nobody learns about it.
- `status` is human-only text, so it cannot feed a statusline or a script.

## Goals

1. **G1 — Durable history.** Every anchor and every probe failure is appended to a local JSONL
   file, capped so it cannot grow without bound. A `history` command renders it.
2. **G2 — Drift is visible.** `status` (and the history rendering) states whether a reset sits on
   the configured grid, and by how much it is off when it does not.
3. **G3 — Fatal errors surface.** Authentication/authorization failures stop the retry loop with a
   clear message instead of looping. Transient failures back off exponentially with jitter.
4. **G4 — Liveness is observable from outside.** An optional heartbeat URL is pinged after every
   anchor, and on failure, so a dead-man switch can alert.
5. **G5 — Machine-readable status.** `status --json` emits a stable, versioned single-line JSON
   object.
6. **G6 — Repo hygiene.** `coverage/` leaves version control; the two unreleased refactors ship.

## Non-goals

- No remote/central log aggregation. Everything stays on the machine.
- No new runtime dependency. The package ships with zero `dependencies` and that stays true.
- No change to the anchoring algorithm itself. Scheduling behaviour is unchanged except for the
  retry delay.
- No log rotation daemon, no logrotate integration — the cap is enforced in-process.

## Requirements

### R1 — History file

- Location: `historyFile()` = `<stateDir>/history.jsonl`, alongside `state.json`.
- Append-only via `appendFileSync` (`O_APPEND`, atomic on POSIX for writes below `PIPE_BUF`).
  Records are ~120 bytes, far under the 4096-byte Linux limit, so concurrent daemons cannot
  interleave a line.
- One JSON object per line, newline-terminated, UTF-8.
- Two record shapes, discriminated by `event`:
  - `{"event":"anchor","at":<epoch>,"resetAt":<epoch>,"usage5h":<number>,"usage7d":<number>,"drift":<seconds>}`
  - `{"event":"failure","at":<epoch>,"reason":"<string>","fatal":<boolean>}`
- `at` is the moment the record was written. `drift` is signed seconds from the nearest grid slot
  (see R2), and is present only on `anchor`.
- Cap: 500 records. When the file exceeds the cap it is rewritten keeping the newest 500.
  The check runs on append; the rewrite is atomic (write temp, rename).
- A corrupted line must not crash a read: unparseable lines are skipped when rendering.
  This is deliberately more lenient than `state.json`, which throws — history is diagnostic data,
  losing one line is preferable to losing the command.

### R2 — Drift

- The grid is derived from config: slots at `startHour:00 + n × 5h`. With the default
  `startHour 7` that is 07:00, 12:00, 17:00, 22:00.
- **`offsetSeconds` is deliberately not part of the grid.** It delays the *probe*, not the reset.
  Observed on the Pi: a probe at 17:02:01 returned `resetAt` = 22:00:00 — a 4h58 window, not 5h.
  The API rounds the reset down to a round time rather than setting it to `probe + 5h`, which is
  what keeps the anchor from creeping forward by `offsetSeconds` on every cycle. Building the
  offset into the grid would report a permanent phantom drift.
- `driftSeconds(resetAt, config)` returns signed seconds to the *nearest* slot, positive when the
  reset is late. Grid slots are computed on the local calendar day of `resetAt`, including the
  neighbouring slots either side of midnight so a 00:30 reset compares against 22:00, not 07:00.
- A reset is "on grid" when `|drift| <= gridTolerance(config)`, where
  `gridTolerance(config) = max(MIN_GRID_TOLERANCE_SECONDS, 4 × config.offsetSeconds)` and
  `MIN_GRID_TOLERANCE_SECONDS = 900`. The 15-minute floor exists because the exact rounding rule
  the API applies is **not known**: two observed resets landed on 22:00:00 and 20:30:00, which is
  consistent with rounding to the half hour, but two samples prove nothing. Fifteen minutes is
  wide enough to absorb half-hour rounding without hiding a real slip of an hour or more.
  Characterising the rule properly is precisely what the history file makes possible — revisit
  this constant once there are a few hundred records.
- The tolerance is **offset-aware**, not fixed, because the offset the daemon deliberately keeps
  out of the grid (previous bullet) does not vanish — it accumulates in `driftSeconds` across a
  day. Each anchor probes at `resetAt + offsetSeconds`, and the API's next `resetAt` is computed
  from that probe time, so successive anchors within the same day drift 0, `offset`, `2×offset`,
  `3×offset` seconds late before the morning re-anchor at exactly `startHour` resets the phase
  (4 slots between re-anchors, so at most 3 accumulations, i.e. up to `4×offset` including the
  0-drift first slot's own margin). At the default `offsetSeconds=120` that ceiling is 480s,
  comfortably under the 900s floor, so today's behaviour is unchanged. At
  `CLAUDE_WINDOW_OFFSET=600` — a value the config validator explicitly allows, up to 3600 — the
  ceiling is 2400s, and a fixed 900s tolerance would report `drifted +20 min` / `+30 min` on the
  third and fourth anchor of every single day of a perfectly healthy daemon. Making the tolerance
  scale with the offset (capped below by the 900s floor for small offsets) fixes that false
  positive without touching the grid itself or the anchoring algorithm.

### R3 — Error classification

- `fetchWindow` distinguishes:
  - **fatal**: HTTP 400, 401, 403, 404 — the token is invalid, expired, revoked, or the request
    itself is wrong. Retrying cannot fix any of them.
  - **transient**: everything else — network errors, timeouts, 408, 425, 429 without usable
    headers, and 5xx.
- 200 and 429 *with* rate-limit headers remain successes — that is existing behaviour and must not
  regress.
- On a transient error the daemon applies **full jitter** backoff, the AWS-recommended form:
  `sleep = random(0, min(cap, base × 2^attempt))`, floored at `MIN_SLEEP_SECONDS` so a burst of
  failures cannot hammer the endpoint. `base` = 60s, `cap` = 1800s. The attempt counter resets
  after any successful anchor. This replaces the current flat `RETRY_SECONDS = 300`.
- If the response carries `Retry-After` (integer seconds or HTTP-date), it wins over the computed
  backoff whenever it is larger.
- On a fatal error the daemon writes a `failure` record with `fatal: true`, reports it, pings the
  heartbeat failure endpoint if configured, and exits non-zero.
- Because the systemd unit uses `Restart=always`, a fatal exit alone would loop every 60s forever.
  The generated unit therefore also sets `StartLimitIntervalSec=3600` and `StartLimitBurst=3`, so
  three fatal exits within an hour put the unit in `failed` and stop it — which `status` then
  reports. launchd and Task Scheduler have no equivalent; for those the heartbeat is the signal,
  and the README says so.

### R4 — Heartbeat

- Config: `CLAUDE_WINDOW_PING_URL`, absent by default. Must parse as an `http:` or `https:` URL,
  otherwise `loadConfig` throws like any other invalid setting.
- After a successful anchor: `GET <url>`. After a failure: `GET <url>/fail`.
- 10s timeout, and **any** ping error is swallowed after being reported — a monitoring outage must
  never break anchoring.
- Compatible with healthchecks.io (`https://hc-ping.com/<uuid>`) and Better Stack
  (`https://uptime.betterstack.com/api/v1/heartbeat/<token>`), which share the `/fail` convention.
  Both rate-limit at 5 pings/min; the daemon pings 4–6 times a day, so the limit is unreachable.

### R5 — `--json`

- `claude-window status --json` prints exactly one line of JSON to stdout, no trailing prose:
  `{"schema":1,"service":{"name":"systemd","status":"active"},"window":{...}|null,"onGrid":<bool>|null,"drift":<seconds>|null}`
- `window` mirrors the snapshot (`resetAt`, `usage5h`, `usage7d`, `probedAt`) and is `null` before
  the first probe, in which case `onGrid` and `drift` are `null` too.
- `schema` is a version integer; any breaking change to the shape bumps it.
- Human output is unchanged when the flag is absent.
- `history --json` emits NDJSON: the raw records, one compact object per line, unparseable lines
  filtered out. No enclosing array — each line stands alone, per the current CLI convention.
- JSON goes to stdout; every diagnostic stays on stderr, so `status --json | jq` is always valid.

### R6 — Hygiene

- `coverage/` is removed from the index and added to `.gitignore`.
- The two unreleased refactors on `main` are released together with this work as `0.5.0`.
- README gains a section documenting `history`, `--json`, and `CLAUDE_WINDOW_PING_URL`.

## Verification

The feature is done when, on the Raspberry Pi:

- `claude-window history` shows one line per anchor since the upgrade, each marked on-grid.
- `claude-window status --json | jq .onGrid` returns `true`.
- Revoking the token makes the daemon exit with a message naming the credential, visible in
  `systemctl --user status`, and increments `NRestarts`.
- `pnpm check` passes, coverage thresholds hold.
