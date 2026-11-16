import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { analyzeProfile, extractPhones, normPhone, DEFAULT_CONFIG, PRESETS } from '../dist/leads/score.js'
import { migrateLead } from '../dist/leads/db.js'
import { scoreBot } from '../dist/tools/audience.js'

const ID = PRESETS['salon-id']
const analyze = p => analyzeProfile(p, ID)

test('the example file matches the built-in salon-id preset', () => {
  const file = JSON.parse(fs.readFileSync(new URL('../examples/lead-config.salon-id.json', import.meta.url), 'utf8'))
  assert.deepEqual(file, ID)
})

test('phone numbers are normalized with the configured country code', () => {
  assert.equal(normPhone('0812-0000-1111', ID), '6281200001111')
  assert.equal(normPhone('+62 812-0000-2222', ID), '6281200002222')
  assert.equal(normPhone('12345', ID), null)
  assert.deepEqual(extractPhones('WA: 0812000033 open 10:00-21:00', [], ID), ['62812000033'])
  assert.deepEqual(extractPhones('', ['https://wa.me/6281200004444?text=hi'], ID), ['6281200004444'])
})

test('without a country code only international numbers are accepted', () => {
  assert.equal(normPhone('0812-0000-1111', DEFAULT_CONFIG), null)
  assert.equal(normPhone('+1 (512) 555-0147', DEFAULT_CONFIG), '15125550147')
  assert.deepEqual(extractPhones('Call 0812000033 or +44 20 7946 0958', [], DEFAULT_CONFIG), ['442079460958'])
  assert.deepEqual(extractPhones('', ['https://wa.me/6281200004444'], DEFAULT_CONFIG), ['6281200004444'])
})

test('a multi-branch salon that books via WhatsApp gets priority A', () => {
  const a = analyze({
    username: 'example.hairstudio',
    fullName: 'Example Hair Studio Denpasar',
    bio: '📞BOOK BY WHATSAPP OR DM 📍Tabanan Dajan Peken (09.00-20.00) 📍Gunung Tangkuban Perahu Denpasar',
    followerCount: 15568,
    postCount: 400,
    isProfessional: true,
  })
  assert.equal(a.type, 'salon')
  assert.equal(a.city, 'Bali')
  assert.equal(a.booking, 'whatsapp')
  assert.equal(a.multiBranch, true)
  assert.equal(a.priority, 'A')
})

test('a barbershop already using a booking app is detected', () => {
  const a = analyze({
    username: 'example.barbershop',
    fullName: 'Example Barber Canggu',
    bio: 'BALI-INDONESIA OutCall Service Available',
    externalUrl: 'https://example.setmore.com',
    followerCount: 2591,
    postCount: 120,
  })
  assert.equal(a.type, 'barbershop')
  assert.equal(a.booking, 'app')
  assert.deepEqual(a.bookingApps, ['setmore'])
})

test('an explicit "no branches" statement is not counted as multi-branch', () => {
  const a = analyze({ username: 'example.barbers', fullName: 'Example Barbers', bio: 'OFFICIAL STORE💈 (TIDAK MEMILIKI CABANG) Bandung WA 081234567890', followerCount: 1364 })
  assert.equal(a.multiBranch, false)
  assert.equal(a.city, 'Bandung')
})

test('perfume shops and personal or private accounts are not a fit', () => {
  assert.equal(analyze({ username: 'example.perfume', fullName: 'Example Perfume Bali', bio: 'Inspired parfume WA 08123456789', followerCount: 2890 }).fit, false)
  assert.equal(analyze({ username: 'example.person', fullName: 'Example Person', bio: 'travel and food', followerCount: 5000 }).fit, false)
  assert.equal(analyze({ username: 'example.salon', fullName: 'Salon Denpasar', bio: 'WA: 0812000033', followerCount: 1916, isPrivate: true }).fit, false)
})

test('the generic default config scores without types or cities', () => {
  const a = analyzeProfile(
    { username: 'smiledental', fullName: 'Smile Dental', bio: 'Book via WhatsApp +1 512 555 0147. Three locations in Austin', followerCount: 4200, postCount: 80 },
    DEFAULT_CONFIG,
  )
  assert.equal(a.fit, true)
  assert.equal(a.type, null)
  assert.equal(a.city, null)
  assert.deepEqual(a.whatsapp, ['15125550147'])
  assert.equal(a.multiBranch, true)
  assert.equal(a.priority, 'A')
  assert.equal(analyzeProfile({ username: 'x', bio: 'Coming soon', followerCount: 4200 }, DEFAULT_CONFIG).fit, false)
})

test('leads saved with the old field names are migrated', () => {
  const l = migrateLead({
    username: 'example.hairstudio',
    url: 'https://www.instagram.com/example.hairstudio/',
    nama: 'Beaute Panic',
    kota: 'Bali',
    wa: ['6281234567890'],
    cabang: true,
    prioritas: 'A',
    alasan: ['ukuran usaha ideal', 'sudah pakai fresha'],
    status: 'dihubungi',
    booking: 'aplikasi',
    sumber: ['cari:salon Denpasar'],
    dinilai: true,
    aktivitas: { postTerakhir: null, post30Hari: 2, rataLike: 10, rataKomentar: 1 },
    pertamaDilihat: '2026-11-14T00:00:00.000Z',
    diperbarui: '2026-11-14T00:00:00.000Z',
  })
  assert.equal(l.name, 'Beaute Panic')
  assert.equal(l.city, 'Bali')
  assert.deepEqual(l.whatsapp, ['6281234567890'])
  assert.equal(l.multiBranch, true)
  assert.equal(l.priority, 'A')
  assert.deepEqual(l.reasons, ['ideal business size', 'already uses fresha'])
  assert.equal(l.status, 'contacted')
  assert.equal(l.booking, 'app')
  assert.deepEqual(l.sources, ['search:salon Denpasar'])
  assert.equal(l.scored, true)
  assert.deepEqual(l.activity, { lastPostAt: null, postsLast30Days: 2, avgLikes: 10, avgComments: 1 })
  assert.equal(l.firstSeenAt, '2026-11-14T00:00:00.000Z')
  assert.equal('nama' in l, false)
})

test('bot scoring from follower list data', () => {
  const base = { id: '1', fullName: '', isPrivate: false, isVerified: false }
  assert.equal(scoreBot({ ...base, username: 'user8372615', noAvatar: true }).risk, 'high')
  assert.equal(scoreBot({ ...base, username: 'salon_ayu', fullName: 'Salon Ayu', noAvatar: false }).risk, 'low')
  assert.equal(scoreBot({ ...base, username: 'user8372615', noAvatar: true, isVerified: true }).risk, 'low')
})
