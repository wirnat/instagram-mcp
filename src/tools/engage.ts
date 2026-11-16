import { randomUUID } from 'node:crypto'
import { defineTool, need, int, str, flag, cleanUsername } from './registry.js'
import { normComment, normPost, normUserLite, parsePostRef } from '../ig/normalize.js'
import { cfg } from '../config.js'
import { dailyBump, dailyCount } from '../store.js'
import { viewerInfo } from './read.js'
import { postByShortcode, userPostsPage } from '../ig/feeds.js'
import type { IgSession } from '../ig/client.js'

type LimitKind = keyof typeof cfg.dailyLimits

/** Refuses the action once the daily limit is reached, unless `force` is set. */
const overLimit = (kind: LimitKind, force: boolean) => {
  const used = dailyCount(kind)
  const max = cfg.dailyLimits[kind]
  if (used < max || force) return null
  return { done: false, dailyLimitReached: true, kind, used, max, message: `Daily ${kind} limit (${max}) reached. Continue tomorrow, or use force if the user asks for it.` }
}

const ok = (j: any): boolean => j?.status === 'ok' || j?.status === 'Success' || j?.success === true

// MARK: Comments

defineTool({
  name: 'comments_list',
  description: "A post's comments, or the replies to one comment.",
  params: [
    { name: 'post', type: 'string', description: 'Post: media id, shortcode, or URL.', required: true },
    { name: 'cursor', type: 'string', description: 'nextCursor from a previous call. Leave empty for the first page.' },
    { name: 'replies', type: 'string', description: "Comment id: return that comment's replies instead of the post's top-level comments." },
  ],
  risk: 'read',
  handler: async ({ post, cursor, replies }, ig) => {
    const { pk, shortcode } = parsePostRef(need(post, 'comments_list', 'post'))
    const parent = str(replies)
    if (parent) {
      const j = await ig.get(`/api/v1/media/${pk}/comments/${parent}/child_comments/`, { max_id: str(cursor) })
      return {
        postId: pk,
        parentId: parent,
        comments: (j.child_comments ?? []).map(normComment),
        nextCursor: j.has_more_tail_child_comments || j.has_more_head_child_comments ? (j.next_max_child_cursor ?? j.next_min_child_cursor ?? null) : null,
      }
    }
    const j = await ig.get(`/api/v1/media/${pk}/comments/`, { can_support_threading: 'true', permalink_enabled: 'false', min_id: str(cursor) })
    return {
      postId: pk,
      shortcode,
      total: j.comment_count ?? null,
      comments: (j.comments ?? []).map(normComment),
      nextCursor: j.has_more_headload_comments || j.has_more_comments ? (j.next_min_id ?? j.next_max_id ?? null) : null,
    }
  },
})

/** Creates a comment or reply through the same mutation Instagram web uses. */
const createComment = async (ig: IgSession, pk: string, text: string, replyTo?: string) => {
  const j = await ig.gql('usePolarisCommentCreateMutation', {
    data: { comment_text: text, media_id: pk, ...(replyTo && { replied_to_comment_fbid: replyTo }) },
    root_connections: [],
  })
  const c = j?.data?.xig_comment_create?.comment
  return { done: !!c?.pk, commentId: c?.pk ? String(c.pk) : null, text: c?.text ?? text, ...(!c?.pk && { message: j?.errors?.[0]?.message ?? 'Instagram did not create this comment' }) }
}

defineTool({
  name: 'comment_add',
  description: 'Posts a comment on a post. Returns `done: false` when a limit is hit.',
  params: [
    { name: 'post', type: 'string', description: 'Post: media id, shortcode, or URL.', required: true },
    { name: 'text', type: 'string', description: 'Comment text.', required: true },
    { name: 'force', type: 'boolean', description: 'True to bypass the daily limit. Use only when the user asks for it.' },
  ],
  risk: 'action',
  handler: async ({ post, text, force }, ig) => {
    const { pk } = parsePostRef(need(post, 'comment_add', 'post'))
    const t = need(text, 'comment_add', 'text')
    const blocked = overLimit('comment', flag(force))
    if (blocked) return blocked
    const r = await createComment(ig, pk, t)
    if (r.done) dailyBump('comment')
    return { postId: pk, ...r }
  },
})

defineTool({
  name: 'comment_reply',
  description: 'Replies to a comment. Start the text with @username so the comment author gets notified.',
  params: [
    { name: 'post', type: 'string', description: 'The post the comment belongs to: media id, shortcode, or URL.', required: true },
    { name: 'commentId', type: 'string', description: 'Id of the comment to reply to (from comments_list).', required: true },
    { name: 'text', type: 'string', description: 'Reply text.', required: true },
    { name: 'force', type: 'boolean', description: 'True to bypass the daily limit. Use only when the user asks for it.' },
  ],
  risk: 'action',
  handler: async ({ post, commentId, text, force }, ig) => {
    const { pk } = parsePostRef(need(post, 'comment_reply', 'post'))
    const parent = need(commentId, 'comment_reply', 'commentId')
    const t = need(text, 'comment_reply', 'text')
    const blocked = overLimit('comment', flag(force))
    if (blocked) return blocked
    const r = await createComment(ig, pk, t, parent)
    if (r.done) dailyBump('comment')
    return { postId: pk, parentId: parent, ...r }
  },
})

defineTool({
  name: 'comment_like',
  description: 'Likes a comment, or removes the like with `unlike: true`.',
  params: [
    { name: 'post', type: 'string', description: 'The post the comment belongs to: media id, shortcode, or URL.', required: true },
    { name: 'commentId', type: 'string', description: 'Comment id (from comments_list).', required: true },
    { name: 'unlike', type: 'boolean', description: 'True to remove the like. Default false.' },
  ],
  risk: 'action',
  handler: async ({ post, commentId, unlike }, ig) => {
    const { pk } = parsePostRef(need(post, 'comment_like', 'post'))
    const id = need(commentId, 'comment_like', 'commentId')
    const undo = flag(unlike)
    const j = await ig.gql(undo ? 'PolarisCommentActionsUnlikeMutation' : 'PolarisCommentActionsLikeMutation', { input: { comment_id: id, media_id: pk } })
    return { done: !j?.errors?.length, postId: pk, commentId: id, liked: !undo }
  },
})

defineTool({
  name: 'comment_delete',
  description: "Deletes a comment: one of your own, or anyone's comment on your own post. Permanent.",
  params: [
    { name: 'post', type: 'string', description: 'The post the comment belongs to: media id, shortcode, or URL.', required: true },
    { name: 'commentId', type: 'string', description: 'Id of the comment to delete (from comments_list).', required: true },
  ],
  risk: 'action',
  handler: async ({ post, commentId }, ig) => {
    const { pk } = parsePostRef(need(post, 'comment_delete', 'post'))
    const id = need(commentId, 'comment_delete', 'commentId')
    const j = await ig.gql('PolarisCommentActionsDeleteMutation', { input: { comment_id: id, media_id: pk } })
    return { done: !j?.errors?.length, postId: pk, commentId: id }
  },
})

// MARK: Like, follow, block

defineTool({
  name: 'ig_action',
  description: 'Like, unlike, follow, or unfollow. One target per call. Returns `done: false` when a limit is hit.',
  params: [
    { name: 'type', type: 'string', description: 'One of: "like", "unlike", "follow", "unfollow".', required: true },
    { name: 'username', type: 'string', description: "Target account, without @. Required for follow and unfollow. For a like without a post, the account's latest post is liked." },
    { name: 'post', type: 'string', description: 'Post to like or unlike: media id, shortcode, or URL.' },
    { name: 'force', type: 'boolean', description: 'True to bypass the daily limit. Use only when the user asks for it.' },
  ],
  risk: 'action',
  handler: async ({ type, username, post, postId, shortcode, force }, ig) => {
    const kind = need(type, 'ig_action', 'type').toLowerCase()
    const name = cleanUsername(username)
    const postRef = str(post) ?? str(postId) ?? str(shortcode)
    if (kind === 'like' || kind === 'unlike') {
      let media: any
      if (postRef) media = await postByShortcode(ig, parsePostRef(postRef).shortcode)
      else {
        if (kind === 'unlike') throw new Error('ig_action unlike requires `post`')
        const feed = await userPostsPage(ig, need(name, 'ig_action', 'username or post'))
        media = feed.items.find((m: any) => !m.has_liked)
      }
      if (!media) return { done: false, message: postRef ? 'Post not found' : `@${name} has no post that can be liked` }
      const pk = String(media.pk)
      const token = media.organic_tracking_token ?? ''
      if (kind === 'like') {
        const blocked = overLimit('like', flag(force))
        if (blocked) return blocked
      }
      const j =
        kind === 'like'
          ? await ig.gql('usePolarisLikeMediaXIGLikeMutation', { input: { container_module: 'single_post', media_id: pk, tracking_token: token } })
          : await ig.gql('usePolarisLikeMediaXIGUnlikeMutation', { input: { media_id: pk, tracking_token: token } })
      const res = j?.data?.xig_media_like ?? j?.data?.xig_media_unlike
      if (kind === 'like' && res) dailyBump('like')
      return { done: !!res && !j?.errors?.length, type: kind, postId: pk, url: `https://www.instagram.com/p/${media.code}/`, liked: res?.media?.has_liked ?? kind === 'like' }
    }
    if (kind === 'follow' || kind === 'unfollow') {
      const id = await ig.userId(need(name, 'ig_action', 'username'))
      if (kind === 'follow') {
        const blocked = overLimit('follow', flag(force))
        if (blocked) return blocked
      }
      const j = await ig.gql(kind === 'follow' ? 'usePolarisFollowUserFollowMutation' : 'usePolarisFollowUserUnfollowMutation', { target_user_id: id })
      const res = j?.data?.xdt_create_friendship ?? j?.data?.xdt_destroy_friendship
      if (kind === 'follow' && res) dailyBump('follow')
      const fs = res?.friendship_status ?? {}
      return { done: !!res && !j?.errors?.length, type: kind, username: name, userId: id, following: fs.following === true, requested: fs.outgoing_request === true }
    }
    throw new Error('ig_action: type must be like, unlike, follow, or unfollow')
  },
})

defineTool({
  name: 'ig_block',
  description: 'Blocks an account. Unblocking is not supported here yet; do it in the Instagram app (Settings > Blocked accounts).',
  params: [{ name: 'user', type: 'string', description: 'Account: username, profile URL, or id.', required: true }],
  risk: 'action',
  handler: async ({ user, unblock }, ig) => {
    if (flag(unblock)) return { done: false, unsupported: true, message: 'Unblocking is not supported yet. Unblock in the Instagram app: Settings > Blocked accounts.' }
    const id = await ig.userId(need(user, 'ig_block', 'user'))
    const j = await ig.post(`/api/v1/web/friendships/${id}/block/`)
    return { done: ok(j), userId: id, blocked: true }
  },
})

defineTool({
  name: 'follower_remove',
  description: 'Removes an account from your followers without blocking it. The account is not notified and can follow again.',
  params: [{ name: 'user', type: 'string', description: 'Account: username, profile URL, or id.', required: true }],
  risk: 'action',
  handler: async ({ user }, ig) => {
    const id = await ig.userId(need(user, 'follower_remove', 'user'))
    const j = await ig.post(`/api/v1/web/friendships/${id}/remove_follower/`)
    return { done: ok(j), userId: id }
  },
})

// MARK: Notifications and lists

// Matches both English and Indonesian notification text, since the web UI language follows the account settings.
const NOTIF_KIND = (s: any): string => {
  const t = `${s.notif_name ?? ''} ${s.args?.rich_text ?? s.args?.text ?? ''}`.toLowerCase()
  if (/comment|berkomentar|membalas/.test(t)) return 'comments'
  if (/like|menyukai/.test(t)) return 'likes'
  if (/follow|mengikuti/.test(t)) return 'follows'
  if (/mention|tag|menyebut|menandai/.test(t)) return 'mentions'
  return 'other'
}

export const normNotification = (s: any) => ({
  kind: NOTIF_KIND(s),
  text: String(s.args?.text ?? s.args?.rich_text ?? '').replace(/\{([^|}]+)\|[^}]*\}/g, '$1'),
  username: s.args?.profile_name ?? null,
  userId: s.args?.profile_id ? String(s.args.profile_id) : null,
  postId: s.args?.media?.[0]?.id ? String(s.args.media[0].id).split('_')[0] : null,
  at: s.args?.timestamp ? new Date(Number(s.args.timestamp) * 1000).toISOString() : null,
})

defineTool({
  name: 'notifications_list',
  description: 'Recent notifications: comments, likes, follows, and mentions.',
  params: [
    { name: 'type', type: 'string', description: 'Filter: all (default), comments, likes, follows, or mentions.' },
    { name: 'limit', type: 'number', description: 'Maximum number of items, 1-200. Default 50. Newest first.' },
  ],
  risk: 'read',
  handler: async ({ type, limit }, ig) => {
    const want = str(type) ?? 'all'
    const j = await ig.get('/api/v1/news/inbox/')
    const all = [...(j.new_stories ?? []), ...(j.old_stories ?? [])].map(normNotification)
    return { notifications: all.filter(n => want === 'all' || n.kind === want).slice(0, int(limit, 50, 1, 200)) }
  },
})

defineTool({
  name: 'follow_requests_list',
  description: 'Follow requests waiting for approval (private accounts).',
  params: [{ name: 'cursor', type: 'string', description: 'nextCursor from a previous call.' }],
  risk: 'read',
  handler: async ({ cursor }, ig) => {
    const j = await ig.get('/api/v1/friendships/pending/', { max_id: str(cursor) })
    return { requests: (j.users ?? []).map(normUserLite), nextCursor: j.next_max_id ? String(j.next_max_id) : null }
  },
})

defineTool({
  name: 'story_viewers',
  description: "Who viewed one of this account's active stories.",
  params: [
    { name: 'storyId', type: 'string', description: 'Story id from ig_fetch_stories. Must be an active story of your own.', required: true },
    { name: 'cursor', type: 'string', description: 'nextCursor from a previous call.' },
  ],
  risk: 'read',
  handler: async ({ storyId, cursor }, ig) => {
    const id = need(storyId, 'story_viewers', 'storyId')
    const j = await ig.get(`/api/v1/media/${id}/list_reel_media_viewer/`, { max_id: str(cursor) })
    return {
      storyId: id,
      total: j.total_viewer_count ?? j.user_count ?? null,
      viewers: (j.users ?? []).map(normUserLite),
      nextCursor: j.next_max_id ? String(j.next_max_id) : null,
    }
  },
})

// MARK: Own posts and profile

defineTool({
  name: 'ig_post_edit',
  description: 'Edits the caption of a published post. Your own posts only.',
  params: [
    { name: 'post', type: 'string', description: 'Post: media id, shortcode, or URL.', required: true },
    { name: 'caption', type: 'string', description: 'New caption. An empty string removes the caption.', required: true },
  ],
  risk: 'write',
  handler: async ({ post, caption }, ig) => {
    const { pk } = parsePostRef(need(post, 'ig_post_edit', 'post'))
    if (caption == null) throw new Error('ig_post_edit requires `caption`')
    const j = await ig.post(`/api/v1/media/${pk}/edit_media/`, { caption_text: String(caption) })
    return { done: ok(j), postId: pk, caption: j.media?.caption?.text ?? String(caption) }
  },
})

defineTool({
  name: 'ig_post_delete',
  description: 'Permanently deletes a published post. Your own posts only. This cannot be undone.',
  params: [{ name: 'post', type: 'string', description: 'Post: media id, shortcode, or URL.', required: true }],
  risk: 'write',
  handler: async ({ post }, ig) => {
    const { pk } = parsePostRef(need(post, 'ig_post_delete', 'post'))
    const j = await ig.post(`/api/v1/web/create/${pk}/delete/`)
    return { postId: pk, deleted: j.did_delete === true || ok(j) }
  },
})

defineTool({
  name: 'profile_update',
  description: "Updates the logged-in account's bio (the text under the name on the profile). Bio links cannot be changed here.",
  params: [{ name: 'bio', type: 'string', description: 'New bio. An empty string removes the bio.', required: true }],
  risk: 'write',
  handler: async ({ bio }, ig) => {
    if (bio == null) throw new Error('profile_update requires `bio`')
    const cur = (await ig.get('/api/v1/accounts/edit/web_form_data/')).form_data ?? {}
    const j = await ig.post('/api/v1/web/accounts/edit/', {
      biography: String(bio),
      chaining_enabled: cur.chaining_enabled === false ? '' : 'on',
      email: cur.email ?? '',
      external_url: cur.external_url ?? '',
      first_name: cur.first_name ?? '',
      phone_number: cur.phone_number ?? '',
      username: cur.username ?? '',
    })
    return { done: ok(j), bio: String(bio) }
  },
})

defineTool({
  name: 'note_set',
  description: "Sets the account's Note (up to 60 characters, shown above the avatar in the DM inbox, expires after 24 hours). Empty text removes the Note.",
  params: [{ name: 'text', type: 'string', description: 'Note text, up to 60 characters. Leave empty to remove it.' }],
  risk: 'write',
  handler: async ({ text }, ig) => {
    const t = str(text)
    if (t && t.length > 60) throw new Error('note_set: text must be 60 characters or fewer')
    if (t) {
      const j = await ig.post('/api/v1/notes/create_note/', { text: t, uuid: randomUUID(), audience: 0, note_style: 0 })
      return { done: ok(j), text: t, noteId: j.id ? String(j.id) : null }
    }
    const me = await viewerInfo(ig)
    const notes = (await ig.get('/api/v1/notes/get_notes/')).items ?? []
    const mine = notes.find((n: any) => String(n.user_id ?? n.user?.pk ?? '') === me.id)
    if (!mine) return { done: true, cleared: false, message: 'No active Note' }
    const j = await ig.post('/api/v1/notes/delete_note/', { id: mine.id })
    return { done: ok(j), cleared: true }
  },
})

defineTool({
  name: 'ig_fetch_tagged',
  description: "Posts by other people that tag an account. Useful for seeing a business's customers.",
  params: [
    { name: 'username', type: 'string', description: 'Account username, without @.', required: true },
    { name: 'cursor', type: 'string', description: 'nextCursor from a previous call.' },
  ],
  risk: 'read',
  handler: async ({ username, cursor }, ig) => {
    const name = need(cleanUsername(username), 'ig_fetch_tagged', 'username')
    const id = await ig.userId(name)
    const j = await ig.gql('PolarisProfileTaggedTabContentQuery', { count: 12, user_id: id, ...(str(cursor) && { after: str(cursor) }) })
    const c = j?.data?.xdt_api__v1__usertags__user_id__feed_connection ?? {}
    const items = (c.edges ?? []).map((e: any) => e.node).filter(Boolean)
    return { username: name, posts: items.map((m: any) => normPost(m)), nextCursor: c.page_info?.has_next_page ? (c.page_info.end_cursor ?? null) : null }
  },
})
