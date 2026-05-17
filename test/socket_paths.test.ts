import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as net from 'node:net'
import * as os from 'node:os'
import * as path from 'node:path'
import { test } from 'node:test'
import { cleanupOrphanSockets, getSocketPath } from '../src/socket_paths'

test('getSocketPath: unix path under tmpdir', { skip: process.platform === 'win32' }, () => {
  const p = getSocketPath('abcd1234')
  assert.equal(p, path.join(os.tmpdir(), 'subagent-cli_abcd1234.sock'))
})

test('getSocketPath: windows named pipe', { skip: process.platform !== 'win32' }, () => {
  assert.equal(getSocketPath('abcd1234'), '\\\\.\\pipe\\subagent-cli_abcd1234')
})

test(
  'cleanupOrphanSockets removes dead socket files, keeps live ones',
  { skip: process.platform === 'win32' },
  async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-test-'))
    const dead = path.join(dir, 'subagent-cli_dead0001.sock')
    fs.writeFileSync(dead, '') // plain file, no listener → dead

    const liveServer = net.createServer()
    const livePath = path.join(dir, 'subagent-cli_live0002.sock')
    await new Promise<void>((resolve) => liveServer.listen(livePath, resolve))

    // Unrelated file must be untouched.
    const other = path.join(dir, 'keep-me.txt')
    fs.writeFileSync(other, 'x')

    await cleanupOrphanSockets(dir)

    assert.equal(fs.existsSync(dead), false, 'dead socket should be removed')
    assert.equal(fs.existsSync(livePath), true, 'live socket should be kept')
    assert.equal(fs.existsSync(other), true, 'unrelated file should be kept')

    liveServer.close()
    fs.rmSync(dir, { recursive: true, force: true })
  },
)
