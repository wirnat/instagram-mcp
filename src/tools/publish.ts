import fs from 'node:fs'
import path from 'node:path'
import { randomBytes } from 'node:crypto'
import { defineTool, need, int, str, flag } from './registry.js'
import type { IgClient, IgSession } from '../ig/client.js'
import { DATA_DIR } from '../config.js'
import { Store } from '../store.js'
import { sleep } from '../queue.js'
import { IgError } from '../errors.js'
import { pkToShortcode } from '../ig/normalize.js'
import { placeSearch } from '../ig/feeds.js'

type DraftType = 'post' | 'reel' | 'story'
type DraftStatus = 'draft' | 'scheduled' | 'publishing' | 'published' | 'failed'
type Asset = { src: string; file: string; kind: 'image' | 'video' }
export type Draft = {
  id: string
  type: DraftType
  assets: Asset[]
  caption: string
  at: string | null
  status: DraftStatus
  location: string | null
  mentions: string[]
  collaborators: string[]
  hideLikes: boolean
  disableComments: boolean
  shareToFeed: boolean
  closeFriends: boolean
  stretchToFill: boolean
  createdAt: string
  updatedAt: string
  publishedAt?: string
  postUrl?: string
  mediaId?: string
  error?: string
  /** Options that were requested but are not supported by this server yet. */
  ignored?: string[]
}

const store = new Store<{ drafts: Draft[] }>('drafts', () => ({ drafts: [] }))
const ASSET_DIR = path.join(DATA_DIR, 'assets')
const MAX_FILE = 100 * 1024 * 1024
const IMAGE_EXT = new Set(['.jpg', '.jpeg', '.png', '.webp'])
const VIDEO_EXT = new Set(['.mp4', '.mov', '.m4v', '.webm'])
const UNSUPPORTED = ['musicTrackId', 'musicTrackName', 'linkUrl', 'stickerText', 'sticker', 'linkSticker', 'locationSticker']

const findDraft = (id: string): Draft => {
  const d = store.get().drafts.find(x => x.id === id)
  if (!d) throw new Error(`Draft ${id} not found`)
  return d
}
const touch = (d: Draft, patch: Partial<Draft>): Draft => {
  Object.assign(d, patch, { updatedAt: new Date().toISOString() })
  store.save()
  return d
}

const view = (d: Draft, full = false) => ({
  draftId: d.id,
  type: d.type,
  status: d.status,
  at: d.at,
  caption: full ? d.caption : d.caption.slice(0, 140),
  assets: d.assets.map(a => ({ kind: a.kind, source: a.src })),
  ...(d.location && { location: d.location }),
  ...(d.mentions.length && { mentions: d.mentions }),
  ...(d.collaborators.length && { collaborators: d.collaborators }),
  ...(d.postUrl && { postUrl: d.postUrl }),
  ...(d.publishedAt && { publishedAt: d.publishedAt }),
  ...(d.error && { error: d.error }),
  ...(d.ignored?.length && { ignored: d.ignored, note: 'Options listed in `ignored` are not supported by this server yet and will not be published.' }),
})

/** Publish time in ISO 8601. Without an offset it is read in the server time zone. */
const parseAt = (v: unknown, tool: string): string => {
  const s = need(v, tool, 'at')
  const t = Date.parse(s)
  if (!Number.isFinite(t)) throw new Error(`${tool}: \`at\` is not a valid ISO 8601 time`)
  if (t <= Date.now() + 30_000) throw new Error(`${tool}: \`at\` must be in the future`)
  return new Date(t).toISOString()
}

const kindOf = (name: string, contentType = ''): 'image' | 'video' => {
  const ext = path.extname(name.split('?')[0]).toLowerCase()
  if (VIDEO_EXT.has(ext) || contentType.startsWith('video/')) return 'video'
  if (IMAGE_EXT.has(ext) || contentType.startsWith('image/')) return 'image'
  throw new Error(`File ${name} is not a supported photo or video (jpg, png, webp, mp4, mov, webm)`)
}

/** Copies a local server file or downloads a URL into the draft folder. */
const ingest = async (src: string, dir: string, index: number): Promise<Asset> => {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
  if (/^https?:\/\//i.test(src)) {
    const res = await fetch(src, { signal: AbortSignal.timeout(180_000) })
    if (!res.ok) throw new Error(`Failed to download ${src} (${res.status})`)
    const kind = kindOf(new URL(src).pathname, res.headers.get('content-type') ?? '')
    const buf = Buffer.from(await res.arrayBuffer())
    if (buf.length > MAX_FILE) throw new Error(`File ${src} is larger than 100 MB`)
    const file = path.join(dir, `${index}${kind === 'video' ? '.mp4' : '.jpg'}`)
    fs.writeFileSync(file, buf)
    return { src, file, kind }
  }
  if (!path.isAbsolute(src)) throw new Error(`An asset must be an absolute path on the server or an http(s) URL: ${src}`)
  const st = fs.statSync(src)
  if (st.size > MAX_FILE) throw new Error(`File ${src} is larger than 100 MB`)
  const kind = kindOf(src)
  const file = path.join(dir, `${index}${path.extname(src).toLowerCase()}`)
  fs.copyFileSync(src, file)
  return { src, file, kind }
}

const usernames = (v: unknown, max: number): string[] => (Array.isArray(v) ? v : []).map(x => String(x).replace(/^@/, '').trim()).filter(Boolean).slice(0, max)

// MARK: Publishing

const uploadId = () => `${Date.now()}${Math.floor(Math.random() * 90 + 10)}`

const commonForm = async (ig: IgSession, d: Draft, firstUploadId: string): Promise<Record<string, string | number>> => {
  const form: Record<string, string | number> = {
    archive_only: 'false',
    caption: d.caption,
    clips_share_preview_to_feed: d.shareToFeed ? 1 : 0,
    disable_comments: d.disableComments ? 1 : 0,
    disable_oa_reuse: 'false',
    igtv_share_preview_to_feed: 1,
    is_meta_only_post: 0,
    is_unified_video: 1,
    like_and_view_counts_disabled: d.hideLikes ? 1 : 0,
    source_type: 'library',
    upload_id: firstUploadId,
    video_subtitles_enabled: 0,
  }
  if (d.location) {
    const loc = (await placeSearch(ig, d.location))[0]
    if (loc) {
      form.location = JSON.stringify({ lat: loc.lat, lng: loc.lng, facebook_places_id: loc.id })
      form.geotag_enabled = 'true'
    }
  }
  if (d.mentions.length) {
    const ids = []
    for (const u of d.mentions) ids.push(await ig.userId(u))
    form.usertags = JSON.stringify({ in: ids.map((id, i) => ({ user_id: id, position: [0.5, Math.min(0.9, 0.3 + i * 0.1)] })) })
  }
  if (d.collaborators.length) {
    const ids = []
    for (const u of d.collaborators) ids.push(await ig.userId(u))
    form.invite_coauthor_user_ids_string = JSON.stringify(ids)
  }
  return form
}

/** Instagram needs time to process videos, so this retries until the video is ready. */
const configureWithRetry = async (ig: IgSession, endpoint: string, form: Record<string, string | number>): Promise<any> => {
  let last: any
  for (let i = 0; i < 14; i++) {
    try {
      last = await ig.post(endpoint, form, { allow: [202] })
    } catch (e) {
      if (e instanceof IgError && /transcode|not finished|belum selesai/i.test(`${e.message} ${e.body ?? ''}`)) last = { status: 'processing' }
      else throw e
    }
    if (last?.media || last?.status === 'ok') return last
    await sleep(5000)
  }
  throw new Error(`Instagram has not finished processing the video: ${JSON.stringify(last).slice(0, 200)}`)
}

const mediaResult = (j: any) => {
  const m = j.media ?? {}
  const pk = String(m.pk ?? m.id ?? '').split('_')[0]
  const code = m.code ?? (pk ? pkToShortcode(pk) : '')
  return { mediaId: pk, postUrl: code ? `https://www.instagram.com/${m.product_type === 'clips' ? 'reel' : 'p'}/${code}/` : undefined }
}

/** Uploads a draft's assets and publishes it. */
export const publishDraft = async (ig: IgSession, d: Draft): Promise<Draft> => {
  touch(d, { status: 'publishing', error: undefined })
  try {
    let result: { mediaId: string; postUrl?: string }
    if (d.type === 'story') {
      let last: any
      for (const a of d.assets) {
        const id = uploadId()
        await ig.upload(a.file, { kind: a.kind, uploadId: id, mode: 'story', stretch: d.stretchToFill })
        const form: Record<string, string | number> = { upload_id: id, caption: '', ...(d.closeFriends && { audience: 'besties' }) }
        last = a.kind === 'video' ? await configureWithRetry(ig, '/api/v1/media/configure_to_story/', { ...form, video_result: '' }) : await ig.post('/api/v1/media/configure_to_story/', form)
      }
      const m = last?.media ?? {}
      result = { mediaId: String(m.pk ?? '').split('_')[0], postUrl: m.user?.username ? `https://www.instagram.com/stories/${m.user.username}/${String(m.pk ?? '').split('_')[0]}/` : undefined }
    } else if (d.assets.length > 1) {
      if (d.type === 'reel') throw new Error('A reel accepts only one video')
      const children: { upload_id: string }[] = []
      let ratio: number | undefined
      for (const a of d.assets) {
        const id = uploadId()
        const r = await ig.upload(a.file, { kind: a.kind, uploadId: id, mode: 'feed', ratio, isSidecar: true })
        ratio ??= Math.min(1.91, Math.max(0.8, r.ratio))
        children.push({ upload_id: id })
        await sleep(800)
      }
      const form = await commonForm(ig, d, children[0].upload_id)
      const j = await ig.postJson('/api/v1/media/configure_sidecar/', {
        archive_only: false,
        caption: d.caption,
        children_metadata: children,
        client_sidecar_id: uploadId(),
        disable_comments: String(form.disable_comments),
        is_meta_only_post: false,
        like_and_view_counts_disabled: Number(form.like_and_view_counts_disabled),
        source_type: 'library',
        ...(form.location && { location: JSON.parse(String(form.location)), geotag_enabled: true }),
        ...(form.invite_coauthor_user_ids_string && { invite_coauthor_user_ids_string: form.invite_coauthor_user_ids_string }),
      })
      result = mediaResult(j)
    } else {
      const a = d.assets[0]
      const id = uploadId()
      const isVideo = a.kind === 'video'
      if (d.type === 'reel' && !isVideo) throw new Error('A reel needs a video file')
      await ig.upload(a.file, { kind: a.kind, uploadId: id, mode: 'feed', isClips: isVideo })
      const form = await commonForm(ig, d, id)
      const j = isVideo ? await configureWithRetry(ig, '/api/v1/media/configure_to_clips/', form) : await ig.post('/api/v1/media/configure/', form)
      result = mediaResult(j)
    }
    return touch(d, { status: 'published', publishedAt: new Date().toISOString(), ...result })
  } catch (e) {
    touch(d, { status: 'failed', error: (e as Error).message.slice(0, 400) })
    throw e
  }
}

let schedulerTimer: NodeJS.Timeout | null = null
let schedulerBusy = false

/** Checks every 30 seconds whether a scheduled draft is due to be published. */
export const startScheduler = (client: IgClient): void => {
  if (schedulerTimer) return
  schedulerTimer = setInterval(async () => {
    if (schedulerBusy || client.queue.paused) return
    const due = store.get().drafts.find(d => d.status === 'scheduled' && d.at && Date.parse(d.at) <= Date.now())
    if (!due) return
    schedulerBusy = true
    try {
      await publishDraft(client.session(false, true), due)
    } catch {
      /* the draft is already marked as failed */
    } finally {
      schedulerBusy = false
    }
  }, 30_000)
  schedulerTimer.unref()
}

// MARK: Tool

const OPTION_PARAMS = [
  { name: 'caption', type: 'string' as const, description: 'Caption, including hashtags and @mentions.' },
  { name: 'at', type: 'string' as const, description: 'Publish time in ISO 8601, must be in the future. Without an offset it is read in the server time zone (see account_info).' },
  { name: 'type', type: 'string' as const, description: 'Publish as: post (default), reel, or story.' },
  { name: 'location', type: 'string' as const, description: 'Name of the place to tag. The first search result is used.' },
  { name: 'mentions', type: 'array' as const, description: 'Usernames to tag in the photo, without @. Up to 20.' },
  { name: 'collaborators', type: 'array' as const, description: 'Usernames to invite as collaborators, without @. Up to 5.' },
  { name: 'closeFriends', type: 'boolean' as const, description: 'Stories only: share with Close Friends only.' },
  { name: 'hideLikes', type: 'boolean' as const, description: 'Hide like and view counts.' },
  { name: 'disableComments', type: 'boolean' as const, description: 'Turn off comments.' },
  { name: 'shareToFeed', type: 'boolean' as const, description: 'Reels only: also show in the feed. Default true.' },
  { name: 'stretchToFill', type: 'boolean' as const, description: 'Stories only: fill the screen by cropping (default true) or add black bars (false).' },
]

const applyOptions = (d: Draft, a: Record<string, any>, tool: string): void => {
  if (a.caption != null) d.caption = String(a.caption)
  if (a.type != null) {
    const t = String(a.type).toLowerCase()
    if (!['post', 'reel', 'story'].includes(t)) throw new Error(`${tool}: type must be post, reel, or story`)
    d.type = t as DraftType
  }
  if (a.location != null) d.location = str(a.location) ?? null
  if (a.mentions != null) d.mentions = usernames(a.mentions, 20)
  if (a.collaborators != null) d.collaborators = usernames(a.collaborators, 5)
  for (const k of ['closeFriends', 'hideLikes', 'disableComments', 'shareToFeed', 'stretchToFill'] as const) if (a[k] != null) d[k] = flag(a[k])
  const ignored = UNSUPPORTED.filter(k => a[k] != null && a[k] !== '')
  if (ignored.length) d.ignored = [...new Set([...(d.ignored ?? []), ...ignored])]
  if (d.type === 'reel' && (d.assets.length !== 1 || d.assets[0].kind !== 'video')) throw new Error(`${tool}: a reel needs exactly one video`)
}

defineTool({
  name: 'draft_create',
  description:
    'Creates a post draft from photos or videos. Set `at` to schedule it right away; otherwise follow up with draft_schedule or draft_publish. Assets are http(s) URLs or absolute paths on the machine running this server. Music and story stickers are not supported yet.',
  params: [{ name: 'assets', type: 'array', description: 'Photos or videos in carousel order. http(s) URLs or absolute paths on the server. jpg/png/webp/mp4. Up to 20.', required: true }, ...OPTION_PARAMS],
  risk: 'write',
  paced: false,
  handler: async a => {
    const srcs = (Array.isArray(a.assets) ? a.assets : [a.assets]).map((x: unknown) => String(x ?? '').trim()).filter(Boolean)
    if (!srcs.length) throw new Error('draft_create needs `assets`')
    if (srcs.length > 20) throw new Error('draft_create: up to 20 assets')
    const id = `d_${randomBytes(5).toString('hex')}`
    const dir = path.join(ASSET_DIR, id)
    try {
      const assets: Asset[] = []
      for (const [i, s] of srcs.entries()) assets.push(await ingest(s, dir, i + 1))
      const nowIso = new Date().toISOString()
      const d: Draft = {
        id, type: 'post', assets, caption: '', at: null, status: 'draft', location: null, mentions: [], collaborators: [],
        hideLikes: false, disableComments: false, shareToFeed: true, closeFriends: false, stretchToFill: true, createdAt: nowIso, updatedAt: nowIso,
      }
      applyOptions(d, a, 'draft_create')
      if (a.at != null && a.at !== '') {
        d.at = parseAt(a.at, 'draft_create')
        d.status = 'scheduled'
      }
      store.update(s => void s.drafts.push(d))
      return view(d, true)
    } catch (e) {
      fs.rmSync(dir, { recursive: true, force: true })
      throw e
    }
  },
})

defineTool({
  name: 'draft_update',
  description: 'Changes an unpublished draft: caption, time, type, location, tags, or other options. Set at least one field; the rest stay unchanged.',
  params: [{ name: 'draftId', type: 'string', description: 'Draft id from draft_create or draft_list.', required: true }, ...OPTION_PARAMS],
  risk: 'write',
  paced: false,
  handler: async a => {
    const d = findDraft(need(a.draftId, 'draft_update', 'draftId'))
    if (d.status === 'published' || d.status === 'publishing') throw new Error('draft_update: this draft is already published or being published')
    applyOptions(d, a, 'draft_update')
    if (a.at != null && a.at !== '') {
      d.at = parseAt(a.at, 'draft_update')
      d.status = 'scheduled'
    }
    return view(touch(d, {}), true)
  },
})

defineTool({
  name: 'draft_schedule',
  description: 'Schedules a draft to publish automatically at a given time. This server must still be running when that time comes.',
  params: [
    { name: 'draftId', type: 'string', description: 'Draft id from draft_create or draft_list.', required: true },
    { name: 'at', type: 'string', description: 'Publish time in ISO 8601, must be in the future. Without an offset it is read in the server time zone.', required: true },
  ],
  risk: 'write',
  paced: false,
  handler: async ({ draftId, at }) => {
    const d = findDraft(need(draftId, 'draft_schedule', 'draftId'))
    if (d.status === 'published' || d.status === 'publishing') throw new Error('draft_schedule: this draft is already published or being published')
    return view(touch(d, { at: parseAt(at, 'draft_schedule'), status: 'scheduled', error: undefined }))
  },
})

defineTool({
  name: 'draft_publish',
  description: 'Publishes a draft to Instagram now. This cannot be undone from here. Waits up to about 45 seconds; longer uploads continue in the background (check with draft_get).',
  params: [{ name: 'draftId', type: 'string', description: 'Draft id from draft_create or draft_list.', required: true }],
  risk: 'action',
  handler: async ({ draftId }, ig) => {
    const d = findDraft(need(draftId, 'draft_publish', 'draftId'))
    if (d.status === 'published') return { ...view(d, true), message: 'This draft is already published' }
    if (d.status === 'publishing') return { ...view(d), message: 'This draft is being published' }
    const run = publishDraft(ig.background(), d).catch(() => undefined)
    await Promise.race([run, sleep(45_000)])
    return view(d, true)
  },
})

defineTool({
  name: 'draft_get',
  description: 'Reads one draft: status, schedule, full caption, assets, location, tags, the post link once published, and the last error.',
  params: [{ name: 'draftId', type: 'string', description: 'Draft id.', required: true }],
  risk: 'read',
  paced: false,
  handler: async ({ draftId }) => view(findDraft(need(draftId, 'draft_get', 'draftId')), true),
})

defineTool({
  name: 'draft_list',
  description: 'Lists drafts, scheduled posts, and recently published or failed ones, soonest schedule first.',
  params: [
    { name: 'status', type: 'string', description: 'Filter: draft, scheduled, publishing, published, failed.' },
    { name: 'limit', type: 'number', description: 'Maximum number of results, 1-200, default 50.' },
  ],
  risk: 'read',
  paced: false,
  handler: async ({ status, limit }) => {
    const want = str(status)
    const rows = store
      .get()
      .drafts.filter(d => !want || d.status === want)
      .sort((a, b) => (a.at ? Date.parse(a.at) : Infinity) - (b.at ? Date.parse(b.at) : Infinity))
    return { drafts: rows.slice(0, int(limit, 50, 1, 200)).map(d => view(d)) }
  },
})

defineTool({
  name: 'draft_delete',
  description: 'Deletes a draft and its media from this server. A post already published on Instagram is not deleted; use ig_post_delete for that.',
  params: [{ name: 'draftId', type: 'string', description: 'Draft id.', required: true }],
  risk: 'write',
  paced: false,
  handler: async ({ draftId }) => {
    const d = findDraft(need(draftId, 'draft_delete', 'draftId'))
    if (d.status === 'publishing') throw new Error('draft_delete: this draft is being published')
    store.update(s => void (s.drafts = s.drafts.filter(x => x.id !== d.id)))
    fs.rmSync(path.join(ASSET_DIR, d.id), { recursive: true, force: true })
    return { deleted: true, draftId: d.id }
  },
})

defineTool({
  name: 'draft_reorder',
  description: 'Reorders scheduled posts using their existing time slots: the earliest slot goes to the first id, and so on.',
  params: [{ name: 'draftIds', type: 'array', description: 'Scheduled draft ids in the desired order, at least two.', required: true }],
  risk: 'write',
  paced: false,
  handler: async ({ draftIds }) => {
    const ids = (Array.isArray(draftIds) ? draftIds : []).map(String)
    if (ids.length < 2) throw new Error('draft_reorder needs at least two ids')
    const drafts = ids.map(findDraft)
    if (drafts.some(d => d.status !== 'scheduled' || !d.at)) throw new Error('draft_reorder: every draft must have status scheduled')
    const slots = drafts.map(d => d.at!).sort((a, b) => Date.parse(a) - Date.parse(b))
    drafts.forEach((d, i) => touch(d, { at: slots[i] }))
    return { drafts: drafts.map(d => view(d)) }
  },
})

defineTool({
  name: 'draft_preview',
  description: 'Summary of a draft as it will be published: type, asset order with file sizes, caption, and active options.',
  params: [{ name: 'draftId', type: 'string', description: 'Draft id.', required: true }],
  risk: 'read',
  paced: false,
  handler: async ({ draftId }) => {
    const d = findDraft(need(draftId, 'draft_preview', 'draftId'))
    return { ...view(d, true), files: d.assets.map(a => ({ kind: a.kind, path: a.file, sizeKb: Math.round(fs.statSync(a.file).size / 1024) })) }
  },
})
