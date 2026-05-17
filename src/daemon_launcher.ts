import { spawn } from 'node:child_process'
import * as vscode from 'vscode'
import { probePort, waitForDaemon } from './net_probe'

interface DaemonConfig {
  port: number
  cliPath: string
}

/** Ensure the App daemon is running. Probes the configured port; spawns via CLI on miss. */
export async function ensureDaemon(): Promise<void> {
  const cfg = readDaemonConfig()
  if (await probePort(cfg.port)) return
  await spawnCliDaemonStart(cfg)
  await waitForDaemon(cfg.port, 10_000)
}

function readDaemonConfig(): DaemonConfig {
  const cfg = vscode.workspace.getConfiguration('subagent-cli')
  return {
    port: cfg.get<number>('daemon.port', 7100),
    cliPath: cfg.get<string>('cli.path', ''),
  }
}

function spawnCliDaemonStart(cfg: DaemonConfig): Promise<void> {
  return new Promise((resolve, reject) => {
    const args = ['daemon', 'start', '--port', String(cfg.port)]
    const command = cfg.cliPath || 'subagent-cli'
    // Daemon inherits cwd from its launcher (us). Pass the workspace folder so
    // the daemon's working dir is sensible (matters as a fallback when callers
    // omit --cwd; otherwise sessions would land in '/').
    const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? process.cwd()
    // Critical: blank SUBAGENT_VSCODE_IPC so the child CLI does not loop back via IPC
    // (daemon is not up yet, so any IPC handshake would deadlock).
    const child = spawn(command, args, {
      detached: true,
      stdio: 'pipe',
      cwd,
      env: { ...process.env, SUBAGENT_VSCODE_IPC: '' },
    })

    let stderr = ''
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString()
    })
    child.on('error', (err) => reject(new Error(`Failed to spawn ${command}: ${err.message}`)))
    child.on('exit', (code) => {
      if (code === 0) resolve()
      else reject(new Error(stderr.trim() || `subagent-cli daemon start exited with code ${code}`))
    })
  })
}
