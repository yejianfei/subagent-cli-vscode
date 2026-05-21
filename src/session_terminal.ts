import * as vscode from 'vscode'
import type { Logger } from './logger'
import { WSClient } from './ws_client'

export interface SessionTerminalOptions {
  clientId: string
  subagent: string
  port: number
  ipcPath: string
  log: Logger
  location?: vscode.TerminalLocation
}

/**
 * Two-phase Pseudoterminal:
 *  - construct: blank terminal showing "Connecting…" (no session yet, no ws)
 *  - attach(sessionId): wire the WebSocket and start streaming
 *
 * Close semantics:
 *  - attached → POST /api/session/:id/close (daemon-side close)
 *  - never attached → just clean up (no session exists to close)
 */
export class SessionTerminal {
  private readonly writeEmitter = new vscode.EventEmitter<string>()
  private readonly closeEmitter = new vscode.EventEmitter<void>()
  private readonly terminal: vscode.Terminal
  private ws: WSClient | undefined
  private sessionId: string | undefined
  private opened = false
  private disposed = false
  private lastCols: number | undefined
  private lastRows: number | undefined

  static create(opts: SessionTerminalOptions): SessionTerminal {
    return new SessionTerminal(opts)
  }

  private constructor(private readonly opts: SessionTerminalOptions) {
    const pty: vscode.Pseudoterminal = {
      onDidWrite: this.writeEmitter.event,
      onDidClose: this.closeEmitter.event,
      open: () => {
        this.opened = true
        this.writeEmitter.fire(`Connecting to ${opts.subagent}…\r\n`)
        this.ws?.connect()
      },
      close: () => {
        void this.handleUserClose()
      },
      handleInput: (data) => this.ws?.send(data),
      setDimensions: ({ columns, rows }) => {
        this.lastCols = columns
        this.lastRows = rows
        this.ws?.send(JSON.stringify({ type: 'resize', cols: columns, rows }))
      },
    }

    opts.log(`SessionTerminal: creating blank terminal for ${opts.subagent} (client=${opts.clientId})`)
    this.terminal = vscode.window.createTerminal({
      name: opts.subagent,
      pty,
      location: opts.location ?? vscode.TerminalLocation.Panel,
    })
    this.terminal.show()
  }

  /** Phase 2: bind to a real session and start streaming PTY bytes. */
  attach(sessionId: string): void {
    if (this.disposed || this.sessionId) return
    this.sessionId = sessionId
    const wsUrl = `ws://127.0.0.1:${this.opts.port}/ws?session=${encodeURIComponent(sessionId)}&client=${encodeURIComponent(this.opts.clientId)}`
    const ws = new WSClient(wsUrl)
    ws.onMessage((data) => this.writeEmitter.fire(data))
    // When the daemon closes the session (CLI `close`, /exit inside the TUI,
    // daemon shutdown, etc.) it drops the ws. Tear down this terminal so the
    // tab doesn't linger in sessionTerminals and trick future `open --session`
    // dedup into focusing a dead tab.
    ws.onClose(() => this.dispose())
    // Send current terminal dimensions as soon as ws is up so daemon redraws
    // the snapshot at the right size (otherwise replay uses stale PTY dims).
    ws.onOpen(() => {
      if (this.lastCols !== undefined && this.lastRows !== undefined) {
        ws.send(JSON.stringify({ type: 'resize', cols: this.lastCols, rows: this.lastRows }))
      }
    })
    this.ws = ws
    this.opts.log(`SessionTerminal: attach session=${sessionId} ws=${wsUrl}`)
    if (this.opened) ws.connect()
  }

  /** Fires when the terminal is gone (user closed tab or extension disposed). */
  onDispose(cb: () => void): vscode.Disposable {
    return this.closeEmitter.event(cb)
  }

  /** Bring the underlying terminal tab to focus (idempotent). */
  show(): void {
    if (this.disposed) return
    this.terminal.show()
  }

  /** Programmatic teardown (extension shutdown). Does NOT notify the daemon. */
  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.ws?.close()
    this.closeEmitter.fire()
    this.writeEmitter.dispose()
    this.closeEmitter.dispose()
    this.terminal.dispose()
  }

  private async handleUserClose(): Promise<void> {
    if (this.disposed) return
    this.disposed = true
    this.ws?.close()
    const sid = this.sessionId
    try {
      if (!sid) {
        this.opts.log(`SessionTerminal: closed before attach, no session to close (client=${this.opts.clientId})`)
        return
      }
      const url = `http://127.0.0.1:${this.opts.port}/api/session/${encodeURIComponent(sid)}/close`
      const headers = { 'X-Subagent-Cli-IPC': this.opts.ipcPath }
      this.opts.log(
        `SessionTerminal: close POST url=${url} headers=${JSON.stringify(headers)}`,
      )
      const res = await fetch(url, { method: 'POST', headers })
      const bodyText = await res.text().catch(() => '<read failed>')
      this.opts.log(
        `SessionTerminal: close response status=${res.status} body=${bodyText}`,
      )
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      this.opts.log(`SessionTerminal: close notify failed (daemon gone?): ${message}`)
    } finally {
      this.closeEmitter.fire()
      this.writeEmitter.dispose()
      this.closeEmitter.dispose()
    }
  }
}
