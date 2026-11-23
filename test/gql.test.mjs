import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

process.env.INSTAGRAM_MCP_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'igmcp-gql-'))
const { ensureDirs } = await import('../dist/config.js')
const { IgBrowser } = await import('../dist/browser.js')
ensureDirs()

/** A browser whose network calls are answered by `answer(path, friendlyName)`. */
const fakeBrowser = answer => {
  const b = new IgBrowser()
  const calls = []
  b.ensureTokens = async () => {}
  b.operation = async () => ({ id: '123' })
  b.fetch = async (p, o) => {
    calls.push(p)
    return { status: 200, json: answer(p, o.form.fb_api_req_friendly_name) }
  }
  return { b, calls }
}

test('a confirmed read query moves to the other endpoint when its path returns empty data', async () => {
  // Instagram moved the profile query from /graphql/query to /api/graphql; the old path answers with user: null.
  const { b, calls } = fakeBrowser(p => ({ data: { user: p === '/api/graphql' ? { username: 'brotherbarber_' } : null } }))
  b.gqlPaths.set('PolarisProfilePageContentQuery', '/graphql/query')
  b.confirmedPaths.add('PolarisProfilePageContentQuery')

  const j = await b.gql('PolarisProfilePageContentQuery', { id: '7611623068' })
  assert.equal(j.data.user.username, 'brotherbarber_')
  assert.deepEqual(calls, ['/graphql/query', '/api/graphql'])
  assert.equal(b.gqlPaths.get('PolarisProfilePageContentQuery'), '/api/graphql')

  calls.length = 0
  await b.gql('PolarisProfilePageContentQuery', { id: '7611623068' })
  assert.deepEqual(calls, ['/api/graphql'], 'the working path is remembered')
})

test('a mutation is never sent to a second endpoint', async () => {
  const { b, calls } = fakeBrowser(() => ({ data: { result: null } }))
  await b.gql('usePolarisFollowMutation', { target_user_id: '1' })
  assert.equal(calls.length, 1)
})
