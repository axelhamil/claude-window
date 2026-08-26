# claude-window Observability & Resilience Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the daemon's behaviour verifiable from outside — a durable anchor history, drift detection, fatal-vs-transient error handling, an optional heartbeat, and machine-readable output.

**Architecture:** Keep the existing shape: pure functions in `scheduling.ts` / `window.ts`, side effects behind the `DaemonPorts` interface injected into `runDaemon`, thin `cli.ts` on top. New effects (history append, heartbeat ping) become new ports so `daemon.test.ts` keeps testing the loop with zero I/O. Two new modules — `src/history.ts` and `src/heartbeat.ts` — each own one responsibility and one file.

**Tech Stack:** TypeScript 5.7 (ESM, `.js` import specifiers), Node ≥22, vitest 3, biome, bun for the build, semantic-release.

**Spec:** `docs/superpowers/specs/2026-08-26-observability.md`

## Global Constraints

- **Zero runtime dependencies.** `package.json` `dependencies` stays absent. Node built-ins only.
- **ESM import specifiers end in `.js`** (`import { x } from "./paths.js"`), even for `.ts` sources.
- **Coverage thresholds must keep passing:** statements 90, branches 90, functions 85, lines 90, measured over `src/**` excluding `src/cli.ts` and `src/service/**`.
- **Every new pure function is tested in `tests/<module>.test.ts`**, following the existing style: `describe` per exported function, `it` sentences that state the behaviour, no snapshot tests.
- **Tests that touch the filesystem** override `XDG_STATE_HOME` to a `mkdtempSync` directory in `beforeEach` and restore it in `afterEach` — copy the harness at the top of `tests/state.test.ts`.
- **Commit messages follow Conventional Commits**, lowercase subject (commitlint rejects capitals). `feat:` for user-visible additions, `refactor:`/`chore:` otherwise.
- **Run `pnpm check`** (biome + tsc + vitest + build) before the final release task.
- **No new CLI output on stdout except data.** Diagnostics go to stderr.

---

### Task 1: Repo hygiene

**Files:**
- Modify: `.gitignore`
- Delete from index: `coverage/`

**Interfaces:**
- Consumes: nothing.
- Produces: nothing consumed by later tasks. Independent, done first so later diffs stay readable.

- [ ] **Step 1: Confirm the problem**

```bash
git ls-files coverage | head -3
```

Expected: three paths printed (`coverage/base.css`, …) — the generated coverage report is tracked.

- [ ] **Step 2: Add the ignore rule**

Append to `.gitignore`, after the `dist` line:

```
coverage
```

- [ ] **Step 3: Drop it from the index without deleting the files**

```bash
git rm -r --cached coverage
```

- [ ] **Step 4: Verify**

```bash
git ls-files coverage
git status --short | head -5
```

Expected: `git ls-files coverage` prints nothing; `git status` shows the deletions staged and no untracked `coverage/` noise.

- [ ] **Step 5: Commit**

```bash
git add .gitignore
git commit -m "chore: stop tracking the generated coverage report"
```

---

### Task 2: History file path

**Files:**
- Modify: `src/paths.ts`
- Test: `tests/paths.test.ts`

**Interfaces:**
- Consumes: `stateDir()` from `src/paths.ts`.
- Produces: `historyFile(): string` — absolute path to `<stateDir>/history.jsonl`. Used by Task 4.

- [ ] **Step 1: Write the failing test**

Add to `tests/paths.test.ts`, inside the same `describe` block that already asserts on `stateFile()` and `logFile()` (it sets `XDG_STATE_HOME` to `/s`), and add `historyFile` to the import list at the top of the file:

```ts
it("puts the history next to the state file", () => {
  expect(historyFile()).toBe(join("/s", "claude-window", "history.jsonl"));
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run tests/paths.test.ts`
Expected: FAIL — `historyFile is not a function` (or a TypeScript error on the import).

- [ ] **Step 3: Write minimal implementation**

Add to `src/paths.ts`, next to `stateFile()`:

```ts
export function historyFile(): string {
  return join(stateDir(), "history.jsonl");
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run tests/paths.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/paths.ts tests/paths.test.ts
git commit -m "feat: locate the anchor history next to the state file"
```

---

### Task 3: Drift against the grid

**Files:**
- Modify: `src/scheduling.ts`
- Test: `tests/scheduling.test.ts`

**Interfaces:**
- Consumes: `Config` from `src/config.ts` (`startHour`, `endHour`, `offsetSeconds`, `model`).
- Produces:
  - `GRID_TOLERANCE_SECONDS: number` (= 900)
  - `driftSeconds(resetAt: number, config: Config): number` — signed seconds from the nearest grid slot, positive when the reset is late.
  - `onGrid(resetAt: number, config: Config): boolean` — `Math.abs(driftSeconds(...)) <= GRID_TOLERANCE_SECONDS`.
  Used by Tasks 4, 7 and 8.

The grid slots are `startHour:00` plus `n × 5h`, on the local calendar day of `resetAt`. Slots from
the previous and next day are included as candidates so a reset just after midnight compares
against the late-evening slot rather than the morning one.

**`offsetSeconds` is not part of the grid** — read the spec's R2 before touching this. The offset
delays the probe, not the reset: a probe at 17:02:01 on the reference machine returned a reset of
22:00:00, so the API rounds the reset to a round time instead of setting it to `probe + 5h`.
Folding the offset into the grid would report a permanent phantom drift of `n × offsetSeconds`.
The 15-minute tolerance covers the (unconfirmed) half-hour rounding.

- [ ] **Step 1: Write the failing tests**

Add to `tests/scheduling.test.ts`. The file already defines `config` (startHour 7, endHour 23,
offsetSeconds 120) and the `at(hour, minute)` helper building a local `Date` on 2026-08-14; reuse
both, and add `driftSeconds`, `onGrid` and `GRID_TOLERANCE_SECONDS` to the existing import.

```ts
function epoch(hour: number, minute = 0): number {
  return Math.floor(at(hour, minute).getTime() / 1000);
}

describe("driftSeconds", () => {
  it("is zero on an exact grid slot", () => {
    expect(driftSeconds(epoch(12, 0), config)).toBe(0);
  });

  it("is positive when the reset runs late", () => {
    expect(driftSeconds(epoch(12, 5), config)).toBe(300);
  });

  it("is negative when the reset runs early", () => {
    expect(driftSeconds(epoch(11, 55), config)).toBe(-300);
  });

  it("measures against the nearest slot, not the first one", () => {
    expect(driftSeconds(epoch(17, 1), config)).toBe(60);
  });

  it("ignores the probe offset, which delays the probe and not the reset", () => {
    const shifted = { ...config, offsetSeconds: 600 };
    expect(driftSeconds(epoch(12, 0), shifted)).toBe(0);
  });

  it("compares a reset just after midnight to the evening slot", () => {
    const justAfterMidnight = Math.floor(new Date(2026, 7, 15, 0, 2, 0, 0).getTime() / 1000);
    expect(driftSeconds(justAfterMidnight, config)).toBe(7320);
  });

  it("follows the configured start hour", () => {
    const shifted = { ...config, startHour: 9 };
    expect(driftSeconds(epoch(14, 0), shifted)).toBe(0);
  });
});

describe("onGrid", () => {
  it("accepts a reset inside the tolerance", () => {
    expect(onGrid(epoch(12, 6), config)).toBe(true);
  });

  it("accepts the reset observed in production, a probe at 17:02 resetting at 22:00", () => {
    expect(onGrid(epoch(22, 0), config)).toBe(true);
  });

  it("accepts the tolerance boundary itself", () => {
    expect(onGrid(epoch(12, 15), config)).toBe(true);
  });

  it("rejects a reset past the tolerance", () => {
    expect(onGrid(epoch(12, 40), config)).toBe(false);
  });

  it("rejects a reset that drifted early past the tolerance", () => {
    expect(onGrid(epoch(11, 20), config)).toBe(false);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm vitest run tests/scheduling.test.ts`
Expected: FAIL — `driftSeconds is not a function`.

- [ ] **Step 3: Write minimal implementation**

Add to `src/scheduling.ts`:

```ts
export const GRID_TOLERANCE_SECONDS = 300;

const SLOTS_PER_DAY = 5;
const HOUR_SECONDS = 3600;
const WINDOW_HOURS = 5;

function gridSlots(resetAt: number, config: Config): number[] {
  const day = new Date(resetAt * 1000);
  day.setHours(config.startHour, 0, 0, 0);
  const anchor = Math.floor(day.getTime() / 1000) + config.offsetSeconds;

  const slots: number[] = [];
  for (let index = -SLOTS_PER_DAY; index <= SLOTS_PER_DAY * 2; index += 1) {
    slots.push(anchor + index * WINDOW_HOURS * HOUR_SECONDS);
  }
  return slots;
}

export function driftSeconds(resetAt: number, config: Config): number {
  let nearest = 0;
  for (const slot of gridSlots(resetAt, config)) {
    const candidate = resetAt - slot;
    if (nearest === 0 || Math.abs(candidate) < Math.abs(nearest)) nearest = candidate;
  }
  return nearest;
}

export function onGrid(resetAt: number, config: Config): boolean {
  return Math.abs(driftSeconds(resetAt, config)) <= GRID_TOLERANCE_SECONDS;
}
```

Note the loop seeds `nearest` with `0`, which is also the "perfect slot" value — that is fine
because a candidate of `0` is already the minimum possible distance and no later candidate can
beat it.

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm vitest run tests/scheduling.test.ts`
Expected: PASS, all existing scheduling tests still green.

- [ ] **Step 5: Commit**

```bash
git add src/scheduling.ts tests/scheduling.test.ts
git commit -m "feat: measure how far a reset drifted from the configured grid"
```

---

### Task 4: History records

**Files:**
- Create: `src/history.ts`
- Create: `tests/history.test.ts`

**Interfaces:**
- Consumes: `historyFile()` from Task 2.
- Produces:
  - `type HistoryRecord = AnchorRecord | FailureRecord`
  - `interface AnchorRecord { event: "anchor"; at: number; resetAt: number; usage5h: number; usage7d: number; drift: number }`
  - `interface FailureRecord { event: "failure"; at: number; reason: string; fatal: boolean }`
  - `HISTORY_LIMIT: number` (= 500)
  - `appendRecord(record: HistoryRecord): void`
  - `readRecords(): HistoryRecord[]` — oldest first, unparseable lines skipped.
  Used by Tasks 7 and 8.

- [ ] **Step 1: Write the failing tests**

Create `tests/history.test.ts`:

```ts
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  appendRecord,
  type HistoryRecord,
  HISTORY_LIMIT,
  readRecords,
} from "../src/history.js";
import { historyFile } from "../src/paths.js";

let dir: string;
let previous: string | undefined;

beforeEach(() => {
  previous = process.env.XDG_STATE_HOME;
  dir = mkdtempSync(join(tmpdir(), "claude-window-history-"));
  process.env.XDG_STATE_HOME = dir;
});

afterEach(() => {
  if (previous === undefined) delete process.env.XDG_STATE_HOME;
  else process.env.XDG_STATE_HOME = previous;
  rmSync(dir, { recursive: true, force: true });
});

function anchorAt(at: number): HistoryRecord {
  return { event: "anchor", at, resetAt: at + 18000, usage5h: 0.1, usage7d: 0.02, drift: 0 };
}

describe("readRecords", () => {
  it("returns nothing before the first append", () => {
    expect(readRecords()).toEqual([]);
  });

  it("returns records oldest first", () => {
    appendRecord(anchorAt(1000));
    appendRecord(anchorAt(2000));
    expect(readRecords().map((record) => record.at)).toEqual([1000, 2000]);
  });

  it("skips a corrupted line instead of throwing", () => {
    appendRecord(anchorAt(1000));
    writeFileSync(historyFile(), `${readFileSync(historyFile(), "utf8")}{ not json\n`, "utf8");
    appendRecord(anchorAt(3000));
    expect(readRecords().map((record) => record.at)).toEqual([1000, 3000]);
  });

  it("skips a well-formed line whose shape is wrong", () => {
    writeFileSync(historyFile(), `${JSON.stringify({ event: "anchor" })}\n`, "utf8");
    expect(readRecords()).toEqual([]);
  });
});

describe("appendRecord", () => {
  it("creates the state directory on first write", () => {
    appendRecord(anchorAt(1000));
    expect(readRecords()).toHaveLength(1);
  });

  it("keeps failure records with their reason and severity", () => {
    appendRecord({ event: "failure", at: 1000, reason: "probe rejected with HTTP 401", fatal: true });
    expect(readRecords()[0]).toMatchObject({ event: "failure", fatal: true });
  });

  it("writes one line per record", () => {
    appendRecord(anchorAt(1000));
    appendRecord(anchorAt(2000));
    expect(readFileSync(historyFile(), "utf8").trimEnd().split("\n")).toHaveLength(2);
  });

  it("caps the file at the limit, dropping the oldest records", () => {
    for (let index = 0; index < HISTORY_LIMIT + 10; index += 1) appendRecord(anchorAt(index));
    const records = readRecords();
    expect(records).toHaveLength(HISTORY_LIMIT);
    expect(records[0]?.at).toBe(10);
    expect(records.at(-1)?.at).toBe(HISTORY_LIMIT + 9);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm vitest run tests/history.test.ts`
Expected: FAIL — cannot resolve `../src/history.js`.

- [ ] **Step 3: Write minimal implementation**

Create `src/history.ts`:

```ts
import { appendFileSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { historyFile } from "./paths.js";

export const HISTORY_LIMIT = 500;

export interface AnchorRecord {
  event: "anchor";
  at: number;
  resetAt: number;
  usage5h: number;
  usage7d: number;
  drift: number;
}

export interface FailureRecord {
  event: "failure";
  at: number;
  reason: string;
  fatal: boolean;
}

export type HistoryRecord = AnchorRecord | FailureRecord;

function isRecord(value: unknown): value is HistoryRecord {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Record<string, unknown>;
  if (!Number.isInteger(candidate.at)) return false;

  if (candidate.event === "anchor") {
    return (
      Number.isInteger(candidate.resetAt) &&
      typeof candidate.usage5h === "number" &&
      typeof candidate.usage7d === "number" &&
      typeof candidate.drift === "number"
    );
  }
  return (
    candidate.event === "failure" &&
    typeof candidate.reason === "string" &&
    typeof candidate.fatal === "boolean"
  );
}

function parse(contents: string): HistoryRecord[] {
  const records: HistoryRecord[] = [];
  for (const line of contents.split("\n")) {
    if (line.trim() === "") continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    if (isRecord(parsed)) records.push(parsed);
  }
  return records;
}

function read(path: string): string | null {
  try {
    return readFileSync(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

function truncate(path: string): void {
  const records = parse(read(path) ?? "");
  if (records.length <= HISTORY_LIMIT) return;

  const kept = records.slice(-HISTORY_LIMIT);
  const temporary = `${path}.tmp`;
  writeFileSync(temporary, `${kept.map((record) => JSON.stringify(record)).join("\n")}\n`, "utf8");
  renameSync(temporary, path);
}

export function appendRecord(record: HistoryRecord): void {
  const path = historyFile();
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, `${JSON.stringify(record)}\n`, "utf8");
  truncate(path);
}

export function readRecords(): HistoryRecord[] {
  return parse(read(historyFile()) ?? "");
}
```

`appendFileSync` opens with `O_APPEND`, which POSIX makes atomic for writes below `PIPE_BUF`
(4096 bytes on Linux). Records are ~120 bytes, so two daemons cannot interleave a line.

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm vitest run tests/history.test.ts`
Expected: PASS, 8 tests.

- [ ] **Step 5: Commit**

```bash
git add src/history.ts tests/history.test.ts
git commit -m "feat: record every anchor and probe failure in a capped jsonl history"
```

---

### Task 5: Fatal vs transient probe failures

**Files:**
- Modify: `src/window.ts`
- Test: `tests/window.test.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces:
  - `class ProbeError extends Error { readonly fatal: boolean; readonly retryAfterSeconds: number | null }`
  - `classifyStatus(status: number): "success" | "fatal" | "transient"`
  - `parseRetryAfter(raw: string | null, nowMs?: number): number | null`
  `fetchWindow` keeps its signature `(token: string, model: string) => Promise<RateLimitWindow>` but now throws `ProbeError`. Used by Tasks 6 and 7.

Fatal: 400, 401, 403, 404 — retrying cannot fix them. Transient: everything else, including 408,
425, 5xx, and network errors. 200 and 429 stay successes when the rate-limit headers are present:
that is the whole trick of the tool and must not regress.

- [ ] **Step 1: Write the failing tests**

Add to `tests/window.test.ts`, extending its existing import from `../src/window.js`:

```ts
describe("classifyStatus", () => {
  it("treats 200 as a success", () => {
    expect(classifyStatus(200)).toBe("success");
  });

  it("treats a rate-limited 429 as a success, because the headers are what we came for", () => {
    expect(classifyStatus(429)).toBe("success");
  });

  it.each([400, 401, 403, 404])("treats %i as fatal", (status) => {
    expect(classifyStatus(status)).toBe("fatal");
  });

  it.each([408, 425, 500, 502, 503, 504])("treats %i as transient", (status) => {
    expect(classifyStatus(status)).toBe("transient");
  });
});

describe("parseRetryAfter", () => {
  it("reads a delay in whole seconds", () => {
    expect(parseRetryAfter("120")).toBe(120);
  });

  it("reads an HTTP-date as a delay from now", () => {
    const now = Date.parse("2026-08-14T12:00:00Z");
    expect(parseRetryAfter("Fri, 14 Aug 2026 12:02:00 GMT", now)).toBe(120);
  });

  it("returns null when the header is absent", () => {
    expect(parseRetryAfter(null)).toBeNull();
  });

  it("returns null on garbage", () => {
    expect(parseRetryAfter("soon")).toBeNull();
  });

  it("returns null on a date already in the past", () => {
    const now = Date.parse("2026-08-14T12:00:00Z");
    expect(parseRetryAfter("Fri, 14 Aug 2026 11:00:00 GMT", now)).toBeNull();
  });
});

describe("fetchWindow failures", () => {
  it("marks an expired token as fatal", async () => {
    const response = new Response("", { status: 401 });
    vi.stubGlobal("fetch", vi.fn(async () => response));
    await expect(fetchWindow("sk-ant-oat-x", "model")).rejects.toMatchObject({ fatal: true });
  });

  it("marks a server error as transient", async () => {
    const response = new Response("", { status: 503 });
    vi.stubGlobal("fetch", vi.fn(async () => response));
    await expect(fetchWindow("sk-ant-oat-x", "model")).rejects.toMatchObject({ fatal: false });
  });

  it("carries Retry-After through to the caller", async () => {
    const response = new Response("", { status: 503, headers: { "retry-after": "900" } });
    vi.stubGlobal("fetch", vi.fn(async () => response));
    await expect(fetchWindow("sk-ant-oat-x", "model")).rejects.toMatchObject({
      retryAfterSeconds: 900,
    });
  });

  it("treats missing rate-limit headers on a 200 as transient", async () => {
    const response = new Response("", { status: 200 });
    vi.stubGlobal("fetch", vi.fn(async () => response));
    await expect(fetchWindow("sk-ant-oat-x", "model")).rejects.toMatchObject({ fatal: false });
  });
});
```

Add `afterEach(() => vi.unstubAllGlobals());` near the top of the file if it is not there already,
and make sure `vi` is imported from `vitest`.

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm vitest run tests/window.test.ts`
Expected: FAIL — `classifyStatus is not a function`.

- [ ] **Step 3: Write minimal implementation**

In `src/window.ts`, add above `fetchWindow`:

```ts
const FATAL_STATUSES = new Set([400, 401, 403, 404]);

export class ProbeError extends Error {
  readonly fatal: boolean;
  readonly retryAfterSeconds: number | null;

  constructor(message: string, fatal: boolean, retryAfterSeconds: number | null = null) {
    super(message);
    this.name = "ProbeError";
    this.fatal = fatal;
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

export function classifyStatus(status: number): "success" | "fatal" | "transient" {
  if (status === 200 || status === 429) return "success";
  return FATAL_STATUSES.has(status) ? "fatal" : "transient";
}

export function parseRetryAfter(raw: string | null, nowMs = Date.now()): number | null {
  if (raw === null || raw.trim() === "") return null;

  const seconds = Number(raw);
  if (Number.isInteger(seconds) && seconds > 0) return seconds;

  const target = Date.parse(raw);
  if (Number.isNaN(target)) return null;

  const delay = Math.round((target - nowMs) / 1000);
  return delay > 0 ? delay : null;
}
```

Then replace the two `throw new Error(...)` statements in `fetchWindow`:

```ts
  if (classifyStatus(response.status) !== "success") {
    throw new ProbeError(
      `probe rejected with HTTP ${response.status}`,
      classifyStatus(response.status) === "fatal",
      parseRetryAfter(response.headers.get("retry-after")),
    );
  }

  const resetAt = Number(response.headers.get(HEADER.resetAt));
  if (!Number.isInteger(resetAt) || resetAt <= 0) {
    throw new ProbeError(
      `missing rate-limit headers on a HTTP ${response.status} response`,
      false,
    );
  }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm vitest run tests/window.test.ts`
Expected: PASS, including the pre-existing tests on 200/429 successes.

- [ ] **Step 5: Commit**

```bash
git add src/window.ts tests/window.test.ts
git commit -m "feat: tell an expired token apart from a transient probe failure"
```

---

### Task 6: Full-jitter backoff

**Files:**
- Modify: `src/scheduling.ts`
- Test: `tests/scheduling.test.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces:
  - `BACKOFF_BASE_SECONDS: number` (= 60), `BACKOFF_CAP_SECONDS: number` (= 1800)
  - `backoffSeconds(attempt: number, retryAfterSeconds: number | null, random?: () => number): number`
  Used by Task 7. `RETRY_SECONDS` is deleted; `MIN_SLEEP_SECONDS` stays and becomes the backoff floor.

Full jitter, the form AWS recommends: `random(0, min(cap, base × 2^attempt))`, floored at
`MIN_SLEEP_SECONDS` so repeated failures cannot hammer the endpoint. `Retry-After` wins when larger.

- [ ] **Step 1: Write the failing tests**

Add to `tests/scheduling.test.ts` (add `backoffSeconds`, `BACKOFF_BASE_SECONDS`,
`BACKOFF_CAP_SECONDS` and `MIN_SLEEP_SECONDS` to the existing import):

```ts
describe("backoffSeconds", () => {
  const always = (value: number) => () => value;

  it("never sleeps less than the floor", () => {
    expect(backoffSeconds(1, null, always(0))).toBe(MIN_SLEEP_SECONDS);
  });

  it("spreads the first attempt over the base delay", () => {
    expect(backoffSeconds(1, null, always(1))).toBe(BACKOFF_BASE_SECONDS * 2);
  });

  it("doubles the ceiling on every attempt", () => {
    expect(backoffSeconds(3, null, always(1))).toBe(BACKOFF_BASE_SECONDS * 8);
  });

  it("stops growing at the cap", () => {
    expect(backoffSeconds(20, null, always(1))).toBe(BACKOFF_CAP_SECONDS);
  });

  it("jitters between the floor and the ceiling", () => {
    const value = backoffSeconds(4, null, always(0.5));
    expect(value).toBeGreaterThanOrEqual(MIN_SLEEP_SECONDS);
    expect(value).toBeLessThanOrEqual(BACKOFF_CAP_SECONDS);
  });

  it("obeys Retry-After when it asks for longer", () => {
    expect(backoffSeconds(1, 3600, always(0))).toBe(3600);
  });

  it("ignores Retry-After when the backoff already waits longer", () => {
    expect(backoffSeconds(20, 10, always(1))).toBe(BACKOFF_CAP_SECONDS);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm vitest run tests/scheduling.test.ts`
Expected: FAIL — `backoffSeconds is not a function`.

- [ ] **Step 3: Write minimal implementation**

In `src/scheduling.ts`, delete `export const RETRY_SECONDS = 300;` and add:

```ts
export const BACKOFF_BASE_SECONDS = 60;
export const BACKOFF_CAP_SECONDS = 1800;

export function backoffSeconds(
  attempt: number,
  retryAfterSeconds: number | null,
  random: () => number = Math.random,
): number {
  const ceiling = Math.min(BACKOFF_CAP_SECONDS, BACKOFF_BASE_SECONDS * 2 ** attempt);
  const jittered = Math.round(random() * ceiling);
  const backoff = Math.max(MIN_SLEEP_SECONDS, jittered);
  return Math.max(backoff, retryAfterSeconds ?? 0);
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm vitest run tests/scheduling.test.ts`
Expected: PASS. `tests/daemon.test.ts` may now fail to compile on the removed `RETRY_SECONDS` import — Task 7 fixes that; if it blocks this task, comment out the import line and restore it in Task 7.

- [ ] **Step 5: Commit**

```bash
git add src/scheduling.ts tests/scheduling.test.ts
git commit -m "feat: back off with full jitter instead of a flat five minutes"
```

---

### Task 7: Heartbeat pings

**Files:**
- Create: `src/heartbeat.ts`
- Create: `tests/heartbeat.test.ts`
- Modify: `src/config.ts`
- Test: `tests/config.test.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces:
  - `Config` gains `pingUrl: string | null` (default `null`, from `CLAUDE_WINDOW_PING_URL`).
  - `ping(url: string | null, outcome: "success" | "fail", fetchImpl?: typeof fetch): Promise<string | null>` — resolves to `null` when there was nothing to do or the ping succeeded, or to a human-readable error message that the caller reports. It never rejects.
  Used by Task 8.

Every `Config` literal in the test suites gains `pingUrl: null` — `tests/scheduling.test.ts` and
`tests/daemon.test.ts` both declare one at the top.

- [ ] **Step 1: Write the failing config test**

Add to `tests/config.test.ts`:

```ts
it("has no heartbeat by default", () => {
  delete process.env.CLAUDE_WINDOW_PING_URL;
  expect(loadConfig().pingUrl).toBeNull();
});

it("accepts an https heartbeat url", () => {
  process.env.CLAUDE_WINDOW_PING_URL = "https://hc-ping.com/abc";
  expect(loadConfig().pingUrl).toBe("https://hc-ping.com/abc");
});

it("rejects a url that is not http", () => {
  process.env.CLAUDE_WINDOW_PING_URL = "ftp://example.com/ping";
  expect(() => loadConfig()).toThrow("CLAUDE_WINDOW_PING_URL");
});

it("rejects something that is not a url at all", () => {
  process.env.CLAUDE_WINDOW_PING_URL = "hc-ping.com/abc";
  expect(() => loadConfig()).toThrow("CLAUDE_WINDOW_PING_URL");
});
```

Make sure the file's existing `afterEach` clears `CLAUDE_WINDOW_PING_URL` along with the other
`CLAUDE_WINDOW_*` variables it already restores.

- [ ] **Step 2: Write the failing heartbeat test**

Create `tests/heartbeat.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";
import { ping } from "../src/heartbeat.js";

describe("ping", () => {
  it("does nothing when no url is configured", async () => {
    const fetchImpl = vi.fn();
    expect(await ping(null, "success", fetchImpl as unknown as typeof fetch)).toBeNull();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("calls the url as-is on success", async () => {
    const fetchImpl = vi.fn(async () => new Response("OK"));
    await ping("https://hc-ping.com/abc", "success", fetchImpl as unknown as typeof fetch);
    expect(fetchImpl.mock.calls[0]?.[0]).toBe("https://hc-ping.com/abc");
  });

  it("appends /fail on failure", async () => {
    const fetchImpl = vi.fn(async () => new Response("OK"));
    await ping("https://hc-ping.com/abc", "fail", fetchImpl as unknown as typeof fetch);
    expect(fetchImpl.mock.calls[0]?.[0]).toBe("https://hc-ping.com/abc/fail");
  });

  it("does not double the slash when the url already ends with one", async () => {
    const fetchImpl = vi.fn(async () => new Response("OK"));
    await ping("https://hc-ping.com/abc/", "fail", fetchImpl as unknown as typeof fetch);
    expect(fetchImpl.mock.calls[0]?.[0]).toBe("https://hc-ping.com/abc/fail");
  });

  it("reports a rejected ping instead of throwing", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error("getaddrinfo ENOTFOUND");
    });
    const message = await ping("https://hc-ping.com/abc", "success", fetchImpl as unknown as typeof fetch);
    expect(message).toContain("heartbeat");
  });

  it("reports a non-2xx response instead of throwing", async () => {
    const fetchImpl = vi.fn(async () => new Response("nope", { status: 500 }));
    const message = await ping("https://hc-ping.com/abc", "success", fetchImpl as unknown as typeof fetch);
    expect(message).toContain("500");
  });
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `pnpm vitest run tests/heartbeat.test.ts tests/config.test.ts`
Expected: FAIL — cannot resolve `../src/heartbeat.js`, and `pingUrl` is not on `Config`.

- [ ] **Step 4: Write the implementation**

Create `src/heartbeat.ts`:

```ts
const TIMEOUT_MS = 10_000;

export async function ping(
  url: string | null,
  outcome: "success" | "fail",
  fetchImpl: typeof fetch = fetch,
): Promise<string | null> {
  if (url === null) return null;

  const target = outcome === "fail" ? `${url.replace(/\/+$/, "")}/fail` : url;

  try {
    const response = await fetchImpl(target, {
      method: "GET",
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!response.ok) return `heartbeat ping returned HTTP ${response.status}`;
    return null;
  } catch (error) {
    return `heartbeat ping failed: ${error instanceof Error ? error.message : String(error)}`;
  }
}
```

In `src/config.ts`, add `pingUrl: string | null;` to the `Config` interface, `pingUrl: null` to
`DEFAULTS`, and this reader plus its use in `loadConfig`:

```ts
function readUrl(name: string, raw: string | undefined): string | null {
  if (raw === undefined || raw.trim() === "") return null;

  const value = raw.trim();
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`invalid configuration (${name}: expected an http(s) url, got "${raw}")`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(`invalid configuration (${name}: expected an http(s) url, got "${raw}")`);
  }
  return value;
}
```

```ts
  const pingUrl = readUrl("CLAUDE_WINDOW_PING_URL", process.env.CLAUDE_WINDOW_PING_URL);
```

and `pingUrl: pingUrl ?? DEFAULTS.pingUrl,` in the returned `config` object.

- [ ] **Step 5: Add `pingUrl: null` to every test Config literal**

Files: `tests/scheduling.test.ts`, `tests/daemon.test.ts`. Both declare
`const config: Config = { startHour: 7, endHour: 23, offsetSeconds: 120, model: "..." };` — add the
field so the suites keep type-checking.

- [ ] **Step 6: Run tests to verify they pass**

Run: `pnpm vitest run tests/heartbeat.test.ts tests/config.test.ts && pnpm typecheck`
Expected: PASS, and no TypeScript error.

- [ ] **Step 7: Commit**

```bash
git add src/heartbeat.ts src/config.ts tests/heartbeat.test.ts tests/config.test.ts tests/scheduling.test.ts tests/daemon.test.ts
git commit -m "feat: ping an optional heartbeat url after every anchor"
```

---

### Task 8: Wire the daemon loop

**Files:**
- Modify: `src/daemon.ts`
- Test: `tests/daemon.test.ts`

**Interfaces:**
- Consumes: `appendRecord`/`HistoryRecord` (Task 4), `driftSeconds` (Task 3), `backoffSeconds` (Task 6), `ProbeError` (Task 5), `ping` (Task 7).
- Produces: `DaemonPorts` gains three members:
  - `record(entry: HistoryRecord): void`
  - `ping(outcome: "success" | "fail"): Promise<string | null>`
  - `random(): number`
  `runDaemon` keeps its signature but now rejects with the original error on a fatal probe failure instead of looping. Used by Task 9.

- [ ] **Step 1: Write the failing tests**

Add to `tests/daemon.test.ts`. Its `ports()` helper builds a `DaemonPorts` with overrides — extend
it with the three new members first:

```ts
    record: vi.fn(),
    ping: vi.fn(async () => null),
    random: () => 1,
```

then add:

```ts
describe("runDaemon history and resilience", () => {
  it("records every anchor with its drift", async () => {
    const { signal } = abortAfter(1);
    const port = ports();
    await runDaemon("token", config, signal, port);
    expect(port.record).toHaveBeenCalledWith(
      expect.objectContaining({ event: "anchor", resetAt: window.resetAt }),
    );
  });

  it("records a transient failure without stopping", async () => {
    const { signal } = abortAfter(1);
    const port = ports({
      probe: vi.fn(async () => {
        throw new ProbeError("probe rejected with HTTP 503", false);
      }),
    });
    await runDaemon("token", config, signal, port);
    expect(port.record).toHaveBeenCalledWith(
      expect.objectContaining({ event: "failure", fatal: false }),
    );
  });

  it("stops on a fatal failure instead of retrying forever", async () => {
    const controller = new AbortController();
    const port = ports({
      probe: vi.fn(async () => {
        throw new ProbeError("probe rejected with HTTP 401", true);
      }),
    });
    await expect(runDaemon("token", config, controller.signal, port)).rejects.toThrow("401");
    expect(port.record).toHaveBeenCalledWith(
      expect.objectContaining({ event: "failure", fatal: true }),
    );
  });

  it("pings the heartbeat after a successful anchor", async () => {
    const { signal } = abortAfter(1);
    const port = ports();
    await runDaemon("token", config, signal, port);
    expect(port.ping).toHaveBeenCalledWith("success");
  });

  it("pings the failure endpoint when the probe fails", async () => {
    const { signal } = abortAfter(1);
    const port = ports({
      probe: vi.fn(async () => {
        throw new ProbeError("probe rejected with HTTP 503", false);
      }),
    });
    await runDaemon("token", config, signal, port);
    expect(port.ping).toHaveBeenCalledWith("fail");
  });

  it("reports a broken heartbeat but keeps anchoring", async () => {
    const { signal } = abortAfter(1);
    const port = ports({ ping: vi.fn(async () => "heartbeat ping failed: down") });
    await runDaemon("token", config, signal, port);
    expect(port.messages.some((message) => message.includes("heartbeat"))).toBe(true);
  });

  it("backs off further on each consecutive failure", async () => {
    const { signal } = abortAfter(3);
    const waits: number[] = [];
    const port = ports({
      probe: vi.fn(async () => {
        throw new ProbeError("probe rejected with HTTP 503", false);
      }),
      wait: vi.fn(async (seconds: number) => {
        waits.push(seconds);
      }),
    });
    await runDaemon("token", config, signal, port);
    expect(waits[1]).toBeGreaterThan(waits[0] ?? 0);
  });
});
```

Import `ProbeError` from `../src/window.js` at the top of the file.

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm vitest run tests/daemon.test.ts`
Expected: FAIL — `port.record is not a function`, and the fatal test loops rather than rejecting.

- [ ] **Step 3: Write the implementation**

In `src/daemon.ts`, extend the imports and the ports:

```ts
import { appendRecord, type HistoryRecord } from "./history.js";
import { ping } from "./heartbeat.js";
import {
  backoffSeconds,
  clock,
  driftSeconds,
  nextStartOfDay,
  secondsUntilNextProbe,
  withinActiveHours,
} from "./scheduling.js";
import { fetchWindow, ProbeError, type RateLimitWindow, windowStart } from "./window.js";
```

```ts
export interface DaemonPorts {
  probe(token: string, model: string): Promise<RateLimitWindow>;
  persist(window: RateLimitWindow): void;
  record(entry: HistoryRecord): void;
  ping(outcome: "success" | "fail"): Promise<string | null>;
  report(message: string): void;
  wait(seconds: number, signal: AbortSignal): Promise<void>;
  nowSeconds(): number;
  random(): number;
}
```

`defaultPorts` needs the three new members; `ping` closes over the config, so build the ports from
it instead of exporting a frozen literal:

```ts
export function createPorts(config: Config): DaemonPorts {
  return {
    probe: fetchWindow,
    persist: saveSnapshot,
    record: appendRecord,
    ping: (outcome) => ping(config.pingUrl, outcome),
    report: writeToStderr,
    wait: waitWithTimer,
    nowSeconds: () => Math.floor(Date.now() / 1000),
    random: Math.random,
  };
}
```

Delete the old `defaultPorts` constant and make `ports` a required parameter of `anchor` and
`runDaemon` — `cli.ts` (Task 9) is the only caller and will pass `createPorts(config)`.

`anchor` records the anchor and pings:

```ts
export async function anchor(
  token: string,
  config: Config,
  ports: DaemonPorts,
): Promise<RateLimitWindow> {
  const window = await ports.probe(token, config.model);
  ports.persist(window);

  const drift = driftSeconds(window.resetAt, config);
  ports.record({
    event: "anchor",
    at: ports.nowSeconds(),
    resetAt: window.resetAt,
    usage5h: window.usage5h,
    usage7d: window.usage7d,
    drift,
  });
  ports.report(
    `anchored ${clock(windowStart(window))}->${clock(window.resetAt)} ` +
      `usage5=${window.usage5h} usage7=${window.usage7d} drift=${drift}s`,
  );

  const pingError = await ports.ping("success");
  if (pingError) ports.report(pingError);

  return window;
}
```

The loop tracks the attempt counter and rethrows fatals:

```ts
export async function runDaemon(
  token: string,
  config: Config,
  signal: AbortSignal,
  ports: DaemonPorts,
): Promise<void> {
  let attempt = 0;

  while (!signal.aborted) {
    if (!withinActiveHours(config)) {
      const wakeAt = nextStartOfDay(config.startHour);
      ports.report(`outside active hours, sleeping until ${clock(wakeAt)}`);
      await ports.wait(wakeAt - ports.nowSeconds(), signal);
      continue;
    }

    try {
      const window = await anchor(token, config, ports);
      attempt = 0;
      const seconds = secondsUntilNextProbe(window, config, ports.nowSeconds() * 1000);
      ports.report(`sleeping ${seconds}s until ${clock(ports.nowSeconds() + seconds)}`);
      await ports.wait(seconds, signal);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      const fatal = error instanceof ProbeError && error.fatal;

      ports.record({ event: "failure", at: ports.nowSeconds(), reason, fatal });
      ports.report(`probe failed: ${reason}`);

      const pingError = await ports.ping("fail");
      if (pingError) ports.report(pingError);

      if (fatal) {
        ports.report("this will not fix itself, refresh the token with: claude setup-token");
        throw error;
      }

      attempt += 1;
      const retryAfter = error instanceof ProbeError ? error.retryAfterSeconds : null;
      const seconds = backoffSeconds(attempt, retryAfter, ports.random);
      ports.report(`retrying in ${seconds}s`);
      await ports.wait(seconds, signal);
    }
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm vitest run tests/daemon.test.ts`
Expected: PASS, including the pre-existing loop tests once they pass `createPorts`-shaped ports.

- [ ] **Step 5: Commit**

```bash
git add src/daemon.ts tests/daemon.test.ts
git commit -m "feat: record, ping and back off from the daemon loop"
```

---

### Task 9: CLI — `history`, `--json`, fatal exit code

**Files:**
- Modify: `src/cli.ts`
- Create: `tests/cli-render.test.ts`
- Create: `src/render.ts`

**Interfaces:**
- Consumes: `readRecords` (Task 4), `driftSeconds`/`onGrid` (Task 3), `readSnapshot` (existing), `createPorts` (Task 8).
- Produces:
  - `src/render.ts`: `statusJson(snapshot, service, config)`, `statusLines(snapshot, service, config)`, `historyLines(records)`.
  - `cli.ts` gains `history [--json] [--limit N]` and `status [--json]`.

`cli.ts` is excluded from coverage, so the formatting lives in `src/render.ts` where it *is*
measured. `cli.ts` keeps only argument parsing and I/O.

- [ ] **Step 1: Write the failing tests**

Create `tests/cli-render.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import type { Config } from "../src/config.js";
import type { HistoryRecord } from "../src/history.js";
import { historyLines, statusJson, statusLines } from "../src/render.js";
import type { Snapshot } from "../src/state.js";

const config: Config = {
  startHour: 7,
  endHour: 23,
  offsetSeconds: 120,
  model: "claude-haiku-4-5-20251001",
  pingUrl: null,
};

const service = { name: "systemd", status: "active" };

function snapshotAt(hour: number, minute: number): Snapshot {
  const resetAt = Math.floor(new Date(2026, 7, 14, hour, minute, 0, 0).getTime() / 1000);
  return { resetAt, usage5h: 0.34, usage7d: 0.03, probedAt: resetAt - 18000 };
}

describe("statusJson", () => {
  it("is a single line of parseable json", () => {
    const line = statusJson(snapshotAt(12, 2), service, config);
    expect(line.includes("\n")).toBe(false);
    expect(() => JSON.parse(line)).not.toThrow();
  });

  it("carries a schema version", () => {
    expect(JSON.parse(statusJson(snapshotAt(12, 2), service, config)).schema).toBe(1);
  });

  it("reports an on-grid window", () => {
    const parsed = JSON.parse(statusJson(snapshotAt(12, 2), service, config));
    expect(parsed.onGrid).toBe(true);
    expect(parsed.drift).toBe(0);
  });

  it("reports a drifted window", () => {
    const parsed = JSON.parse(statusJson(snapshotAt(12, 40), service, config));
    expect(parsed.onGrid).toBe(false);
    expect(parsed.drift).toBe(2280);
  });

  it("nulls the window fields before the first probe", () => {
    const parsed = JSON.parse(statusJson(null, service, config));
    expect(parsed.window).toBeNull();
    expect(parsed.onGrid).toBeNull();
    expect(parsed.drift).toBeNull();
  });
});

describe("statusLines", () => {
  it("says when the window sits on the grid", () => {
    expect(statusLines(snapshotAt(12, 2), service, config).join("\n")).toContain("on grid");
  });

  it("quantifies the drift when it has slipped", () => {
    expect(statusLines(snapshotAt(12, 40), service, config).join("\n")).toContain("38 min");
  });

  it("explains that nothing has been probed yet", () => {
    expect(statusLines(null, service, config).join("\n")).toContain("no probe");
  });
});

describe("historyLines", () => {
  const records: HistoryRecord[] = [
    { event: "anchor", at: 1786700000, resetAt: 1786732200, usage5h: 0.3, usage7d: 0.02, drift: 0 },
    { event: "failure", at: 1786700100, reason: "probe rejected with HTTP 503", fatal: false },
  ];

  it("renders one line per record", () => {
    expect(historyLines(records)).toHaveLength(2);
  });

  it("marks an on-grid anchor", () => {
    expect(historyLines(records)[0]).toContain("on grid");
  });

  it("surfaces the failure reason", () => {
    expect(historyLines(records)[1]).toContain("503");
  });

  it("says so when there is nothing to show", () => {
    expect(historyLines([]).join("")).toContain("no anchor recorded");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm vitest run tests/cli-render.test.ts`
Expected: FAIL — cannot resolve `../src/render.js`.

- [ ] **Step 3: Write the implementation**

Create `src/render.ts`:

```ts
import type { Config } from "./config.js";
import type { HistoryRecord } from "./history.js";
import { clock, driftSeconds, GRID_TOLERANCE_SECONDS, onGrid } from "./scheduling.js";
import type { Snapshot } from "./state.js";

export const STATUS_SCHEMA = 1;

export interface ServiceView {
  name: string;
  status: string;
}

function describeDrift(drift: number): string {
  if (Math.abs(drift) <= GRID_TOLERANCE_SECONDS) return "on grid";
  const minutes = Math.round(Math.abs(drift) / 60);
  return `drifted ${drift > 0 ? "+" : "-"}${minutes} min off grid`;
}

export function statusJson(
  snapshot: Snapshot | null,
  service: ServiceView,
  config: Config,
): string {
  const drift = snapshot === null ? null : driftSeconds(snapshot.resetAt, config);
  return JSON.stringify({
    schema: STATUS_SCHEMA,
    service,
    window: snapshot,
    onGrid: snapshot === null ? null : onGrid(snapshot.resetAt, config),
    drift,
  });
}

export function statusLines(
  snapshot: Snapshot | null,
  service: ServiceView,
  config: Config,
): string[] {
  const lines = [`service (${service.name}): ${service.status}`];

  if (snapshot === null) {
    lines.push("no probe recorded yet");
    return lines;
  }

  const minutes = Math.round((snapshot.resetAt - Date.now() / 1000) / 60);
  const when = minutes >= 0 ? `in ${minutes} min` : `${-minutes} min ago`;
  lines.push(
    `window -> reset ${clock(snapshot.resetAt)} (${when}), ` +
      describeDrift(driftSeconds(snapshot.resetAt, config)),
  );
  lines.push(`usage 5h ${snapshot.usage5h} | 7d ${snapshot.usage7d}`);
  return lines;
}

export function historyLines(records: HistoryRecord[]): string[] {
  if (records.length === 0) return ["no anchor recorded yet"];

  return records.map((record) =>
    record.event === "anchor"
      ? `${clock(record.at)}  anchor   reset ${clock(record.resetAt)}  ` +
        `usage5=${record.usage5h}  ${describeDrift(record.drift)}`
      : `${clock(record.at)}  ${record.fatal ? "FATAL   " : "failure "} ${record.reason}`,
  );
}
```

In `src/cli.ts`: import `readRecords`, the three render functions, `createPorts`, and `loadConfig`;
replace `showStatus` and add the `history` command. Argument parsing stays flag-order-independent
via a small helper.

```ts
function hasFlag(args: string[], flag: string): boolean {
  return args.includes(flag);
}

function showStatus(args: string[]): void {
  const manager = serviceManager();
  const service = { name: manager.name, status: manager.status() };
  const snapshot = readSnapshot();
  const config = loadConfig();

  if (hasFlag(args, "--json")) {
    console.log(statusJson(snapshot, service, config));
    return;
  }
  for (const line of statusLines(snapshot, service, config)) console.log(line);
  if (snapshot === null) console.log(`(${stateFile()})`);
}

function showHistory(args: string[]): void {
  const limitIndex = args.indexOf("--limit");
  const limit = limitIndex === -1 ? 20 : Number(args[limitIndex + 1]);
  if (!Number.isInteger(limit) || limit <= 0) {
    throw new Error("--limit expects a positive integer");
  }

  const records = readRecords().slice(-limit);

  if (hasFlag(args, "--json")) {
    for (const record of records) console.log(JSON.stringify(record));
    return;
  }
  for (const line of historyLines(records)) console.log(line);
}
```

Wire the switch:

```ts
    case "status":
      showStatus(rest);
      return 0;

    case "history":
      showHistory(rest);
      return 0;
```

and update the two commands that build ports:

```ts
    case "once": {
      const config = loadConfig();
      await anchor(loadToken(), config, createPorts(config));
      return 0;
    }

    case "daemon": {
      const config = loadConfig();
      const controller = new AbortController();
      for (const signal of ["SIGINT", "SIGTERM"] as const) {
        process.on(signal, () => controller.abort());
      }
      await runDaemon(loadToken(), config, controller.signal, createPorts(config));
      return 0;
    }
```

Add the two new lines to `USAGE`:

```
  claude-window history         what the daemon has anchored so far
```

and document `--json` on the `status` line:

```
  claude-window status [--json] last known window, costs nothing
```

A fatal probe error propagates out of `runDaemon` into the existing `main().catch(...)`, which
already writes the message to stderr and sets `process.exitCode = 1`. No extra handling needed.

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm vitest run tests/cli-render.test.ts && pnpm typecheck`
Expected: PASS, no TypeScript error.

- [ ] **Step 5: Exercise the CLI by hand**

```bash
pnpm build
node dist/cli.js history
node dist/cli.js status --json
node dist/cli.js status --json | node -e "process.stdin.once('data', (d) => JSON.parse(d))"
```

Expected: `history` prints `no anchor recorded yet` on a clean machine, `status --json` prints one
parseable line, and the pipe does not throw.

- [ ] **Step 6: Commit**

```bash
git add src/render.ts src/cli.ts tests/cli-render.test.ts
git commit -m "feat: add a history command and json status output"
```

---

### Task 10: Stop the systemd restart loop on fatal exits

**Files:**
- Modify: `src/service/systemd.ts`
- Test: `tests/systemd.test.ts` (create)

**Interfaces:**
- Consumes: `systemdManager(executable, args)` (existing).
- Produces: no new exports. The generated unit gains `StartLimitIntervalSec=3600` and `StartLimitBurst=3` in `[Unit]`.

With `Restart=always` and `RestartSec=60`, a daemon that exits on an expired token would restart
every minute forever. systemd's start limiter turns three fatal exits within an hour into a
`failed` unit, which `status` then surfaces. The directives belong in `[Unit]`, not `[Service]`.

- [ ] **Step 1: Write the failing test**

Create `tests/systemd.test.ts`:

```ts
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("node:child_process", () => ({ execFileSync: vi.fn(() => "active") }));

const { systemdManager } = await import("../src/service/systemd.js");

let dir: string;
let previous: string | undefined;

beforeEach(() => {
  previous = process.env.XDG_CONFIG_HOME;
  dir = mkdtempSync(join(tmpdir(), "claude-window-systemd-"));
  process.env.XDG_CONFIG_HOME = dir;
});

afterEach(() => {
  if (previous === undefined) delete process.env.XDG_CONFIG_HOME;
  else process.env.XDG_CONFIG_HOME = previous;
  rmSync(dir, { recursive: true, force: true });
});

function install(): string {
  systemdManager("/usr/bin/node", ["/opt/claude-window/cli.js", "daemon"]).install();
  return readFileSync(join(dir, "systemd", "user", "claude-window.service"), "utf8");
}

describe("systemdManager.install", () => {
  it("gives up after three fatal exits in an hour", () => {
    const unit = install();
    expect(unit).toContain("StartLimitIntervalSec=3600");
    expect(unit).toContain("StartLimitBurst=3");
  });

  it("puts the start limit in the unit section, where systemd reads it", () => {
    const unit = install();
    const unitSection = unit.slice(unit.indexOf("[Unit]"), unit.indexOf("[Service]"));
    expect(unitSection).toContain("StartLimitIntervalSec=3600");
  });

  it("still restarts on ordinary failures", () => {
    expect(install()).toContain("Restart=always");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run tests/systemd.test.ts`
Expected: FAIL — the unit does not contain `StartLimitIntervalSec`.

- [ ] **Step 3: Write minimal implementation**

In `src/service/systemd.ts`, extend the `[Unit]` block of the generated file:

```ts
          "[Unit]",
          "Description=Pin the Claude Code 5h rate-limit window",
          "After=network-online.target",
          "StartLimitIntervalSec=3600",
          "StartLimitBurst=3",
          "",
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run tests/systemd.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/service/systemd.ts tests/systemd.test.ts
git commit -m "fix: stop restarting the daemon forever after a fatal token error"
```

---

### Task 11: Document and release

**Files:**
- Modify: `README.md`
- Verify: whole repo

**Interfaces:**
- Consumes: everything above.
- Produces: a released `0.5.0` on npm.

- [ ] **Step 1: Run the whole check**

```bash
pnpm check
```

Expected: biome clean, `tsc --noEmit` clean, every test green, build succeeds. Fix anything that
fails before continuing — do not proceed on a red suite.

- [ ] **Step 2: Confirm the coverage thresholds still hold**

```bash
pnpm test:coverage
```

Expected: statements ≥ 90, branches ≥ 90, functions ≥ 85, lines ≥ 90. `src/render.ts`,
`src/history.ts`, `src/heartbeat.ts` all appear in the report.

- [ ] **Step 3: Document the new surface in README.md**

Add to the commands table/list, next to `status`:

```markdown
### Checking that it works

`claude-window status` now says whether the window sits on the grid it is supposed to:

    service (systemd): active
    window -> reset 22:02 (in 184 min), on grid
    usage 5h 0.34 | 7d 0.03

`claude-window history` replays what the daemon has done, from `history.jsonl` in your state
directory — 500 records, oldest dropped first:

    07:02  anchor   reset 12:02  usage5=0  on grid
    12:02  anchor   reset 17:02  usage5=0.34  on grid
    17:04  failure  probe rejected with HTTP 503

Both take `--json`: `status --json` prints one versioned object, `history --json` prints one
object per line. Diagnostics go to stderr, so piping into `jq` is always safe.

### Knowing when it dies

Set `CLAUDE_WINDOW_PING_URL` to a healthchecks.io or Better Stack heartbeat URL. The daemon
pings it after every anchor and pings `<url>/fail` when a probe fails, so a dead daemon raises
an alert instead of quietly not anchoring. A monitoring outage never interrupts anchoring.

### When the token expires

An expired or revoked token is fatal, not transient: the daemon says so and exits instead of
retrying every five minutes forever. On Linux the unit gives up after three such exits in an
hour and shows as `failed`. Refresh with `claude-window login "$(claude setup-token)"`.
```

Also document the new environment variable wherever `CLAUDE_WINDOW_START`, `CLAUDE_WINDOW_END`,
`CLAUDE_WINDOW_OFFSET` and `CLAUDE_WINDOW_MODEL` are listed:

```markdown
| `CLAUDE_WINDOW_PING_URL` | _(none)_ | Heartbeat URL pinged after each anchor, `<url>/fail` on failure |
```

- [ ] **Step 4: Commit the docs**

```bash
git add README.md
git commit -m "docs: document history, json output and the heartbeat url"
```

- [ ] **Step 5: Push and let semantic-release ship it**

```bash
git push
```

Expected: CI runs, semantic-release cuts `0.5.0` (the `feat:` commits force a minor bump) and
publishes to npm.

- [ ] **Step 6: Verify on the Raspberry Pi**

```bash
ssh baguette 'sudo npm update -g claude-window && claude-window version'
ssh baguette 'systemctl --user restart claude-window && sleep 5 && claude-window status'
ssh baguette 'claude-window once && claude-window history'
```

Expected: version `0.5.0`; `status` reports `on grid`; `history` shows the anchor just forced by
`once`.
