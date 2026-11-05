/**
 * Batch deletion: the behaviour that matters is the report, not the speed.
 *
 * A batch exists because one failure must not abort the rest, and because the
 * caller has to learn which ids went and which did not. Those two properties are
 * what these tests pin.
 *
 * Usage: node tools/selftest-delete-batch.mjs
 */

import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { SessionSuiteService } from '../lib/service.js'
import { CheckpointStore } from '../lib/checkpoints.js'

const checks = []
const root = await fs.mkdtemp(path.join(os.tmpdir(), 'batch-'))
const home = path.join(root, 'home')
await fs.mkdir(home, { recursive: true })
const store = new CheckpointStore({ root })

/** @param {any[]} items @returns {any} a ctx exposing a fake session controller */
const ctxWith = items => ({
  get(name) {
    if (name === 'sessionController') return { list: async () => ({ items }) }
    if (name === 'workspaceRegistry') return { archiveSession: async () => {}, unarchiveSession: async () => {} }
    return undefined
  },
  emit() {},
})

/**
 * @param {any[]} items controller rows
 * @param {Record<string, string[]>} [logs] sessionId -> directories to create
 * @returns {Promise<SessionSuiteService>} a service wired to that state
 */
async function makeService(items, logs = {}) {
  const sessionsRoot = path.join(home, 'sessions', 'ws')
  for (const [sessionId, files] of Object.entries(logs)) {
    const dir = path.join(sessionsRoot, sessionId)
    await fs.mkdir(dir, { recursive: true })
    for (const file of files) await fs.writeFile(path.join(dir, file), 'x')
  }
  const service = new SessionSuiteService({
    ctx: ctxWith(items),
    root,
    store,
    memory: { purge: async () => {}, list: async () => [] },
    log: () => {},
    config: {},
  })
  service.dshHome = home
  return service
}

// 1. Every requested session is deleted, and the report names them.
{
  const items = [
    { sessionId: 's1', updatedAt: 1 },
    { sessionId: 's2', updatedAt: 2 },
    { sessionId: 's3', updatedAt: 3 },
  ]
  const service = await makeService(items, {
    s1: ['session.v4.jsonl.zstd'],
    s2: ['session.v4.jsonl.zstd'],
  })
  const result = await service.deleteSessions(['s1', 's2'])
  assert.equal(result.requested, 2)
  assert.deepEqual(result.removed, ['s1', 's2'])
  assert.deepEqual(result.failed, [])
  checks.push('a batch deletes every requested session and reports them')
}

// 2. A session that cannot be deleted must not abort the rest — that is the
//    whole reason a batch exists. A running session is skipped and reported.
{
  const items = [
    { sessionId: 's3', updatedAt: 3, running: true },
    { sessionId: 's4', updatedAt: 4 },
  ]
  const service = await makeService(items, {
    s3: ['session.v4.jsonl.zstd'],
    s4: ['session.v4.jsonl.zstd'],
  })
  const result = await service.deleteSessions(['s3', 's4'])
  assert.equal(result.removed.includes('s4'), true, 'a deletable session must still be deleted')
  assert.equal(result.removed.includes('s3'), false, 'a running session must not be reported as removed')
  assert.equal(result.failed.length, 1)
  assert.equal(result.failed[0].sessionId, 's3')
  assert.match(result.failed[0].reason, /running/i, 'the reason must say it is running')
  // And the running session must still be on disk: a refusal deletes nothing.
  const dir = path.join(home, 'sessions', 'ws', 's3')
  assert.equal(await fs.stat(dir).then(() => true, () => false), true, 'a refused session keeps its files')
  checks.push('one running session does not abort the batch, and its files survive')
}

// 3. Duplicates collapse, so a repeated id is not deleted twice or reported twice.
{
  const items = [{ sessionId: 's5', updatedAt: 5 }]
  const service = await makeService(items, { s5: ['session.v4.jsonl.zstd'] })
  const result = await service.deleteSessions(['s5', 's5', 's5'])
  assert.equal(result.requested, 1, 'duplicates must collapse to one request')
  assert.deepEqual(result.removed, ['s5'])
  checks.push('duplicate ids collapse into a single request')
}

// 4. Junk in the list is ignored rather than throwing.
{
  const service = await makeService([{ sessionId: 's6', updatedAt: 6 }], { s6: ['session.v4.jsonl.zstd'] })
  const result = await service.deleteSessions([null, undefined, '', 42, 's6'])
  assert.equal(result.requested, 1)
  assert.deepEqual(result.removed, ['s6'])
  checks.push('non-string and empty ids are ignored')
}

// 5. An empty request is a no-op, not an error.
{
  const service = await makeService([{ sessionId: 's7', updatedAt: 7 }])
  assert.deepEqual(await service.deleteSessions([]), { removed: [], failed: [], requested: 0 })
  assert.deepEqual(await service.deleteSessions(null), { removed: [], failed: [], requested: 0 })
  checks.push('an empty batch is a no-op')
}

// 6. An oversized batch is refused outright. A partial apply of a nonsense
//    request is worse than a clear refusal.
{
  const service = await makeService([{ sessionId: 's8', updatedAt: 8 }])
  const huge = Array.from({ length: 201 }, (_, index) => `bulk-${index}`)
  await assert.rejects(
    () => service.deleteSessions(huge),
    /cannot delete more than 200/i,
    'an oversized batch must be refused, not partially applied',
  )
  checks.push('an oversized batch is refused rather than partially applied')
}

// 7. The HTTP route exposes it, and an absent list becomes an empty no-op
//    instead of a crash.
{
  const { createRoute } = await import('../lib/api.js')
  let seen
  const service = {
    deleteSessions: async (ids, options) => {
      seen = { ids, options }
      return { removed: ids, failed: [], requested: ids.length }
    },
  }
  const route = createRoute(service, { log() {} })
  const response = await route.fetch(
    new Request('http://localhost/api/session-suite', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'deleteSessions', sessionIds: ['a', 'b'] }),
    }),
  )
  assert.equal(response.status, 200)
  assert.deepEqual(seen.ids, ['a', 'b'])
  assert.equal(seen.options.cascade, true, 'cascade must default to on')

  const empty = await route.fetch(
    new Request('http://localhost/api/session-suite', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'deleteSessions' }),
    }),
  )
  assert.equal(empty.status, 200)
  assert.deepEqual(seen.ids, [], 'a missing list must become an empty batch')
  checks.push('the route accepts a batch and defaults to cascading')
}

await fs.rm(root, { recursive: true, force: true })
console.log(checks.map((line, index) => `  ${index + 1}. ${line}`).join('\n'))
console.log(`\n${checks.length}/${checks.length} checks passed`)
