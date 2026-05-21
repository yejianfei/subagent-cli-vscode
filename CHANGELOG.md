# Changelog

All notable changes to this extension will be documented in this file.

## [0.1.1] - 2026-05-18

- Status bar shows a colored RUNNING count for sessions owned by this window. Polled every 5s; only triggers HTTP when the window owns at least one terminal.
- `subagent-cli open --session $SID` now reuses an existing terminal for the same session instead of opening a duplicate. Terminal creation is deferred until session id is known, also removing the brief "Connecting…" flash on new opens.
- Terminal tab name on resume (`open --session $SID`) now reflects the real subagent (e.g. `claude`) instead of the literal `subagent` fallback. Extension looks up the name from the daemon when the CLI omits it.
- Terminals auto-close when the daemon drops the session (CLI `close`, TUI `/exit`, daemon restart), so they don't linger in the dedup map.
- `keywords` expanded for marketplace discoverability; added `AI` category.
- Updated VS Marketplace badge to `badgen.net` (shields.io retired its visual-studio-marketplace endpoint).

## [0.1.0] - 2026-05-18

- Initial scaffolding: IPC server, Pseudoterminal + WebSocket bridge, lazy daemon launch.
- Per-window UUID isolation via `SUBAGENT_VSCODE_IPC` / `SUBAGENT_VSCODE_UUID` env vars.
- Settings: `subagent-cli.daemon.port`, `subagent-cli.cli.path`, `subagent-cli.viewer.browser`, `subagent-cli.terminal.location`.
- `cli.path` directory is auto-prepended to `PATH` in VS Code terminals so plain `subagent-cli` resolves to the configured build.
