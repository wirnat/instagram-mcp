import http from 'node:http'
import { timingSafeEqual } from 'node:crypto'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import { cfg } from './config.js'
import { IgError } from './errors.js'
import type { IgClient } from './ig/client.js'
import { allTools, getTool, inputSchema, flag } from './tools/registry.js'

export const VERSION = '0.1.0'

const INSTRUCTIONS = `This server controls one Instagram account through a real, logged-in Chrome browser.
Call account_info first to confirm the session is alive. All requests are paced automatically; do not use
\`instant\` unless the user asks for an immediate action. Action tools (DM, comment, like, follow, publish) change
the real account, so run them only when the user asks. A \`busy\`, \`rateLimited\`, or \`paused\` response means
try again later, not retry immediately.`

/** Runs one tool and turns Instagram errors into responses the agent can read. */
export const runTool = async (client: IgClient, name: string, args: Record<string, any> = {}): Promise<unknown> => {
  const tool = getTool(name)
  if (!tool) throw new Error(`Unknown tool: ${name}`)
  const { instant, ...rest } = args
  const q = client.queue
  if (tool.risk !== 'read' && q.paused) {
    return { done: false, paused: true, pausedUntil: new Date(q.pausedUntil).toISOString(), reason: q.pauseReason }
  }
  // Once Instagram logs the session out, stop completely until a new login. Retrying requests
  // in that state only adds more red flags to the account.
  if (client.loggedOut && tool.paced !== false && tool.name !== 'account_info' && !(await client.sessionAlive())) {
    return { done: false, error: 'not-logged-in', message: 'The Instagram session was logged out. Run `instagram-mcp login` on the server machine, then try again.' }
  }
  try {
    return await tool.handler(rest, client.session(tool.paced === false ? true : flag(instant)))
  } catch (e) {
    if (!(e instanceof IgError)) throw e
    if (e.code === 'busy') return { busy: true, retryAfterMs: Math.ceil(q.estimateWaitMs()), message: e.message }
    if (e.code === 'rate-limited') return { done: false, rateLimited: true, message: e.message }
    if (e.code === 'challenge' || e.code === 'action-blocked' || e.code === 'not-logged-in') {
      return { done: false, error: e.code, message: e.message }
    }
    throw e
  }
}

export const buildServer = (client: IgClient): Server => {
  const server = new Server({ name: 'instagram-mcp', version: VERSION }, { capabilities: { tools: {} }, instructions: INSTRUCTIONS })
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: allTools().map(t => ({
      name: t.name,
      description: t.description,
      inputSchema: inputSchema(t),
      annotations: { readOnlyHint: t.risk === 'read', destructiveHint: t.risk === 'action' },
    })),
  }))
  server.setRequestHandler(CallToolRequestSchema, async req => {
    try {
      const result = await runTool(client, req.params.name, (req.params.arguments ?? {}) as Record<string, any>)
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] }
    } catch (e) {
      const err = e as Error & { code?: string }
      return { isError: true, content: [{ type: 'text', text: `${err.code ? `[${err.code}] ` : ''}${err.message}` }] }
    }
  })
  return server
}

export const serveStdio = async (client: IgClient): Promise<void> => {
  const server = buildServer(client)
  await server.connect(new StdioServerTransport())
}

const readBody = (req: http.IncomingMessage): Promise<any> =>
  new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    req.on('data', (c: Buffer) => {
      size += c.length
      if (size > 8 * 1024 * 1024) {
        reject(new Error('Body too large'))
        req.destroy()
      } else chunks.push(c)
    })
    req.on('end', () => {
      try {
        resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : undefined)
      } catch {
        reject(new Error('Body is not valid JSON'))
      }
    })
    req.on('error', reject)
  })

const authorized = (req: http.IncomingMessage): boolean => {
  if (!cfg.token) return true
  const got = Buffer.from((req.headers.authorization ?? '').replace(/^Bearer\s+/i, ''))
  const want = Buffer.from(cfg.token)
  return got.length === want.length && timingSafeEqual(got, want)
}

const json = (res: http.ServerResponse, status: number, body: unknown) => {
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(JSON.stringify(body))
}

/**
 * HTTP mode: one process owns the browser and many agents connect over a URL.
 * `/mcp` is the MCP endpoint (Streamable HTTP, stateless). `/call` is a shortcut
 * for calling a single tool from the CLI.
 */
export const serveHttp = async (client: IgClient, extra?: (req: http.IncomingMessage, res: http.ServerResponse, body: any) => Promise<boolean>): Promise<http.Server> => {
  const loopback = ['127.0.0.1', 'localhost', '::1'].includes(cfg.host)
  if (!loopback && !cfg.token) throw new Error('INSTAGRAM_MCP_TOKEN is required when the server listens on anything other than 127.0.0.1')
  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', 'http://x')
      if (url.pathname === '/health') return json(res, 200, { ok: true, version: VERSION })
      if (!authorized(req)) return json(res, 401, { error: 'unauthorized' })
      if (url.pathname === '/mcp') {
        if (req.method !== 'POST') return json(res, 405, { jsonrpc: '2.0', error: { code: -32000, message: 'Method not allowed' }, id: null })
        const body = await readBody(req)
        const mcp = buildServer(client)
        const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined })
        res.on('close', () => {
          void transport.close()
          void mcp.close()
        })
        await mcp.connect(transport)
        await transport.handleRequest(req, res, body)
        return
      }
      if (url.pathname === '/call' && req.method === 'POST') {
        const body = await readBody(req)
        try {
          return json(res, 200, { result: await runTool(client, String(body?.tool), body?.args ?? {}) })
        } catch (e) {
          const err = e as Error & { code?: string; body?: string }
          return json(res, 200, { error: { code: err.code ?? 'error', message: err.message, body: err.body } })
        }
      }
      if (extra && req.method === 'POST' && (await extra(req, res, await readBody(req)))) return
      json(res, 404, { error: 'not found' })
    } catch (e) {
      if (!res.headersSent) json(res, 500, { error: (e as Error).message })
    }
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(cfg.port, cfg.host, resolve)
  })
  return server
}
