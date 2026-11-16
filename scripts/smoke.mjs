// Tests the MCP layer without touching Instagram: lists tools and calls tools that only use local data.
// Usage: INSTAGRAM_MCP_HOME=/folder/sementara node scripts/smoke.mjs
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const entry = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'dist', 'index.js')
const t = new StdioClientTransport({ command: 'node', args: [entry, 'serve'], env: { ...process.env }, stderr: 'ignore' })
const c = new Client({ name: 'smoke', version: '1.0.0' })
await c.connect(t)
const { tools } = await c.listTools()
console.log('tools:', tools.length, '| with instant:', tools.filter(x => x.inputSchema.properties.instant).length)

const call = async (name, args) => {
  const r = await c.callTool({ name, arguments: args })
  console.log(`## ${name}${r.isError ? ' [ERROR]' : ''}:`, r.content[0].text.replace(/\s+/g, ' ').slice(0, 380))
}

await call('lead_config', {})
await call('lead_update', { username: '@test_coffee_shop', status: 'qualified', notes: 'smoke test' })
await call('lead_list', { includeUnscored: true })
await call('lead_update', { username: 'test_coffee_shop', status: 'invalid' })
await call('link_inspect', { url: 'http://127.0.0.1:48231/' })
await call('link_inspect', { url: 'http://192.168.1.1/' })
await call('link_inspect', { url: 'https://example.com/' })
await call('draft_create', { assets: ['relative/path.jpg'] })
await call('draft_list', {})
await call('jobs_status', {})
await call('unfollowers_report', {})
await c.close()
