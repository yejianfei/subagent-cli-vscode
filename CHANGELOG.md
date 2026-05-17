# Changelog

All notable changes to this extension will be documented in this file.

## [0.1.0] - 2026-05-18

- Initial scaffolding: IPC server, Pseudoterminal + WebSocket bridge, lazy daemon launch.
- Per-window UUID isolation via `SUBAGENT_VSCODE_IPC` / `SUBAGENT_VSCODE_UUID` env vars.
- Settings: `subagent-cli.daemon.port`, `subagent-cli.cli.path`, `subagent-cli.viewer.browser`, `subagent-cli.terminal.location`.
- `cli.path` directory is auto-prepended to `PATH` in VS Code terminals so plain `subagent-cli` resolves to the configured build.
