/** Data shapes returned by tools, normalized from raw Instagram responses. */

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_'

export const shortcodeToPk = (code: string): string => {
  let n = 0n
  for (const ch of code.slice(0, 11)) {
    const i = ALPHABET.indexOf(ch)
    if (i < 0) throw new Error(`Invalid shortcode: ${code}`)
    n = n * 64n + BigInt(i)
  }
  return n.toString()
}

export const pkToShortcode = (pk: string): string => {
  let n = BigInt(pk.split('_')[0])
  let out = ''
  while (n > 0n) {
    out = ALPHABET[Number(n % 64n)] + out
    n /= 64n
  }
  return out
}

/** Accepts a media id, shortcode, or post URL and returns both id and shortcode. */
export const parsePostRef = (ref: string): { pk: string; shortcode: string } => {
  const s = String(ref ?? '').trim()
  if (!s) throw new Error('A post is required: media id, shortcode, or URL')
  const m = s.match(/instagram\.com\/(?:[^/]+\/)?(?:p|reel|reels|tv)\/([A-Za-z0-9_-]+)/)
  if (m) return { pk: shortcodeToPk(m[1]), shortcode: m[1] }
  if (/^\d+(_\d+)?$/.test(s)) {
    const pk = s.split('_')[0]
    return { pk, shortcode: pkToShortcode(pk) }
  }
  if (/^[A-Za-z0-9_-]{5,}$/.test(s)) return { pk: shortcodeToPk(s), shortcode: s }
  throw new Error(`Unrecognized post: ${s}`)
}

/** Accepts a username, profile URL, or numeric id. */
export const parseUserRef = (ref: string): { username?: string; id?: string } => {
  const s = String(ref ?? '').trim().replace(/^@/, '')
  if (!s) throw new Error('An account is required: username, profile URL, or id')
  const m = s.match(/instagram\.com\/([A-Za-z0-9._]+)/)
  if (m) return { username: m[1] }
  if (/^\d+$/.test(s)) return { id: s }
  return { username: s }
}

const iso = (sec: unknown): string | null => {
  const n = Number(sec)
  return Number.isFinite(n) && n > 0 ? new Date(n * 1000).toISOString() : null
}

const MEDIA_TYPE: Record<number, string> = { 1: 'image', 2: 'video', 8: 'carousel' }

const bestImage = (m: any): string | null => m?.image_versions2?.candidates?.[0]?.url ?? m?.display_url ?? null
const bestVideo = (m: any): string | null => m?.video_versions?.[0]?.url ?? m?.video_url ?? null

/** Media item from API v1 (feed, info, saved, hashtag). */
export const normPost = (m: any, opts: { full?: boolean } = {}) => {
  const code = m.code ?? m.shortcode
  const type = m.product_type === 'clips' ? 'reel' : (MEDIA_TYPE[m.media_type] ?? 'image')
  const out: Record<string, unknown> = {
    id: String(m.pk ?? m.id ?? '').split('_')[0],
    shortcode: code,
    url: `https://www.instagram.com/${type === 'reel' ? 'reel' : 'p'}/${code}/`,
    type,
    caption: m.caption?.text ?? '',
    likes: m.like_count ?? null,
    comments: m.comment_count ?? null,
    views: m.play_count ?? m.ig_play_count ?? m.view_count ?? null,
    takenAt: iso(m.taken_at),
    ownerUsername: m.user?.username ?? m.owner?.username ?? null,
    slideCount: m.carousel_media_count ?? m.carousel_media?.length ?? 1,
    commentsDisabled: m.comments_disabled === true,
    liked: m.has_liked === true,
  }
  if (opts.full) {
    out.location = m.location ? { id: String(m.location.pk ?? ''), name: m.location.name ?? null } : null
    out.media = (m.carousel_media ?? [m]).map((x: any) => ({
      type: MEDIA_TYPE[x.media_type] ?? 'image',
      imageUrl: bestImage(x),
      videoUrl: bestVideo(x),
      width: x.original_width ?? null,
      height: x.original_height ?? null,
    }))
    out.owner = m.user ? { id: String(m.user.pk ?? m.user.id ?? ''), username: m.user.username, fullName: m.user.full_name ?? '' } : null
    out.musicTitle = m.clips_metadata?.music_info?.music_asset_info?.title ?? m.clips_metadata?.original_sound_info?.original_audio_title ?? null
  } else {
    out.thumbnailUrl = bestImage(m.carousel_media?.[0] ?? m)
  }
  return out
}

/** Profile from /users/web_profile_info/. */
export const normProfile = (u: any) => ({
  found: true,
  id: String(u.id ?? u.pk ?? ''),
  username: u.username,
  fullName: u.full_name ?? '',
  url: `https://www.instagram.com/${u.username}/`,
  bio: u.biography ?? '',
  externalUrl: u.external_url || u.bio_links?.[0]?.url || null,
  links: (u.bio_links ?? []).map((l: any) => ({ title: l.title ?? '', url: l.url })),
  category: u.category_name ?? u.category ?? '',
  followerCount: u.edge_followed_by?.count ?? u.follower_count ?? null,
  followingCount: u.edge_follow?.count ?? u.following_count ?? null,
  postCount: u.edge_owner_to_timeline_media?.count ?? u.media_count ?? null,
  isPrivate: u.is_private === true,
  isVerified: u.is_verified === true,
  isBusiness: u.is_business_account === true || u.is_business === true,
  isProfessional: u.is_professional_account === true || u.is_business === true || u.account_type === 2 || u.account_type === 3,
  address: u.address_street || null,
  city: u.city_name || null,
  businessEmail: u.business_email ?? u.public_email ?? null,
  businessPhone: u.business_phone_number ?? u.public_phone_number ?? null,
  avatarUrl: u.profile_pic_url_hd ?? u.profile_pic_url ?? null,
  viewer: {
    isFollowing: u.followed_by_viewer === true || u.friendship_status?.following === true,
    isFollower: u.follows_viewer === true || u.friendship_status?.followed_by === true,
    isBlocking: u.blocked_by_viewer === true || u.friendship_status?.blocking === true,
    isOutgoingRequest: u.requested_by_viewer === true || u.friendship_status?.outgoing_request === true,
  },
})

/** Compact account from lists (search, followers, likers). */
export const normUserLite = (u: any) => ({
  id: String(u.pk ?? u.id ?? ''),
  username: u.username,
  fullName: u.full_name ?? '',
  url: `https://www.instagram.com/${u.username}/`,
  isVerified: u.is_verified === true,
  isPrivate: u.is_private === true,
  avatarUrl: u.profile_pic_url ?? null,
})

export const normStory = (m: any) => ({
  id: String(m.pk ?? m.id ?? '').split('_')[0],
  type: MEDIA_TYPE[m.media_type] ?? 'image',
  takenAt: iso(m.taken_at),
  expiresAt: iso(m.expiring_at),
  imageUrl: bestImage(m),
  videoUrl: bestVideo(m),
  viewerCount: m.total_viewer_count ?? m.viewer_count ?? null,
})

export const normComment = (c: any) => ({
  id: String(c.pk ?? c.id ?? ''),
  text: c.text ?? '',
  username: c.user?.username ?? null,
  userId: String(c.user?.pk ?? c.user_id ?? ''),
  at: iso(c.created_at ?? c.created_at_utc),
  likes: c.comment_like_count ?? 0,
  replyCount: c.child_comment_count ?? 0,
  liked: c.has_liked_comment === true,
  parentId: c.parent_comment_id ? String(c.parent_comment_id) : null,
})
