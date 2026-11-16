import fs from 'node:fs'
import path from 'node:path'
import { DOWNLOAD_DIR } from '../config.js'
import { Store } from '../store.js'
import type { Booking, Priority } from './score.js'

export type LeadStatus = 'new' | 'contacted' | 'replied' | 'qualified' | 'rejected'
export const LEAD_STATUSES: LeadStatus[] = ['new', 'contacted', 'replied', 'qualified', 'rejected']

export type Lead = {
  username: string
  id?: string
  name?: string
  url: string
  type?: string | null
  city?: string | null
  followers?: number | null
  posts?: number | null
  bio?: string
  link?: string | null
  whatsapp?: string[]
  emails?: string[]
  booking?: Booking
  bookingApps?: string[]
  multiBranch?: boolean
  score?: number
  priority?: Priority
  reasons?: string[]
  status: LeadStatus
  notes?: string
  tags?: string[]
  sources: string[]
  /** true once the profile has been fetched and scored. false means a raw candidate from a search. */
  scored: boolean
  activity?: { lastPostAt: string | null; postsLast30Days: number; avgLikes: number; avgComments: number }
  firstSeenAt: string
  updatedAt: string
  lastContactedAt?: string
}

// MARK: Migration from the older Indonesian field names

const KEY_MAP: Record<string, string> = {
  nama: 'name',
  jenis: 'type',
  kota: 'city',
  wa: 'whatsapp',
  email: 'emails',
  cabang: 'multiBranch',
  skor: 'score',
  prioritas: 'priority',
  alasan: 'reasons',
  catatan: 'notes',
  tag: 'tags',
  sumber: 'sources',
  dinilai: 'scored',
  aktivitas: 'activity',
  pertamaDilihat: 'firstSeenAt',
  diperbarui: 'updatedAt',
  terakhirDihubungi: 'lastContactedAt',
}
const ACTIVITY_MAP: Record<string, string> = { postTerakhir: 'lastPostAt', post30Hari: 'postsLast30Days', rataLike: 'avgLikes', rataKomentar: 'avgComments' }
const STATUS_MAP: Record<string, LeadStatus> = { baru: 'new', dihubungi: 'contacted', membalas: 'replied', prospek: 'qualified', ditolak: 'rejected' }
const BOOKING_MAP: Record<string, Booking> = { aplikasi: 'app', 'tidak jelas': 'unknown' }
const REASON_MAP: Record<string, string> = {
  'ukuran usaha ideal': 'ideal business size',
  'booking masih lewat WhatsApp': 'still takes bookings via WhatsApp',
  'punya beberapa cabang': 'has multiple branches',
  'nomor WA tersedia': 'WhatsApp number available',
  'akun tidak ditemukan': 'account not found',
  'bukan usaha sasaran': 'not a target business',
  'tidak posting lebih dari 4 bulan': 'no posts in over 4 months',
}
const SOURCE_PREFIX: Record<string, string> = { 'cari:': 'search:', 'lokasi:': 'location:', 'mirip:': 'similar:' }

const rename = (o: Record<string, any>, map: Record<string, string>) =>
  Object.fromEntries(Object.entries(o).map(([k, v]) => [map[k] ?? k, v]))

/** Converts a lead saved by an older version. Leads that are already in the new shape pass through unchanged. */
export const migrateLead = (old: Record<string, any>): Lead => {
  const l = rename(old, KEY_MAP)
  if (l.activity) l.activity = rename(l.activity, ACTIVITY_MAP)
  if (l.status in STATUS_MAP) l.status = STATUS_MAP[l.status]
  if (l.booking in BOOKING_MAP) l.booking = BOOKING_MAP[l.booking]
  if (Array.isArray(l.reasons)) l.reasons = l.reasons.map((r: string) => REASON_MAP[r] ?? r.replace(/^sudah pakai /, 'already uses '))
  if (Array.isArray(l.sources)) {
    l.sources = l.sources.map((s: string) => {
      const p = Object.keys(SOURCE_PREFIX).find(x => s.startsWith(x))
      return p ? SOURCE_PREFIX[p] + s.slice(p.length) : s
    })
  }
  return l as Lead
}

const needsMigration = (l: Record<string, any>) => Object.keys(l).some(k => k in KEY_MAP) || l.status in STATUS_MAP

const store = new Store<{ leads: Record<string, Lead> }>('leads', () => ({ leads: {} }))
let migrated = false
const data = () => {
  const d = store.get()
  if (!migrated) {
    migrated = true
    if (Object.values(d.leads).some(l => needsMigration(l as Record<string, any>))) {
      store.update(s => {
        for (const [k, l] of Object.entries(s.leads)) s.leads[k] = migrateLead(l as Record<string, any>)
      })
    }
  }
  return d
}

const key = (username: string) => username.replace(/^@/, '').toLowerCase()
const now = () => new Date().toISOString()

export const getLead = (username: string): Lead | undefined => data().leads[key(username)]

/** Adds or updates a lead. Re-enriching never overwrites the existing status, notes, or tags. */
export const upsertLead = (patch: Partial<Lead> & { username: string }, source?: string): Lead => {
  let out!: Lead
  data()
  store.update(s => {
    const k = key(patch.username)
    const old = s.leads[k]
    const sources = [...new Set([...(old?.sources ?? []), ...(patch.sources ?? []), ...(source ? [source] : [])])]
    out = {
      ...(old ?? { status: 'new' as LeadStatus, scored: false, firstSeenAt: now() }),
      ...patch,
      username: k,
      url: `https://www.instagram.com/${k}/`,
      status: patch.status ?? old?.status ?? 'new',
      sources,
      scored: patch.scored ?? old?.scored ?? false,
      firstSeenAt: old?.firstSeenAt ?? now(),
      updatedAt: now(),
    }
    s.leads[k] = out
  })
  return out
}

/** Called after a DM is sent, so other agents know this account has been contacted. */
export const markContacted = (username: string): void => {
  const lead = getLead(username)
  if (!lead) return
  upsertLead({ username, lastContactedAt: now(), status: lead.status === 'new' ? 'contacted' : lead.status })
}

export type LeadFilter = {
  status?: string
  priority?: string
  type?: string
  city?: string
  text?: string
  minScore?: number
  hasWhatsapp?: boolean
  multiBranch?: boolean
  scored?: boolean
  source?: string
}

export const listLeads = (f: LeadFilter = {}): Lead[] => {
  const q = f.text?.toLowerCase()
  const has = (v: string | null | undefined, want?: string) => !want || (v ?? '').toLowerCase() === want.toLowerCase()
  return Object.values(data().leads)
    .filter(
      l =>
        has(l.status, f.status) &&
        has(l.priority, f.priority) &&
        has(l.type, f.type) &&
        has(l.city, f.city) &&
        (f.minScore == null || (l.score ?? 0) >= f.minScore) &&
        (f.hasWhatsapp == null || (l.whatsapp?.length ?? 0) > 0 === f.hasWhatsapp) &&
        (f.multiBranch == null || !!l.multiBranch === f.multiBranch) &&
        (f.scored == null || l.scored === f.scored) &&
        (!f.source || l.sources.some(s => s.includes(f.source!))) &&
        (!q || `${l.username} ${l.name ?? ''} ${l.bio ?? ''}`.toLowerCase().includes(q)),
    )
    .sort((a, b) => (a.priority ?? 'Z').localeCompare(b.priority ?? 'Z') || (b.score ?? 0) - (a.score ?? 0) || (b.followers ?? 0) - (a.followers ?? 0))
}

export const leadStats = () => {
  const all = Object.values(data().leads)
  const count = (fn: (l: Lead) => string | null | undefined) =>
    all.reduce<Record<string, number>>((m, l) => {
      const k = fn(l) ?? '-'
      m[k] = (m[k] ?? 0) + 1
      return m
    }, {})
  return {
    total: all.length,
    scored: all.filter(l => l.scored).length,
    status: count(l => l.status),
    priority: count(l => (l.scored ? l.priority : 'unscored')),
    city: count(l => l.city),
  }
}

const csvCell = (v: unknown): string => {
  const s = Array.isArray(v) ? v.join('; ') : v == null ? '' : String(v)
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}

export const writeCsv = (name: string, columns: string[], rows: Record<string, unknown>[]): string => {
  fs.mkdirSync(DOWNLOAD_DIR, { recursive: true })
  const file = path.join(DOWNLOAD_DIR, `${name}-${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}.csv`)
  fs.writeFileSync(file, [columns.join(','), ...rows.map(r => columns.map(c => csvCell(r[c])).join(','))].join('\n'))
  return file
}

export const exportLeads = (f: LeadFilter = {}): { path: string; count: number } => {
  const rows = listLeads(f)
  const cols = ['priority', 'score', 'status', 'city', 'type', 'username', 'name', 'url', 'followers', 'posts', 'booking', 'multiBranch', 'whatsapp', 'emails', 'link', 'reasons', 'sources', 'notes', 'lastContactedAt', 'bio']
  return { path: writeCsv('leads', cols, rows as unknown as Record<string, unknown>[]), count: rows.length }
}
