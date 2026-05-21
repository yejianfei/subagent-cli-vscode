import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  makeCreatePendingTerminal,
  type PendingTerminalFactoryDeps,
  type SessionTerminalLike,
} from '../src/pending_terminal_factory'

interface FakeTerminal extends SessionTerminalLike {
  buildArgs: { clientId: string; subagent: string }
  attachedSessions: string[]
  shows: number
  disposes: number
  onDisposeCallbacks: Array<() => void>
}

interface Harness {
  deps: PendingTerminalFactoryDeps<FakeTerminal>
  built: FakeTerminal[]
  tracked: Array<{ sessionId: string; term: FakeTerminal }>
  resolveCalls: string[]
  logs: string[]
  setResolved: (name: string | undefined) => void
}

function makeHarness(): Harness {
  const built: FakeTerminal[] = []
  const tracked: Array<{ sessionId: string; term: FakeTerminal }> = []
  const resolveCalls: string[] = []
  const logs: string[] = []
  let nextResolved: string | undefined
  return {
    built,
    tracked,
    resolveCalls,
    logs,
    setResolved: (name) => {
      nextResolved = name
    },
    deps: {
      sessionTerminals: new Map(),
      buildSessionTerminal: (clientId, subagent) => {
        const fake: FakeTerminal = {
          buildArgs: { clientId, subagent },
          attachedSessions: [],
          shows: 0,
          disposes: 0,
          onDisposeCallbacks: [],
          attach: (sessionId) => fake.attachedSessions.push(sessionId),
          onDispose: (cb) => fake.onDisposeCallbacks.push(cb),
          show: () => {
            fake.shows += 1
          },
          dispose: () => {
            fake.disposes += 1
          },
        }
        built.push(fake)
        return fake
      },
      trackSession: (sessionId, term) => tracked.push({ sessionId, term }),
      resolveSubagentName: async (sessionId) => {
        resolveCalls.push(sessionId)
        return nextResolved
      },
      log: (m) => logs.push(m),
    },
  }
}

test('attach() with new sessionId builds + attaches + tracks terminal', () => {
  const h = makeHarness()
  const factory = makeCreatePendingTerminal(h.deps)
  const handle = factory({ clientId: 'c1', subagent: 'claude', port: 7100 })
  handle.attach('sess1')
  assert.equal(h.built.length, 1)
  assert.deepEqual(h.built[0].buildArgs, { clientId: 'c1', subagent: 'claude' })
  assert.deepEqual(h.built[0].attachedSessions, ['sess1'])
  assert.deepEqual(h.tracked, [{ sessionId: 'sess1', term: h.built[0] }])
  assert.equal(h.resolveCalls.length, 0, 'real name should skip resolveSubagentName')
})

test('attach() with existing sessionId reuses (no new terminal, fires pending dispose cbs)', () => {
  const h = makeHarness()
  const existing: FakeTerminal = {
    buildArgs: { clientId: 'old', subagent: 'claude' },
    attachedSessions: ['sess1'],
    shows: 0,
    disposes: 0,
    onDisposeCallbacks: [],
    attach: () => undefined,
    onDispose: () => undefined,
    show: () => {
      existing.shows += 1
    },
    dispose: () => undefined,
  }
  h.deps.sessionTerminals.set('sess1', existing)
  const factory = makeCreatePendingTerminal(h.deps)
  const handle = factory({ clientId: 'c2', subagent: 'claude', port: 7100 })
  const cleanupCalls: number[] = []
  handle.onDispose(() => cleanupCalls.push(1))
  handle.attach('sess1')
  assert.equal(h.built.length, 0, 'no new terminal built when reusing')
  assert.equal(existing.shows, 1, 'existing terminal focused via show()')
  assert.equal(h.tracked.length, 0, 'no new tracking entry on reuse')
  assert.deepEqual(cleanupCalls, [1], 'pending dispose cb fires so IPCServer cleans clientId')
})

test('attach() with fallback subagent triggers resolveSubagentName and uses result', async () => {
  const h = makeHarness()
  h.setResolved('haiku')
  const factory = makeCreatePendingTerminal(h.deps)
  const handle = factory({ clientId: 'c3', subagent: 'subagent', port: 7100 })
  handle.attach('sess2')
  // resolveSubagentName is async; let the microtask run
  await new Promise((r) => setImmediate(r))
  assert.deepEqual(h.resolveCalls, ['sess2'])
  assert.equal(h.built.length, 1)
  assert.equal(h.built[0].buildArgs.subagent, 'haiku', 'resolved name used for terminal title')
})

test('attach() with fallback subagent falls back to opts.subagent if resolve returns undefined', async () => {
  const h = makeHarness()
  h.setResolved(undefined)
  const factory = makeCreatePendingTerminal(h.deps)
  const handle = factory({ clientId: 'c4', subagent: 'subagent', port: 7100 })
  handle.attach('sess3')
  await new Promise((r) => setImmediate(r))
  assert.equal(h.built[0].buildArgs.subagent, 'subagent', 'fallback to opts.subagent literal')
})

test('attach() with empty subagent triggers resolve too', async () => {
  const h = makeHarness()
  h.setResolved('codex')
  const factory = makeCreatePendingTerminal(h.deps)
  const handle = factory({ clientId: 'c5', subagent: '', port: 7100 })
  handle.attach('sess4')
  await new Promise((r) => setImmediate(r))
  assert.deepEqual(h.resolveCalls, ['sess4'])
  assert.equal(h.built[0].buildArgs.subagent, 'codex')
})

test('onDispose before attach is queued; forwarded once terminal is built', () => {
  const h = makeHarness()
  const factory = makeCreatePendingTerminal(h.deps)
  const handle = factory({ clientId: 'c6', subagent: 'claude', port: 7100 })
  const cb = (): void => undefined
  handle.onDispose(cb)
  handle.attach('sess5')
  assert.equal(h.built[0].onDisposeCallbacks.length, 1, 'queued cb forwarded to real terminal')
  assert.equal(h.built[0].onDisposeCallbacks[0], cb)
})

test('onDispose after attach forwards directly to the live terminal', () => {
  const h = makeHarness()
  const factory = makeCreatePendingTerminal(h.deps)
  const handle = factory({ clientId: 'c7', subagent: 'claude', port: 7100 })
  handle.attach('sess6')
  const cb = (): void => undefined
  handle.onDispose(cb)
  assert.equal(h.built[0].onDisposeCallbacks.length, 1)
  assert.equal(h.built[0].onDisposeCallbacks[0], cb)
})

test('dispose() before attach fires queued cbs (no terminal to dispose)', () => {
  const h = makeHarness()
  const factory = makeCreatePendingTerminal(h.deps)
  const handle = factory({ clientId: 'c8', subagent: 'claude', port: 7100 })
  let fired = 0
  handle.onDispose(() => {
    fired += 1
  })
  handle.dispose()
  assert.equal(fired, 1, 'queued cb fires on early dispose')
  assert.equal(h.built.length, 0, 'no terminal ever built')
})

test('dispose() after attach disposes the live terminal', () => {
  const h = makeHarness()
  const factory = makeCreatePendingTerminal(h.deps)
  const handle = factory({ clientId: 'c9', subagent: 'claude', port: 7100 })
  handle.attach('sess7')
  handle.dispose()
  assert.equal(h.built[0].disposes, 1)
})
