import { defineTool, need, int, str, flag, cleanUsername } from './registry.js'
import type { IgSession } from '../ig/client.js'
import { cfg } from '../config.js'
import { dailyBump, dailyCount } from '../store.js'
import { sleep } from '../queue.js'
import { markContacted } from '../leads/db.js'

/**
 * DMs on Instagram web run through the "slide" GraphQL API. Three thread ids are in play:
 * - thread_key  : the id shown to the agent as `thread_id`, and the one the detail query expects.
 * - thread_id   : the long id (igid) the send-message mutation expects.
 * - thread_fbid : another internal id, used by the message request mutations.
 */

const iso = (ms: unknown): string | null => {
  const n = Number(ms)
  return Number.isFinite(n) && n > 0 ? new Date(n).toISOString() : null
}

const messageText = (m: any): string => m?.text_body ?? m?.content?.text_body ?? m?.igd_snippet ?? ''

/** Maps sender ids (interop fbid) to usernames, including the logged-in account. */
const senders = (t: any): Map<string, string> => {
  const map = new Map<string, string>()
  for (const u of t.users ?? []) if (u?.interop_messaging_user_fbid) map.set(String(u.interop_messaging_user_fbid), u.username)
  return map
}
const viewerFbid = (t: any): string => String(t.viewer?.interop_messaging_user_fbid ?? '')
const others = (t: any): any[] => (t.users ?? []).filter((u: any) => String(u.interop_messaging_user_fbid ?? '') !== viewerFbid(t))
const messages = (t: any): any[] => (t.slide_messages?.edges ?? []).map((e: any) => e.node).filter(Boolean)
const newestFirst = (t: any): any[] => [...messages(t)].sort((a, b) => Number(b.timestamp_ms) - Number(a.timestamp_ms))

const normMessage = (m: any, t: any) => {
  const mine = String(m.sender_fbid) === viewerFbid(t)
  return {
    id: String(m.id ?? ''),
    from: mine ? 'me' : 'them',
    sender: mine ? null : (senders(t).get(String(m.sender_fbid)) ?? null),
    type: String(m.content_type ?? 'TEXT').toLowerCase(),
    text: messageText(m),
    at: iso(m.timestamp_ms),
  }
}

const isUnread = (t: any): boolean => {
  if (t.marked_as_unread === true) return true
  const last = newestFirst(t)[0]
  if (!last || String(last.sender_fbid) === viewerFbid(t)) return false
  const mine = (t.slide_read_receipts ?? []).find((r: any) => String(r.participant_fbid) === viewerFbid(t))
  return mine ? Number(mine.watermark_timestamp_ms) < Number(last.timestamp_ms) : false
}

const normThread = (t: any) => {
  const last = newestFirst(t)[0]
  const lastMsg = last ? normMessage(last, t) : null
  const peerIds = new Set(others(t).map((u: any) => String(u.interop_messaging_user_fbid)))
  const seenByThem =
    lastMsg?.from === 'me' && last
      ? (t.slide_read_receipts ?? []).some((r: any) => peerIds.has(String(r.participant_fbid)) && Number(r.watermark_timestamp_ms) >= Number(last.timestamp_ms))
      : null
  const names = others(t).map((u: any) => u.username)
  return {
    thread_id: String(t.thread_key),
    title: t.thread_title || names.join(', '),
    is_group: t.is_group === true,
    participants: names,
    last_message: lastMsg,
    last_activity: iso(t.last_activity_timestamp_ms),
    unread: isUnread(t),
    awaiting_reply: lastMsg?.from === 'them',
    seen_by_them: seenByThem,
  }
}

/** First page of the inbox. */
export const inboxThreads = async (ig: IgSession): Promise<any[]> => {
  const j = await ig.gql('PolarisDirectInboxQuery', { device_id_for_iris_subscription: await ig.browser.irisDeviceId() })
  const box = j?.data?.get_slide_mailbox_for_iris_subscription
  return (box?.threads_by_folder?.edges ?? []).map((e: any) => e.node?.as_ig_direct_thread).filter(Boolean)
}

/** A single thread with its most recent messages. */
export const fetchThread = async (ig: IgSession, threadKey: string): Promise<any> => {
  const j = await ig.gql('IGDThreadDetailQuery', { min_uq_seq_id: null, thread_fbid: threadKey })
  const t = j?.data?.get_slide_thread_nullable?.as_ig_direct_thread
  if (!t) throw new Error(`Thread ${threadKey} not found`)
  return t
}

/** Client-side message id, built the same way as the web client: timestamp shifted left 22 bits plus a random number. */
const offlineThreadingId = (): string => ((BigInt(Date.now()) << 22n) + BigInt(Math.floor(Math.random() * 4194304))).toString()

/** Re-reads the thread to confirm the message actually appears. */
const confirmSent = async (ig: IgSession, threadKey: string, text: string, sentAt: number, messageId: string | null) => {
  for (let i = 0; i < 2; i++) {
    await sleep(1500 + i * 2500)
    try {
      const t = await fetchThread(ig, threadKey)
      const hit = messages(t).find(
        (m: any) => String(m.sender_fbid) === viewerFbid(t) && ((messageId && String(m.id) === messageId) || (messageText(m) === text && Number(m.timestamp_ms) >= sentAt - 60_000)),
      )
      if (hit) return { confirmed: true, message_id: String(hit.id) }
    } catch {
      if (i === 1) return { confirmed: false, verified: false, warning: 'Instagram accepted the message, but the thread could not be re-read. Ask the user to check the chat before sending again.' }
    }
  }
  return { confirmed: false, verified: true, warning: 'Instagram accepted the message, but it does not appear in the thread yet. Ask the user to check the chat before sending again.' }
}

defineTool({
  name: 'dm_list',
  description: 'Recent DM threads with their last message and whether they are waiting for our reply. Returns one inbox page.',
  params: [],
  risk: 'read',
  handler: async (_a, ig) => ({ threads: (await inboxThreads(ig)).map(normThread) }),
})

defineTool({
  name: 'dm_read',
  description: 'Reads the messages in one thread, oldest to newest. Returns up to the 20 most recent messages. `has_more` means older messages exist.',
  params: [
    { name: 'thread_id', type: 'string', description: 'Thread id from dm_list.', required: true },
    { name: 'limit', type: 'number', description: 'Number of recent messages, 1-20. Default 20.' },
  ],
  risk: 'read',
  handler: async ({ thread_id, limit }, ig) => {
    const id = need(thread_id, 'dm_read', 'thread_id')
    const t = await fetchThread(ig, id)
    const max = int(limit, 20, 1, 20)
    return {
      thread_id: String(t.thread_key ?? id),
      title: t.thread_title || others(t).map((u: any) => u.username).join(', '),
      is_group: t.is_group === true,
      participants: others(t).map((u: any) => u.username),
      messages: newestFirst(t).slice(0, max).map(m => normMessage(m, t)).reverse(),
      has_more: t.slide_messages?.page_info?.has_next_page === true || messages(t).length > max,
    }
  },
})

defineTool({
  name: 'dm_send',
  description:
    "Sends a text message by thread_id (from dm_list) or username. A username with no existing inbox thread starts a new conversation, which lands in the recipient's message requests; these sends have a daily limit. After sending, the thread is re-read: `confirmed: false` means the message is not visible yet, so ask the user to check before sending again.",
  params: [
    { name: 'thread_id', type: 'string', description: 'Thread id from dm_list. Provide this or `username`.' },
    { name: 'username', type: 'string', description: 'Recipient username. Provide this or `thread_id`.' },
    { name: 'text', type: 'string', description: 'Message text.', required: true },
    { name: 'force', type: 'boolean', description: 'True to start a new conversation even past the daily limit. Use only when the user asks for it: the more DMs sent to new people, the higher the risk of the account being restricted.' },
  ],
  risk: 'action',
  handler: async ({ thread_id, username, text, force }, ig) => {
    const body = need(text, 'dm_send', 'text')
    const key = str(thread_id)
    const name = cleanUsername(username)
    if (!key && !name) throw new Error('dm_send requires `thread_id` or `username`')

    let thread: any | null = null
    if (key) thread = await fetchThread(ig, key)
    else {
      const list = await inboxThreads(ig)
      thread = list.find(t => !t.is_group && others(t).some((u: any) => String(u.username).toLowerCase() === name!.toLowerCase())) ?? null
    }

    const variables: Record<string, unknown> = {
      commands: null,
      forwarded_from_thread_id: null,
      ig_thread_igid: null,
      is_forwarded_from_own_message: null,
      mentioned_user_ids: [],
      mentions: [],
      offline_threading_id: offlineThreadingId(),
      recipient_igids: null,
      replied_to_client_context: null,
      replied_to_item_id: null,
      reply_to_message_id: null,
      sampled: null,
      send_attribution: null,
      text: { sensitive_string_value: body },
    }
    const newConversation = !thread
    if (thread) variables.ig_thread_igid = String(thread.thread_id)
    else {
      const used = dailyCount('coldDm')
      if (used >= cfg.dailyLimits.coldDm && !flag(force)) {
        return { done: false, dailyLimitReached: true, used, max: cfg.dailyLimits.coldDm, message: `Today's limit for DMs to new people (${cfg.dailyLimits.coldDm}) has been reached. Continue tomorrow, or use force if the user asks for it.` }
      }
      variables.recipient_igids = [await ig.userId(name!)]
    }

    const sentAt = Date.now()
    const j = await ig.gql('IGDirectTextSendMutation', variables)
    const res = j?.data?.xig_direct_text_send_with_slide_messaging_response
    if (!res?.message_id) return { done: false, message: j?.errors?.[0]?.message ?? 'Instagram did not confirm this message' }
    if (newConversation) dailyBump('coldDm')
    const to = thread ? others(thread).map((u: any) => u.username) : [name!]
    for (const u of to) markContacted(u)
    const threadKey = thread ? String(thread.thread_key) : null
    const check = threadKey
      ? await confirmSent(ig, threadKey, body, sentAt, String(res.message_id))
      : { confirmed: false, verified: false, warning: 'New conversation: Instagram accepted the message. Check dm_list to confirm.' }
    return { done: true, thread_id: threadKey, to, text: body, new_conversation: newConversation, message_id: String(res.message_id), ...check }
  },
})

defineTool({
  name: 'dm_requests',
  description: 'Pending message requests (DMs from people the account is not connected with). These often contain inquiries from potential customers.',
  params: [],
  risk: 'read',
  handler: async (_a, ig) => {
    const j = await ig.gql('PolarisDirectMessageRequestQuery', {
      device_id_for_iris_subscription: await ig.browser.irisDeviceId(),
      __relay_internal__pv__IGD30DayAgoTimestampMsrelayprovider: String(Date.now() - 30 * 86_400_000),
    })
    const edges = j?.data?.get_slide_mailbox_for_iris_subscription?.threads_by_folder?.edges ?? []
    const threads = edges.map((e: any) => e.node?.as_ig_direct_thread ?? e.node).filter((t: any) => t?.thread_key)
    return { requests: threads.map(normThread) }
  },
})

defineTool({
  name: 'dm_mark_seen',
  description: 'Marks a DM thread as read up to its latest incoming message.',
  params: [{ name: 'thread_id', type: 'string', description: 'Thread id from dm_list.', required: true }],
  risk: 'write',
  handler: async ({ thread_id }, ig) => {
    const id = need(thread_id, 'dm_mark_seen', 'thread_id')
    const t = await fetchThread(ig, id)
    const wasUnread = isUnread(t)
    const incoming = newestFirst(t).find(m => String(m.sender_fbid) !== viewerFbid(t))
    if (!incoming?.id) return { done: true, thread_id: id, marked: false, was_unread: wasUnread, message: 'No incoming message to mark' }
    const j = await ig.gql('useIGDMarkThreadAsReadMutation', { data: { item_id: '', message_id: String(incoming.id) }, metadata: { ig_thread_igid: String(t.thread_id) } })
    const res = j?.data?.xig_direct_item_seen_mutation_with_slide_messaging_response
    return { done: !!res && !j?.errors?.length, thread_id: id, marked: !!res, was_unread: wasUnread }
  },
})

export { normThread, normMessage, messages, newestFirst, others, viewerFbid, isUnread }
