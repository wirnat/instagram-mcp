import { Store } from '../store.js'

/**
 * Ideal customer profile used to score leads. The default is deliberately generic:
 * no business types, cities, or country-specific phone rules. Load a preset (see PRESETS)
 * or pass your own config through the lead_config tool.
 */
export type LeadConfig = {
  /** Business types and the words that identify them (regex, no delimiters). Order sets priority. Empty means type is not a filter. */
  types: { name: string; pattern: string }[]
  /** Booking or POS apps a target business may already use, searched in the bio and links. */
  competitorApps: string[]
  /** Cities or regions and the words that identify them. The first match wins. */
  cities: { name: string; pattern: string }[]
  /** Follower range that counts as the ideal business size. */
  idealFollowers: [number, number]
  /** Words that disqualify an account (not a target business). Empty disables it. */
  excludePattern: string
  /** Words in the bio that signal several branches or outlets. */
  branchPattern: string
  /** Words that explicitly say there is only one location. Overrides branchPattern. */
  noBranchPattern: string
  /**
   * Country calling code used to normalize local phone numbers, e.g. "62" for Indonesia.
   * null means only numbers written with an international prefix (+...) or wa.me links are accepted.
   */
  defaultCountryCode: string | null
  /** First digit(s) of a local mobile number after the trunk 0, e.g. "8" in Indonesia. null accepts any digit. */
  mobilePrefix: string | null
}

export const DEFAULT_CONFIG: LeadConfig = {
  types: [],
  competitorApps: [],
  cities: [],
  idealFollowers: [1000, 30000],
  excludePattern: 'coming soon|temporarily closed|permanently closed',
  branchPattern: 'branch|outlets|locations|find us at',
  noBranchPattern: 'no branch(es)?|single location|only one (location|outlet)',
  defaultCountryCode: null,
  mobilePrefix: null,
}

/** Ready-made configs. The same data is in examples/lead-config.<name>.json. */
export const PRESETS: Record<string, LeadConfig> = {
  'salon-id': {
    types: [
      { name: 'barbershop', pattern: 'barber|cukur|pangkas' },
      { name: 'clinic', pattern: 'klinik|clinic|aesthetic|estetik|derma|skin ?care|dr\\.' },
      { name: 'salon', pattern: 'salon|hair|rambut' },
      { name: 'spa', pattern: '\\bspa\\b|spa_|massage|pijat|reflex|wellness' },
      { name: 'nail/lash', pattern: 'nail|lash|brow|kuku|bulu mata' },
      { name: 'salon', pattern: 'beauty|studio' },
    ],
    competitorApps: [
      'fresha', 'booksy', 'setmore', 'simplybook', 'zenoti', 'vagaro', 'mindbody', 'glamify', 'majoo', 'moka', 'qasir', 'olsera',
      'treatwell', 'phorest', 'reservio', 'appointy', 'calendly', 'square\\.site', 'getsquire', 'glossgenius', 'youcanbook',
    ],
    cities: [
      { name: 'Balikpapan', pattern: 'balikpapan' },
      { name: 'Bali', pattern: '\\bbali\\b|denpasar|ubud|seminyak|canggu|\\bkuta\\b|tabanan|singaraja|gianyar|jimbaran|uluwatu|sanur|dalung|renon|kerobokan|nusa dua' },
      { name: 'Jakarta', pattern: 'jakarta|jaksel|jakbar|jaktim|jakut|jakpus|kemang|kelapa gading' },
      { name: 'Tangerang', pattern: 'tangerang|bsd|serpong|bintaro' },
      { name: 'Bekasi', pattern: 'bekasi' },
      { name: 'Depok', pattern: 'depok' },
      { name: 'Bogor', pattern: 'bogor' },
      { name: 'Surabaya', pattern: 'surabaya|sidoarjo' },
      { name: 'Bandung', pattern: 'bandung|cimahi' },
      { name: 'Yogyakarta', pattern: 'yogya|jogja' },
      { name: 'Semarang', pattern: 'semarang' },
      { name: 'Malang', pattern: 'malang' },
      { name: 'Medan', pattern: 'medan' },
      { name: 'Makassar', pattern: 'makassar' },
      { name: 'Lombok', pattern: 'lombok|mataram' },
      { name: 'Solo', pattern: '\\bsolo\\b|surakarta' },
    ],
    idealFollowers: [1000, 30000],
    excludePattern: 'parfum|coming soon|temporarily closed|tutup sementara|permanently closed|academy|kursus saja',
    branchPattern: 'cabang|\\bcab\\.|branch|outlets|locations|find us at',
    noBranchPattern: 'tidak (memiliki|punya|ada) cabang|no branch',
    defaultCountryCode: '62',
    mobilePrefix: '8',
  },
}

const store = new Store<{ config: Partial<LeadConfig> }>('lead-config', () => ({ config: {} }))

/** Configs saved by older versions had no phone fields and used the Indonesian salon defaults. */
const migrateConfig = (c: Partial<LeadConfig>): Partial<LeadConfig> =>
  Object.keys(c).length && !('defaultCountryCode' in c) ? { ...PRESETS['salon-id'], ...c } : c

export const getLeadConfig = (): LeadConfig => ({ ...DEFAULT_CONFIG, ...migrateConfig(store.get().config ?? {}) })
export const setLeadConfig = (patch: Partial<LeadConfig>): LeadConfig => {
  store.update(s => {
    s.config = { ...getLeadConfig(), ...patch }
  })
  return getLeadConfig()
}
/** Replaces the whole config with a preset. */
export const applyPreset = (name: string): LeadConfig => {
  const p = PRESETS[name]
  if (!p) throw new Error(`Unknown preset "${name}". Available: ${Object.keys(PRESETS).join(', ')}`)
  store.set({ config: { ...p } })
  return getLeadConfig()
}

const re = (p: string) => new RegExp(p, 'i')
const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

export type PhoneRules = Pick<LeadConfig, 'defaultCountryCode' | 'mobilePrefix'>

/**
 * Normalizes a phone number to international digits without "+", e.g. 6281200002222.
 * `international` marks numbers that are known to include the country code (wa.me links).
 */
export const normPhone = (raw: string, rules: PhoneRules = getLeadConfig(), international = false): string | null => {
  const d = raw.replace(/[^\d]/g, '')
  if (international || raw.trim().startsWith('+')) return /^[1-9]\d{7,14}$/.test(d) ? d : null
  const cc = rules.defaultCountryCode
  if (!cc) return null
  if (d.startsWith(cc) && d.length >= cc.length + 8 && d.length <= cc.length + 13) return d
  if (/^0\d{8,13}$/.test(d)) return `${cc}${d.slice(1)}`
  if (rules.mobilePrefix && d.startsWith(rules.mobilePrefix) && d.length >= 9 && d.length <= 13) return `${cc}${d}`
  return null
}

/** Finds WhatsApp/phone numbers in text and links. */
export const extractPhones = (text: string, links: string[] = [], rules: PhoneRules = getLeadConfig()): string[] => {
  const out = new Set<string>()
  const add = (p: string | null) => p && out.add(p)
  for (const m of text.matchAll(/\+\d[\d\s.-]{7,16}\d/g)) add(normPhone(m[0], rules))
  if (rules.defaultCountryCode) {
    const first = rules.mobilePrefix ? esc(rules.mobilePrefix) : '\\d'
    const local = new RegExp(`(?:\\+?${esc(rules.defaultCountryCode)}|0)[\\s.-]?${first}[\\d\\s.-]{7,14}\\d`, 'g')
    for (const m of text.matchAll(local)) add(normPhone(m[0], rules))
  }
  for (const l of [...links, text]) {
    for (const m of l.matchAll(/(?:wa\.me\/|whatsapp\.com\/send\/?\?phone=|wa\.link\/|phone=)(\+?\d{9,15})/gi)) add(normPhone(m[1], rules, true))
  }
  return [...out]
}

export const extractEmails = (text: string): string[] => [...new Set(text.match(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g) ?? [])]

export type ProfileLike = {
  username: string
  fullName?: string
  bio?: string
  category?: string
  externalUrl?: string | null
  links?: { title?: string; url: string }[]
  followerCount?: number | null
  postCount?: number | null
  isPrivate?: boolean
  isProfessional?: boolean
  businessEmail?: string | null
  businessPhone?: string | null
}

export type Booking = 'whatsapp' | 'app' | 'unknown'
export type Priority = 'A' | 'B' | 'C'

export type Analysis = {
  type: string | null
  city: string | null
  whatsapp: string[]
  emails: string[]
  booking: Booking
  bookingApps: string[]
  multiBranch: boolean
  score: number
  priority: Priority
  reasons: string[]
  /** false when the account is private, excluded, or does not match any configured type. */
  fit: boolean
}

/** Scores a profile as a potential customer. Uses only public profile data. */
export const analyzeProfile = (p: ProfileLike, config: LeadConfig = getLeadConfig(), extraText = ''): Analysis => {
  const bio = p.bio ?? ''
  const links = [p.externalUrl ?? '', ...(p.links ?? []).map(l => l.url)].filter(Boolean)
  const text = [p.username, p.fullName ?? '', bio, p.category ?? '', links.join(' '), extraText].join(' ').toLowerCase()
  const reasons: string[] = []

  const type = config.types.find(t => re(t.pattern).test(text))?.name ?? null
  const city = config.cities.find(c => re(c.pattern).test(text))?.name ?? null
  const whatsapp = extractPhones(`${bio} ${p.businessPhone ?? ''} ${extraText}`, links, config)
  const emails = extractEmails(`${bio} ${p.businessEmail ?? ''} ${extraText}`)
  const bookingApps = [...new Set(config.competitorApps.filter(a => re(`\\b${a}\\b`).test(text)).map(a => a.replace(/\\/g, '')))]
  const mentionsWa = whatsapp.length > 0 || /wa\.me|whatsapp|\bwa\b|wa:|book(ing)? (by|via) (wa|dm)/.test(text)
  const booking: Booking = bookingApps.length ? 'app' : mentionsWa ? 'whatsapp' : 'unknown'

  const noBranch = !!config.noBranchPattern && re(config.noBranchPattern).test(text)
  const pins = (bio.match(/📍/g) ?? []).length
  const multiBranch = !noBranch && ((!!config.branchPattern && re(config.branchPattern).test(bio)) || pins >= 2)

  let score = 0
  const f = p.followerCount ?? 0
  const [lo, hi] = config.idealFollowers
  if (f >= lo && f <= hi) {
    score += 3
    reasons.push('ideal business size')
  } else if (f > hi && f <= hi * 4) score += 2
  else if (f >= 300 && f < lo) score += 1
  if ((p.postCount ?? 0) >= 50) score += 1
  if (booking === 'whatsapp') {
    score += 3
    reasons.push('still takes bookings via WhatsApp')
  }
  if (booking === 'app') {
    score += 1
    reasons.push(`already uses ${bookingApps.join(', ')}`)
  }
  if (multiBranch) {
    score += 3
    reasons.push('has multiple branches')
  }
  if (p.isProfessional) score += 1
  if (whatsapp.length) reasons.push('WhatsApp number available')

  const excluded = !!config.excludePattern && re(config.excludePattern).test(text)
  const fit = (config.types.length === 0 || !!type) && !excluded && !p.isPrivate
  const priority: Priority = !fit ? 'C' : (multiBranch && booking === 'whatsapp') || score >= 10 ? 'A' : score >= 8 ? 'B' : 'C'
  return { type, city, whatsapp, emails, booking, bookingApps, multiBranch, score, priority, reasons, fit }
}
