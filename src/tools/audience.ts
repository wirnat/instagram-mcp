import { defineTool, int, str, cleanUsername } from './registry.js'
import type { IgSession } from '../ig/client.js'
import { Store } from '../store.js'
import { startJob, runningJob, jobView, listJobs, type JobHandle } from '../jobs.js'
import { writeCsv } from '../leads/db.js'
import { viewerInfo } from './read.js'

export type Peer = { id: string; username: string; fullName: string; isPrivate: boolean; isVerified: boolean; noAvatar: boolean }
type PeerList = { username: string; type: 'followers' | 'following'; scannedOn: string; complete: boolean; total: number | null; users: Peer[] }
type Unfollow = { id: string; username: string; fullName: string; detectedOn: string }

const peerStore = (username: string, type: string) => new Store<PeerList | null>(`peers-${username.toLowerCase()}-${type}`, () => null)
const unfollowStore = new Store<{ events: Unfollow[]; lastScanOn: string | null }>('unfollowers', () => ({ events: [], lastScanOn: null }))

const normPeer = (u: any): Peer => ({
  id: String(u.pk ?? u.id ?? ''),
  username: u.username,
  fullName: u.full_name ?? '',
  isPrivate: u.is_private === true,
  isVerified: u.is_verified === true,
  noAvatar: u.has_anonymous_profile_picture === true,
})

/**
 * Fetches a follower or following list page by page through the paced queue.
 * `onPage` can stop early by returning false.
 */
export const crawlPeers = async (
  ig: IgSession,
  userId: string,
  type: 'followers' | 'following',
  limit: number,
  h?: JobHandle,
  onPage?: (page: Peer[]) => boolean | void,
): Promise<{ users: Peer[]; complete: boolean }> => {
  const users: Peer[] = []
  const seen = new Set<string>()
  let maxId: string | undefined
  for (;;) {
    if (h?.cancelled) return { users, complete: false }
    const j: any = await ig.get(`/api/v1/friendships/${userId}/${type}/`, { count: 25, search_surface: 'follow_list_page', max_id: maxId })
    const page = (j.users ?? []).map(normPeer).filter((p: Peer) => !seen.has(p.id) && seen.add(p.id))
    users.push(...page)
    h?.progress(users.length, limit)
    if (onPage?.(page) === false) return { users, complete: false }
    maxId = j.next_max_id ? String(j.next_max_id) : undefined
    if (!maxId || !page.length) return { users, complete: true }
    if (users.length >= limit) return { users: users.slice(0, limit), complete: false }
  }
}

const target = async (ig: IgSession, username: unknown): Promise<{ name: string; id: string; own: boolean }> => {
  const me = await viewerInfo(ig)
  const name = cleanUsername(username)
  if (!name || name.toLowerCase() === me.username.toLowerCase()) return { name: me.username, id: me.id, own: true }
  return { name, id: await ig.userId(name), own: false }
}

const listType = (v: unknown): 'followers' | 'following' => (str(v) === 'following' ? 'following' : 'followers')

// MARK: Follower and following lists

defineTool({
  name: 'peers_scan',
  description: 'Starts collecting the follower or following list of an account. Runs in the background; check the result with peers_report.',
  params: [
    { name: 'username', type: 'string', description: 'Account to scan, without @. Leave empty for the logged-in account.' },
    { name: 'type', type: 'string', description: 'followers (default) or following.' },
    { name: 'limit', type: 'number', description: 'Maximum number of accounts, default 2500. Larger lists take longer.' },
  ],
  risk: 'action',
  handler: async ({ username, type, limit }, ig) => {
    const t = await target(ig, username)
    const kind = listType(type)
    const max = int(limit, 2500, 1, 50_000)
    const label = `${t.name}:${kind}`
    const running = runningJob('peers', label)
    if (running) return { started: false, message: 'A scan of this list is still running', ...jobView(running) }
    const bg = ig.background()
    const job = startJob('peers', label, async h => {
      const { users, complete } = await crawlPeers(bg, t.id, kind, max, h)
      const st = peerStore(t.name, kind)
      st.set({ username: t.name, type: kind, scannedOn: new Date().toISOString(), complete, total: users.length, users })
      return { collected: users.length, complete }
    })
    return { started: true, ...jobView(job) }
  },
})

defineTool({
  name: 'peers_report',
  description: 'Reads one page of a follower or following list collected by peers_scan.',
  params: [
    { name: 'username', type: 'string', description: 'Account whose list to read, without @. Leave empty for the logged-in account.' },
    { name: 'type', type: 'string', description: 'followers (default) or following.' },
    { name: 'from', type: 'number', description: 'Zero-based offset, default 0.' },
    { name: 'limit', type: 'number', description: 'Page size, 1-1000, default 100.' },
    { name: 'filter', type: 'string', description: 'Text that must appear in the username or full name, for example "coffee". Optional.' },
  ],
  risk: 'read',
  paced: false,
  handler: async ({ username, type, from, limit, filter }, ig) => {
    const t = await target(ig, username)
    const kind = listType(type)
    const data = peerStore(t.name, kind).get()
    const job = listJobs('peers').find(j => j.label === `${t.name}:${kind}`)
    if (!data) return { username: t.name, type: kind, scanned: false, ...(job && { job: jobView(job) }), message: 'No data yet. Run peers_scan first.' }
    const q = str(filter)?.toLowerCase()
    const rows = q ? data.users.filter(u => `${u.username} ${u.fullName}`.toLowerCase().includes(q)) : data.users
    const start = Math.max(0, Math.trunc(Number(from)) || 0)
    return {
      username: t.name,
      type: kind,
      scannedOn: data.scannedOn,
      complete: data.complete,
      total: rows.length,
      from: start,
      users: rows.slice(start, start + int(limit, 100, 1, 1000)),
      ...(job?.status === 'running' && { job: jobView(job) }),
    }
  },
})

defineTool({
  name: 'peers_export',
  description: 'Exports the full follower or following list to a CSV file on the server and returns its path.',
  params: [
    { name: 'username', type: 'string', description: 'Account to export, without @. Leave empty for the logged-in account.' },
    { name: 'type', type: 'string', description: 'followers (default) or following.' },
  ],
  risk: 'write',
  paced: false,
  handler: async ({ username, type }, ig) => {
    const t = await target(ig, username)
    const kind = listType(type)
    const data = peerStore(t.name, kind).get()
    if (!data) throw new Error('peers_export: no data yet. Run peers_scan first.')
    const path = writeCsv(`${kind}-${t.name}`, ['id', 'username', 'fullName', 'isPrivate', 'isVerified', 'noAvatar'], data.users as any)
    return { path, count: data.users.length }
  },
})

// MARK: Unfollowers

defineTool({
  name: 'unfollowers_scan',
  description: 'Starts an unfollower scan for the logged-in account by comparing the current follower list with the previous scan. The first scan only sets a baseline. Check the result with unfollowers_report.',
  params: [],
  risk: 'action',
  handler: async (_a, ig) => {
    const me = await viewerInfo(ig)
    const running = runningJob('unfollowers')
    if (running) return { started: false, message: 'An unfollower scan is still running', ...jobView(running) }
    const bg = ig.background()
    const job = startJob('unfollowers', me.username, async h => {
      const st = peerStore(me.username, 'followers')
      const before = st.get()
      const { users, complete } = await crawlPeers(bg, me.id, 'followers', 100_000, h)
      if (!complete) throw new Error('The scan stopped before finishing, so the result was discarded to avoid false unfollowers')
      const nowIso = new Date().toISOString()
      let found = 0
      if (before?.complete) {
        const current = new Set(users.map(u => u.id))
        const gone = before.users.filter(u => !current.has(u.id))
        found = gone.length
        unfollowStore.update(s => {
          for (const g of gone) s.events.push({ id: g.id, username: g.username, fullName: g.fullName, detectedOn: nowIso })
          s.lastScanOn = nowIso
        })
      } else unfollowStore.update(s => void (s.lastScanOn = nowIso))
      st.set({ username: me.username, type: 'followers', scannedOn: nowIso, complete: true, total: users.length, users })
      return { followers: users.length, unfollowersFound: found, baseline: !before?.complete }
    })
    return { started: true, ...jobView(job) }
  },
})

defineTool({
  name: 'unfollowers_report',
  description: 'Accounts that unfollowed in the last 7 days (or `days`), based on saved scan data.',
  params: [{ name: 'days', type: 'number', description: 'Number of days to look back, default 7.' }],
  risk: 'read',
  paced: false,
  handler: async ({ days }) => {
    const s = unfollowStore.get()
    const since = Date.now() - int(days, 7, 1, 365) * 86_400_000
    const job = runningJob('unfollowers')
    return {
      lastScanOn: s.lastScanOn,
      scanning: !!job,
      ...(job && { job: jobView(job) }),
      unfollowers: s.events.filter(e => Date.parse(e.detectedOn) >= since).reverse(),
    }
  },
})

defineTool({
  name: 'unfollowers_export',
  description: 'Exports every unfollower ever detected to a CSV file on the server.',
  params: [],
  risk: 'write',
  paced: false,
  handler: async () => {
    const s = unfollowStore.get()
    return { path: writeCsv('unfollowers', ['id', 'username', 'fullName', 'detectedOn'], s.events as any), count: s.events.length }
  },
})

// MARK: Bot detection

type BotRow = Peer & { risk: 'high' | 'medium' | 'low'; kind: 'bot' | 'suspicious' | 'clean'; reasons: string[] }
const botStore = new Store<{ scannedOn: string | null; rows: BotRow[] }>('antibot', () => ({ scannedOn: null, rows: [] }))

/** Older scans stored reasons in Indonesian; translate them when read. */
const LEGACY_REASONS: Record<string, string> = {
  'tanpa foto profil': 'no profile picture',
  'username penuh angka': 'username full of digits',
  'nama kosong': 'empty name',
  'pola username acak': 'random-looking username',
}
const botRows = (): BotRow[] => botStore.get().rows.map(r => ({ ...r, reasons: r.reasons.map(x => LEGACY_REASONS[x] ?? x) }))

/** Scores an account using only follower-list data, without opening each profile. */
export const scoreBot = (p: Peer): BotRow => {
  const reasons: string[] = []
  let pts = 0
  const digits = (p.username.match(/\d/g) ?? []).length
  if (p.noAvatar) {
    pts += 2
    reasons.push('no profile picture')
  }
  if (digits >= 5 || /\d{4,}$/.test(p.username)) {
    pts += 2
    reasons.push('username full of digits')
  }
  if (!p.fullName.trim()) {
    pts += 1
    reasons.push('empty name')
  }
  if (/^[a-z]+[._]?[a-z]*\d{2,}[._]?[a-z]*\d*$/.test(p.username) && p.username.length > 14) {
    pts += 1
    reasons.push('random-looking username')
  }
  if (p.isVerified) pts = 0
  const risk = pts >= 4 ? 'high' : pts >= 2 ? 'medium' : 'low'
  return { ...p, risk, kind: risk === 'high' ? 'bot' : risk === 'medium' ? 'suspicious' : 'clean', reasons }
}

defineTool({
  name: 'antibot_scan',
  description: 'Starts a follower scan and rates each account as bot, suspicious, or clean. Detection only; nobody is removed. Check the result with antibot_report.',
  params: [{ name: 'limit', type: 'number', description: 'Maximum number of followers to rate, default 5000.' }],
  risk: 'action',
  handler: async ({ limit }, ig) => {
    const me = await viewerInfo(ig)
    const running = runningJob('antibot')
    if (running) return { started: false, message: 'An antibot scan is still running', ...jobView(running) }
    const bg = ig.background()
    const job = startJob('antibot', me.username, async h => {
      const { users } = await crawlPeers(bg, me.id, 'followers', int(limit, 5000, 1, 100_000), h)
      const rows = users.map(scoreBot)
      botStore.set({ scannedOn: new Date().toISOString(), rows })
      return { scanned: rows.length, high: rows.filter(r => r.risk === 'high').length, medium: rows.filter(r => r.risk === 'medium').length }
    })
    return { started: true, ...jobView(job) }
  },
})

defineTool({
  name: 'antibot_report',
  description: 'Result of the last antibot scan: counts per risk level and the list of flagged followers.',
  params: [{ name: 'limit', type: 'number', description: 'Number of flagged accounts to show, default 100.' }],
  risk: 'read',
  paced: false,
  handler: async ({ limit }) => {
    const s = { ...botStore.get(), rows: botRows() }
    const job = runningJob('antibot')
    const flagged = s.rows.filter(r => r.risk !== 'low').sort((a, b) => (a.risk === b.risk ? 0 : a.risk === 'high' ? -1 : 1))
    return {
      scannedOn: s.scannedOn,
      scanning: !!job,
      ...(job && { job: jobView(job) }),
      totals: { scanned: s.rows.length, high: s.rows.filter(r => r.risk === 'high').length, medium: s.rows.filter(r => r.risk === 'medium').length, low: s.rows.filter(r => r.risk === 'low').length },
      flagged: flagged.slice(0, int(limit, 100, 1, 1000)),
    }
  },
})

defineTool({
  name: 'antibot_export',
  description: 'Exports the full antibot analysis (risk and kind of each follower) to a CSV file on the server.',
  params: [],
  risk: 'write',
  paced: false,
  handler: async () => {
    const s = { ...botStore.get(), rows: botRows() }
    return { path: writeCsv('antibot', ['id', 'username', 'fullName', 'risk', 'kind', 'reasons', 'isPrivate', 'noAvatar'], s.rows as any), count: s.rows.length }
  },
})
