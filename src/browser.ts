import { chromium, type BrowserContext, type Page, type Request } from 'playwright-core'
import { cfg, PROFILE_DIR, ensureDirs } from './config.js'
import { IgError, classify } from './errors.js'
import { Store } from './store.js'

export const ORIGIN = 'https://www.instagram.com'
/** Instagram web app id. Fallback only: the real value is copied from Instagram's own requests. */
const APP_ID_FALLBACK = '936619743392459'
const SNIFF_HEADERS = ['x-ig-app-id', 'x-asbd-id', 'x-ig-www-claim', 'x-instagram-ajax', 'x-web-session-id', 'x-bloks-version-id']
const BASE_FORM_KEYS = [
  'av', '__d', '__user', '__a', '__hs', 'dpr', '__ccg', '__rev', '__s', '__hsi', '__dyn', '__csr', '__hsdp', '__hblp',
  '__sjsp', '__comet_req', 'fb_dtsg', 'jazoest', 'lsd', '__spin_r', '__spin_b', '__spin_t', '__crn',
]

export type FetchOpts = {
  method?: 'GET' | 'POST'
  query?: Record<string, string | number | boolean | null | undefined>
  form?: Record<string, string | number | boolean | null | undefined>
  /** Raw JSON body, for endpoints that do not accept form data. */
  json?: unknown
  headers?: Record<string, string>
  /** Do not throw for these statuses; return the response as is. */
  allow?: number[]
}
export type UploadOpts = {
  kind: 'image' | 'video'
  uploadId: string
  mode: 'feed' | 'story'
  /** Forced width/height ratio (used by carousels so every slide matches). */
  ratio?: number
  /** Story: fill the screen by cropping (true) or add black bars (false). */
  stretch?: boolean
  isClips?: boolean
  isSidecar?: boolean
}
export type UploadResult = { width: number; height: number; ratio: number; durationMs: number }
/** Pages opened to learn queries that the home page does not load. */
const LEARN_URLS: Record<string, string> = {
  PolarisDirectInboxQuery: '/direct/inbox/',
  IGDThreadDetailQuery: '/direct/inbox/',
  PolarisDirectMessageRequestQuery: '/direct/requests/',
  PolarisProfileTaggedTabContentQuery: '/instagram/tagged/',
  useIGDMarkThreadAsReadMutation: '/direct/inbox/',
  PolarisKeywordSearchExplorePageRelayQuery: '/explore/search/keyword/?q=salon',
}
type Learned = Record<string, { docId: string; provided?: Record<string, unknown>; path?: string; confirmed?: boolean; at: number }>
const learnedStore = new Store<Learned>('gql-learned', () => ({}))

export type OperationInfo = { id: string; provided: Record<string, unknown>; args: string[] }
export type FetchResult = { status: number; url: string; text: string; json: any }
export type GqlSeen = { name: string; docId: string; variables: any; at: number; path?: string }
export type Harvested = { name: string; variables: any; data: any }

const isGqlUrl = (url: string) => /^https:\/\/www\.instagram\.com\/(graphql\/query|api\/graphql)/.test(url)
const isApiUrl = (url: string) => /^https:\/\/www\.instagram\.com\/api\/v1\//.test(url)
const parseJson = (text: string): any => {
  const t = text.startsWith('for (;;);') ? text.slice(9) : text
  const c = t.trimStart()[0]
  if (c !== '{' && c !== '[') return undefined
  try {
    return JSON.parse(t)
  } catch {
    return undefined
  }
}
const cleanParams = (o: Record<string, unknown> | undefined) => {
  const p = new URLSearchParams()
  for (const [k, v] of Object.entries(o ?? {})) if (v !== undefined && v !== null) p.set(k, String(v))
  return p
}

/**
 * A real Chrome with its own profile, logged in to Instagram. Every request is sent from inside
 * an instagram.com page, so the cookies, headers, and fingerprint belong to that browser.
 * Required headers and tokens are copied from requests made by the Instagram web app itself,
 * never guessed.
 */
export class IgBrowser {
  ctx: BrowserContext | null = null
  private apiPage: Page | null = null
  private starting: Promise<void> | null = null
  private reqCounter = 1
  headers: Record<string, string> = {}
  form: Record<string, string> = {}
  docIds = new Map<string, string>()
  gqlLog: GqlSeen[] = []
  private scriptUrls = new Set<string>()
  private scannedScripts = new Set<string>()
  private irisDevice: string | null = null
  /** Endpoint the web app uses for each query: some go to /graphql/query, DMs go to /api/graphql. */
  gqlPaths = new Map<string, string>()
  /** Queries whose endpoint has been confirmed to return data. */
  private confirmedPaths = new Set<string>()
  private operations = new Map<string, OperationInfo>()
  private learning: Record<string, Promise<void>> = {}
  /** Provided variables seen in Instagram's own requests, used as a fallback when the module cannot be loaded. */
  private sniffedProvided = new Map<string, Record<string, unknown>>()
  /** Only filled while debugging (grepScripts). */
  private scriptText = new Map<string, string>()

  async start(opts: { headless?: boolean } = {}): Promise<void> {
    if (this.ctx) return
    this.starting ??= this.launch(opts).finally(() => (this.starting = null))
    await this.starting
  }

  private async launch(opts: { headless?: boolean }): Promise<void> {
    ensureDirs()
    const args = ['--disable-blink-features=AutomationControlled', '--no-first-run', '--no-default-browser-check']
    if (process.env.INSTAGRAM_MCP_NO_SANDBOX) args.push('--no-sandbox')
    const ctx = await chromium.launchPersistentContext(PROFILE_DIR, {
      headless: opts.headless ?? cfg.headless,
      ...(cfg.chromePath ? { executablePath: cfg.chromePath } : cfg.channel ? { channel: cfg.channel } : {}),
      viewport: { width: 1280, height: 860 },
      args,
      ignoreDefaultArgs: ['--enable-automation'],
    })
    ctx.on('request', req => this.sniff(req))
    ctx.on('close', () => {
      this.ctx = null
      this.apiPage = null
    })
    this.ctx = ctx
    this.loadLearned()
  }

  async stop(): Promise<void> {
    await this.ctx?.close().catch(() => undefined)
    this.ctx = null
    this.apiPage = null
  }

  /** Records headers, tokens, and doc_ids from requests made by the Instagram web app itself. */
  private sniff(req: Request): void {
    const url = req.url()
    if (req.resourceType() === 'script') {
      if (/cdninstagram\.com|instagram\.com\/rsrc|fbcdn\.net/.test(url)) this.scriptUrls.add(url)
      return
    }
    if (!isGqlUrl(url) && !isApiUrl(url)) return
    const h = req.headers()
    for (const k of SNIFF_HEADERS) if (h[k]) this.headers[k] = h[k]
    if (req.method() !== 'POST' || !isGqlUrl(url)) return
    const body = req.postData()
    if (!body) return
    const p = new URLSearchParams(body)
    for (const k of BASE_FORM_KEYS) {
      const v = p.get(k)
      if (v) this.form[k] = v
    }
    const name = p.get('fb_api_req_friendly_name')
    const docId = p.get('doc_id')
    if (name && docId) {
      this.docIds.set(name, docId)
      this.gqlPaths.set(name, new URL(url).pathname)
      this.confirmedPaths.add(name)
      let variables: any = null
      try {
        variables = JSON.parse(p.get('variables') || 'null')
      } catch {
        /* leave as null */
      }
      if (variables && typeof variables === 'object') {
        // The device id for the realtime DM subscription is only valid while its page is open,
        // so only ids from the server's own persistent tab are recorded.
        const dev = (variables as Record<string, unknown>).device_id_for_iris_subscription
        if (typeof dev === 'string' && this.fromApiPage(req)) this.irisDevice = dev
        const pv = Object.fromEntries(Object.entries(variables).filter(([k]) => k.startsWith('__relay_internal__pv__')))
        if (Object.keys(pv).length) this.sniffedProvided.set(name, pv)
      }
      this.gqlLog.push({ name, docId, variables, at: Date.now(), path: new URL(url).pathname })
      if (this.gqlLog.length > 400) this.gqlLog.splice(0, 100)
    }
  }

  private fromApiPage(req: Request): boolean {
    try {
      return !!this.apiPage && req.frame().page() === this.apiPage
    } catch {
      return false
    }
  }

  /** Realtime DM device id of the persistent tab. If not seen yet, the tab is reloaded once. */
  async irisDeviceId(): Promise<string> {
    const page = await this.api()
    for (let i = 0; i < 2 && !this.irisDevice; i++) {
      if (i > 0) await page.reload({ waitUntil: 'domcontentloaded', timeout: 45_000 })
      for (let t = 0; t < 16 && !this.irisDevice; t++) await page.waitForTimeout(500)
    }
    if (!this.irisDevice) throw new IgError('other', 'The DM device id is not available on the Instagram page yet')
    return this.irisDevice
  }

  private requireCtx(): BrowserContext {
    if (!this.ctx) throw new Error('Browser has not been started')
    return this.ctx
  }

  async cookies(): Promise<Record<string, string>> {
    const list = await this.requireCtx().cookies(ORIGIN)
    return Object.fromEntries(list.map(c => [c.name, c.value]))
  }

  async isLoggedIn(): Promise<boolean> {
    const c = await this.cookies()
    return !!c.sessionid && !!c.ds_user_id
  }

  async viewerId(): Promise<string> {
    const id = (await this.cookies()).ds_user_id
    if (!id) throw new IgError('not-logged-in', 'Instagram is not logged in on this browser. Run the `login` command.')
    return id
  }

  /** Persistent instagram.com tab used to send requests. */
  async api(): Promise<Page> {
    const ctx = this.requireCtx()
    if (!this.apiPage || this.apiPage.isClosed()) this.apiPage = ctx.pages()[0] ?? (await ctx.newPage())
    const page = this.apiPage
    if (!page.url().startsWith(ORIGIN) || /\/accounts\/login|\/challenge\//.test(page.url())) {
      await page.goto(`${ORIGIN}/`, { waitUntil: 'domcontentloaded', timeout: 45_000 })
      await page.waitForTimeout(1500)
    }
    const url = page.url()
    if (/\/accounts\/login/.test(url)) throw new IgError('not-logged-in', 'Instagram is not logged in on this browser. Run the `login` command.')
    if (/\/challenge\//.test(url)) throw new IgError('challenge', 'Instagram is asking to verify the account. Complete it in the browser window, then try again.')
    return page
  }

  /** Request sent from inside the Instagram page, with the browser's own cookies and headers. */
  async fetch(pathOrUrl: string, opts: FetchOpts = {}): Promise<FetchResult> {
    const page = await this.api()
    const cookies = await this.cookies()
    const method = opts.method ?? 'GET'
    const u = new URL(pathOrUrl, ORIGIN)
    for (const [k, v] of cleanParams(opts.query)) u.searchParams.set(k, v)
    const headers: Record<string, string> = {
      accept: '*/*',
      'x-ig-app-id': this.headers['x-ig-app-id'] ?? APP_ID_FALLBACK,
      'x-requested-with': 'XMLHttpRequest',
      'x-csrftoken': cookies.csrftoken ?? '',
    }
    for (const k of ['x-asbd-id', 'x-instagram-ajax', 'x-web-session-id']) if (this.headers[k]) headers[k] = this.headers[k]
    let body: string | undefined
    if (opts.form) {
      body = cleanParams(opts.form).toString()
      headers['content-type'] = 'application/x-www-form-urlencoded'
    } else if (opts.json !== undefined) {
      body = JSON.stringify(opts.json)
      headers['content-type'] = 'application/json'
    }
    Object.assign(headers, opts.headers)
    const res = await page.evaluate(
      async ({ url, method, headers, body }) => {
        if (!headers['x-ig-www-claim']) headers['x-ig-www-claim'] = sessionStorage.getItem('www-claim-v2') || '0'
        const r = await fetch(url, { method, headers, body, credentials: 'include' })
        return { status: r.status, url: r.url, text: await r.text() }
      },
      { url: u.toString(), method, headers, body },
    )
    const code = classify(res.status, res.url, res.text)
    if (code && !opts.allow?.includes(res.status)) {
      const msg = parseJson(res.text)?.message
      throw new IgError(code, `${method} ${u.pathname} failed (${res.status}${msg ? `: ${String(msg).slice(0, 160)}` : ''})`, { status: res.status, body: res.text })
    }
    return { ...res, json: parseJson(res.text) }
  }

  /**
   * Fetches a page and searches it for one pattern, entirely inside the browser.
   * Used to resolve a username to an id without moving hundreds of KB of HTML to the server.
   */
  async fetchMatch(path: string, pattern: string): Promise<{ status: number; url: string; match: string | null }> {
    const page = await this.api()
    return page.evaluate(
      async ({ url, pattern }) => {
        const r = await fetch(url, { credentials: 'include' })
        const m = (await r.text()).match(new RegExp(pattern))
        return { status: r.status, url: r.url, match: m ? (m[1] ?? m[0]) : null }
      },
      { url: new URL(path, ORIGIN).toString(), pattern },
    )
  }

  /** fb_dtsg and lsd tokens. Taken from Instagram's own requests, or from the page if none seen yet. */
  async ensureTokens(): Promise<void> {
    if (this.form.fb_dtsg && this.form.lsd) return
    const page = await this.api()
    const t = await page.evaluate(() => {
      const out: { dtsg?: string; lsd?: string } = {}
      try {
        const req = (window as any).require
        out.dtsg = req('DTSGInitData')?.token
        out.lsd = req('LSD')?.token
      } catch {
        /* fall through to the second method */
      }
      if (!out.dtsg || !out.lsd) {
        const html = document.documentElement.innerHTML
        out.dtsg ||= html.match(/"DTSGInitData",\[\],\{"token":"([^"]+)"/)?.[1] ?? html.match(/"dtsg":\{"token":"([^"]+)"/)?.[1]
        out.lsd ||= html.match(/"LSD",\[\],\{"token":"([^"]+)"/)?.[1]
      }
      return out
    })
    if (!t.dtsg) throw new IgError('not-logged-in', 'Instagram page tokens not found. Make sure the account is logged in.')
    this.form.fb_dtsg = t.dtsg
    if (t.lsd) this.form.lsd = t.lsd
    this.form.jazoest = `2${[...t.dtsg].reduce((s, c) => s + c.charCodeAt(0), 0)}`
    this.form.av ??= await this.viewerId()
    this.form.__user ??= '0'
    this.form.__a ??= '1'
    this.form.__d ??= 'www'
    this.form.__comet_req ??= '7'
  }

  /** Looks up a query's doc_id in the JavaScript files loaded by the Instagram web app. */
  async resolveDocId(name: string): Promise<string> {
    const known = this.docIds.get(name)
    if (known) return known
    await this.scanScripts()
    const found = this.docIds.get(name)
    if (!found) throw new IgError('no-doc-id', `doc_id for ${name} not found on the Instagram page`)
    return found
  }

  async scanScripts(): Promise<number> {
    const ctx = this.requireCtx()
    const page = await this.api()
    const fromDom = await page.evaluate(() => [
      ...Array.from(document.scripts, s => s.src),
      ...performance.getEntriesByType('resource').map(e => e.name),
    ])
    for (const u of fromDom) if (/\.js(\?|$)/.test(u) && /cdninstagram\.com|instagram\.com\/rsrc|fbcdn\.net/.test(u)) this.scriptUrls.add(u)
    const todo = [...this.scriptUrls].filter(u => !this.scannedScripts.has(u))
    const re = /"([A-Za-z0-9_]+)_instagramRelayOperation"[^"]{0,160}?exports="(\d+)"/g
    let added = 0
    const worker = async () => {
      for (;;) {
        const url = todo.pop()
        if (!url) return
        this.scannedScripts.add(url)
        try {
          const text = await (await ctx.request.get(url, { timeout: 30_000 })).text()
          for (const m of text.matchAll(re)) {
            if (!this.docIds.has(m[1])) added++
            this.docIds.set(m[1], m[2])
          }
        } catch {
          this.scannedScripts.delete(url)
        }
      }
    }
    await Promise.all(Array.from({ length: 6 }, worker))
    return added
  }

  /** Debug: searches Instagram's JavaScript files for a pattern and returns surrounding snippets. */
  async grepScripts(pattern: string, after = 1200, max = 4): Promise<string[]> {
    const ctx = this.requireCtx()
    await this.scanScripts()
    const re = new RegExp(pattern, 'g')
    const out: string[] = []
    for (const url of this.scannedScripts) {
      if (out.length >= max) break
      try {
        const text = this.scriptText.get(url) ?? (await (await ctx.request.get(url, { timeout: 30_000 })).text())
        this.scriptText.set(url, text)
        for (const m of text.matchAll(re)) {
          out.push(text.slice(Math.max(0, m.index - 40), m.index + after))
          if (out.length >= max) break
        }
      } catch {
        /* skip files that fail to download */
      }
    }
    return out
  }

  /**
   * Some queries are only loaded on specific pages (for example the DM inbox). For those, the
   * page is opened briefly once, and the doc_id and provided variables sent by the Instagram
   * web app are recorded and saved to disk.
   */
  async learn(name: string): Promise<void> {
    const url = LEARN_URLS[name]
    if (!url) return
    this.learning[url] ??= this.harvest(url, { waitMs: 9000, until: () => this.docIds.has(name) }).then(
      () => undefined,
      () => undefined,
    )
    await this.learning[url]
    delete this.learning[url]
    this.saveLearned()
  }

  private loadLearned(): void {
    const s = learnedStore.get()
    for (const [name, v] of Object.entries(s)) {
      if (Date.now() - v.at > 24 * 3_600_000) continue
      this.docIds.set(name, v.docId)
      if (v.provided) this.sniffedProvided.set(name, v.provided)
      if (v.path) this.gqlPaths.set(name, v.path)
      if (v.confirmed) this.confirmedPaths.add(name)
    }
  }

  private saveLearned(): void {
    const out: Learned = {}
    for (const name of new Set([...Object.keys(LEARN_URLS), ...this.confirmedPaths])) {
      const docId = this.docIds.get(name)
      if (docId) out[name] = { docId, provided: this.sniffedProvided.get(name), path: this.gqlPaths.get(name), confirmed: this.confirmedPaths.has(name), at: Date.now() }
    }
    learnedStore.set(out)
  }

  /**
   * Reads a query definition from a module already loaded by the Instagram page: the doc_id and
   * "provided variables" (values filled in by Instagram's own code, such as feature flags).
   * This way doc_ids are never hardcoded and follow along when Instagram ships a new version.
   */
  async operation(name: string): Promise<OperationInfo | null> {
    const cached = this.operations.get(name)
    if (cached) return cached
    const page = await this.api()
    const info = await page.evaluate(async n => {
      const w = window as any
      const read = () => {
        const op = w.require(`${n}.graphql`)
        const params = op.params ?? op.default?.params
        if (!params?.id) return null
        const provided: Record<string, unknown> = {}
        for (const [k, v] of Object.entries(params.providedVariables ?? {})) {
          try {
            provided[k] = (v as { get: () => unknown }).get()
          } catch {
            provided[k] = false
          }
        }
        const defs = (op.fragment ?? op.default?.fragment)?.argumentDefinitions ?? []
        return { id: String(params.id), provided, args: defs.map((a: { name: string }) => a.name) as string[] }
      }
      try {
        return read()
      } catch {
        /* module not loaded yet; ask Instagram's module loader to fetch it */
      }
      try {
        await new Promise<void>((ok, no) => {
          const timer = setTimeout(() => no(new Error('timeout')), 8000)
          w.require('Bootloader').loadModules([`${n}.graphql`], () => {
            clearTimeout(timer)
            ok()
          }, 'relay')
        })
        return read()
      } catch {
        return null
      }
    }, name)
    if (info) {
      this.operations.set(name, info)
      this.docIds.set(name, info.id)
    }
    return info
  }

  async gql(name: string, variables: Record<string, unknown>, opts: { docId?: string; path?: string } = {}): Promise<any> {
    const op = opts.docId ? null : await this.operation(name)
    if (!op && !opts.docId && !this.docIds.has(name)) await this.learn(name)
    const docId = opts.docId ?? op?.id ?? (await this.resolveDocId(name))
    variables = { ...(op?.provided ?? this.sniffedProvided.get(name)), ...variables }
    await this.ensureTokens()
    const form: Record<string, string> = {
      ...this.form,
      __req: (this.reqCounter++).toString(36),
      fb_api_caller_class: 'RelayModern',
      fb_api_req_friendly_name: name,
      variables: JSON.stringify(variables),
      server_timestamps: 'true',
      doc_id: docId,
    }
    const headers: Record<string, string> = { 'x-fb-friendly-name': name }
    if (form.lsd) headers['x-fb-lsd'] = form.lsd
    // The web app sends some queries to /graphql/query and others to /api/graphql. The wrong endpoint
    // returns empty data without an error, so the other one is tried once and the working one is remembered.
    const preferred = opts.path ?? this.gqlPaths.get(name) ?? (/^(IGD|IGDirect|useIGD)|Mutation$/.test(name) ? '/api/graphql' : '/graphql/query')
    // Mutations are never tried twice, so an action is never sent twice. Read queries always keep the
    // other endpoint as a fallback, even after a path was confirmed: Instagram moves queries between
    // endpoints, and a stale confirmed path otherwise returns empty data forever.
    const single = !!opts.path || /Mutation$/.test(name)
    const candidates = single ? [preferred] : [preferred, preferred === '/api/graphql' ? '/graphql/query' : '/api/graphql']
    let last: any
    for (const path of candidates) {
      const r = await this.fetch(path, { method: 'POST', form: { ...form, __req: (this.reqCounter++).toString(36) }, headers })
      if (!r.json) throw new IgError('html-response', `${name} did not return JSON`, { status: r.status, body: r.text })
      last = r.json
      const hasData = r.json.data && Object.values(r.json.data).some(v => v != null)
      if (r.json.errors?.length && !hasData) {
        const e = r.json.errors[0]
        if (path === candidates.at(-1)) throw new IgError('graphql-error', `${name}: ${e?.message ?? 'GraphQL error'}`, { body: r.text })
        continue
      }
      if (hasData) {
        const changed = this.gqlPaths.get(name) !== path
        this.gqlPaths.set(name, path)
        if (changed || !this.confirmedPaths.has(name)) {
          this.confirmedPaths.add(name)
          this.saveLearned()
        }
        return r.json
      }
    }
    return last
  }

  /**
   * Uploads one photo or video from a local file. The file is served to the page through a
   * local route, and the page itself sends it to Instagram, the same way a person posts from
   * the web. Photos are converted to JPEG and cropped to an accepted ratio.
   */
  async uploadMedia(file: string, o: UploadOpts): Promise<UploadResult> {
    const page = await this.api()
    const cookies = await this.cookies()
    const token = `${Date.now()}${Math.floor(Math.random() * 1e6)}`
    const pattern = (u: URL) => u.pathname === `/__igmcp_asset__/${token}`
    await page.route(pattern, route => route.fulfill({ path: file, contentType: o.kind === 'video' ? 'video/mp4' : 'application/octet-stream' }))
    const headers: Record<string, string> = {
      'x-ig-app-id': this.headers['x-ig-app-id'] ?? APP_ID_FALLBACK,
      'x-csrftoken': cookies.csrftoken ?? '',
    }
    for (const k of ['x-asbd-id', 'x-instagram-ajax']) if (this.headers[k]) headers[k] = this.headers[k]
    try {
      const res = await page.evaluate(
        async ({ token, o, headers }) => {
          const blob = await (await fetch(`/__igmcp_asset__/${token}`)).blob()
          const toJpeg = (c: HTMLCanvasElement) => new Promise<Blob>((ok, no) => c.toBlob(b => (b ? ok(b) : no(new Error('Failed to create JPEG'))), 'image/jpeg', 0.92))
          const send = async (kind: 'igphoto' | 'igvideo', body: Blob, type: string, params: Record<string, unknown>) => {
            const name = `fb_uploader_${o.uploadId}`
            const r = await fetch(`https://i.instagram.com/rupload_${kind}/${name}`, {
              method: 'POST',
              credentials: 'include',
              headers: { ...headers, 'x-instagram-rupload-params': JSON.stringify(params), 'x-entity-name': name, 'x-entity-length': String(body.size), 'x-entity-type': type, offset: '0', 'content-type': type },
              body,
            })
            const text = await r.text()
            if (!r.ok || !/"status":\s*"ok"/.test(text)) throw new Error(`Upload ${kind} rejected (${r.status}): ${text.slice(0, 200)}`)
          }
          if (o.kind === 'image') {
            const bmp = await createImageBitmap(blob)
            let sx = 0, sy = 0, sw = bmp.width, sh = bmp.height
            let outW: number, outH: number
            const canvas = document.createElement('canvas')
            const g = canvas.getContext('2d')!
            if (o.mode === 'story') {
              outW = 1080
              outH = 1920
              canvas.width = outW
              canvas.height = outH
              g.fillStyle = '#000'
              g.fillRect(0, 0, outW, outH)
              const scale = o.stretch ? Math.max(outW / sw, outH / sh) : Math.min(outW / sw, outH / sh)
              const dw = sw * scale, dh = sh * scale
              g.drawImage(bmp, (outW - dw) / 2, (outH - dh) / 2, dw, dh)
            } else {
              const ratio = o.ratio ?? Math.min(1.91, Math.max(0.8, sw / sh))
              if (sw / sh > ratio) {
                const nw = sh * ratio
                sx = (sw - nw) / 2
                sw = nw
              } else if (sw / sh < ratio) {
                const nh = sw / ratio
                sy = (sh - nh) / 2
                sh = nh
              }
              outW = Math.round(Math.min(1080, sw))
              outH = Math.round(outW / ratio)
              canvas.width = outW
              canvas.height = outH
              g.drawImage(bmp, sx, sy, sw, sh, 0, 0, outW, outH)
            }
            const jpeg = await toJpeg(canvas)
            await send('igphoto', jpeg, 'image/jpeg', { media_type: 1, upload_id: o.uploadId, upload_media_height: outH, upload_media_width: outW })
            return { width: outW, height: outH, ratio: outW / outH, durationMs: 0 }
          }
          const video = document.createElement('video')
          video.muted = true
          video.preload = 'auto'
          video.src = URL.createObjectURL(blob)
          await new Promise<void>((ok, no) => {
            video.onloadedmetadata = () => ok()
            video.onerror = () => no(new Error('Unsupported video format. Use MP4 (H.264 + AAC).'))
          })
          const w = video.videoWidth, h = video.videoHeight
          const durationMs = Math.round(video.duration * 1000)
          await new Promise<void>((ok, no) => {
            video.onseeked = () => ok()
            video.onerror = () => no(new Error('Failed to capture the video cover frame'))
            video.currentTime = Math.min(0.5, video.duration / 2)
          })
          const canvas = document.createElement('canvas')
          canvas.width = w
          canvas.height = h
          canvas.getContext('2d')!.drawImage(video, 0, 0, w, h)
          const cover = await toJpeg(canvas)
          URL.revokeObjectURL(video.src)
          await send('igvideo', blob, 'video/mp4', {
            'client-passthrough': '1',
            is_igtv_video: false,
            is_sidecar: o.isSidecar ? '1' : '0',
            ...(o.isClips && { is_clips_video: '1' }),
            is_unified_video: '0',
            media_type: 2,
            for_album: o.mode === 'story',
            video_format: '',
            upload_id: o.uploadId,
            upload_media_duration_ms: durationMs,
            upload_media_height: h,
            upload_media_width: w,
            video_transform: null,
            video_edit_params: { crop_height: h, crop_width: w, crop_x1: 0, crop_y1: 0, mute: false, trim_end: durationMs / 1000, trim_start: 0 },
          })
          await send('igphoto', cover, 'image/jpeg', { media_type: 2, upload_id: o.uploadId, upload_media_height: h, upload_media_width: w })
          return { width: w, height: h, ratio: w / h, durationMs }
        },
        { token, o, headers },
      )
      return res
    } catch (e) {
      const msg = (e as Error).message.replace(/^page\.evaluate: (Error: )?/, '')
      const code = classify(400, '', msg)
      throw new IgError(code === 'challenge' || code === 'action-blocked' ? code : 'bad-request', msg)
    } finally {
      await page.unroute(pattern).catch(() => undefined)
    }
  }

  /**
   * Opens an Instagram page in a separate tab and collects the GraphQL responses that the page
   * loads itself. Used to learn new queries, and for features whose data is safest to read by
   * opening the page and reading its responses.
   */
  async harvest(
    url: string,
    opts: { match?: (name: string) => boolean; waitMs?: number; until?: (seen: Harvested[]) => boolean; act?: (page: Page) => Promise<void> } = {},
  ): Promise<{ seen: Harvested[]; names: GqlSeen[]; finalUrl: string }> {
    const ctx = this.requireCtx()
    const page = await ctx.newPage()
    const seen: Harvested[] = []
    const from = this.gqlLog.length
    const pending: Promise<void>[] = []
    page.on('response', res => {
      const req = res.request()
      if (req.method() !== 'POST' || !isGqlUrl(req.url())) return
      const p = new URLSearchParams(req.postData() || '')
      const name = p.get('fb_api_req_friendly_name') || ''
      if (opts.match && !opts.match(name)) return
      pending.push(
        res
          .text()
          .then(t => {
            let variables: any = null
            try {
              variables = JSON.parse(p.get('variables') || 'null')
            } catch {
              /* leave as null */
            }
            seen.push({ name, variables, data: parseJson(t) })
          })
          .catch(() => undefined),
      )
    })
    try {
      await page.goto(new URL(url, ORIGIN).toString(), { waitUntil: 'domcontentloaded', timeout: 45_000 })
      if (opts.act) await opts.act(page)
      const deadline = Date.now() + (opts.waitMs ?? 6000)
      while (Date.now() < deadline) {
        await page.waitForTimeout(400)
        await Promise.all(pending.splice(0))
        if (opts.until?.(seen)) break
      }
      await Promise.all(pending.splice(0))
      return { seen, names: this.gqlLog.slice(from), finalUrl: page.url() }
    } finally {
      await page.close().catch(() => undefined)
    }
  }

  /** Opens the login window and waits until the session cookie appears. */
  async login(timeoutMs = 15 * 60_000): Promise<boolean> {
    await this.start({ headless: false })
    const ctx = this.requireCtx()
    const page = ctx.pages()[0] ?? (await ctx.newPage())
    if (!(await this.isLoggedIn())) await page.goto(`${ORIGIN}/accounts/login/`, { waitUntil: 'domcontentloaded' }).catch(() => undefined)
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      if (await this.isLoggedIn()) {
        const url = page.url()
        if (!/\/challenge\/|\/accounts\/login|two_factor/.test(url)) {
          await page.waitForTimeout(4000)
          return true
        }
      }
      await page.waitForTimeout(1500).catch(() => undefined)
      if (page.isClosed()) break
    }
    return this.isLoggedIn()
  }
}
