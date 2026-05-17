import { spawn } from 'node:child_process'

export type CliStatus = 'ok' | 'not-found' | 'outdated'

export interface CliHealth {
  status: CliStatus
  version?: string
  error?: string
}

/**
 * Check whether the subagent-cli executable is installed and meets the minimum
 * version. Used to drive the status bar's three-state UI.
 */
export async function checkCli(cliPath: string, minVersion: string): Promise<CliHealth> {
  const cmd = cliPath || 'subagent-cli'
  try {
    const version = await spawnVersion(cmd)
    if (compareSemver(version, minVersion) < 0) return { status: 'outdated', version }
    return { status: 'ok', version }
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err)
    return { status: 'not-found', error }
  }
}

function spawnVersion(cmd: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, ['--version'], { stdio: ['ignore', 'pipe', 'pipe'] })
    const chunks: string[] = []
    child.stdout?.on('data', (d: Buffer) => chunks.push(d.toString()))
    child.on('error', reject)
    child.on('exit', (code) => {
      if (code !== 0) {
        reject(new Error(`${cmd} --version exited ${code}`))
        return
      }
      const match = chunks.join('').match(/(\d+)\.(\d+)\.(\d+)/)
      if (!match) {
        reject(new Error(`Unrecognized version output from ${cmd}`))
        return
      }
      resolve(match[0])
    })
  })
}

const parse = (s: string): [number, number, number] => {
  const p = s.split('.').map(Number)
  return [p[0] ?? 0, p[1] ?? 0, p[2] ?? 0]
}

/** Compare two semver-ish strings; negative if a<b, 0 equal, positive if a>b. */
export function compareSemver(a: string, b: string): number {
  const [a0, a1, a2] = parse(a)
  const [b0, b1, b2] = parse(b)
  return a0 - b0 || a1 - b1 || a2 - b2
}
