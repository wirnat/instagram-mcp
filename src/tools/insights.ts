import fs from 'node:fs'
import path from 'node:path'
import { defineTool, need, int, str, cleanUsername } from './registry.js'
import type { IgSession } from '../ig/client.js'
import { Store } from '../store.js'
import { DOWNLOAD_DIR } from '../config.js'
import { startJob, runningJob, jobView, getJob, listJobs, cancelJob, type JobHandle } from '../jobs.js'
import { normPost, normProfile, normStory, parsePostRef } from '../ig/normalize.js'
import { normNotification } from './engage.js'
import { postByShortcode, userPosts, userStories } from '../ig/feeds.js'
import { inboxThreads, messages, normMessage, viewerFbid } from './dm.js'

// MARK: Insight

type PostStat = { shortcode: string; url: string; type: string; likes: number; comments: number; views: number | null; takenAt: string; caption: string }
type Insight = { username: string; collectedOn: string; followers: number | null; posts: PostStat[] }
const insightStore = (u: string) => new Store<Insight | null>(`insights-${u.toLowerCase()}`, () => null)

/** Fetches up to `max` posts of an account through the paced queue. */
const collectPosts = async (ig: IgSession, username: string, max: number, h?: JobHandle): Promise<any[]> => {
  const { items } = await userPosts(ig, username, max, {
    onPage: count => {
      h?.progress(count, max)
      return !h?.cancelled
    },
  })
  return items
}

const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0)
const round = (n: number, d = 2) => Math.round(n * 10 ** d) / 10 ** d
const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']

const buildReport = (d: Insight, tz: string) => {
  const posts = d.posts
  const eng = (p: PostStat) => p.likes + p.comments
  const rate = (p: PostStat) => (d.followers ? (eng(p) / d.followers) * 100 : 0)
  const local = (iso: string) => {
    const parts = new Intl.DateTimeFormat('en-US', { timeZone: tz, weekday: 'short', hour: 'numeric', hour12: false }).formatToParts(new Date(iso))
    const wd = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(parts.find(p => p.type === 'weekday')!.value)
    return { wd, hour: Number(parts.find(p => p.type === 'hour')!.value) % 24 }
  }
  const group = <K extends string | number>(key: (p: PostStat) => K) => {
    const m = new Map<K, PostStat[]>()
    for (const p of posts) m.set(key(p), [...(m.get(key(p)) ?? []), p])
    return [...m.entries()].map(([k, v]) => ({ key: k, posts: v.length, avgEngagement: Math.round(mean(v.map(eng))) }))
  }
  const sorted = [...posts].sort((a, b) => Date.parse(b.takenAt) - Date.parse(a.takenAt))
  const spanDays = sorted.length > 1 ? (Date.parse(sorted[0].takenAt) - Date.parse(sorted.at(-1)!.takenAt)) / 86_400_000 : 0
  const recent = sorted.slice(0, 10)
  const prev = sorted.slice(10, 20)
  const tags = new Map<string, number[]>()
  for (const p of posts) for (const t of new Set(p.caption.toLowerCase().match(/#[\p{L}\p{N}_]+/gu) ?? [])) tags.set(t, [...(tags.get(t) ?? []), eng(p)])
  return {
    username: d.username,
    collectedOn: d.collectedOn,
    timeZone: tz,
    followers: d.followers,
    postsAnalyzed: posts.length,
    avgLikes: Math.round(mean(posts.map(p => p.likes))),
    avgComments: Math.round(mean(posts.map(p => p.comments))),
    engagementRatePct: round(mean(posts.map(rate))),
    postsPerWeek: spanDays > 0 ? round((posts.length / spanDays) * 7, 1) : null,
    trend: prev.length ? { last10AvgEngagement: Math.round(mean(recent.map(eng))), previous10AvgEngagement: Math.round(mean(prev.map(eng))), changePct: round(((mean(recent.map(eng)) - mean(prev.map(eng))) / (mean(prev.map(eng)) || 1)) * 100, 1) } : null,
    byType: group(p => p.type).sort((a, b) => b.avgEngagement - a.avgEngagement),
    byWeekday: group(p => local(p.takenAt).wd).sort((a, b) => b.avgEngagement - a.avgEngagement).map(x => ({ ...x, key: DAYS[x.key as number] })),
    bestHours: group(p => local(p.takenAt).hour).filter(x => x.posts >= 2).sort((a, b) => b.avgEngagement - a.avgEngagement).slice(0, 5).map(x => ({ hour: `${String(x.key).padStart(2, '0')}:00`, posts: x.posts, avgEngagement: x.avgEngagement })),
    topPosts: [...posts].sort((a, b) => eng(b) - eng(a)).slice(0, 5).map(p => ({ url: p.url, type: p.type, likes: p.likes, comments: p.comments, takenAt: p.takenAt, caption: p.caption.slice(0, 100) })),
    topHashtags: [...tags.entries()].filter(([, v]) => v.length >= 2).map(([tag, v]) => ({ tag, uses: v.length, avgEngagement: Math.round(mean(v)) })).sort((a, b) => b.avgEngagement - a.avgEngagement).slice(0, 10),
  }
}

defineTool({
  name: 'insights_collect',
  description: 'Starts (or refreshes) an analysis of an account based on its public posts. Runs in the background; read the result with insights_report. Works for your own account and for competitors.',
  params: [
    { name: 'username', type: 'string', description: 'Account to analyze, without @.', required: true },
    { name: 'postsLimit', type: 'number', description: 'Maximum number of posts to analyze, 1-1500, default 100.' },
  ],
  risk: 'read',
  handler: async ({ username, postsLimit }, ig) => {
    const name = need(cleanUsername(username), 'insights_collect', 'username')
    const running = runningJob('insights', name)
    if (running) return { started: false, message: 'An analysis of this account is still running', ...jobView(running) }
    const raw = await ig.rawProfile(name)
    if (!raw) throw new Error(`insights_collect: account @${name} not found`)
    const prof = normProfile(raw)
    const bg = ig.background()
    const job = startJob('insights', name, async h => {
      const items = await collectPosts(bg, name, int(postsLimit, 100, 1, 1500), h)
      const posts: PostStat[] = items.map(m => {
        const p = normPost(m) as any
        return { shortcode: p.shortcode, url: p.url, type: p.type, likes: p.likes ?? 0, comments: p.comments ?? 0, views: p.views, takenAt: p.takenAt, caption: p.caption }
      })
      insightStore(name).set({ username: name, collectedOn: new Date().toISOString(), followers: prof.followerCount, posts })
      return { postsAnalyzed: posts.length }
    })
    return { started: true, ...jobView(job) }
  },
})

defineTool({
  name: 'insights_report',
  description: 'Result of insights_collect: engagement, posting frequency, best days and hours, post types, top posts, trend, and best-performing hashtags.',
  params: [{ name: 'username', type: 'string', description: 'An account that has already been analyzed, without @.', required: true }],
  risk: 'read',
  paced: false,
  handler: async ({ username }) => {
    const name = need(cleanUsername(username), 'insights_report', 'username')
    const d = insightStore(name).get()
    const job = runningJob('insights', name)
    if (!d) return { username: name, collected: false, ...(job && { job: jobView(job) }), message: 'No data yet. Run insights_collect first.' }
    return { ...buildReport(d, Intl.DateTimeFormat().resolvedOptions().timeZone), ...(job && { refreshing: jobView(job) }) }
  },
})

// MARK: Downloads

const saveUrl = async (ig: IgSession, url: string, file: string): Promise<void> => {
  const ctx = ig.browser.ctx
  if (!ctx) throw new Error('The browser is not running')
  const res = await ctx.request.get(url, { timeout: 120_000 })
  if (!res.ok()) throw new Error(`Download failed (${res.status()})`)
  fs.writeFileSync(file, await res.body())
}

const mediaFiles = (m: any): { url: string; ext: string }[] =>
  (m.carousel_media ?? [m]).map((x: any) => {
    const v = x.video_versions?.[0]?.url
    return v ? { url: v, ext: 'mp4' } : { url: x.image_versions2?.candidates?.[0]?.url, ext: 'jpg' }
  }).filter((f: any) => f.url)

defineTool({
  name: 'downloads_start',
  description: 'Downloads media to the server: all posts, reels, and stories of an account via `username`, or a single post via `url`. Set exactly one of them. Returns a job id; check it with downloads_status.',
  params: [
    { name: 'username', type: 'string', description: 'Account to download. Private accounts only work if you follow them.' },
    { name: 'url', type: 'string', description: 'Link to a single post (/p/, /reel/, /tv/).' },
    { name: 'media', type: 'array', description: 'Options: posts, stories (default both). Account downloads only.' },
    { name: 'limit', type: 'number', description: 'Maximum number of posts, default 50. Account downloads only.' },
  ],
  risk: 'write',
  handler: async ({ username, url, media, limit }, ig) => {
    const name = cleanUsername(username)
    const link = str(url)
    if (!!name === !!link) throw new Error('downloads_start needs exactly one of `username` or `url`')
    const want = new Set((Array.isArray(media) && media.length ? media : ['posts', 'stories']).map(String))
    const bg = ig.background()
    const label = name ?? parsePostRef(link!).shortcode
    const dir = path.join(DOWNLOAD_DIR, label)
    const userId = name ? await ig.userId(name) : null
    const job = startJob('downloads', label, async h => {
      fs.mkdirSync(dir, { recursive: true })
      const manifest: unknown[] = []
      let saved = 0
      const savePost = async (m: any) => {
        const p = normPost(m) as any
        const files: string[] = []
        for (const [i, f] of mediaFiles(m).entries()) {
          const file = path.join(dir, `${p.shortcode}${i ? `_${i + 1}` : ''}.${f.ext}`)
          await saveUrl(bg, f.url, file)
          files.push(file)
        }
        manifest.push({ shortcode: p.shortcode, url: p.url, type: p.type, likes: p.likes, comments: p.comments, takenAt: p.takenAt, caption: p.caption, files })
        h.progress(++saved)
      }
      if (link) {
        const m = await postByShortcode(bg, parsePostRef(link).shortcode)
        if (m) await savePost(m)
      } else {
        if (want.has('posts')) for (const m of await collectPosts(bg, name!, int(limit, 50, 1, 2000))) {
          if (h.cancelled) break
          await savePost(m)
        }
        if (want.has('stories') && !h.cancelled) {
          for (const s of await userStories(bg, userId!)) {
            const st = normStory(s)
            const file = path.join(dir, `story_${st.id}.${st.videoUrl ? 'mp4' : 'jpg'}`)
            await saveUrl(bg, (st.videoUrl ?? st.imageUrl)!, file)
            manifest.push({ story: st.id, takenAt: st.takenAt, files: [file] })
            h.progress(++saved)
          }
        }
      }
      const manifestPath = path.join(dir, 'manifest.json')
      fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 1))
      return { folder: dir, manifest: manifestPath, items: manifest.length }
    })
    return { started: true, ...jobView(job) }
  },
})

defineTool({
  name: 'downloads_status',
  description: 'Progress of a download: number of items saved and, once finished, the folder and manifest path. Without jobId it lists all downloads.',
  params: [{ name: 'jobId', type: 'string', description: 'Job id from downloads_start. Leave empty to list all.' }],
  risk: 'read',
  paced: false,
  handler: async ({ jobId }) => {
    const id = str(jobId)
    if (!id) return { jobs: listJobs('downloads').map(jobView) }
    const j = getJob(id)
    if (!j) throw new Error(`downloads_status: job ${id} not found`)
    return jobView(j)
  },
})

defineTool({
  name: 'downloads_cancel',
  description: 'Cancels a running download. Files already saved are deleted.',
  params: [{ name: 'jobId', type: 'string', description: 'Job id from downloads_start.', required: true }],
  risk: 'write',
  paced: false,
  handler: async ({ jobId }) => {
    const id = need(jobId, 'downloads_cancel', 'jobId')
    const j = getJob(id)
    if (!j || j.kind !== 'downloads') throw new Error(`downloads_cancel: job ${id} not found`)
    const cancelled = cancelJob(id)
    fs.rmSync(path.join(DOWNLOAD_DIR, j.label), { recursive: true, force: true })
    return { cancelled, removed: true }
  },
})

// MARK: New activity

const KINDS = ['dm', 'comments', 'likes', 'follows', 'mentions']

defineTool({
  name: 'events_check',
  description: 'New Instagram activity since a cursor, in a single check without waiting: incoming DMs, comments, likes, follows, and mentions. The first call without a cursor only returns a cursor.',
  params: [
    { name: 'kinds', type: 'array', description: 'Options: dm, comments, likes, follows, mentions. Default dm. For message requests use dm_requests.' },
    { name: 'cursor', type: 'string', description: 'Cursor from the previous events_check response. Leave empty on the first call.' },
  ],
  risk: 'read',
  handler: async ({ kinds, cursor }, ig) => {
    const want = (Array.isArray(kinds) && kinds.length ? kinds.map(String) : ['dm']).filter(k => KINDS.includes(k))
    let since = { dmAt: 0, notifAt: 0 }
    const first = !str(cursor)
    if (!first) {
      try {
        since = { ...since, ...JSON.parse(Buffer.from(str(cursor)!, 'base64url').toString()) }
      } catch {
        throw new Error('events_check: invalid cursor')
      }
    }
    const events: unknown[] = []
    let dmAt = since.dmAt
    let notifAt = since.notifAt
    if (want.includes('dm')) {
      for (const t of await inboxThreads(ig)) {
        for (const m of messages(t)) {
          const at = Number(m.timestamp_ms)
          dmAt = Math.max(dmAt, at)
          if (first || at <= since.dmAt || String(m.sender_fbid) === viewerFbid(t)) continue
          const n = normMessage(m, t)
          events.push({ kind: 'dm', thread_id: String(t.thread_key), from: n.sender, message_id: n.id, type: n.type, text: n.text, at: n.at })
        }
      }
    }
    const notifKinds = want.filter(k => !k.startsWith('dm'))
    if (notifKinds.length) {
      const j = await ig.get('/api/v1/news/inbox/')
      for (const s of [...(j.new_stories ?? []), ...(j.old_stories ?? [])]) {
        const n = normNotification(s)
        const at = n.at ? Date.parse(n.at) : 0
        notifAt = Math.max(notifAt, at)
        if (first || at <= since.notifAt || !notifKinds.includes(n.kind)) continue
        events.push({ kind: n.kind, from: n.username, text: n.text, postId: n.postId, at: n.at })
      }
    }
    return { events, cursor: Buffer.from(JSON.stringify({ dmAt, notifAt })).toString('base64url') }
  },
})
