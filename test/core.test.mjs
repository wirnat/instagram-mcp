import test from 'node:test'
import assert from 'node:assert/strict'
import { shortcodeToPk, pkToShortcode, parsePostRef, parseUserRef } from '../dist/ig/normalize.js'
import { classify } from '../dist/errors.js'
import { PacedQueue } from '../dist/queue.js'

test('shortcode and media id round-trip', () => {
  const pk = shortcodeToPk('DfFFEoMqjbz')
  assert.equal(pk, '4018640550770652915')
  assert.equal(pkToShortcode(pk), 'DfFFEoMqjbz')
})

test('parsePostRef accepts a URL, shortcode, or id', () => {
  assert.equal(parsePostRef('https://www.instagram.com/p/DfFFEoMqjbz/').pk, '4018640550770652915')
  assert.equal(parsePostRef('https://www.instagram.com/natgeo/reel/DfFFEoMqjbz/?x=1').shortcode, 'DfFFEoMqjbz')
  assert.equal(parsePostRef('4018640550770652915_71928311841').shortcode, 'DfFFEoMqjbz')
  assert.equal(parsePostRef('DfFFEoMqjbz').pk, '4018640550770652915')
})

test('parseUserRef accepts a username, URL, or id', () => {
  assert.deepEqual(parseUserRef('@natgeo'), { username: 'natgeo' })
  assert.deepEqual(parseUserRef('https://www.instagram.com/natgeo/'), { username: 'natgeo' })
  assert.deepEqual(parseUserRef('71928311841'), { id: '71928311841' })
})

test('classify detects Instagram warning responses', () => {
  assert.equal(classify(200, 'https://www.instagram.com/accounts/login/?next=x', ''), 'not-logged-in')
  assert.equal(classify(400, 'https://www.instagram.com/api/v1/x', '{"message":"checkpoint_required"}'), 'challenge')
  assert.equal(classify(400, 'https://www.instagram.com/api/v1/x', '{"message":"feedback_required","spam":true}'), 'action-blocked')
  assert.equal(classify(429, 'https://www.instagram.com/api/v1/x', ''), 'rate-limited')
  assert.equal(classify(200, 'https://www.instagram.com/api/v1/x', '{"status":"ok"}'), null)
})

test('queue spaces out calls and rejects when the wait is too long', async () => {
  const q = new PacedQueue({ min: 60, max: 60 })
  const t0 = Date.now()
  const stamps = []
  await Promise.all([1, 2, 3].map(() => q.run(async () => stamps.push(Date.now() - t0))))
  assert.ok(stamps[1] - stamps[0] >= 55 && stamps[2] - stamps[1] >= 55, `gap too short: ${stamps}`)
  const slow = new PacedQueue({ min: 60_000, max: 60_000 })
  await slow.run(async () => 1)
  assert.ok(slow.estimateWaitMs() > 50_000)
  await assert.rejects(() => slow.run(async () => 1), e => e.code === 'busy')
})
