import * as net from 'node:net'
import type { Logger } from './logger'

interface IpcRequest {
  method: string
  params?: Record<string, unknown>
}

// CLI expects a flat response object, not a JSON-RPC envelope.
// Success: { client_id } | { ok: true }. Failure: { success: false, error }.
type IpcResult = { client_id: string } | { ok: true }
type IpcResponse = IpcResult | { success: false; error: string }

export interface PendingTerminalOptions {
  clientId: string
  subagent: string
  port: number
}

/** Two-phase session terminal handle — keeps IPCServer vscode-free. */
export interface SessionHandle {
  attach(sessionId: string): void
  onDispose(cb: () => void): void
  dispose(): void
}

/** Injected side effects, supplied by the extension host (real) or tests (fake). */
export interface IpcDeps {
  ensureDaemon: () => Promise<void>
  getDaemonPort: () => number
  createPendingTerminal: (opts: PendingTerminalOptions) => SessionHandle
  log: Logger
}

/**
 * IPC server bound to one VS Code window. Receives length-prefixed JSON-RPC
 * frames from `subagent-cli` running inside the window's terminals and
 * orchestrates Pseudoterminal creation + WebSocket attach.
 *
 * Frame format: 4-byte big-endian length prefix + UTF-8 JSON payload.
 * Pure protocol logic — all vscode/daemon effects are injected via IpcDeps.
 */
export class IPCServer {
  private readonly server: net.Server
  private counter = 0
  private readonly clients = new Map<string, SessionHandle>()

  constructor(
    private readonly socketPath: string,
    private readonly uuid: string,
    private readonly deps: IpcDeps,
  ) {
    this.server = net.createServer((sock) => this.handleConnection(sock))
  }

  listen(): Promise<void> {
    return new Promise((resolve, reject) => {
      const onError = (err: Error): void => {
        this.server.off('listening', onListening)
        reject(err)
      }
      const onListening = (): void => {
        this.server.off('error', onError)
        resolve()
      }
      this.server.once('error', onError)
      this.server.once('listening', onListening)
      this.server.listen(this.socketPath)
    })
  }

  close(): void {
    this.server.close()
    this.clients.forEach((h) => h.dispose())
    this.clients.clear()
  }

  private handleConnection(sock: net.Socket): void {
    let buf = Buffer.alloc(0)
    sock.on('data', (chunk: Buffer) => {
      buf = Buffer.concat([buf, chunk])
      for (;;) {
        if (buf.length < 4) return
        const len = buf.readUInt32BE(0)
        if (buf.length < 4 + len) return
        const payload = buf.subarray(4, 4 + len)
        buf = buf.subarray(4 + len)
        this.dispatch(payload, sock).catch((err) => {
          const message = err instanceof Error ? err.message : String(err)
          this.deps.log(`ipc !! dispatch ERROR ${message}`)
          this.writeFrame(sock, { success: false, error: message })
        })
      }
    })
    sock.on('error', () => sock.destroy())
  }

  private async dispatch(payload: Buffer, sock: net.Socket): Promise<void> {
    let req: IpcRequest
    try {
      req = JSON.parse(payload.toString('utf8'))
    } catch {
      this.writeFrame(sock, { success: false, error: 'Parse error' })
      return
    }
    this.deps.log(`ipc <- ${req.method} ${JSON.stringify(req.params ?? {})}`)
    try {
      const result = await this.handleMethod(req.method, req.params ?? {})
      this.deps.log(`ipc -> ${req.method} ${JSON.stringify(result)}`)
      this.writeFrame(sock, result)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      this.deps.log(`ipc !! ${req.method} ERROR ${message}`)
      this.writeFrame(sock, { success: false, error: message })
    }
  }

  private writeFrame(sock: net.Socket, res: IpcResponse): void {
    const payload = Buffer.from(JSON.stringify(res), 'utf8')
    const header = Buffer.alloc(4)
    header.writeUInt32BE(payload.length, 0)
    sock.write(Buffer.concat([header, payload]))
  }

  private async handleMethod(
    method: string,
    params: Record<string, unknown>,
  ): Promise<IpcResult> {
    if (method === 'prepareTerminal') return this.handlePrepareTerminal(params)
    if (method === 'attachSession') return this.handleAttachSession(params)
    throw new Error(`Unknown IPC method: ${method}`)
  }

  private async handlePrepareTerminal(
    params: Record<string, unknown>,
  ): Promise<{ client_id: string }> {
    await this.deps.ensureDaemon()
    this.counter += 1
    const clientId = `${this.uuid}_${String(this.counter).padStart(3, '0')}`
    const subagent = typeof params.subagent === 'string' ? params.subagent : 'subagent'
    const port = this.deps.getDaemonPort()
    this.deps.log(`prepareTerminal: client=${clientId} subagent=${subagent} port=${port}`)
    const handle = this.deps.createPendingTerminal({ clientId, subagent, port })
    this.clients.set(clientId, handle)
    handle.onDispose(() => this.clients.delete(clientId))
    return { client_id: clientId }
  }

  private async handleAttachSession(
    params: Record<string, unknown>,
  ): Promise<{ ok: true }> {
    const session = typeof params.session === 'string' ? params.session : ''
    const clientId = typeof params.client_id === 'string' ? params.client_id : ''
    if (!session || !clientId) throw new Error('attachSession requires session + client_id')
    const handle = this.clients.get(clientId)
    if (!handle) throw new Error(`attachSession: unknown client_id ${clientId}`)
    this.deps.log(`attachSession: session=${session} client=${clientId}`)
    handle.attach(session)
    return { ok: true }
  }
}
