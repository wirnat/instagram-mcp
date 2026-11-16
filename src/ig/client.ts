import { IgBrowser, type FetchOpts, type FetchResult, type UploadOpts, type UploadResult } from '../browser.js'
import { IgError } from '../errors.js'
import { PacedQueue, sleep, rand } from '../queue.js'
import { parseUserRef } from './normalize.js'

const HOUR = 3_600_000
type Pace = { instant?: boolean; patient?: boolean }

/**
 * Single entry point for every request to Instagram. Each request goes through the paced queue,
 * and warning signals from Instagram (challenge, action block, rate limit) pause further actions
 * for a while so the account does not get restricted further.
 */
export class IgClient {
  readonly queue = new PacedQueue()
  private idCache = new Map<string, string>()
  /** Set when Instagram logs the session out. While true, no requests are sent. */
  loggedOut = false

  /** Checks the session cookie without sending a request. Clears the logout flag once logged in again. */
  async sessionAlive(): Promise<boolean> {
    await this.browser.start()
    const alive = await this.browser.isLoggedIn()
    if (alive) this.loggedOut = false
    return alive
  }

  constructor(readonly browser: IgBrowser) {}

  /** Client for a single tool call. `instant` skips the queue. */
  session(instant = false, patient = false): IgSession {
    return new IgSession(this, instant, patient)
  }

  async request(path: string, opts: FetchOpts, pace: Pace): Promise<FetchResult> {
    return this.guard(() => this.queue.run(() => this.browser.fetch(path, opts), pace))
  }

  async gql(name: string, variables: Record<string, unknown>, pace: Pace, docId?: string, path?: string): Promise<any> {
    return this.guard(() => this.queue.run(() => this.browser.gql(name, variables, { docId, path }), pace))
  }

  private async guard<T>(fn: () => Promise<T>): Promise<T> {
    await this.browser.start()
    try {
      return await fn()
    } catch (e) {
      if (e instanceof IgError) {
        if (e.code === 'not-logged-in') this.loggedOut = true
        if (e.code === 'challenge') this.queue.pause(12 * HOUR, 'Instagram asked to verify the account (challenge)')
        else if (e.code === 'action-blocked') this.queue.pause(6 * HOUR, 'Instagram restricted actions on this account (action block)')
        else if (e.code === 'rate-limited') this.queue.pause(15 * 60_000, 'Instagram is rate limiting requests (429)')
      }
      throw e
    }
  }

  async match(path: string, pattern: string, pace: Pace): Promise<{ status: number; url: string; match: string | null }> {
    return this.guard(() => this.queue.run(() => this.browser.fetchMatch(path, pattern), pace))
  }

  async upload(file: string, opts: UploadOpts, pace: Pace): Promise<UploadResult> {
    return this.guard(() => this.queue.run(() => this.browser.uploadMedia(file, opts), pace))
  }

  cacheUserId(username: string, id: string): void {
    if (username && id) this.idCache.set(username.toLowerCase(), id)
  }
  cachedUserId(username: string): string | undefined {
    return this.idCache.get(username.toLowerCase())
  }
}

export class IgSession {
  constructor(private client: IgClient, readonly instant: boolean, readonly patient = false) {}

  private get pace(): Pace {
    return { instant: this.instant, patient: this.patient }
  }

  /** Session for background jobs: always queued and willing to wait. */
  background(): IgSession {
    return new IgSession(this.client, false, true)
  }

  get browser(): IgBrowser {
    return this.client.browser
  }
  get queue(): PacedQueue {
    return this.client.queue
  }

  async get(path: string, query?: FetchOpts['query'], extra: Partial<FetchOpts> = {}): Promise<any> {
    const r = await this.client.request(path, { method: 'GET', query, ...extra }, this.pace)
    if (r.json === undefined) throw new IgError('html-response', `GET ${path} did not return JSON`, { status: r.status, body: r.text })
    return r.json
  }

  async post(path: string, form: FetchOpts['form'] = {}, extra: Partial<FetchOpts> = {}): Promise<any> {
    const r = await this.client.request(path, { method: 'POST', form, ...extra }, this.pace)
    if (r.json === undefined) throw new IgError('html-response', `POST ${path} did not return JSON`, { status: r.status, body: r.text })
    return r.json
  }

  async gql(name: string, variables: Record<string, unknown>, docId?: string, path?: string): Promise<any> {
    return this.client.gql(name, variables, this.pace, docId, path)
  }

  async postJson(path: string, json: unknown, extra: Partial<FetchOpts> = {}): Promise<any> {
    const r = await this.client.request(path, { method: 'POST', json, ...extra }, this.pace)
    if (r.json === undefined) throw new IgError('html-response', `POST ${path} did not return JSON`, { status: r.status, body: r.text })
    return r.json
  }

  async upload(file: string, opts: UploadOpts): Promise<UploadResult> {
    return this.client.upload(file, opts, this.pace)
  }

  /** Short pause between pages inside a tool that fetches several pages. */
  async pagePause(): Promise<void> {
    await sleep(rand(1200, 2600))
  }

  async viewerId(): Promise<string> {
    await this.browser.start()
    return this.browser.viewerId()
  }

  /**
   * Resolves a username to its numeric id. The Instagram web app embeds the id in the profile
   * page HTML, so one page request is enough. Results are cached to avoid repeat lookups.
   */
  async resolveUsername(username: string): Promise<string | null> {
    const name = username.replace(/^@/, '').toLowerCase()
    const cached = this.client.cachedUserId(name)
    if (cached) return cached
    const r = await this.client.match(`/${encodeURIComponent(name)}/`, '"profile_id":"(\\d+)"', this.pace)
    if (!r.match) return null
    this.client.cacheUserId(name, r.match)
    return r.match
  }

  /** Raw profile data from the query the web profile page uses. */
  async rawProfile(username: string): Promise<any | null> {
    const id = await this.resolveUsername(username)
    if (!id) return null
    return this.rawProfileById(id)
  }

  async rawProfileById(id: string): Promise<any | null> {
    const j = await this.gql('PolarisProfilePageContentQuery', { id, enable_integrity_filters: true })
    const u = j?.data?.user
    if (!u) return null
    this.client.cacheUserId(u.username, String(u.pk ?? u.id))
    return u
  }

  /** Resolves a username, profile URL, or id to a numeric id. */
  async userId(ref: string): Promise<string> {
    const { username, id } = parseUserRef(ref)
    if (id) return id
    const found = await this.resolveUsername(username!)
    if (!found) throw new IgError('not-found', `Account @${username} not found`)
    return found
  }

  rememberUser(username: string, id: string): void {
    this.client.cacheUserId(username, id)
  }
}
