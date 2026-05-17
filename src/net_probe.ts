import * as net from 'node:net'

/** TCP probe: resolve true if something is listening on host:port within timeout. */
export function probePort(port: number, host = '127.0.0.1', timeoutMs = 200): Promise<boolean> {
  return new Promise((resolve) => {
    const sock = net.createConnection({ port, host })
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

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

/** Poll probePort until reachable or the total budget elapses. */
export async function waitForDaemon(port: number, totalMs: number): Promise<void> {
  const deadline = Date.now() + totalMs
  while (Date.now() < deadline) {
    if (await probePort(port)) return
    await sleep(100)
  }
  throw new Error(`Daemon did not become ready on port ${port} within ${totalMs}ms`)
}
