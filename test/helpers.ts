import * as net from 'node:net'
import * as os from 'node:os'
import * as path from 'node:path'

/** Send one length-prefixed JSON-RPC frame, resolve the single response frame. */
export function ipcRoundtrip(
  socketPath: string,
  request: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let expected = -1
    const sock = net.connect(socketPath)
    const timer = setTimeout(() => {
      sock.destroy()
      reject(new Error('ipc roundtrip timeout'))
    }, 3000)

    sock.on('connect', () => {
      const payload = Buffer.from(JSON.stringify(request), 'utf8')
      const header = Buffer.alloc(4)
      header.writeUInt32BE(payload.length, 0)
      sock.write(Buffer.concat([header, payload]))
    })
    sock.on('data', (chunk) => {
      chunks.push(chunk)
      const all = Buffer.concat(chunks)
      if (expected < 0 && all.length >= 4) expected = all.readUInt32BE(0)
      if (expected >= 0 && all.length >= 4 + expected) {
        clearTimeout(timer)
        sock.end()
        resolve(JSON.parse(all.subarray(4, 4 + expected).toString('utf8')))
      }
    })
    sock.on('error', (err) => {
      clearTimeout(timer)
      reject(err)
    })
  })
}

/** Send a raw (already-framed or malformed) buffer, resolve the response frame. */
export function ipcRaw(socketPath: string, raw: Buffer): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let expected = -1
    const sock = net.connect(socketPath)
    const timer = setTimeout(() => {
      sock.destroy()
      reject(new Error('ipc raw timeout'))
    }, 3000)
    sock.on('connect', () => sock.write(raw))
    sock.on('data', (chunk) => {
      chunks.push(chunk)
      const all = Buffer.concat(chunks)
      if (expected < 0 && all.length >= 4) expected = all.readUInt32BE(0)
      if (expected >= 0 && all.length >= 4 + expected) {
        clearTimeout(timer)
        sock.end()
        resolve(JSON.parse(all.subarray(4, 4 + expected).toString('utf8')))
      }
    })
    sock.on('error', (err) => {
      clearTimeout(timer)
      reject(err)
    })
  })
}

export function tmpSocketPath(): string {
  return path.join(os.tmpdir(), `subagent-cli-test_${Math.random().toString(16).slice(2, 10)}.sock`)
}
