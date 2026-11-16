import { defineTool, need, int, str, cleanUsername } from './registry.js'
import { normPost, normProfile, normStory, normUserLite, parsePostRef } from '../ig/normalize.js'
import { keywordPosts, placeSearch, postByShortcode, topSearch, userPosts, userStories } from '../ig/feeds.js'
import type { IgSession } from '../ig/client.js'

let viewerCache: { id: string; username: string; fullName: string; isBusiness: boolean; isProfessional: boolean } | null = null

/** The account currently logged in to the browser. */
export const viewerInfo = async (ig: IgSession) => {
  const id = await ig.viewerId()
  if (viewerCache?.id === id) return viewerCache
  const u = (await ig.rawProfileById(id)) ?? {}
  viewerCache = {
    id,
    username: u.username ?? '',
    fullName: u.full_name ?? '',
    isBusiness: u.is_business === true,
    isProfessional: u.account_type === 2 || u.account_type === 3,
  }
  if (viewerCache.username) ig.rememberUser(viewerCache.username, id)
  return viewerCache
}

defineTool({
  name: 'account_info',
  description:
    "The Instagram account logged in to this server's browser, the safety pause status, and the time zone. Call this first to confirm the session is still alive.",
  params: [],
  risk: 'read',
  handler: async (_a, ig) => {
    const loggedIn = await ig.browser.start().then(() => ig.browser.isLoggedIn())
    if (!loggedIn) return { loggedIn: false, hint: 'Not logged in. Run `instagram-mcp login` on the machine where this server runs.' }
    const v = await viewerInfo(ig)
    return {
      loggedIn: true,
      userId: v.id,
      username: v.username,
      fullName: v.fullName,
      url: `https://www.instagram.com/${v.username}/`,
      isBusiness: v.isBusiness,
      isProfessional: v.isProfessional,
      timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      paused: ig.queue.paused,
      ...(ig.queue.paused && { pausedUntil: new Date(ig.queue.pausedUntil).toISOString(), pauseReason: ig.queue.pauseReason }),
    }
  },
})

defineTool({
  name: 'ig_fetch_profile',
  description: "An account's profile: bio, links, follower/following/post counts, category, address, business contact details, and its relationship to the logged-in account.",
  params: [{ name: 'username', type: 'string', description: 'Account username, without @.', required: true }],
  risk: 'read',
  handler: async ({ username }, ig) => {
    const name = need(cleanUsername(username), 'ig_fetch_profile', 'username')
    const u = await ig.rawProfile(name)
    return u ? normProfile(u) : { found: false, username: name }
  },
})

defineTool({
  name: 'ig_fetch_posts',
  description: "An account's recent posts, newest first: caption, type, likes, comments, time, shortcode, and link. Returns nextCursor when more posts are available.",
  params: [
    { name: 'username', type: 'string', description: 'Account username, without @.', required: true },
    { name: 'limit', type: 'number', description: 'Maximum number of posts, 1-1500. Default 24.' },
    { name: 'cursor', type: 'string', description: 'nextCursor from a previous call. Leave empty for the latest posts.' },
  ],
  risk: 'read',
  handler: async ({ username, limit, cursor }, ig) => {
    const name = need(cleanUsername(username), 'ig_fetch_posts', 'username')
    const { items, next } = await userPosts(ig, name, int(limit, 24, 1, 1500), { cursor: str(cursor) })
    return { username: name, posts: items.map(m => normPost(m)), nextCursor: next }
  },
})

defineTool({
  name: 'ig_fetch_post',
  description: 'A single post by URL or shortcode: caption, owner, type, likes, comments, time, and full-size media URLs. Works for /p/, /reel/, and /tv/ links.',
  params: [
    { name: 'url', type: 'string', description: 'Post link, for example https://www.instagram.com/p/ABC123/. Provide this or shortcode.' },
    { name: 'shortcode', type: 'string', description: 'Post shortcode only, for example ABC123. Provide this or url.' },
  ],
  risk: 'read',
  handler: async ({ url, shortcode }, ig) => {
    const ref = need(str(url) ?? str(shortcode), 'ig_fetch_post', 'url or shortcode')
    const m = await postByShortcode(ig, parsePostRef(ref).shortcode)
    if (!m) return { found: false, post: ref, message: 'Post not found, deleted, or not visible to this account' }
    return normPost(m, { full: true })
  },
})

defineTool({
  name: 'ig_search',
  description:
    'Search accounts and hashtags with free text, like the search box on Instagram web. The web returns only a few top results per search. For more results, run several more specific queries or use ig_hashtag_posts.',
  params: [
    { name: 'query', type: 'string', description: 'Search text. A leading @ or # is ignored.', required: true },
    { name: 'type', type: 'string', description: '"account" or "hashtag". Leave empty to search both.' },
  ],
  risk: 'read',
  handler: async ({ query, type }, ig) => {
    const q = need(query, 'ig_search', 'query').replace(/^[@#]/, '')
    const want = str(type)
    const r = await topSearch(ig, q, want === 'account' ? 'user' : want === 'hashtag' ? 'hashtag' : 'blended')
    for (const u of r.users) ig.rememberUser(u.username, String(u.pk ?? u.id ?? ''))
    return {
      query: q,
      type: want ?? 'all',
      accounts: want === 'hashtag' ? [] : r.users.map((u: any) => ({ ...normUserLite(u), context: u.search_social_context ?? null })),
      hashtags: want === 'account' ? [] : r.hashtags.map((h: any) => ({ name: h.name, postCount: h.media_count ?? null, url: `https://www.instagram.com/explore/tags/${h.name}/` })),
    }
  },
})

defineTool({
  name: 'ig_hashtag_posts',
  description:
    "Top posts for a hashtag or keyword, as shown on Instagram web search results, including each post's owner. Useful for finding accounts that are active on a topic.",
  params: [{ name: 'tag', type: 'string', description: 'A hashtag (with or without #) or a free-text keyword such as "coffee shop brooklyn".', required: true }],
  risk: 'read',
  handler: async ({ tag }, ig) => {
    const raw = need(tag, 'ig_hashtag_posts', 'tag')
    const q = /\s/.test(raw) ? raw : `#${raw.replace(/^#/, '').toLowerCase()}`
    const { medias } = await keywordPosts(ig, q)
    const seen = new Set<string>()
    const posts = medias.map(m => normPost(m)).filter(p => (seen.has(String(p.shortcode)) ? false : (seen.add(String(p.shortcode)), true)))
    return { query: q, posts }
  },
})

defineTool({
  name: 'ig_fetch_stories',
  description: "An account's active stories as seen by the logged-in account. Empty if there are none or they are not visible.",
  params: [{ name: 'username', type: 'string', description: 'Account username, without @.', required: true }],
  risk: 'read',
  handler: async ({ username }, ig) => {
    const name = need(cleanUsername(username), 'ig_fetch_stories', 'username')
    const id = await ig.userId(name)
    return { username: name, stories: (await userStories(ig, id)).map(normStory) }
  },
})

defineTool({
  name: 'ig_fetch_saved',
  description: 'Posts saved by this account, newest first.',
  params: [{ name: 'cursor', type: 'string', description: 'nextCursor from a previous call. Leave empty for the first page.' }],
  risk: 'read',
  handler: async ({ cursor }, ig) => {
    const j = await ig.get('/api/v1/feed/saved/posts/', { max_id: str(cursor) })
    return {
      posts: (j.items ?? []).map((x: any) => normPost(x.media ?? x)),
      nextCursor: j.more_available && j.next_max_id ? String(j.next_max_id) : null,
    }
  },
})

defineTool({
  name: 'location_search',
  description: 'Search Instagram places by name, for use as a post location or as a lead source (lead_from_location).',
  params: [{ name: 'query', type: 'string', description: 'Place name or address, for example "Shoreditch" or "5th Avenue New York".', required: true }],
  risk: 'read',
  handler: async ({ query }, ig) => {
    const q = need(query, 'location_search', 'query')
    return { query: q, places: await placeSearch(ig, q) }
  },
})
