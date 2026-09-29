# claude-window documentation

Start with [Getting started](getting-started.md).

| Page | Contents |
|---|---|
| [Getting started](getting-started.md) | Requirements, install, login, `schedule`, `install`, verifying, running under Bun |
| [Scheduling](scheduling.md) | The rolling 5-hour window, why chaining matters, the anchor algorithm, worked examples, weekdays vs weekend, drift, legacy schedule |
| [CLI reference](cli.md) | Every command and flag, with real output and exit codes |
| [Configuration](configuration.md) | `schedule.json`, range syntax, environment variables, precedence, file locations, token storage, heartbeat |
| [Architecture](architecture.md) | Module map, daemon loop, `DaemonPorts`, backoff, HTTP status classification, data files, service backends |
| [Operations](operations.md) | Status and history, logs per OS, token expiry, upgrading, troubleshooting |
| [Development](development.md) | Setup, scripts, tests, `pnpm analyze`, CI and the release flow |

`superpowers/` holds the design spec and plan of the observability work (history, drift, heartbeat). They are historical notes, not user documentation.
