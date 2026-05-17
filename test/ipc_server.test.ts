import assert from 'node:assert/strict'
import { afterEach, beforeEach, test } from 'node:test'
import { IPCServer, type IpcDeps, type PendingTerminalOptions } from '../src/ipc_server'
import { ipcRaw, ipcRoundtrip, tmpSocketPath } from './helpers'

interface State {
  ensureDaemonCalls: number
  createdOpts: PendingTerminalOptions[]
  attachCalls: { clientId: string; sessionId: string }[]
  disposed: number
  logs: string[]
}

interface Harness {
  server: IPCServer
  socketPath: string
  state: State
}

let harness: Harness

function makeDeps(state: State): IpcDeps {
  return {
    ensureDaemon: async () => {
      state.ensureDaemonCalls += 1
    },
    getDaemonPort: () => 7100,
    createPendingTerminal: (opts) => {
      state.createdOpts.push(opts)
      return {
        attach: (sessionId) => state.attachCalls.push({ clientId: opts.clientId, sessionId }),
        onDispose: () => undefined,
        dispose: () => {
          state.disposed += 1
        },
      }
    },
    log: (m) => state.logs.push(m),
  }
}

beforeEach(async () => {
  const socketPath = tmpSocketPath()
  const state: State = {
    ensureDaemonCalls: 0,
    createdOpts: [],
    attachCalls: [],
    disposed: 0,
    logs: [],
  }
  const server = new IPCServer(socketPath, 'abcd1234', makeDeps(state))
  await server.listen()
  harness = { server, socketPath, state }
})

afterEach(() => {
  harness.server.close()
})

test('prepareTerminal: flat client_id, ensureDaemon ran, pending terminal created', async () => {
  const res = await ipcRoundtrip(harness.socketPath, { method: 'prepareTerminal' })
  assert.equal(res.client_id, 'abcd1234_001')
  assert.equal(harness.state.ensureDaemonCalls, 1)
  assert.deepEqual(harness.state.createdOpts[0], {
    clientId: 'abcd1234_001',
    subagent: 'subagent',
    port: 7100,
  })
})

test('client_id counter increments per prepareTerminal', async () => {
  await ipcRoundtrip(harness.socketPath, { method: 'prepareTerminal' })
  const res = await ipcRoundtrip(harness.socketPath, { method: 'prepareTerminal' })
  assert.equal(res.client_id, 'abcd1234_002')
})

test('subagent name reaches createPendingTerminal at prepare time', async () => {
  await ipcRoundtrip(harness.socketPath, {
    method: 'prepareTerminal',
    params: { subagent: 'haiku' },
  })
  assert.equal(harness.state.createdOpts[0].subagent, 'haiku')
})

test('attachSession wires the pending terminal by client_id', async () => {
  const prep = await ipcRoundtrip(harness.socketPath, { method: 'prepareTerminal' })
  const res = await ipcRoundtrip(harness.socketPath, {
    method: 'attachSession',
    params: { session: 'sess1', client_id: prep.client_id },
  })
  assert.deepEqual(res, { ok: true })
  assert.deepEqual(harness.state.attachCalls, [
    { clientId: 'abcd1234_001', sessionId: 'sess1' },
  ])
})

test('attachSession missing fields -> flat error', async () => {
  const res = await ipcRoundtrip(harness.socketPath, {
    method: 'attachSession',
    params: { session: '' },
  })
  assert.equal(res.success, false)
  assert.match(String(res.error), /requires session \+ client_id/)
})

test('attachSession unknown client_id -> flat error', async () => {
  const res = await ipcRoundtrip(harness.socketPath, {
    method: 'attachSession',
    params: { session: 's', client_id: 'nope_999' },
  })
  assert.equal(res.success, false)
  assert.match(String(res.error), /unknown client_id/)
})

test('unknown method -> flat error', async () => {
  const res = await ipcRoundtrip(harness.socketPath, { method: 'bogus' })
  assert.equal(res.success, false)
  assert.match(String(res.error), /Unknown IPC method/)
})

test('malformed JSON frame -> parse error', async () => {
  const bad = Buffer.from('not json at all', 'utf8')
  const header = Buffer.alloc(4)
  header.writeUInt32BE(bad.length, 0)
  const res = await ipcRaw(harness.socketPath, Buffer.concat([header, bad]))
  assert.equal(res.success, false)
  assert.equal(res.error, 'Parse error')
})

test('close() disposes created terminals', async () => {
  await ipcRoundtrip(harness.socketPath, { method: 'prepareTerminal' })
  assert.equal(harness.state.disposed, 0)
  harness.server.close()
  assert.equal(harness.state.disposed, 1)
})
