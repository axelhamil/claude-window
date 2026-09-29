# Scheduling

## The rolling window

Claude Code's usage limit runs on a rolling 5-hour window. The window does not start at a fixed hour: it starts on your first message after the previous window expired. Start work at 15:34 and your windows are 15:30-20:30, then 20:30-01:30. Start at 09:12 the next day and everything shifts. The reset drifts a little every day and tends to cut out mid-session.

## Why chaining matters

A long session only ever chains windows, so a 9-hour evening covers two. If a window had already been open before you sat down, the same 9 hours would span three.

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

The usual workaround is a cron job at 6am running `claude -p "hi"`. That opens one window and then stops helping: when it expires while you are away, the chain breaks and the next window starts whenever you type. The grid drifts again.

`claude-window` sends a 1-token request, reads the real reset timestamp from the response headers, sleeps until that moment plus an offset, and repeats:

```
anthropic-ratelimit-unified-5h-reset: 1786732200
anthropic-ratelimit-unified-5h-utilization: 0.36
anthropic-ratelimit-unified-7d-utilization: 0.04
```

Every window opens the instant the previous one closes (plus `CLAUDE_WINDOW_OFFSET`, default 120 s). Between probes the process is a sleeping timer, with no polling: 4 wakeups a day under the legacy 07:00-23:00 schedule (07:00, 12:02, 17:04, 22:06), 3 for a 9-17 schedule (05:30, 10:32, 15:34), plus retries after failures.

## Terms

| Term | Meaning |
|---|---|
| Anchor | The minute of the day the daemon first probes. It opens the first window of the day. |
| Reset | A moment when a window expires and the next probe opens a fresh one. Resets fall at `anchor + 5h`, `anchor + 10h`, and so on. |
| Fresh window | A window opened by the daemon: the anchor window plus one per reset. `freshWindows = resets + 1`. |
| Active until | The minute of the day after which the daemon stops probing until the next anchor. |

## The anchor algorithm

`planDay(range, offsetSeconds)` in `src/planner.ts` turns working hours `[start, end)` (minutes since midnight) into a `WorkPlan`. The goal: as many resets as possible strictly inside the working hours, so a fresh window opens during the day, with the first and last windows getting an equal share of it, while the whole chain still ends before the next day's anchor. `offsetSeconds` is `CLAUDE_WINDOW_OFFSET` (default 120), so a plan depends on it.

Constants: `WINDOW_MINUTES = 300`, `MIN_EDGE_MINUTES = 15`, `ACTIVE_SLACK_MINUTES = 90`, `MINUTES_PER_DAY = 1440`.

1. `duration = end - start`.
2. Cap the number of resets. Each hop of the chain lands `offset` late, and the window opened on the last reset must close before the next morning's anchor, so `resets + 1` hops of `300 + offset/60` minutes have to fit in a day: `maxResets = max(0, ceil(1440 / (300 + offset / 60)) - 2)`. That is 3 for every offset from 0 to 3599 seconds (so at most 4 fresh windows a day) and 2 for an offset of 3600.
3. Start from `k = min(ceil(duration / 300), maxResets)` resets. Resets are spaced 300 minutes apart, so `k` resets use `300 * (k - 1)` minutes and leave two equal edges: `edge = (duration - 300 * (k - 1)) / 2`. The edge is the gap from `start` to the first reset and from the last reset to `end`.
4. Edge balancing: while `k > 1` and `edge < MIN_EDGE_MINUTES`, decrease `k` by one and recompute `edge`. A reset a few minutes from the start or the end would give a sliver window that is nearly useless, so it is dropped.
5. The ideal anchor is `round(start + edge) - 300`: the first reset lands `edge` minutes after `start`, and the anchor is one window before it. `Math.round` rounds half up, so a fractional edge lands on the next minute.
6. Clamp: `anchorMinute = max(0, ideal)`. Working hours cannot cross midnight and neither can the anchor, so a very early start anchors at 00:00 instead of the evening before. `clamped` is true when `ideal < 0`.
7. Resets are recomputed from the real anchor: every `anchor + 300 * i` (`i >= 1`) that is strictly greater than `start` and strictly less than `end`, keeping at most the first `k`. After a clamp this can be fewer than `k`.
8. `lastOpening` is the last reset, or the anchor if there is none. The offset accumulates on every hop, so the last reset is probed `resets * offset` late: `activeUntilMinute = min(1440, lastOpening + ceil(resets * offset / 60) + 90)`.
9. `freshWindows = resets.length + 1`.
10. `partial` is true when `anchor > start` or `lastOpening + 300 < end`: the capped chain cannot cover the whole range. `schedule` then warns (below).

The daemon is active on that day for `anchorMinute <= minute < activeUntilMinute`.

### Why chaining stops after the last reset

The last reset opens the window that covers the end of your day. Probing again when that window expires would open windows past your working hours, and the last of them could still be live at the next morning's anchor, so the anchor would land inside a live window and do nothing (see [limitations](../README.md#honest-limitations)). The cap of step 2 guarantees that the window opened at the last reset closes before the next anchor. The daemon then stops probing once past `activeUntilMinute`.

The slack (`ACTIVE_SLACK_MINUTES = 90`, plus the accumulated offset) lets a late probe still open the last reset window: the probe runs at reset + offset, and a retry after a failure (see [Architecture](architecture.md#backoff-and-retry-after)) can be later still. After that probe the daemon sleeps until the window's reset, finds itself outside the active hours, and sleeps until the next anchor. In the 9-17 example the window opened at 15:34 expires at 20:34, long before the next 05:30 anchor.

## Worked examples

Real output of `claude-window schedule` with the default offset:

### 9-17

```
weekdays 09:00-17:00 -> anchor 05:30, resets 10:30, 15:30, 3 fresh windows
```

`duration = 480`, `k = min(ceil(1.6), 3) = 2`, `edge = (480 - 300) / 2 = 90`. Ideal anchor `540 + 90 - 300 = 330` (05:30). Resets 10:30 and 15:30, both inside; the last one leaves 90 minutes to 17:00. `activeUntil = 15:30 + ceil(2 * 2) + 90 = 17:04`.

```
05:30 ──────── 10:30 ──────── 15:30 ──────── 20:30
      [ w1    ][      w2      ][      w3      ]
         09:00 ▲                        17:00 ▲
```

The window opened at 05:30 is still fresh when you sit down at 9, then the chain gives you a new one at 10:30 and 15:30. Without an anchor, 9-17 gets two windows.

### 14-17

```
weekdays 14:00-17:00 -> anchor 10:30, resets 15:30, 2 fresh windows
```

`duration = 180`, `k = 1`, `edge = 90`. Anchor `840 + 90 - 300 = 630` (10:30), one reset at 15:30 in the middle of the afternoon. `activeUntil = 15:30 + 2 + 90 = 17:02`.

### 8-18

```
weekdays 08:00-18:00 -> anchor 05:30, resets 10:30, 15:30, 3 fresh windows
```

`duration = 600`, `k = 2`, `edge = 150`. The plan is identical to 9-17 because both are centred on 13:00; the 150-minute edges give 8:00-10:30 and 15:30-18:00.

### Long days and other cases

```
weekdays 06:00-24:00 -> anchor 05:00, resets 10:00, 15:00, 20:00, 4 fresh windows
weekdays 00:00-24:00 -> anchor 02:00, resets 07:00, 12:00, 17:00, 4 fresh windows
weekdays 09:30-17:45 -> anchor 06:08, resets 11:08, 16:08, 3 fresh windows
weekdays 09:00-19:10 -> anchor 06:35, resets 11:35, 16:35, 3 fresh windows
weekdays 02:00-06:00 -> anchor 00:00, resets 05:00, 2 fresh windows
weekdays 00:00-02:00 -> anchor 00:00, 1 fresh window
```

- 06:00-24:00 (cap): `ceil(1080 / 300) = 4` resets would be wanted, the cap allows 3. `edge = (1080 - 600) / 2 = 240`, anchor `round(360 + 240) - 300 = 300` (05:00), resets 10:00, 15:00, 20:00, `activeUntil = 20:00 + 6 + 90 = 21:36`. The last window (20:00-01:06) closes before the next 05:00 anchor.
- 00:00-24:00: the same cap, `partial`: the chain (02:00 to 22:06) cannot cover midnight to 02:00 nor 22:06 to 24:00. `schedule` prints `warning: weekday hours are longer than the windows one day can chain, the edges of the range are not covered` (`weekend` for the weekend range).
- 09:30-17:45: `duration = 495`, `edge = 97.5`, `round(570 + 97.5) - 300 = 368` (06:08, rounded up).
- 09:00-19:10 (`MIN_EDGE_MINUTES`): `duration = 610`, `ceil(2.03) = 3` resets would leave `edge = 5`, below 15, so `k` drops to 2 and `edge = 155`.
- 02:00-06:00 (clamp): `edge = 120`, so the ideal anchor is `round(120 + 120) - 300 = -60`, clamped to 00:00. The only reset left is 05:00, so the day has 2 windows, and `schedule` warns: `warning: weekday hours start too early to anchor the day before, anchoring at 00:00` (`weekend` for the weekend range).
- 00:00-02:00: no reset fits, so the day has one window (`1 fresh window`, singular). The ideal anchor is also before midnight, so `schedule` prints the same clamp warning.

## Weekdays and weekend

`schedule.json` holds two ranges, `weekdays` and `weekend`, each a range or `null` (off).

- `weekdays` is Monday to Friday, `weekend` is Saturday and Sunday, judged on the machine's local date (`Date.getDay()`).
- A day marked `off` has no plan: the daemon is never active, sleeps through it and wakes at the next planned anchor. `nextStartOfDay` scans up to 8 days ahead for the next anchor; if none exists it throws `the schedule has no active day, run claude-window schedule`.
- At least one of the two must have hours: `the schedule needs working hours on weekdays, on the weekend, or both`.
- `claude-window schedule --weekdays <range>` alone keeps the current `weekend` value from `schedule.json` (`off` when there is no usable file yet), and the other way round. Only these two flags are accepted; anything else is rejected.
- The two ranges are planned independently, so weekdays and weekend can have different anchors.

Example: `--weekdays 9-17 --weekend off` sleeps from Friday's last window through the weekend to Monday 05:30.

Ranges cannot cross midnight (`18-2` is rejected: the end must come after the start). A schedule where you work past midnight has to end at `24`.

## Drift and "on grid"

The grid is the set of expected reset times: for each day around a reset, the plan's anchor plus `0..4` times 5 hours (`SLOTS_PER_DAY = 5`). `driftSeconds(resetAt)` is the signed distance from `resetAt` to the nearest slot, looking at the day before, the day of and the day after the reset (each with its own weekday or weekend plan). It is `null` when none of those days has a plan; that is shown as `off schedule`.

A reset is `on grid` when `|drift| <= gridTolerance`, with

```
gridTolerance = max(900, 4 * CLAUDE_WINDOW_OFFSET)   seconds
```

so 15 minutes at the default offset, and it scales up if you raise the offset. Beyond that, `status` prints `drifted +N min off grid` (or `-N`).

Expected small drift: the first probe fires at the anchor exactly, each following one at reset + offset, so every chained window opens `offset` seconds after the previous slot and the drift grows by 120 s per link: the resets of a 9-17 day sit at 0, 2 and 4 minutes off their slots. It stays well within tolerance for the number of windows in a day.

A large drift usually means a window was already open at the anchor (you were typing, or the daemon started mid-day). The daemon cannot move an open window; it reads its reset and chains from there. The grid restores itself at the next anchor after the last chained window has expired. See [Operations](operations.md#drifted-off-grid).

The drift value stored in each `history.jsonl` anchor record is computed with the configuration in force at that time; `history` compares it with the tolerance of the current configuration.

## Legacy environment schedule

Without `schedule.json`, the daemon behaves as before `schedule` existed. Both ranges (weekdays and weekend) are the same plan, built from two environment variables:

- `CLAUDE_WINDOW_START` (default `7`, integer 0-23): the anchor hour, so `anchorMinute = START * 60`.
- `CLAUDE_WINDOW_END` (default `23`, integer 1-24): the hour after which chaining stops, so `activeUntilMinute = END * 60`.
- `END` must be greater than `START`.

There is no planner in this mode: every day anchors at `START:00` and keeps chaining while the clock is before `END:00`. `status` shows `schedule (environment) every day: anchor 07:00, active until 23:00`. As soon as `schedule.json` exists, `START` and `END` are ignored (and not even validated). See [Configuration](configuration.md#precedence).
