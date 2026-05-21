# Subagent CLI for VS Code

[![VS Code Marketplace](https://badgen.net/vs-marketplace/v/yejianfei-billy.subagent-cli-vscode?label=VS%20Marketplace)](https://marketplace.visualstudio.com/items?itemName=yejianfei-billy.subagent-cli-vscode)
[![Open VSX](https://img.shields.io/open-vsx/v/yejianfei-billy/subagent-cli-vscode?label=Open%20VSX)](https://open-vsx.org/extension/yejianfei-billy/subagent-cli-vscode)
[![npm](https://img.shields.io/npm/v/@yejianfei.billy/subagent-cli?label=npm)](https://www.npmjs.com/package/@yejianfei.billy/subagent-cli)

Render [subagent-cli](https://github.com/yejianfei/subagent-cli) child agent TUIs (Claude Code, Codex, Gemini CLI, etc.) inside VS Code terminal tabs instead of a browser viewer.

<!-- Demo: record a short screen capture, save as media/demo.gif, then uncomment:
![Subagent CLI demo](https://raw.githubusercontent.com/yejianfei/subagent-cli-vscode/main/media/demo.gif)
-->

## Requirements

Requires the [`@yejianfei.billy/subagent-cli`](https://www.npmjs.com/package/@yejianfei.billy/subagent-cli) CLI, **version `0.1.18` or newer**. Older versions lack the IPC handshake this extension depends on; the status bar shows a warning until a compatible CLI is found.

```bash
npm i -g @yejianfei.billy/subagent-cli
```

## Settings

| Setting | Default | Purpose |
|---|---|---|
| `subagent-cli.daemon.port` | `7100` | Authoritative port the extension passes to `subagent-cli daemon start --port`. |
| `subagent-cli.cli.path` | `""` | Absolute path to the `subagent-cli` executable. Leave empty to look it up on `PATH`. When set, the directory is **prepended** to `PATH` in every new VS Code terminal, so plain `subagent-cli` resolves to this build (and overrides any globally installed copy). Reopen terminals to apply changes. |
| `subagent-cli.viewer.browser` | `external` | How to open the Subagent viewer when the status bar button is clicked: `external` (system browser) or `internal` (VS Code webview). |
| `subagent-cli.terminal.location` | `panel` | Where subagent session terminals open: `panel` (terminal panel) or `editor` (editor/document tab area). |

## Development

1. Install dependencies and build:
   ```bash
   npm install
   npm run build
   ```
2. Open this folder in VS Code and press `F5` to launch an Extension Development Host.
3. Ensure the `subagent-cli` CLI is available on `PATH` (or set `subagent-cli.cli.path` to point at a custom build).
4. In a terminal inside the dev host, run `subagent-cli open -s claude` (or any subagent your config defines).

### Scripts

```bash
npm run build    # webpack production bundle → dist/extension.js
npm run watch    # webpack --watch for iterative dev
npm run package  # build a universal .vsix
npm run publish  # package + publish to VS Code Marketplace and Open VSX
```

## Platform support

The extension itself is cross-platform (Unix Socket on Linux/macOS, Named Pipe on Windows). End-to-end availability follows the `subagent-cli` main package builds.

## License

Apache-2.0
