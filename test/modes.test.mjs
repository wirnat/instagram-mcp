import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import '../dist/tools/index.js'
import { getTool, changesAccount } from '../dist/tools/registry.js'

const entry = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'dist', 'index.js')

test('changesAccount marks account-changing tools and leaves reads and scans alone', () => {
  for (const name of ['dm_send', 'ig_action', 'comment_add', 'draft_publish', 'dm_mark_seen', 'profile_update']) {
    assert.equal(changesAccount(getTool(name)), true, name)
  }
  for (const name of ['ig_fetch_profile', 'lead_discover', 'peers_scan', 'peers_report', 'events_check', 'lead_update']) {
    assert.equal(changesAccount(getTool(name)), false, name)
  }
})

test('read-only mode hides and refuses account-changing tools', async () => {
  const home = mkdtempSync(path.join(tmpdir(), 'igmcp-ro-'))
  const t = new StdioClientTransport({ command: 'node', args: [entry, 'serve'], env: { ...process.env, INSTAGRAM_MCP_HOME: home, INSTAGRAM_MCP_READ_ONLY: '1' }, stderr: 'ignore' })
  const c = new Client({ name: 'test', version: '1.0.0' })
  try {
    await c.connect(t)
    const names = (await c.listTools()).tools.map(x => x.name)
    assert.ok(!names.includes('dm_send') && !names.includes('ig_action'))
    assert.ok(names.includes('peers_scan') && names.includes('ig_fetch_profile'))
    const r = await c.callTool({ name: 'dm_send', arguments: { to: 'someone', text: 'hi' } })
    assert.equal(JSON.parse(r.content[0].text).error, 'read-only')
  } finally {
    await c.close()
    rmSync(home, { recursive: true, force: true })
  }
})

test('remote mode fails instead of starting a local browser when the server is down', () => {
  const home = mkdtempSync(path.join(tmpdir(), 'igmcp-remote-'))
  const r = spawnSync('node', [entry, 'call', 'account_info'], {
    env: { ...process.env, INSTAGRAM_MCP_HOME: home, INSTAGRAM_MCP_REMOTE: '1', INSTAGRAM_MCP_PORT: '48399' },
    encoding: 'utf8',
    timeout: 20_000,
  })
  rmSync(home, { recursive: true, force: true })
  assert.equal(r.status, 1)
  assert.equal(JSON.parse(r.stdout).error.code, 'server-down')
})
