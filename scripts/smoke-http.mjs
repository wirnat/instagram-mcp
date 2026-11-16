// Tests HTTP mode with a real MCP client: requests without a valid token must be rejected, with the token they must work.
// Usage: node scripts/smoke-http.mjs http://127.0.0.1:48301/mcp <token>
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'

const [url, token] = process.argv.slice(2)

const noAuth = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })
console.log('no token ->', noAuth.status)
const wrong = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer wrong' }, body: '{}' })
console.log('wrong token ->', wrong.status)

const transport = new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers: { authorization: `Bearer ${token}` } } })
const client = new Client({ name: 'smoke-http', version: '1.0.0' })
await client.connect(transport)
const { tools } = await client.listTools()
console.log('tools ->', tools.length, '| sample:', tools.slice(0, 4).map(t => t.name).join(', '))

const call = async (name, args = {}) => {
  const r = await client.callTool({ name, arguments: args })
  console.log(`${name}${r.isError ? ' [ERROR]' : ''} ->`, r.content[0].text.replace(/\s+/g, ' ').slice(0, 260))
}
await call('lead_list', { limit: 2 })
await call('jobs_status')
await call('draft_list')
await call('account_info')
await client.close()
