import * as crypto from 'node:crypto'
import * as fs from 'node:fs'
import * as path from 'node:path'
import * as vscode from 'vscode'
import { checkCli, compareSemver, type CliHealth } from './cli_health'
import { ensureDaemon } from './daemon_launcher'
import { IPCServer, type IpcDeps } from './ipc_server'
import { makeCreatePendingTerminal } from './pending_terminal_factory'
import { SessionTerminal } from './session_terminal'
import { cleanupOrphanSockets, deriveUuid, getSocketPath, probeSocket } from './socket_paths'
import { InternalViewer, type SessionListItem } from './webview_viewer'

const MIN_CLI_VERSION = '0.1.18'
const CLI_NPM_PKG = '@yejianfei.billy/subagent-cli'
const CLI_NPM_URL = `https://www.npmjs.com/package/${CLI_NPM_PKG}`
const CLI_NPM_LATEST_URL = `https://registry.npmjs.org/${CLI_NPM_PKG}/latest`

let ipcServer: IPCServer | undefined

interface SocketChoice {
  path: string
  uuid: string
  fallback: boolean
}

/**
 * Pick a socket path. The uuid is `<sha1(workspace)[:8]>_<VSCODE_PID>` so the
 * CLI can rediscover this window's socket by globbing
 * `subagent-cli_*_<VSCODE_PID>.sock` when SUBAGENT_VSCODE_IPC isn't propagated
 * (e.g. spawned by Claude Code). VSCODE_PID is the editor main-process pid:
 * unique per window and stable across reloads.
 *
 *  - Try the workspace+pid path — claim it if the previous server is dead.
 *  - On the rare collision (same window's socket still bound, e.g. a lingering
 *    reload) randomize the hash segment but keep the `_<VSCODE_PID>` suffix so
 *    glob discovery still matches.
 */
async function pickSocketPath(seed: string): Promise<SocketChoice> {
  const pid = process.env.VSCODE_PID
  const withPid = (base: string): string => (pid ? `${base}_${pid}` : base)
  const stableUuid = withPid(deriveUuid(seed))
  const stablePath = getSocketPath(stableUuid)
  const alive = await probeSocket(stablePath)
  if (!alive) {
    if (process.platform !== 'win32') {
      await fs.promises.unlink(stablePath).catch(() => undefined)
    }
    return { path: stablePath, uuid: stableUuid, fallback: false }
  }
  const fallbackUuid = withPid(crypto.randomUUID().slice(0, 8))
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
  // Re-inject VSCODE_PID into integrated terminals. VS Code (and Trae) strip
  // this internal var from terminal env, but the CLI's socket discovery globs
  // `subagent-cli_*_<VSCODE_PID>.sock` as a fallback when SUBAGENT_VSCODE_IPC
  // is stale/missing — without VSCODE_PID it can never match. The value we
  // re-inject is the same one VS Code keeps in the extension-host process.env.
  const vscodePid = process.env.VSCODE_PID
  vscodePid && context.environmentVariableCollection.replace('VSCODE_PID', vscodePid)
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

  // Look up the daemon-recorded subagent name for a session. Used when the
  // CLI's `prepareTerminal` didn't include one (e.g. `subagent-cli open
  // --session $SID` falls back to the literal default "subagent"), so the
  // VS Code terminal tab name reflects the real adapter rather than that
  // default placeholder.
  const resolveSubagentName = async (sessionId: string): Promise<string | undefined> => {
    try {
      const sessions = await fetchSessions()
      return sessions.find((s) => s.session === sessionId)?.subagent
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      log(`resolveSubagentName: lookup failed for ${sessionId}: ${message}`)
      return undefined
    }
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
    createPendingTerminal: makeCreatePendingTerminal({
      sessionTerminals,
      buildSessionTerminal,
      trackSession,
      resolveSubagentName,
      log,
    }),
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
  let runningCount = 0

  const updateStatusBar = (): void => {
    if (currentHealth.status === 'ok') {
      const suffix = runningCount > 0 ? ` (${runningCount})` : ''
      statusBar.text = `$(eye) Subagent${suffix}`
      statusBar.tooltip =
        runningCount > 0
          ? vscode.l10n.t('Open Subagent viewer ({0} running)', runningCount)
          : vscode.l10n.t('Open Subagent viewer')
      statusBar.backgroundColor = undefined
      // Color the whole pill green when this window has RUNNING sessions so
      // the count stands out at a glance. VS Code status bar API can't style
      // a sub-range, so we tint the whole item.
      statusBar.color = runningCount > 0 ? new vscode.ThemeColor('charts.green') : undefined
      return
    }
    statusBar.color = undefined
    statusBar.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground')
    if (currentHealth.status === 'not-found') {
      statusBar.text = `$(warning) ${vscode.l10n.t('Subagent: CLI not installed')}`
      statusBar.tooltip = vscode.l10n.t(
        'Subagent CLI not found. Click for installation instructions.',
      )
      return
    }
    statusBar.text = `$(warning) ${vscode.l10n.t('Subagent: CLI v{0} too old', currentHealth.version ?? '?')}`
    statusBar.tooltip = vscode.l10n.t(
      'Subagent CLI version too low (need ≥ {0}, found {1}). Click for upgrade instructions.',
      MIN_CLI_VERSION,
      currentHealth.version ?? '?',
    )
  }

  // Poll daemon for session states and count RUNNING ones owned by this
  // window. Skip the HTTP when we own zero terminals (the count is trivially
  // zero) so idle windows don't ping the daemon.
  const pollRunningCount = async (): Promise<void> => {
    if (currentHealth.status !== 'ok') return
    if (sessionTerminals.size === 0) {
      if (runningCount !== 0) {
        runningCount = 0
        updateStatusBar()
      }
      return
    }
    try {
      const sessions = await fetchSessions()
      const count = sessions.filter(
        (s) => sessionTerminals.has(s.session) && s.state === 'RUNNING',
      ).length
      if (count !== runningCount) {
        runningCount = count
        updateStatusBar()
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      log(`pollRunningCount: ${message}`)
    }
  }

  const refreshHealth = async (): Promise<void> => {
    const cliPath = vscode.workspace.getConfiguration('subagent-cli').get<string>('cli.path', '')
    currentHealth = await checkCli(cliPath, MIN_CLI_VERSION)
    log(`cli health: status=${currentHealth.status} version=${currentHealth.version ?? '?'}`)
    updateStatusBar()
    void pollRunningCount()
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

  // On startup, check npm for a newer CLI release and offer to upgrade. Opens
  // a terminal running the global npm install on confirm. Skipped when:
  //  - the user disabled it (`checkForUpdates`),
  //  - `cli.path` is set (custom/dev build — npm upgrade wouldn't apply),
  //  - the CLI isn't healthy, or the registry is unreachable.
  // "Later" is remembered per-version so the same release doesn't nag again.
  const DISMISSED_UPDATE_KEY = 'dismissedUpdateVersion'
  const fetchLatestCliVersion = async (): Promise<string | undefined> => {
    try {
      const res = await fetch(CLI_NPM_LATEST_URL)
      if (!res.ok) {
        log(`update check: registry responded ${res.status}`)
        return undefined
      }
      const body = (await res.json()) as { version?: string }
      return body.version
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      log(`update check failed: ${message}`)
      return undefined
    }
  }
  const maybePromptCliUpdate = async (): Promise<void> => {
    const cfg = vscode.workspace.getConfiguration('subagent-cli')
    if (!cfg.get<boolean>('checkForUpdates', true)) return
    if (cfg.get<string>('cli.path', '')) return
    if (currentHealth.status !== 'ok' || !currentHealth.version) return
    const latest = await fetchLatestCliVersion()
    if (!latest || compareSemver(latest, currentHealth.version) <= 0) return
    if (context.globalState.get<string>(DISMISSED_UPDATE_KEY) === latest) return
    const upgrade = vscode.l10n.t('Upgrade')
    const later = vscode.l10n.t('Later')
    const choice = await vscode.window.showInformationMessage(
      vscode.l10n.t('Subagent CLI {0} is available (current {1}).', latest, currentHealth.version),
      upgrade,
      later,
    )
    if (choice === upgrade) {
      const term = vscode.window.createTerminal('Subagent CLI Update')
      term.show()
      term.sendText(`npm install -g ${CLI_NPM_PKG}@latest`)
      return
    }
    if (choice === later) await context.globalState.update(DISMISSED_UPDATE_KEY, latest)
  }

  // Re-create terminals for this window's still-running sessions after a window
  // reload. The daemon scopes /api/sessions to the caller's ipc_path (via the
  // X-Subagent-Cli-IPC header), and our socket name is stable across reload
  // (workspace hash + VSCODE_PID), so the same sessions match. On a fresh
  // editor launch VSCODE_PID differs → no sessions match → nothing reopens.
  const reattachWindowSessions = async (): Promise<void> => {
    if (currentHealth.status !== 'ok') return
    try {
      const sessions = await fetchSessions()
      sessions
        .filter((s) => s.state !== 'CLOSED' && !sessionTerminals.has(s.session))
        .forEach((s) => openSessionTerminalById(s.session, s.subagent ?? 'subagent'))
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      log(`reattach: ${message}`)
    }
  }

  await refreshHealth()
  void maybePromptCliUpdate()
  void reattachWindowSessions()

  // Periodically refresh the RUNNING count for this window. Errors are caught
  // inside pollRunningCount itself so a transient daemon outage doesn't crash
  // the interval; the badge just keeps showing the last known value.
  const pollHandle = setInterval(() => void pollRunningCount(), 5000)
  context.subscriptions.push({ dispose: () => clearInterval(pollHandle) })

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
