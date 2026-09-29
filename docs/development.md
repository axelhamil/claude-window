# Development

## Setup

Tools: Node 22+, pnpm 11 (`packageManager: pnpm@11.8.0`), and Bun (used by the build and by `pnpm dev`).

```bash
git clone https://github.com/axelhamil/claude-window
cd claude-window
pnpm install
```

The published package has no runtime dependencies; everything in `devDependencies` is tooling (Biome, TypeScript, Vitest with the v8 coverage provider, semantic-release and its plugins). `pnpm-workspace.yaml` only allows the `esbuild` build script.

TypeScript is strict: `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `verbatimModuleSyntax`, module resolution `bundler`. Biome formats with two-space indentation, 100-column lines, double quotes, semicolons and trailing commas, and lints with the recommended preset.

## Scripts

| Script | Command | Note |
|---|---|---|
| `pnpm build` | `bun build src/cli.ts --target=node --outfile dist/cli.js --minify` | Produces the single-file `dist/cli.js` with the `#!/usr/bin/env node` shebang |
| `pnpm dev` | `bun run src/cli.ts` | Run the CLI from source under Bun |
| `pnpm test` | `vitest run` | |
| `pnpm test:watch` | `vitest` | |
| `pnpm test:coverage` | `vitest run --coverage` | Enforces the thresholds below |
| `pnpm typecheck` | `tsc --noEmit` | Covers `src`, `tests`, `scripts`, `vitest.config.ts` |
| `pnpm lint` | `biome check` | |
| `pnpm lint:fix` | `biome check --fix` | |
| `pnpm format` | `biome format --write` | |
| `pnpm check` | `biome check && pnpm typecheck && pnpm test && pnpm build` | The whole gate |
| `pnpm analyze` | `node scripts/analyze-usage.ts` | See [below](#pnpm-analyze) |
| `prepublishOnly` | `pnpm build` | Runs on `npm publish`, so the published bundle carries the released version |

Prefer calling the tools directly, which keeps output unfiltered and independent of script wrappers:

```bash
pnpm exec vitest run
pnpm exec tsc --noEmit
pnpm exec biome check
bun run build
```

To try the built CLI against a scratch configuration, never your real one:

```bash
bun run build
XDG_CONFIG_HOME=/tmp/cw/cfg XDG_STATE_HOME=/tmp/cw/state node dist/cli.js schedule --weekdays 9-17 --weekend off
```

`schedule`, `status` and `history` are safe this way (the systemd unit path follows `XDG_CONFIG_HOME` too). Avoid `install`, `uninstall`, `once`, `daemon` and `login` unless you mean it: they register services, hit the API or write the token.

## Tests

Vitest with `globals: true`; tests live in `tests/` and import from `../src/`. No network and no timers: the daemon is driven through fake [`DaemonPorts`](architecture.md#daemonports), `fetch` is stubbed, and dates are built from local-time constructors.

| File | Covers |
|---|---|
| `tests/planner.test.ts` | Range parsing, `planDay` (worked examples, edge balancing, clamp, offset-dependent cap and slack, `partial`, strictly-inside resets), formatting |
| `tests/schedule.test.ts` | `schedule.json` load, validation, atomic save, strict `schedule` argument parsing |
| `tests/scheduling.test.ts` | Active hours, next anchor, weekend and day-off handling, backoff, drift and grid tolerance |
| `tests/config.test.ts` | Environment parsing and validation, legacy vs scheduled week, token loading |
| `tests/daemon.test.ts` | `anchor` and `runDaemon` with fake ports: recording, pings, backoff, fatal errors, abort |
| `tests/window.test.ts` | Headers, status classification, `Retry-After`, failure modes of `fetchWindow` |
| `tests/state.test.ts` | Snapshot read and write |
| `tests/history.test.ts` | Append, lenient read, truncation to 500 |
| `tests/heartbeat.test.ts` | Ping URL and failure suffix, timeouts, error reporting (injected `fetch`) |
| `tests/cli-render.test.ts` | Text and JSON output of `status` and `history`, including an invalid schedule |
| `tests/paths.test.ts` | Locations per platform (mocked `node:os`) |
| `tests/systemd.test.ts` | The generated unit and `status()` (mocked `child_process`) |
| `tests/service-restart.test.ts` | `restart()` of the launchd and Task Scheduler backends (mocked `child_process`) |
| `tests/wizard.test.ts` | The interactive `schedule` questions (injected streams) |

Coverage (v8) covers `src/**/*.ts` except `src/cli.ts` and `src/service/**`, with thresholds of 90 % statements, 90 % branches, 85 % functions, 90 % lines. Only `restart()` of launchd and Task Scheduler is tested; systemd also has generation and `status()` tests.

## pnpm analyze

Replays your own Claude Code usage under three strategies, locally, sending nothing anywhere:

```bash
pnpm analyze
```

It runs `node scripts/analyze-usage.ts`, a TypeScript file executed by Node directly (native type stripping, on by default since Node 22.18). It reads `~/.claude/history.jsonl` (prompt timestamps) and, when present, the transcripts under `~/.claude/projects` for output-token totals, excludes today unless you pass `--include-today`, and takes `--home=<dir>` to point at another Claude directory. `history.jsonl` survives the roughly 30-day pruning applied to transcripts, so it usually covers far more days than `~/.claude/projects`.

Output: period, active days, prompts sent, share of prompts per time band, peak hour, and for each day the number of useful windows under:

| Strategy | Meaning |
|---|---|
| Do nothing | Windows open naturally on your first prompt after the previous one expires |
| Single 7am ping | One ping at 07:00, then natural windows |
| Ping on every expiry | The daemon: 07:00, then reset + 120 s while before 23:00 |

A window counts as useful only if a prompt was actually sent inside it. The script hard-codes the legacy defaults (07:00, 23:00, 120 s); it does not read `schedule.json`. On the author's 137 days:

| Strategy | Useful windows | Gain |
|---|---|---|
| Do nothing | 296 | reference |
| Single 7am ping | 315 | +6 % |
| Ping on every expiry | 359 | +21 % |

Chaining improved 62 of the author's 137 days. The result depends entirely on when you work, which is why you should measure rather than trust the table.

## Continuous integration

`.github/workflows/ci.yml` runs on pushes and pull requests to `main`:

1. Quality: `pnpm biome check` and `pnpm typecheck` (Node 22).
2. Test: `pnpm test:coverage` on Node 22 and 24, after Quality.
3. Build: `pnpm build` with Bun, then `node dist/cli.js version`, after Quality.

## Release flow

Releases are automatic and decided by CI. Do not bump `package.json`, edit `CHANGELOG.md` or create tags by hand.

1. Commit with [conventional commits](https://www.conventionalcommits.org/). The `angular` preset applies: `feat:` releases a minor version, `fix:` and `perf:` a patch, `BREAKING CHANGE:` in the footer (or `!`) a major. Other types (`docs`, `chore`, `refactor`, `test`, ...) do not release, with one rule in `.releaserc.json`: `docs(readme):` releases a patch, so a README fix reaches the npm page.
2. Merge to `main`. `.github/workflows/release.yml` (also runnable by hand with `workflow_dispatch`) checks out full history, then runs Biome, typecheck, tests and build, then `pnpm semantic-release` with `GH_TOKEN` and `NPM_TOKEN` secrets.
3. semantic-release, on `main` only, analyzes the commits since the last tag and: generates release notes, updates `CHANGELOG.md`, bumps `package.json` and publishes to npm (which triggers `prepublishOnly`, rebuilding `dist/cli.js` with the new version), commits `CHANGELOG.md` and `package.json` as `chore(release): <version> [skip ci]`, and creates the GitHub release and tag.

If no commit since the last release warrants one, nothing is published. Write the subject as what the change does for the user: it becomes the changelog line.
