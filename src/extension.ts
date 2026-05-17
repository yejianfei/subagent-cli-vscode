import * as crypto from 'node:crypto'
import * as fs from 'node:fs'
import * as path from 'node:path'
import * as vscode from 'vscode'
import { checkCli, type CliHealth } from './cli_health'
import { ensureDaemon } from './daemon_launcher'
import { IPCServer, type IpcDeps } from './ipc_server'
import { SessionTerminal } from './session_terminal'
import { cleanupOrphanSockets, deriveUuid, getSocketPath, probeSocket } from './socket_paths'
import { InternalViewer, type SessionListItem } from './webview_viewer'

const MIN_CLI_VERSION = '0.1.18'
const CLI_NPM_URL = 'https://www.npmjs.com/package/@yejianfei.billy/subagent-cli'

let ipcServer: IPCServer | undefined

interface SocketChoice {
  path: string
  uuid: string
  fallback: boolean
}

/**
 * Pick a socket path:
 *  - First try the stable hash(workspace) path — claim it if the previous server is dead.
 *  - Otherwise (another window in the same workspace is alive) generate a random fallback.
 */
async function pickSocketPath(seed: string): Promise<SocketChoice> {
  const stableUuid = deriveUuid(seed)
  const stablePath = getSocketPath(stableUuid)
  const alive = await probeSocket(stablePath)
  if (!alive) {
    if (process.platform !== 'win32') {
      await fs.promises.unlink(stablePath).catch(() => undefined)
    }
    return { path: stablePath, uuid: stableUuid, fallback: false }
  }
  const fallbackUuid = crypto.randomUUID().slice(0, 8)
  return { path: getSocketPath(fallbackUuid), uuid: fallbackUuid, fallback: true }
}

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  await cleanupOrphanSockets()

  const output = vscode.window.createOutputChannel('Subagent CLI')
  const log = (message: string): void =>
    output.appendLine(`[${new Date().toISOString()}] ${message}`)
  context.subscriptions.push(output)

  const seed = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? process.cwd()
  const { path: socketPath, uuid, fallback } = await pickSocketPath(seed)
  log(`activate: uuid=${uuid} socket=${socketPath} fallback=${fallback} seed=${seed}`)

  context.environmentVariableCollection.replace('SUBAGENT_VSCODE_UUID', uuid)
  context.environmentVariableCollection.replace('SUBAGENT_VSCODE_IPC', socketPath)
  context.environmentVariableCollection.description = vscode.l10n.t(
    'Subagent CLI: IPC socket may change after reload. Click Relaunch if a terminal becomes stale.',
  )

  // Also write to extension-host process.env so subprocesses spawned by OTHER
  // extensions (e.g. Claude Code's Bash tool) inherit the IPC info. The env
  // collection above only reaches VS Code's integrated terminals; child
  // processes started via `child_process.spawn` from another extension would
  // otherwise see nothing. Restore prior values on deactivate.
  const originalUuid = process.env.SUBAGENT_VSCODE_UUID
  const originalIpc = process.env.SUBAGENT_VSCODE_IPC
  process.env.SUBAGENT_VSCODE_UUID = uuid
  process.env.SUBAGENT_VSCODE_IPC = socketPath
  context.subscriptions.push({
    dispose: () => {
      if (originalUuid === undefined) delete process.env.SUBAGENT_VSCODE_UUID
      else process.env.SUBAGENT_VSCODE_UUID = originalUuid
      if (originalIpc === undefined) delete process.env.SUBAGENT_VSCODE_IPC
      else process.env.SUBAGENT_VSCODE_IPC = originalIpc
    },
  })

  // Prepend the directory of `subagent-cli.cli.path` to PATH in every new
  // VS Code terminal so users can run `subagent-cli` without a full path while
  // overriding any globally installed copy. Skipped when the setting is empty
  // or relative (relative paths would silently inject CWD, which is unsafe).
  const applyCliPathToTerminalPath = (): void => {
    const cliPath = vscode.workspace.getConfiguration('subagent-cli').get<string>('cli.path', '')
    // Always clear first so config changes don't stack across reloads.
    context.environmentVariableCollection.delete('PATH')
    if (!cliPath || !path.isAbsolute(cliPath)) {
      log(`PATH inject: skipped (cli.path empty or relative: '${cliPath}')`)
      return
    }
    const dir = path.dirname(cliPath)
    context.environmentVariableCollection.prepend('PATH', `${dir}${path.delimiter}`)
    log(`PATH inject: prepended '${dir}'`)
  }
  applyCliPathToTerminalPath()

  if (fallback) {
    void vscode.window.showWarningMessage(
      vscode.l10n.t(
        'Another VS Code window owns Subagent CLI for this workspace. This window uses a fallback socket — existing terminals here cannot auto-open VS Code tabs.',
      ),
    )
  }

  // Shared session-terminal factory + tracking (used by both IPC handshake and webview dispatch).
  const sessionTerminals = new Map<string, SessionTerminal>()
  let viewerCounter = 0

  const buildSessionTerminal = (clientId: string, subagent: string): SessionTerminal => {
    const cfg = vscode.workspace.getConfiguration('subagent-cli')
    const locConf = cfg.get<string>('terminal.location', 'panel')
    const location =
      locConf === 'editor' ? vscode.TerminalLocation.Editor : vscode.TerminalLocation.Panel
    const port = cfg.get<number>('daemon.port', 7100)
    return SessionTerminal.create({
      clientId,
      subagent,
      port,
      ipcPath: socketPath,
      log,
      location,
    })
  }

  const trackSession = (sessionId: string, term: SessionTerminal): void => {
    sessionTerminals.set(sessionId, term)
    log(`trackSession: id=${sessionId} mapSize=${sessionTerminals.size}`)
    term.onDispose(() => {
      sessionTerminals.delete(sessionId)
      log(`untrackSession: id=${sessionId} mapSize=${sessionTerminals.size}`)
    })
  }

  const openSessionTerminalById = (sessionId: string, subagent: string): void => {
    const existing = sessionTerminals.get(sessionId)
    log(`viewer open: id=${sessionId} existing=${!!existing} mapKeys=[${Array.from(sessionTerminals.keys()).join(',')}]`)
    if (existing) {
      existing.show()
      return
    }
    viewerCounter += 1
    const clientId = `${uuid}_v${viewerCounter.toString().padStart(3, '0')}`
    const term = buildSessionTerminal(clientId, subagent)
    term.attach(sessionId)
    trackSession(sessionId, term)
  }

  const fetchSessions = async (): Promise<SessionListItem[]> => {
    const port = vscode.workspace
      .getConfiguration('subagent-cli')
      .get<number>('daemon.port', 7100)
    const res = await fetch(`http://127.0.0.1:${port}/api/sessions`, {
      headers: { 'X-Subagent-Cli-IPC': socketPath },
    })
    if (!res.ok) throw new Error(`GET /api/sessions ${res.status}`)
    const body = (await res.json()) as { data?: { sessions?: SessionListItem[] } }
    const items = body.data?.sessions ?? []
    // Tag each session with whether this window already owns a terminal for it.
    // Sessions during the daemon's spawn-wait window appear here but aren't yet
    // attached by the IPC handshake — clicking them must be disabled to avoid
    // accidentally opening a second terminal.
    return items.map((s) => ({ ...s, attached: sessionTerminals.has(s.session) }))
  }

  let internalViewer: InternalViewer | undefined
  context.subscriptions.push({
    dispose: () => {
      internalViewer?.dispose()
    },
  })

  const deps: IpcDeps = {
    ensureDaemon,
    getDaemonPort: () =>
      vscode.workspace.getConfiguration('subagent-cli').get<number>('daemon.port', 7100),
    createPendingTerminal: (opts) => {
      const term = buildSessionTerminal(opts.clientId, opts.subagent)
      return {
        attach: (sessionId) => {
          term.attach(sessionId)
          trackSession(sessionId, term)
        },
        onDispose: (cb) => {
          term.onDispose(cb)
        },
        dispose: () => term.dispose(),
      }
    },
    log,
  }

  const server = new IPCServer(socketPath, uuid, deps)
  try {
    await server.listen()
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    log(`IPC server listen failed: ${message}`)
    void vscode.window.showErrorMessage(
      `${vscode.l10n.t('Failed to bind Subagent CLI IPC socket.')} (${message})`,
    )
    return
  }
  ipcServer = server
  log('IPC server listening')

  context.subscriptions.push({
    dispose: async () => {
      server.close()
      if (process.platform !== 'win32') {
        await fs.promises.unlink(socketPath).catch(() => undefined)
      }
    },
  })

  // One status bar item; one command. Click target depends on CLI health.
  const statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100)
  statusBar.command = 'subagent-cli.openViewer'
  statusBar.show()
  context.subscriptions.push(statusBar)

  let currentHealth: CliHealth = { status: 'not-found' }

  const applyHealth = (health: CliHealth): void => {
    if (health.status === 'ok') {
      statusBar.text = '$(eye) Subagent'
      statusBar.tooltip = vscode.l10n.t('Open Subagent viewer')
      statusBar.backgroundColor = undefined
      return
    }
    statusBar.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground')
    if (health.status === 'not-found') {
      statusBar.text = `$(warning) ${vscode.l10n.t('Subagent: CLI not installed')}`
      statusBar.tooltip = vscode.l10n.t(
        'Subagent CLI not found. Click for installation instructions.',
      )
      return
    }
    statusBar.text = `$(warning) ${vscode.l10n.t('Subagent: CLI v{0} too old', health.version ?? '?')}`
    statusBar.tooltip = vscode.l10n.t(
      'Subagent CLI version too low (need ≥ {0}, found {1}). Click for upgrade instructions.',
      MIN_CLI_VERSION,
      health.version ?? '?',
    )
  }

  const refreshHealth = async (): Promise<void> => {
    const cliPath = vscode.workspace.getConfiguration('subagent-cli').get<string>('cli.path', '')
    currentHealth = await checkCli(cliPath, MIN_CLI_VERSION)
    log(`cli health: status=${currentHealth.status} version=${currentHealth.version ?? '?'}`)
    applyHealth(currentHealth)
  }

  const viewerCmd = vscode.commands.registerCommand('subagent-cli.openViewer', async () => {
    if (currentHealth.status !== 'ok') {
      await vscode.env.openExternal(vscode.Uri.parse(CLI_NPM_URL))
      return
    }
    try {
      await ensureDaemon()
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      log(`openViewer: ensureDaemon failed: ${message}`)
      void vscode.window.showErrorMessage(
        vscode.l10n.t('Failed to start daemon: {0}', message),
      )
      return
    }
    const cfg = vscode.workspace.getConfiguration('subagent-cli')
    const port = cfg.get<number>('daemon.port', 7100)
    const mode = cfg.get<string>('viewer.browser', 'external')
    const url = `http://127.0.0.1:${port}/viewer`
    if (mode === 'external') {
      await vscode.env.openExternal(vscode.Uri.parse(url))
      return
    }
    internalViewer ??= new InternalViewer({
      fetchSessions,
      openSession: openSessionTerminalById,
      log,
    })
    internalViewer.show()
  })
  context.subscriptions.push(viewerCmd)

  await refreshHealth()

  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (!e.affectsConfiguration('subagent-cli.cli.path')) return
      applyCliPathToTerminalPath()
      void refreshHealth()
    }),
  )
}

export function deactivate(): void {
  ipcServer?.close()
  ipcServer = undefined
}
