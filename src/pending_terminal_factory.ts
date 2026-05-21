import type { PendingTerminalOptions, SessionHandle } from './ipc_server'
import type { Logger } from './logger'

/**
 * Subset of SessionTerminal used by the factory. Declared structurally so the
 * factory can be unit-tested without pulling in the vscode runtime.
 */
export interface SessionTerminalLike {
  attach(sessionId: string): void
  onDispose(cb: () => void): void
  show(): void
  dispose(): void
}

export interface PendingTerminalFactoryDeps<T extends SessionTerminalLike> {
  sessionTerminals: Map<string, T>
  buildSessionTerminal: (clientId: string, subagent: string) => T
  trackSession: (sessionId: string, term: T) => void
  resolveSubagentName: (sessionId: string) => Promise<string | undefined>
  log: Logger
}

/**
 * Produce the `IpcDeps.createPendingTerminal` callback.
 *
 * Two behaviours that make this worth its own file:
 *  - **Deferred creation**: a VS Code terminal is only created at attach()
 *    time, after the session id is known. That lets us dedupe against any
 *    existing terminal for the same session id without first opening a
 *    duplicate that we'd then need to dispose.
 *  - **Late name resolution**: if the CLI didn't pass a real subagent name
 *    (the `--session $SID` resume path falls back to the literal `'subagent'`),
 *    we look up the daemon's recorded name so the tab title isn't generic.
 */
export function makeCreatePendingTerminal<T extends SessionTerminalLike>(
  deps: PendingTerminalFactoryDeps<T>,
): (opts: PendingTerminalOptions) => SessionHandle {
  return (opts) => {
    const pendingDisposeCallbacks: Array<() => void> = []
    let term: T | undefined
    const createWith = (name: string, sessionId: string): void => {
      term = deps.buildSessionTerminal(opts.clientId, name)
      term.attach(sessionId)
      deps.trackSession(sessionId, term)
      pendingDisposeCallbacks.forEach((cb) => term?.onDispose(cb))
    }
    return {
      attach: (sessionId) => {
        const existing = deps.sessionTerminals.get(sessionId)
        if (existing) {
          deps.log(`ipc reuse: session=${sessionId} client=${opts.clientId} focused existing terminal`)
          existing.show()
          pendingDisposeCallbacks.forEach((cb) => cb())
          return
        }
        const hasRealName = !!opts.subagent && opts.subagent !== 'subagent'
        if (hasRealName) {
          createWith(opts.subagent, sessionId)
          return
        }
        void deps.resolveSubagentName(sessionId).then((resolved) => {
          createWith(resolved ?? opts.subagent, sessionId)
        })
      },
      onDispose: (cb) => {
        if (term) {
          term.onDispose(cb)
          return
        }
        pendingDisposeCallbacks.push(cb)
      },
      dispose: () => {
        if (term) {
          term.dispose()
          return
        }
        pendingDisposeCallbacks.forEach((cb) => cb())
      },
    }
  }
}
