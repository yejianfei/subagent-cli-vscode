import * as crypto from 'node:crypto'
import * as fs from 'node:fs'
import * as net from 'node:net'
import * as os from 'node:os'
import * as path from 'node:path'

/** Build the IPC endpoint path for a given window UUID. */
export function getSocketPath(uuid: string): string {
  if (process.platform === 'win32') return `\\\\.\\pipe\\subagent-cli_${uuid}`
  return path.join(os.tmpdir(), `subagent-cli_${uuid}.sock`)
}

/**
 * Derive an 8-char hex uuid from a seed string (e.g. workspace folder path).
 * Stable across reloads → same path → old terminals' env stays valid.
 */
export function deriveUuid(seed: string): string {
  return crypto.createHash('sha1').update(seed).digest('hex').slice(0, 8)
}

/** Probe a Unix socket / Named Pipe path; true if some server is listening. */
export function probeSocket(socketPath: string, timeoutMs = 200): Promise<boolean> {
  return new Promise((resolve) => {
    const sock = net.createConnection(socketPath)
    const timer = setTimeout(() => {
      sock.destroy()
      resolve(false)
    }, timeoutMs)
    sock.once('connect', () => {
      clearTimeout(timer)
      sock.end()
      resolve(true)
    })
    sock.once('error', () => {
      clearTimeout(timer)
      resolve(false)
    })
  })
}

/** Scan a dir (default OS temp) for stale subagent-cli sockets, remove dead ones. */
export async function cleanupOrphanSockets(dir: string = os.tmpdir()): Promise<void> {
  if (process.platform === 'win32') return // Named Pipes are kernel-managed
  const files = await fs.promises.readdir(dir).catch(() => [] as string[])
  // Matches both legacy `subagent-cli_<hash>.sock` and the current
  // `subagent-cli_<hash>_<VSCODE_PID>.sock` naming.
  const candidates = files.filter((f) => /^subagent-cli_[0-9a-f]+(_\d+)?\.sock$/.test(f))

  await Promise.all(
    candidates.map(async (file) => {
      const full = path.join(dir, file)
      const alive = await probeSocket(full)
      if (!alive) await fs.promises.unlink(full).catch(() => undefined)
    }),
  )
}
