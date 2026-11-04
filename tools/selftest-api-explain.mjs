/**
 * Contracts for the two newest HTTP actions.
 *
 * `previewDelete` and `longterm.explain` are read-only, and that is exactly what
 * is easy to get wrong: a dry run that quietly records an access would let a
 * user's curiosity re-rank their own memory library. These tests pin the request
 * shape the client sends, the side-effect flags the route sets, and the refusal
 * to accept a missing session id.
 *
 * Usage: node tools/selftest-api-explain.mjs
 */

import assert from 'node:assert/strict'
import { createRoute } from '../lib/api.js'

const checks = []

/** @param {object} service @param {object} body @returns {Promise<any>} parsed response */
async function post(service, body) {
  const route = createRoute(service, { log() {} })
  const response = await route.fetch(
    new Request('http://localhost/api/session-suite', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
  )
  return { status: response.status, payload: await response.json() }
}

// 1. `longterm.explain` must forward the question and the workspace, and must
//    set `touch: false` — a dry run that counts as an access would let a user
//    re-rank their own library just by testing queries.
{
  let seen
  const service = {
    longTerm: {
      select: async input => {
        seen = input
        return { items: [{ id: 'mem_a', text: 'x' }], omitted: [], effectiveLimit: 2, topScore: 0.7 }
      },
    },
  }
  const { status, payload } = await post(service, {
    action: 'longterm.explain',
    cwd: 'D:\\ws',
    query: '缓存为什么掉',
    limit: 4,
  })
  assert.equal(status, 200)
  assert.equal(payload.ok, true)
  assert.equal(seen.query, '缓存为什么掉', 'the question must reach the engine')
  assert.equal(seen.cwd, 'D:\\ws', 'the workspace must reach the engine')
  assert.equal(seen.limit, 4, 'the limit must be forwarded')
  assert.equal(seen.touch, false, 'a dry run must not record an access')
  assert.equal(payload.data.items.length, 1)
  checks.push('longterm.explain forwards the query and never records an access')
}

// 1b. `longterm.recall` is the other read path, and it carries the same
//     no-side-effect contract. Mutation testing exposed that the first version
//     of this file only covered `explain`, because a patch aimed at one case
//     silently hit the other — the two request shapes are near-identical.
{
  let seen
  const service = {
    longTerm: {
      recall: async input => {
        seen = input
        return [{ id: 'mem_b' }]
      },
    },
  }
  const { status } = await post(service, { action: 'longterm.recall', cwd: '/ws', query: '快照', limit: 3 })
  assert.equal(status, 200)
  assert.equal(seen.query, '快照')
  assert.equal(seen.limit, 3)
  assert.equal(seen.touch, false, 'the settings-page search must not record an access either')
  checks.push('longterm.recall forwards the query and never records an access')
}

// 2. A missing query is an empty string, not undefined: the engine treats a
//    question-less recall as importance-only, which is the right answer for a
//    blank box rather than an error.
{
  let seen
  const service = { longTerm: { select: async input => { seen = input; return { items: [], omitted: [] } } } }
  const { status } = await post(service, { action: 'longterm.explain' })
  assert.equal(status, 200)
  assert.equal(seen.query, '')
  assert.equal(seen.limit, undefined, 'an absent limit must stay absent so the engine default applies')
  checks.push('an empty explain request is answered, not rejected')
}

// 3. `previewDelete` requires a session id and passes it through untouched.
{
  let seen
  const service = {
    previewDelete: async sessionId => {
      seen = sessionId
      return { sessionId, subagents: [], totalSessions: 1, willRefuse: false, refuseReason: null }
    },
  }
  const ok = await post(service, { action: 'previewDelete', sessionId: 'session-abc' })
  assert.equal(ok.status, 200)
  assert.equal(seen, 'session-abc')
  assert.equal(ok.payload.data.willRefuse, false)

  const missing = await post(service, { action: 'previewDelete' })
  assert.equal(missing.status, 400, 'a preview without a session id must fail loudly')
  assert.equal(seen, 'session-abc', 'the rejected call must not have reached the service')
  checks.push('previewDelete requires a session id and is otherwise read-only')
}

// 4. `deleteSession` defaults to cascading, and an explicit `cascade: false`
//    must be honoured — otherwise there would be no way to delete only the one
//    session a user picked.
{
  const calls = []
  const service = {
    deleteSession: async (sessionId, options) => {
      calls.push({ sessionId, options })
      return { sessionFiles: [], removedSubagents: [], refused: [] }
    },
  }
  await post(service, { action: 'deleteSession', sessionId: 's1' })
  await post(service, { action: 'deleteSession', sessionId: 's2', cascade: false })
  assert.equal(calls[0].options.cascade, true, 'cascade must default to on')
  assert.equal(calls[1].options.cascade, false, 'an explicit opt-out must be honoured')
  checks.push('deleteSession cascades by default and can be told not to')
}

// 5. The route must not invent actions. An unknown one is a loud 400 rather than
//    a silent no-op.
{
  const { status, payload } = await post({}, { action: 'longterm.doesNotExist' })
  assert.equal(status, 400)
  assert.equal(payload.ok, false)
  checks.push('an unknown action is rejected')
}

console.log(checks.map((line, index) => `  ${index + 1}. ${line}`).join('\n'))
console.log(`\n${checks.length}/${checks.length} checks passed`)
