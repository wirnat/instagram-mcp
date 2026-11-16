import { randomUUID } from 'node:crypto'
import type { IgSession } from './client.js'

/** Queries the Instagram web app uses to read data. Names and variable shapes match the web app. */

const POSTS_DATA = {
  count: 12,
  include_reel_media_seen_timestamp: true,
  include_relationship_info: true,
  latest_besties_reel_media: true,
  latest_reel_media: true,
}

/** One page of an account's posts (12 posts), newest first. */
export const userPostsPage = async (ig: IgSession, username: string, cursor?: string | null): Promise<{ items: any[]; next: string | null }> => {
  const j = cursor
    ? await ig.gql('PolarisProfilePostsTabContentQuery_connection', { after: cursor, before: null, data: POSTS_DATA, first: 12, last: null, username })
    : await ig.gql('PolarisProfilePostsQuery', { data: POSTS_DATA, username })
  const c = j?.data?.xdt_api__v1__feed__user_timeline_graphql_connection ?? {}
  const items = (c.edges ?? []).map((e: any) => e.node).filter(Boolean)
  return { items, next: c.page_info?.has_next_page && c.page_info?.end_cursor ? String(c.page_info.end_cursor) : null }
}

/** An account's posts up to `max`, page by page through the paced queue. */
export const userPosts = async (
  ig: IgSession,
  username: string,
  max: number,
  opts: { cursor?: string | null; onPage?: (count: number) => boolean | void } = {},
): Promise<{ items: any[]; next: string | null }> => {
  const items: any[] = []
  let next = opts.cursor ?? null
  for (let page = 0; items.length < max; page++) {
    if (page > 0) await ig.pagePause()
    const r = await userPostsPage(ig, username, next)
    items.push(...r.items)
    next = r.next
    if (opts.onPage?.(items.length) === false || !next || !r.items.length) break
  }
  return { items: items.slice(0, max), next }
}

export const postByShortcode = async (ig: IgSession, shortcode: string): Promise<any | null> => {
  const j = await ig.gql('PolarisPostRootQuery', { shortcode, include_longform_landscape_cover: false })
  return j?.data?.xdt_api__v1__media__shortcode__web_info?.items?.[0] ?? null
}

export type SearchContext = 'blended' | 'user' | 'hashtag' | 'place'

/** The web search box: accounts, hashtags, and places. The web app only returns the top few results. */
export const topSearch = async (ig: IgSession, query: string, context: SearchContext = 'blended') => {
  const j = await ig.gql('PolarisSearchBoxRefetchableQuery', {
    data: { context, include_reel: 'true', query, rank_token: '', search_session_id: randomUUID(), search_surface: 'web_top_search' },
    hasQuery: true,
  })
  const c = j?.data?.xdt_api__v1__fbsearch__topsearch_connection ?? {}
  return {
    users: (c.users ?? []).map((x: any) => x.user ?? x).filter((u: any) => u?.username),
    hashtags: (c.hashtags ?? []).map((x: any) => x.hashtag ?? x).filter((h: any) => h?.name),
    places: (c.places ?? []).map((x: any) => x.place ?? x),
  }
}

const walkMedia = (o: any, out: any[]): void => {
  if (Array.isArray(o)) for (const v of o) walkMedia(v, out)
  else if (o && typeof o === 'object') {
    if (o.code && o.user && typeof o.user === 'object') out.push(o)
    else for (const v of Object.values(o)) walkMedia(v, out)
  }
}

/**
 * Keyword search results page, which the web app also uses for hashtags (#name).
 * Returns posts with their owners, which is useful for finding accounts active on a topic.
 */
export const keywordPosts = async (ig: IgSession, query: string): Promise<{ medias: any[]; next: string | null }> => {
  const session = randomUUID()
  const j = await ig.gql('PolarisKeywordSearchExplorePageRelayQuery', { query, search_session_id: session, serp_session_id: session })
  const c = j?.data?.xdt_fbsearch__top_serp_graphql ?? {}
  const medias: any[] = []
  walkMedia(c.edges ?? [], medias)
  return { medias, next: c.page_info?.has_next_page ? (c.page_info.end_cursor ?? null) : null }
}

/** Active stories of one account. */
export const userStories = async (ig: IgSession, userId: string): Promise<any[]> => {
  const j = await ig.gql('PolarisStoriesV3ReelPageStandaloneQuery', { reel_ids_arr: [userId], is_highlight: false, media_id: '' })
  const reels = j?.data?.xdt_api__v1__feed__reels_media?.reels_media ?? j?.data?.xdt_api__v1__feed__reels_media__connection?.edges?.map((e: any) => e.node) ?? []
  return reels.find((r: any) => String(r.id ?? r.user?.pk) === userId)?.items ?? reels[0]?.items ?? []
}

/** Place search for post locations. */
export const placeSearch = async (ig: IgSession, query: string) => {
  const j = await ig.gql('PolarisAPILocationSearchQuery', { request: { latitude: null, longitude: null, search_query: query } })
  return (j?.data?.ig_place_search?.meta_places ?? [])
    .filter((p: any) => p?.best_page_fbid && p.name && p.latitude != null && p.longitude != null)
    .map((p: any) => ({ id: String(p.best_page_fbid), name: p.name, lat: p.latitude, lng: p.longitude }))
}

/** Posts tagged with a place. */
export const locationPosts = async (ig: IgSession, locationId: string, tab: 'ranked' | 'recent' = 'ranked', cursor?: string | null) => {
  const j = await ig.gql('PolarisLocationPageTabContentQuery', { after: cursor ?? null, first: 12, location_id: locationId, page_size_override: 6, tab })
  const medias: any[] = []
  walkMedia(j?.data ?? {}, medias)
  const info = JSON.stringify(j?.data ?? {}).match(/"end_cursor":"([^"]+)"/)
  return { medias, next: info ? info[1] : null }
}
