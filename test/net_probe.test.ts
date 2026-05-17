import assert from 'node:assert/strict'
import * as net from 'node:net'
import { test } from 'node:test'
import { probePort, waitForDaemon } from '../src/net_probe'

function listen(): Promise<{ port: number; close: () => void }> {
  return new Promise((resolve) => {
    const srv = net.createServer()
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address()
      const port = typeof addr === 'object' && addr ? addr.port : 0
      resolve({ port, close: () => srv.close() })
    })
  })
}

test('probePort false when nothing listens', async () => {
  // Port 1 is privileged and unbound in test env.
  assert.equal(await probePort(1, '127.0.0.1', 200), false)
})

test('probePort true when a server listens', async () => {
  const { port, close } = await listen()
  assert.equal(await probePort(port), true)
  close()
})

test('waitForDaemon resolves once port comes up', async () => {
  const { port, close } = await listen()
  await waitForDaemon(port, 1000)
  close()
})

test('waitForDaemon rejects when port never comes up', async () => {
  await assert.rejects(() => waitForDaemon(1, 300), /did not become ready/)
})
