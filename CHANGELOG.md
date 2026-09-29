# [0.6.0](https://github.com/axelhamil/claude-window/compare/v0.5.1...v0.6.0) (2026-09-29)


### Features

* plan the anchor from your working hours ([e5aff4a](https://github.com/axelhamil/claude-window/commit/e5aff4afe3a07917bb37038fe01d56c75b75673a))

## [0.5.1](https://github.com/axelhamil/claude-window/compare/v0.5.0...v0.5.1) (2026-09-29)


### Bug Fixes

* retry a 403 probe instead of stopping the daemon ([f876764](https://github.com/axelhamil/claude-window/commit/f8767644d0112b7041bb7c6a1281e515c2d55a6f))

# [0.5.0](https://github.com/axelhamil/claude-window/compare/v0.4.5...v0.5.0) (2026-08-26)


### Bug Fixes

* forward Retry-After when a probe response lacks rate-limit headers ([8490dcd](https://github.com/axelhamil/claude-window/commit/8490dcd4322845395a38e489bfca0eedae09a746))
* isolate directory creation test to prevent blast radius from test setup ([ebeadda](https://github.com/axelhamil/claude-window/commit/ebeadda4349d305ca77bc7768b937dea4d11950f))
* keep the dead-man switch alive when history writes fail ([ddbbd4f](https://github.com/axelhamil/claude-window/commit/ddbbd4f01eef6dedcad65983cf857cd7ec9dced7))
* make the on-grid tolerance scale with the probe offset ([bc75beb](https://github.com/axelhamil/claude-window/commit/bc75bebc142273822b3fece8198db32930d7bb92))
* read one clock in runDaemon instead of mixing real Date with ports.nowSeconds ([1529ee7](https://github.com/axelhamil/claude-window/commit/1529ee74ae44c88666f06f7bbf6f6628f0ef8646))
* report a failed systemd unit's real status instead of "inactive" ([42b41f5](https://github.com/axelhamil/claude-window/commit/42b41f5ee002d8e5fbbb0d1473cd2184ab9040e6))
* stop restarting the daemon forever after a fatal token error ([fdb98ec](https://github.com/axelhamil/claude-window/commit/fdb98ec920445f164763923a2ee0a618f7db31b2))


### Features

* add a history command and json status output ([69cb765](https://github.com/axelhamil/claude-window/commit/69cb7657a7a093e63fafb6c79678382d32517c42))
* back off with full jitter instead of a flat five minutes ([f496b2e](https://github.com/axelhamil/claude-window/commit/f496b2ea11fdc8330acc8be6e3288fab61e941f5))
* locate the anchor history next to the state file ([495f13a](https://github.com/axelhamil/claude-window/commit/495f13a62d29b55d0d75fe0a50c1c1293a2f589b))
* make the daemon's behaviour observable and its failures survivable ([d8ac742](https://github.com/axelhamil/claude-window/commit/d8ac742edef86e49fc71da8e98fbd342a77ce28b))
* measure how far a reset drifted from the configured grid ([6890dfe](https://github.com/axelhamil/claude-window/commit/6890dfec01102fa94b0afdced7759afb39ef4048))
* ping an optional heartbeat url after every anchor ([0ff90a1](https://github.com/axelhamil/claude-window/commit/0ff90a1c475234ae2707da80e322071645006123))
* record every anchor and probe failure in a capped jsonl history ([720d7ab](https://github.com/axelhamil/claude-window/commit/720d7ab4aa782e0433c9c252d53b50342cfc0b8d))
* record, ping and back off from the daemon loop ([479b67f](https://github.com/axelhamil/claude-window/commit/479b67f81aee45c9775d1f4c45466b9032a18599))
* tell an expired token apart from a transient probe failure ([01108f0](https://github.com/axelhamil/claude-window/commit/01108f0dd43e732bea81807839ebb96c453b1404))

## [0.4.5](https://github.com/axelhamil/claude-window/compare/v0.4.4...v0.4.5) (2026-08-14)


### Performance Improvements

* drop zod and ship with no runtime dependencies ([e5b88dc](https://github.com/axelhamil/claude-window/commit/e5b88dc13dac11ea9afd79f3772fc7718d9a5d85))

## [0.4.4](https://github.com/axelhamil/claude-window/compare/v0.4.3...v0.4.4) (2026-08-14)

## [0.4.3](https://github.com/axelhamil/claude-window/compare/v0.4.2...v0.4.3) (2026-08-14)

## [0.4.2](https://github.com/axelhamil/claude-window/compare/v0.4.1...v0.4.2) (2026-08-14)


### Bug Fixes

* never sleep for a negative delay after a probe ([32a1b1c](https://github.com/axelhamil/claude-window/commit/32a1b1c296b1bf556bee0551abca5bdb39f70f03))
