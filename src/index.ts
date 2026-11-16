#!/usr/bin/env node
import type http from 'node:http'
import { cfg, HOME, ensureDirs } from './config.js'
import { IgBrowser } from './browser.js'
import { IgClient } from './ig/client.js'
import { serveHttp, serveStdio, runTool, VERSION } from './mcp.js'
import { allTools } from './tools/registry.js'
import './tools/index.js'
import { startScheduler } from './tools/publish.js'

const HELP = `instagram-mcp ${VERSION}

Commands:
  login                 Open a Chrome window to log in to Instagram (once per machine)
  serve [--http]        Run the MCP server. Defaults to stdio; --http serves http://${cfg.host}:${cfg.port}/mcp
  status                Check whether the Instagram session is still logged in
  tools                 List tools
  call <tool> [json]    Call one tool (through the HTTP server if it is running)
  probe <url> [ms]      Open an Instagram page and record the GraphQL queries it loads

Data folder: ${HOME}`

const log = (...a: unknown[]) => console.error('[instagram-mcp]', ...a)
const daemonUrl = `http://${cfg.host === '0.0.0.0' ? '127.0.0.1' : cfg.host}:${cfg.port}`
const authHeader = (): Record<string, string> => (cfg.token ? { authorization: `Bearer ${cfg.token}` } : {})

const daemonUp = async (): Promise<boolean> => {
  try {
    const r = await fetch(`${daemonUrl}/health`, { signal: AbortSignal.timeout(1500) })
    return r.ok
  } catch {
    return false
  }
}

const daemonPost = async (path: string, body: unknown): Promise<any> => {
  const r = await fetch(`${daemonUrl}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...authHeader() },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(300_000),
  })
  return r.json()
}

const probe = async (browser: IgBrowser, url: string, waitMs: number, dump?: string) => {
  const { seen, names, finalUrl } = await browser.harvest(url, { waitMs })
  return {
    finalUrl,
    queries: names.map(n => ({ name: n.name, docId: n.docId, path: n.path, variables: n.variables })),
    responses: seen.map(s => ({
      name: s.name,
      keys: s.data?.data ? Object.keys(s.data.data) : Object.keys(s.data ?? {}),
      ...(dump && new RegExp(dump).test(s.name) && { data: s.data }),
    })),
    headers: browser.headers,
    formKeys: Object.keys(browser.form),
  }
}

const main = async () => {
  const [cmd = 'help', ...rest] = process.argv.slice(2)
  ensureDirs()

  if (cmd === 'help' || cmd === '--help' || cmd === '-h') return console.log(HELP)
  if (cmd === '--version' || cmd === 'version') return console.log(VERSION)
  if (cmd === 'tools') {
    for (const t of allTools()) console.log(`${t.name.padEnd(24)} ${t.risk.padEnd(7)} ${t.description.slice(0, 90)}`)
    return
  }

  if (cmd === 'call' && (await daemonUp())) {
    const out = await daemonPost('/call', { tool: rest[0], args: rest[1] ? JSON.parse(rest[1]) : {} })
    console.log(JSON.stringify(out.result ?? out, null, 2))
    return
  }
  if (cmd === 'raw') {
    // Debug: send one raw request through the running server (requires INSTAGRAM_MCP_DEBUG=1 on the server).
    const out = await daemonPost('/raw', { method: rest[0], path: rest[1], params: rest[2] ? JSON.parse(rest[2]) : undefined })
    console.log(JSON.stringify(out, null, 1).slice(0, Number(rest[3]) || 6000))
    return
  }
  if (cmd === 'probe' && (await daemonUp())) {
    console.log(JSON.stringify(await daemonPost('/probe', { url: rest[0], waitMs: Number(rest[1]) || 8000, dump: rest[2] }), null, 2))
    return
  }

  const browser = new IgBrowser()
  const client = new IgClient(browser)
  const shutdown = async (code = 0) => {
    await browser.stop()
    process.exit(code)
  }
  process.on('SIGINT', () => void shutdown())
  process.on('SIGTERM', () => void shutdown())

  if (cmd === 'login') {
    log('Opening a Chrome window. Log in to Instagram in that window.')
    const ok = await browser.login(Number(rest[0]) > 0 ? Number(rest[0]) * 60_000 : undefined)
    if (ok) {
      const info: any = await runTool(client, 'account_info', { instant: true }).catch(e => ({ error: String(e) }))
      log(`Logged in${info?.username ? ` as @${info.username}` : ''}. Session saved in ${HOME}/profile`)
    } else log('Login did not finish before the timeout.')
    return shutdown(ok ? 0 : 1)
  }

  if (cmd === 'status') {
    await browser.start()
    console.log(JSON.stringify(await runTool(client, 'account_info', { instant: true }), null, 2))
    return shutdown()
  }

  if (cmd === 'call') {
    await browser.start()
    try {
      console.log(JSON.stringify(await runTool(client, rest[0], rest[1] ? JSON.parse(rest[1]) : {}), null, 2))
    } catch (e) {
      const err = e as Error & { code?: string; body?: string }
      console.log(JSON.stringify({ error: { code: err.code ?? 'error', message: err.message, body: err.body } }, null, 2))
    }
    return shutdown()
  }

  if (cmd === 'probe') {
    await browser.start()
    console.log(JSON.stringify(await probe(browser, rest[0], Number(rest[1]) || 8000, rest[2]), null, 2))
    return shutdown()
  }

  if (cmd === 'serve') {
    if (rest.includes('--http')) {
      const server: http.Server = await serveHttp(client, async (req, res, body) => {
        const pathname = new URL(req.url ?? '/', 'http://x').pathname
        if (pathname === '/raw' && process.env.INSTAGRAM_MCP_DEBUG) {
          const ig = client.session(false, true)
          let out: unknown
          try {
            if (body?.method === 'GQL') {
              const { __path, ...vars } = body.params ?? {}
              out = await ig.gql(String(body.path), vars, undefined, __path)
            }
            else if (body?.method === 'POST') out = await ig.post(String(body.path), body.params ?? {})
            else if (body?.method === 'GREP') {
              // Fetch a page as text and show snippets around each pattern.
              await browser.start()
              const r = await browser.fetch(String(body.path), { allow: [400, 404] })
              out = { status: r.status, length: r.text.length, hits: Object.fromEntries((body.params?.patterns ?? []).map((p: string) => [p, [...r.text.matchAll(new RegExp(p, 'g'))].slice(0, 6).map(m => r.text.slice(Math.max(0, m.index - 80), m.index + 160))])) }
            } else if (body?.method === 'OP') {
              await browser.start()
              out = (await browser.operation(String(body.path))) ?? { notLoaded: true }
            } else if (body?.method === 'SRC') {
              await browser.start()
              out = await browser.grepScripts(String(body.path), Number(body.params?.after) || 1200, Number(body.params?.max) || 4)
            } else if (body?.method === 'DOCIDS') {
              await browser.start()
              await browser.scanScripts()
              out = [...browser.docIds.entries()].filter(([k]) => new RegExp(String(body.path ?? '.'), 'i').test(k))
            } else out = await ig.get(String(body?.path), body?.params)
          } catch (e) {
            const err = e as Error & { code?: string; body?: string; status?: number }
            out = { error: { code: err.code, status: err.status, message: err.message, body: err.body } }
          }
          res.writeHead(200, { 'content-type': 'application/json' })
          res.end(JSON.stringify(out))
          return true
        }
        if (pathname !== '/probe') return false
        await browser.start()
        const out = await probe(browser, String(body?.url), Number(body?.waitMs) || 8000, body?.dump)
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify(out))
        return true
      })
      startScheduler(client)
      log(`MCP server at http://${cfg.host}:${cfg.port}/mcp${cfg.token ? ' (bearer token required)' : ''}`)
      browser.start().then(
        async () => log((await browser.isLoggedIn()) ? 'Browser ready, Instagram session is logged in.' : 'Browser ready, but Instagram is NOT logged in. Run `login`.'),
        e => log('Failed to start the browser:', (e as Error).message),
      )
      process.on('SIGINT', () => server.close())
      return
    }
    startScheduler(client)
    await serveStdio(client)
    log('MCP server ready on stdio.')
    return
  }

  console.log(HELP)
  process.exit(1)
}

main().catch(e => {
  log('Failed:', (e as Error).message)
  process.exit(1)
})
