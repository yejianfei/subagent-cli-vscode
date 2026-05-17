import assert from 'node:assert/strict'
import { test } from 'node:test'
import { WebSocketServer } from 'ws'
import { WSClient } from '../src/ws_client'

function startWs(): Promise<{ url: string; wss: WebSocketServer }> {
  return new Promise((resolve) => {
    const wss = new WebSocketServer({ port: 0 }, () => {
      const addr = wss.address()
      const port = typeof addr === 'object' && addr ? addr.port : 0
      resolve({ url: `ws://127.0.0.1:${port}`, wss })
    })
  })
}

test('WSClient receives messages and sends back', async () => {
  const { url, wss } = await startWs()
  const received: string[] = []

  const serverGot = new Promise<string>((resolve) => {
    wss.on('connection', (ws) => {
      ws.on('message', (d) => resolve(d.toString()))
      ws.send('hello-from-daemon')
    })
  })

  const client = new WSClient(url)
  const onMsg = new Promise<void>((resolve) => {
    client.onMessage((m) => {
      received.push(m)
      resolve()
    })
  })
  client.connect()

  await onMsg
  assert.deepEqual(received, ['hello-from-daemon'])

  client.send('hi-from-client')
  assert.equal(await serverGot, 'hi-from-client')

  client.close()
  wss.close()
})

test('WSClient onClose fires when server drops', async () => {
  const { url, wss } = await startWs()
  wss.on('connection', (ws) => ws.close())

  const client = new WSClient(url)
  const closed = new Promise<void>((resolve) => client.onClose(() => resolve()))
  client.connect()

  await closed
  client.close()
  wss.close()
})

test('send before connect is a no-op (no throw)', () => {
  const client = new WSClient('ws://127.0.0.1:1')
  assert.doesNotThrow(() => client.send('x'))
  client.close()
})
