import dns from 'node:dns/promises'
import net from 'node:net'
import { defineTool, need, int, str, flag, cleanUsername } from './registry.js'
import type { IgSession } from '../ig/client.js'
import { normProfile, parsePostRef } from '../ig/normalize.js'
import { analyzeProfile, applyPreset, extractEmails, extractPhones, getLeadConfig, setLeadConfig, PRESETS, type LeadConfig } from '../leads/score.js'
import { exportLeads, getLead, leadStats, listLeads, upsertLead, LEAD_STATUSES, type Lead, type LeadStatus } from '../leads/db.js'
import { startJob, jobView, getJob, listJobs, cancelJob } from '../jobs.js'
import { crawlPeers } from './audience.js'
import { keywordPosts, locationPosts, topSearch, userPostsPage } from '../ig/feeds.js'

const list = (v: unknown): string[] =>
  (Array.isArray(v) ? v : typeof v === 'string' ? v.split(/[,\n]/) : [])
    .map(x => String(x).trim())
    .filter(Boolean)

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** Name filter: the agent's keywords, or every business type in the config. With neither, everything passes. */
const nameFilter = (keywords: string[]): RegExp => {
  const parts = keywords.length ? keywords.map(esc) : getLeadConfig().types.map(t => t.pattern)
  return parts.length ? new RegExp(parts.join('|'), 'i') : /(?:)/
}

type Candidate = { username: string; name: string; id?: string }

/** Saves candidates to the lead database and separates new accounts from known ones. */
const saveCandidates = (cands: Candidate[], source: string) => {
  const fresh: Candidate[] = []
  let known = 0
  const seen = new Set<string>()
  for (const c of cands) {
    const k = c.username.toLowerCase()
    if (!c.username || seen.has(k)) continue
    seen.add(k)
    if (getLead(k)) known++
    else fresh.push(c)
    upsertLead({ username: k, name: c.name, ...(c.id && { id: c.id }) }, source)
  }
  return { fresh, known }
}

const row = (l: Lead) => ({
  username: l.username,
  name: l.name ?? '',
  type: l.type ?? null,
  city: l.city ?? null,
  followers: l.followers ?? null,
  booking: l.booking ?? null,
  multiBranch: l.multiBranch ?? false,
  whatsapp: l.whatsapp ?? [],
  priority: l.scored ? l.priority : null,
  score: l.score ?? null,
  reasons: l.reasons ?? [],
  status: l.status,
  ...(l.activity && { activity: l.activity }),
  ...(l.notes && { notes: l.notes }),
  ...(l.tags?.length && { tags: l.tags }),
  ...(l.lastContactedAt && { lastContactedAt: l.lastContactedAt }),
})

// MARK: Bio link inspection

const isPrivateIp = (ip: string): boolean => {
  if (net.isIPv6(ip)) return /^(::1|fc|fd|fe80|::ffff:(10\.|127\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.))/i.test(ip) || ip === '::'
  const [a, b] = ip.split('.').map(Number)
  return a === 10 || a === 127 || a === 0 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254) || a >= 224
}

/** Only public addresses may be opened, so this tool cannot be used to reach the server's internal network. */
const assertPublicUrl = async (raw: string): Promise<URL> => {
  const u = new URL(raw)
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error('Only http(s) links can be inspected')
  const addrs = net.isIP(u.hostname) ? [{ address: u.hostname }] : await dns.lookup(u.hostname, { all: true })
  if (!addrs.length || addrs.some(a => isPrivateIp(a.address))) throw new Error('The link points to a private network address and was not inspected')
  return u
}

export const inspectLink = async (raw: string) => {
  let url = (await assertPublicUrl(raw)).toString()
  let res: Response | null = null
  for (let hop = 0; hop < 5; hop++) {
    res = await fetch(url, {
      redirect: 'manual',
      signal: AbortSignal.timeout(12_000),
      headers: { 'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36', accept: 'text/html,*/*' },
    })
    const loc = res.headers.get('location')
    if (res.status >= 300 && res.status < 400 && loc) {
      url = (await assertPublicUrl(new URL(loc, url).toString())).toString()
      continue
    }
    break
  }
  if (!res) throw new Error('The link could not be opened')
  const html = (await res.text()).slice(0, 600_000)
  const hrefs = [...html.matchAll(/href=(?:"([^"]+)"|'([^']+)'|([^\s>]+))/g)].map(m => (m[1] ?? m[2] ?? m[3]).replace(/&amp;/g, '&'))
  const text = html.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/g, ' ').replace(/<[^>]+>/g, ' ')
  const cfgLead = getLeadConfig()
  const hay = `${url} ${hrefs.join(' ')} ${html.slice(0, 200_000)}`.toLowerCase()
  return {
    url: raw,
    finalUrl: url,
    status: res.status,
    title: html.match(/<title[^>]*>([^<]*)<\/title>/i)?.[1]?.trim() ?? null,
    wa: extractPhones(text.slice(0, 50_000), [url, ...hrefs]),
    emails: extractEmails(`${text.slice(0, 50_000)} ${hrefs.filter(h => h.startsWith('mailto:')).join(' ')}`).slice(0, 5),
    bookingApps: [...new Set(cfgLead.competitorApps.filter(a => new RegExp(`\\b${a}\\b`, 'i').test(hay)).map(a => a.replace(/\\/g, '')))],
    links: [...new Set(hrefs.filter(h => /^https?:\/\//.test(h) && !/\.(css|js|png|jpg|svg|ico|woff2?)(\?|$)/.test(h)))].slice(0, 25),
  }
}

defineTool({
  name: 'link_inspect',
  description: 'Opens a link from an account bio (Linktree, website, wa.me) and extracts WhatsApp numbers, emails, and booking apps it uses. Does not touch Instagram.',
  params: [{ name: 'url', type: 'string', description: 'The http(s) link to inspect.', required: true }],
  risk: 'read',
  paced: false,
  handler: async ({ url }) => inspectLink(need(url, 'link_inspect', 'url')),
})

// MARK: Enrichment and scoring

/** Fetches a profile, scores it, and saves it as a lead. */
export const enrichOne = async (ig: IgSession, username: string, opts: { activity?: boolean; deep?: boolean; source?: string } = {}): Promise<Lead | null> => {
  const raw = await ig.rawProfile(username)
  if (!raw) {
    upsertLead({ username, scored: true, priority: 'C', score: 0, reasons: ['account not found'], status: 'rejected' })
    return null
  }
  const p = normProfile(raw)
  let extra = ''
  let linkApps: string[] = []
  if (opts.deep && p.externalUrl) {
    try {
      const info = await inspectLink(p.externalUrl)
      extra = `${info.wa.map(w => `wa.me/${w}`).join(' ')} ${info.emails.join(' ')} ${info.bookingApps.join(' ')}`
      linkApps = info.bookingApps
    } catch {
      /* a dead link does not fail the scoring */
    }
  }
  const a = analyzeProfile(p, getLeadConfig(), extra)
  let activity: Lead['activity']
  if (opts.activity && !p.isPrivate) {
    const items: any[] = (await userPostsPage(ig, p.username)).items
    const month = Date.now() / 1000 - 30 * 86_400
    const avg = (fn: (m: any) => number) => (items.length ? Math.round(items.reduce((s, m) => s + (fn(m) || 0), 0) / items.length) : 0)
    activity = {
      lastPostAt: items[0]?.taken_at ? new Date(Math.max(...items.map(m => m.taken_at)) * 1000).toISOString() : null,
      postsLast30Days: items.filter(m => m.taken_at >= month).length,
      avgLikes: avg(m => m.like_count),
      avgComments: avg(m => m.comment_count),
    }
    if (activity.lastPostAt && Date.now() - Date.parse(activity.lastPostAt) > 120 * 86_400_000) a.reasons.push('no posts in over 4 months')
  }
  return upsertLead(
    {
      username: p.username,
      id: p.id,
      name: p.fullName,
      type: a.type,
      city: a.city,
      followers: p.followerCount,
      posts: p.postCount,
      bio: p.bio.replace(/\s+/g, ' ').slice(0, 300),
      link: p.externalUrl,
      whatsapp: a.whatsapp,
      emails: a.emails,
      booking: a.booking,
      bookingApps: [...new Set([...a.bookingApps, ...linkApps])],
      multiBranch: a.multiBranch,
      score: a.score,
      priority: a.priority,
      reasons: a.fit ? a.reasons : ['not a target business', ...a.reasons],
      scored: true,
      ...(activity && { activity }),
    },
    opts.source,
  )
}

defineTool({
  name: 'lead_enrich',
  description:
    'Fetches prospect profiles, scores how well they fit (business type, city, booking method, branches, WhatsApp number), and saves them to the lead database. Up to 8 accounts are answered directly; more run as a background job (check jobs_status, read results with lead_list).',
  params: [
    { name: 'usernames', type: 'array', description: 'Usernames to score, without @. Leave empty to use `pending`.' },
    { name: 'pending', type: 'number', description: 'Take this many unscored candidates from the lead database (from lead_discover and similar tools).' },
    { name: 'activity', type: 'boolean', description: 'True to also check activity: last post, posts in the last 30 days, average likes. Adds one request per account.' },
    { name: 'deep', type: 'boolean', description: 'True to also open the bio link and look for WhatsApp numbers and booking apps there.' },
  ],
  risk: 'read',
  handler: async ({ usernames, pending, activity, deep }, ig) => {
    let names = list(usernames).map(u => u.replace(/^@/, ''))
    if (!names.length) names = listLeads({ scored: false }).slice(0, int(pending, 8, 1, 500)).map(l => l.username)
    if (!names.length) return { enriched: 0, message: 'No candidates need scoring. Run lead_discover first.' }
    const opts = { activity: flag(activity), deep: flag(deep) }
    if (names.length <= 8) {
      const leads: unknown[] = []
      for (const [i, n] of names.entries()) {
        if (i > 0) await ig.pagePause()
        const l = await enrichOne(ig, n, opts)
        leads.push(l ? row(l) : { username: n, found: false })
      }
      return { enriched: leads.length, leads }
    }
    const bg = ig.background()
    const job = startJob('lead_enrich', `${names.length} accounts`, async h => {
      let ok = 0
      for (const [i, n] of names.entries()) {
        if (h.cancelled) break
        try {
          if (await enrichOne(bg, n, opts)) ok++
        } catch (e) {
          const code = (e as { code?: string }).code
          if (code === 'challenge' || code === 'action-blocked' || code === 'not-logged-in' || code === 'rate-limited') throw e
        }
        h.progress(i + 1, names.length)
      }
      return { enriched: ok, stats: leadStats() }
    })
    return { started: true, ...jobView(job), hint: 'Check progress with jobs_status. Results can be read any time with lead_list.' }
  },
})

// MARK: Candidate sources

defineTool({
  name: 'lead_discover',
  description:
    'Finds prospects by combining keywords with cities (e.g. "dentist" x "Austin") and hashtags, in one call. Candidates are saved to the lead database as unscored; follow up with lead_enrich.',
  params: [
    { name: 'keywords', type: 'array', description: 'Business types to search for, e.g. ["dentist","physiotherapy"].', required: true },
    { name: 'cities', type: 'array', description: 'Cities or areas, e.g. ["Austin","Dallas"]. Leave empty to search the keywords alone.' },
    { name: 'hashtags', type: 'array', description: 'Extra hashtags without #, e.g. ["austindentist"]. Owners of posts under them also become candidates.' },
    { name: 'maxQueries', type: 'number', description: 'Maximum searches in this call. Default 8, max 12.' },
  ],
  risk: 'read',
  handler: async ({ keywords, cities, hashtags, maxQueries }, ig) => {
    const kws = list(keywords)
    const cts = list(cities)
    const tags = list(hashtags).map(t => t.replace(/^#/, '').toLowerCase())
    if (!kws.length && !tags.length) throw new Error('lead_discover needs `keywords` or `hashtags`')
    const queries = (cts.length ? kws.flatMap(k => cts.map(c => `${k} ${c}`)) : kws).map(q => ({ kind: 'search', q }))
    const all = [...queries, ...tags.map(q => ({ kind: 'hashtag', q }))]
    const max = int(maxQueries, 8, 1, 12)
    const filter = nameFilter([])
    const perQuery: Record<string, number> = {}
    const fresh: Candidate[] = []
    let known = 0
    for (const [i, { kind, q }] of all.slice(0, max).entries()) {
      if (i > 0) await ig.pagePause()
      let cands: Candidate[]
      if (kind === 'search') {
        // Web account search returns only a handful of results, so it is combined with post owners from the keyword results page.
        const r = await topSearch(ig, q, 'user')
        cands = r.users.filter((u: any) => !u.is_private).map((u: any) => ({ username: u.username, name: u.full_name ?? '', id: String(u.pk ?? '') }))
        await ig.pagePause()
        const { medias } = await keywordPosts(ig, q)
        cands.push(...medias.map((m: any) => ({ username: m.user.username, name: m.user.full_name ?? '', id: String(m.user.pk ?? '') })).filter((c: Candidate) => filter.test(`${c.username} ${c.name}`)))
      } else {
        const { medias } = await keywordPosts(ig, `#${q}`)
        cands = medias.map((m: any) => ({ username: m.user.username, name: m.user.full_name ?? '', id: String(m.user.pk ?? '') })).filter((c: Candidate) => filter.test(`${c.username} ${c.name}`))
      }
      const r = saveCandidates(cands, `${kind}:${q}`)
      perQuery[`${kind}:${q}`] = r.fresh.length
      fresh.push(...r.fresh)
      known += r.known
    }
    return {
      queriesRun: Math.min(all.length, max),
      queriesSkipped: all.slice(max).map(x => x.q),
      newCandidates: fresh.length,
      alreadyKnown: known,
      perQuery,
      candidates: fresh.slice(0, 120),
      next: 'Run lead_enrich with `pending` to score the new candidates.',
    }
  },
})

defineTool({
  name: 'lead_from_location',
  description: 'Collects the owners of posts tagged at a place (e.g. a neighborhood or mall) and keeps those that look like target businesses. Find the location id with location_search.',
  params: [
    { name: 'locationId', type: 'string', description: 'Location id from location_search.', required: true },
    { name: 'keywords', type: 'array', description: 'Words that must appear in the username or name. Leave empty to use the configured business types.' },
  ],
  risk: 'read',
  handler: async ({ locationId, keywords }, ig) => {
    const id = need(locationId, 'lead_from_location', 'locationId')
    const ranked = await locationPosts(ig, id, 'ranked')
    await ig.pagePause()
    const recent = await locationPosts(ig, id, 'recent').catch(() => ({ medias: [] as any[] }))
    const medias = [...ranked.medias, ...recent.medias]
    const filter = nameFilter(list(keywords))
    const owners: Candidate[] = medias.map((m: any) => ({ username: m.user?.username, name: m.user?.full_name ?? '', id: String(m.user?.pk ?? '') })).filter((c: Candidate) => c.username)
    const r = saveCandidates(owners.filter(c => filter.test(`${c.username} ${c.name}`)), `location:${id}`)
    return { locationId: id, postsSeen: medias.length, owners: new Set(owners.map(o => o.username)).size, newCandidates: r.fresh.length, alreadyKnown: r.known, candidates: r.fresh }
  },
})

defineTool({
  name: 'lead_from_followers',
  description:
    'Scans the followers (or following) of an account, such as a competitor, supplier, or industry community, and keeps those whose name or username matches the target businesses. Runs in the background; check jobs_status.',
  params: [
    { name: 'username', type: 'string', description: 'Source account, without @.', required: true },
    { name: 'type', type: 'string', description: 'followers (default) or following.' },
    { name: 'keywords', type: 'array', description: 'Words that must appear in the username or name. Leave empty to use the configured business types.' },
    { name: 'limit', type: 'number', description: 'Maximum accounts to scan. Default 1000.' },
  ],
  risk: 'read',
  handler: async ({ username, type, keywords, limit }, ig) => {
    const name = need(cleanUsername(username), 'lead_from_followers', 'username')
    const kind = str(type) === 'following' ? 'following' : 'followers'
    const id = await ig.userId(name)
    const filter = nameFilter(list(keywords))
    const max = int(limit, 1000, 25, 20_000)
    const bg = ig.background()
    const job = startJob('lead_from_followers', `${kind} @${name}`, async h => {
      let fresh = 0
      let known = 0
      const { users } = await crawlPeers(bg, id, kind, max, h, page => {
        const r = saveCandidates(page.filter(p => !p.isPrivate && filter.test(`${p.username} ${p.fullName}`)).map(p => ({ username: p.username, name: p.fullName, id: p.id })), `${kind}:@${name}`)
        fresh += r.fresh.length
        known += r.known
      })
      return { scanned: users.length, newCandidates: fresh, alreadyKnown: known }
    })
    return { started: true, ...jobView(job), hint: 'When it finishes, run lead_enrich with `pending`.' }
  },
})

defineTool({
  name: 'lead_from_engagers',
  description: 'Collects accounts that liked and commented on posts of an account (e.g. a competitor or supplier) and keeps those that look like target businesses.',
  params: [
    { name: 'username', type: 'string', description: 'Source account, without @. Its latest posts are used. Provide this or `post`.' },
    { name: 'post', type: 'string', description: 'A specific post: media id, shortcode, or URL.' },
    { name: 'posts', type: 'number', description: 'Number of latest posts to use with `username`. Default 3, max 5.' },
    { name: 'keywords', type: 'array', description: 'Words that must appear in the username or name. Leave empty to use the configured business types.' },
  ],
  risk: 'read',
  handler: async ({ username, post, posts, keywords }, ig) => {
    const name = cleanUsername(username)
    let pks: string[]
    if (str(post)) pks = [parsePostRef(str(post)!).pk]
    else {
      const feed = await userPostsPage(ig, need(name, 'lead_from_engagers', 'username or post'))
      pks = feed.items.slice(0, int(posts, 3, 1, 5)).map((m: any) => String(m.pk))
    }
    const filter = nameFilter(list(keywords))
    const cands: Candidate[] = []
    let seen = 0
    for (const pk of pks) {
      await ig.pagePause()
      const likers = await ig.get(`/api/v1/media/${pk}/likers/`).catch(() => ({ users: [] }))
      await ig.pagePause()
      const comments = await ig.get(`/api/v1/media/${pk}/comments/`, { can_support_threading: 'true', permalink_enabled: 'false' }).catch(() => ({ comments: [] }))
      const users = [...(likers.users ?? []), ...(comments.comments ?? []).map((c: any) => c.user)].filter(Boolean)
      seen += users.length
      cands.push(...users.filter((u: any) => !u.is_private && filter.test(`${u.username} ${u.full_name ?? ''}`)).map((u: any) => ({ username: u.username, name: u.full_name ?? '', id: String(u.pk ?? '') })))
    }
    const r = saveCandidates(cands, `engagers:${name ? `@${name}` : pks[0]}`)
    return { postsUsed: pks.length, accountsSeen: seen, newCandidates: r.fresh.length, alreadyKnown: r.known, candidates: r.fresh }
  },
})

defineTool({
  name: 'lead_similar',
  description: 'Finds accounts similar to a given account using Instagram\'s "suggested accounts". Useful for expanding from one good lead.',
  params: [{ name: 'username', type: 'string', description: 'Reference account, without @.', required: true }],
  risk: 'read',
  handler: async ({ username }, ig) => {
    const name = need(cleanUsername(username), 'lead_similar', 'username')
    const id = await ig.userId(name)
    const j = await ig.get('/api/v1/discover/chaining/', { target_id: id })
    const users: Candidate[] = (j.users ?? []).filter((u: any) => !u.is_private).map((u: any) => ({ username: u.username, name: u.full_name ?? '', id: String(u.pk ?? '') }))
    const r = saveCandidates(users, `similar:@${name}`)
    return { similar: users.length, newCandidates: r.fresh.length, alreadyKnown: r.known, candidates: r.fresh }
  },
})

// MARK: Lead database

const filterFrom = (a: Record<string, any>) => ({
  status: str(a.status),
  priority: str(a.priority)?.toUpperCase(),
  type: str(a.type),
  city: str(a.city),
  text: str(a.text),
  source: str(a.source),
  ...(a.minScore != null && { minScore: Number(a.minScore) }),
  ...(a.hasWhatsapp != null && { hasWhatsapp: flag(a.hasWhatsapp) }),
  ...(a.multiBranch != null && { multiBranch: flag(a.multiBranch) }),
})

const FILTER_PARAMS = [
  { name: 'status', type: 'string' as const, description: `Filter by status: ${LEAD_STATUSES.join(', ')}.` },
  { name: 'priority', type: 'string' as const, description: 'Filter by priority: A, B, or C.' },
  { name: 'type', type: 'string' as const, description: 'Filter by business type, as named in lead_config `types`.' },
  { name: 'city', type: 'string' as const, description: 'Filter by city, as named in lead_config `cities`.' },
  { name: 'text', type: 'string' as const, description: 'Text to look for in the username, name, or bio.' },
  { name: 'source', type: 'string' as const, description: 'Filter by where the candidate came from, e.g. "followers:@" or "search:dentist".' },
  { name: 'minScore', type: 'number' as const, description: 'Minimum score.' },
  { name: 'hasWhatsapp', type: 'boolean' as const, description: 'True to keep only leads with a WhatsApp number.' },
  { name: 'multiBranch', type: 'boolean' as const, description: 'True to keep only leads with multiple branches.' },
]

defineTool({
  name: 'lead_list',
  description: 'Reads the lead database with filters, sorted by highest priority, plus summary counts. Use it to pick who to contact next and to check who has already been contacted.',
  params: [
    ...FILTER_PARAMS,
    { name: 'includeUnscored', type: 'boolean', description: 'True to include candidates that have not been scored yet.' },
    { name: 'limit', type: 'number', description: 'Maximum results. Default 30, max 200.' },
    { name: 'from', type: 'number', description: 'Offset, starting at 0.' },
  ],
  risk: 'read',
  paced: false,
  handler: async a => {
    const rows = listLeads({ ...filterFrom(a), scored: flag(a.includeUnscored) ? undefined : true })
    const start = Math.max(0, Math.trunc(Number(a.from)) || 0)
    return { stats: leadStats(), matched: rows.length, from: start, leads: rows.slice(start, start + int(a.limit, 30, 1, 200)).map(row) }
  },
})

defineTool({
  name: 'lead_update',
  description: `Updates the status, notes, or tags of a lead. Statuses: ${LEAD_STATUSES.join(', ')}. dm_send automatically moves "new" to "contacted".`,
  params: [
    { name: 'username', type: 'string', description: 'Lead username, without @.', required: true },
    { name: 'status', type: 'string', description: `New status: ${LEAD_STATUSES.join(', ')}.` },
    { name: 'notes', type: 'string', description: 'Free-form notes, e.g. the outcome of a conversation. Replaces existing notes.' },
    { name: 'tags', type: 'array', description: 'List of tags. Replaces existing tags.' },
  ],
  risk: 'write',
  paced: false,
  handler: async ({ username, status, notes, tags }) => {
    const name = need(cleanUsername(username), 'lead_update', 'username')
    const st = str(status)?.toLowerCase() as LeadStatus | undefined
    if (st && !LEAD_STATUSES.includes(st)) throw new Error(`lead_update: status must be one of ${LEAD_STATUSES.join(', ')}`)
    const l = upsertLead({ username: name, ...(st && { status: st }), ...(notes != null && { notes: String(notes) }), ...(tags != null && { tags: list(tags) }) })
    return { done: true, lead: row(l) }
  },
})

defineTool({
  name: 'lead_export',
  description: 'Exports leads (with the same filters as lead_list) to a CSV file on the server and returns its path.',
  params: FILTER_PARAMS,
  risk: 'write',
  paced: false,
  handler: async a => exportLeads({ ...filterFrom(a), scored: true }),
})

defineTool({
  name: 'lead_config',
  description:
    'Reads or changes the ideal customer profile used for lead scoring: business types, competitor apps, cities, ideal follower range, branch keywords, and phone number rules. With no arguments it only reads. The default config is generic; load a preset for a ready-made setup.',
  params: [
    {
      name: 'config',
      type: 'object',
      description:
        'Fields to change: types, competitorApps, cities, idealFollowers, excludePattern, branchPattern, noBranchPattern, defaultCountryCode, mobilePrefix. Leave empty to only read.',
    },
    { name: 'preset', type: 'string', description: `Replace the whole config with a preset before applying \`config\`. Available: ${Object.keys(PRESETS).join(', ')}.` },
  ],
  risk: 'write',
  paced: false,
  handler: async ({ config, preset }) => {
    if (str(preset)) applyPreset(str(preset)!)
    if (config && typeof config === 'object') return { config: setLeadConfig(config as Partial<LeadConfig>) }
    return { config: getLeadConfig(), presets: Object.keys(PRESETS) }
  },
})

// MARK: Background jobs

defineTool({
  name: 'jobs_status',
  description: 'Status of background jobs (follower scans, lead enrichment, insights, downloads). With jobId: one job. Without: the last 30 jobs.',
  params: [{ name: 'jobId', type: 'string', description: 'Job id returned by the tool that started it. Leave empty to see all jobs.' }],
  risk: 'read',
  paced: false,
  handler: async ({ jobId }) => {
    const id = str(jobId)
    if (!id) return { jobs: listJobs().map(jobView) }
    const j = getJob(id)
    if (!j) throw new Error(`jobs_status: job ${id} not found`)
    return jobView(j)
  },
})

defineTool({
  name: 'jobs_cancel',
  description: 'Stops a background job that is still running.',
  params: [{ name: 'jobId', type: 'string', description: 'Id of the job to stop.', required: true }],
  risk: 'write',
  paced: false,
  handler: async ({ jobId }) => ({ cancelled: cancelJob(need(jobId, 'jobs_cancel', 'jobId')) }),
})
