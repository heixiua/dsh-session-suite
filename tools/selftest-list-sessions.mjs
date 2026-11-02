// Regression test for the snapshot panel showing the wrong session.
//
// The bug: listSessions() dropped any session carrying a parentSessionId, on the
// theory that a child is a subagent. But every rewind / delete forks the
// conversation and retires the original, so the session a user is actually in
// carries a parent too. The live session disappeared from the panel's list and
// it fell back to showing whichever unrelated session had snapshots.
//
// Usage: node tools/selftest-list-sessions.mjs
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { SessionSuiteService } from '../lib/service.js'
import { CheckpointStore } from '../lib/checkpoints.js'

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'list-sessions-'))
const store = new CheckpointStore({ root })

// A fake sessionController, since a Host service cannot be mounted here.
function controllerWith(items) {
  return { list: async () => ({ items }) }
}

const ctx = {
  get(name) {
    return name === 'sessionController' ? controller : undefined
  },
}
let controller = null

const service = new SessionSuiteService({
  ctx,
  root,
  store,
  memory: { list: async () => [] },
  log: () => {},
  config: {},
})

// 1. A forked conversation (rewind / delete) is the live one and must be listed.
{
  controller = controllerWith([
    // The session the user is talking in: forked by a rewind, so it has a parent.
    { sessionId: 'session-live', parentSessionId: 'session-retired', updatedAt: 3000, running: false },
    // An unrelated old session that happens to have snapshots.
    { sessionId: 'session-old', updatedAt: 1000, running: false },
  ])
  const rows = await service.listSessions()
  const ids = rows.map(row => row.sessionId)
  assert.deepEqual(ids.sort(), ['session-live', 'session-old'])
  assert.equal(
    ids.includes('session-live'),
    true,
    'a session forked by a rewind is the live conversation and must be listed',
  )
  console.log('  ok  a forked conversation is still listed')
}

// 2. A real subagent child must still be hidden.
{
  controller = controllerWith([
    { sessionId: 'session-live', updatedAt: 3000, running: false },
    { sessionId: 'session-sub', origin: 'subagent', parentSessionId: 'session-live', updatedAt: 2000 },
  ])
  const rows = await service.listSessions()
  const ids = rows.map(row => row.sessionId)
  assert.deepEqual(ids, ['session-live'])
  console.log('  ok  a subagent child stays hidden')
}

// 3. The panel's fallback must land on the session that actually has snapshots,
//    which is the live one after a rewind inherited them.
{
  await store.capture({
    sessionId: 'session-live',
    cwd: root,
    turn: 3,
    phase: 'end',
    kind: 'auto',
    label: 'after turn 3',
  })
  controller = controllerWith([
    { sessionId: 'session-old', updatedAt: 1000, running: false },
    { sessionId: 'session-live', parentSessionId: 'session-retired', updatedAt: 3000, running: false },
  ])
  const rows = await service.listSessions()
  const live = rows.find(row => row.sessionId === 'session-live')
  assert.equal(live.checkpoints > 0, true, 'the live session reports its snapshots')
  // This mirrors the client's `rows.find(row => row.checkpoints > 0)` fallback.
  const withSnapshots = rows.find(row => row.checkpoints > 0)
  assert.equal(
    withSnapshots.sessionId,
    'session-live',
    'the panel fallback must not pick an unrelated session',
  )
  console.log('  ok  the panel fallback lands on the live session')
}

await fs.rm(root, { recursive: true, force: true })
console.log('\n3/3 checks passed')
