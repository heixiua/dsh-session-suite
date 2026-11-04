/**
 * Regression test for the delete cascade: previewDelete, subagent descendants,
 * the "validate all, then touch" refusal, and the descendants-first order.
 *
 * The Host is replaced by a fake ctx (a sessionController whose list() returns
 * a fixed set of summaries, a workspaceController that records archives), and
 * DSH_HOME points at a throwaway tree, so the real on-disk deletion path runs
 * without a Host.
 *
 * Usage: node tools/selftest-delete-cascade.mjs
 */
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { SessionSuiteService } from '../lib/service.js'
import { CheckpointStore } from '../lib/checkpoints.js'

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'delete-cascade-'))
const home = path.join(root, 'home')
const data = path.join(root, 'data')
const workspace = path.join(root, 'workspace')
process.env.DSH_HOME = home
await fs.mkdir(workspace, { recursive: true })
await fs.writeFile(path.join(workspace, 'a.txt'), 'v1\n')

const checks = []
const ok = description => {
  checks.push(description)
  console.log(`  ok  ${description}`)
}

const exists = async target => {
  try {
    await fs.stat(target)
    return true
  } catch {
    return false
  }
}

const sessionDirOf = sessionId => path.join(home, 'sessions', '--workspace--', sessionId)
const cacheOf = sessionId => path.join(home, 'storages', 'session_projcache', 'sessions', `${sessionId}.json`)
const onDisk = async sessionId => {
  await fs.mkdir(sessionDirOf(sessionId), { recursive: true })
  await fs.writeFile(path.join(sessionDirOf(sessionId), 'session.v4.jsonl.zstd'), 'log')
  await fs.mkdir(path.dirname(cacheOf(sessionId)), { recursive: true })
  await fs.writeFile(cacheOf(sessionId), '{}')
}
const summary = (sessionId, extra = {}) => ({ sessionId, running: false, updatedAt: Date.now(), cwd: workspace, ...extra })

const ROOT = 'session-root'
const SUB_A = 'session-sub-a'
const SUB_B = 'session-sub-b'
const FORK = 'session-fork' // a rewind fork: has a parentSessionId, is NOT a subagent
const OTHER = 'session-other'
const RUN_SUB = 'session-sub-run'
const CYCLE_A = 'session-cycle-a'
const CYCLE_B = 'session-cycle-b'
const SUB_MISSING = 'session-sub-missing' // listed as a subagent, but has no files on disk
const LONE = 'session-lone'
const GONE = 'session-already-gone'

const store = new CheckpointStore({ root: data })
// Record the order in which sessions are actually purged; that is the delete order.
const purgeOrder = []
const storePurge = store.purgeSession.bind(store)
store.purgeSession = async sessionId => {
  purgeOrder.push(sessionId)
  return storePurge(sessionId)
}

const archived = []
const memoryPurged = []
let controller = { list: async () => ({ items: [] }) }
const ctx = {
  get(name) {
    if (name === 'sessionController') return controller
    if (name === 'workspaceController') {
      return {
        archiveSession: async sessionId => {
          archived.push(sessionId)
        },
        unarchiveSession: async () => {},
      }
    }
    return undefined
  },
  emit: () => {},
}
const memory = {
  list: async () => [],
  purge: async sessionId => {
    memoryPurged.push(sessionId)
  },
  snapshot: async () => [],
  restore: async () => {},
  trimTo: async () => ({ removed: 0, kept: 0 }),
  clone: async () => ({ copied: 0 }),
}
const service = new SessionSuiteService({ ctx, root: data, store, memory, log: () => {}, config: { keep: 10 } })
const reset = () => {
  purgeOrder.length = 0
  archived.length = 0
  memoryPurged.length = 0
}

// 1. previewDelete walks two levels of subagents and counts them.
{
  reset()
  controller = {
    list: async () => ({
      items: [
        summary(ROOT, { projections: { values: { title: 'Root chat' } } }),
        summary(SUB_A, { origin: 'subagent', parentSessionId: ROOT, cwd: '/tmp/sub-a' }),
        summary(SUB_B, { origin: 'subagent', parentSessionId: SUB_A, cwd: '/tmp/sub-b' }),
      ],
    }),
  }
  const preview = await service.previewDelete(ROOT)
  assert.deepEqual(preview.subagents.map(entry => entry.sessionId).sort(), [SUB_A, SUB_B])
  assert.equal(preview.totalSessions, 3, 'the session and both subagents are counted')
  assert.equal(preview.title, 'Root chat')
  assert.equal(preview.subagents.find(entry => entry.sessionId === SUB_B).title, '/tmp/sub-b')
  assert.equal(preview.running, false)
  assert.equal(preview.willRefuse, false)
  assert.equal(preview.refuseReason, null)
  ok('previewDelete lists subagents two levels deep')
}

// 2. Core regression, pitfalls.md #48: a forked conversation has a parent but
//    is not a subagent, and must not be swept into a cascade.
{
  reset()
  controller = {
    list: async () => ({
      items: [
        summary(ROOT),
        summary(SUB_A, { origin: 'subagent', parentSessionId: ROOT }),
        summary(FORK, { parentSessionId: ROOT }),
        summary(OTHER),
      ],
    }),
  }
  const preview = await service.previewDelete(ROOT)
  assert.deepEqual(preview.subagents.map(entry => entry.sessionId), [SUB_A])
  assert.equal(
    preview.subagents.some(entry => entry.sessionId === FORK),
    false,
    'a rewind fork carries a parentSessionId but is a conversation, not a subagent',
  )
  assert.equal(preview.subagents.some(entry => entry.sessionId === OTHER), false, 'unrelated sessions are not descendants')
  ok('previewDelete ignores a forked conversation that only has a parentSessionId')
}

// 3. A running session refuses itself.
{
  reset()
  controller = { list: async () => ({ items: [summary(ROOT, { running: true })] }) }
  const preview = await service.previewDelete(ROOT)
  assert.equal(preview.running, true)
  assert.equal(preview.willRefuse, true)
  assert.equal(preview.refuseReason, 'session-running')
  ok('previewDelete refuses a running session')
}

// 4. A running subagent is what makes the cascade refuse.
{
  reset()
  controller = {
    list: async () => ({
      items: [
        summary(ROOT),
        summary(SUB_A, { origin: 'subagent', parentSessionId: ROOT }),
        summary(RUN_SUB, { origin: 'subagent', parentSessionId: ROOT, running: true }),
      ],
    }),
  }
  const preview = await service.previewDelete(ROOT)
  assert.equal(preview.running, false, 'the requested session itself is idle')
  assert.equal(preview.willRefuse, true)
  assert.equal(preview.refuseReason, 'subagent-running')
  assert.equal(
    preview.subagents.find(entry => entry.sessionId === RUN_SUB).running,
    true,
    'the preview names the subagent that has to stop',
  )
  ok('previewDelete refuses when a descendant subagent is running')
}

// 5. Validate all, then touch: a running descendant refuses the whole delete
//    and not one byte is removed.
{
  reset()
  for (const id of [ROOT, SUB_A, RUN_SUB]) await onDisk(id)
  await store.capture({ sessionId: ROOT, cwd: workspace, seq: 1, turn: 0, kind: 'auto', label: 'baseline' })
  await store.capture({ sessionId: SUB_A, cwd: workspace, seq: 1, turn: 0, kind: 'auto', label: 'baseline' })
  await store.capture({ sessionId: RUN_SUB, cwd: workspace, seq: 1, turn: 0, kind: 'auto', label: 'baseline' })
  controller = {
    list: async () => ({
      items: [summary(ROOT), summary(SUB_A, { origin: 'subagent', parentSessionId: ROOT }), summary(RUN_SUB, { origin: 'subagent', parentSessionId: ROOT, running: true })],
    }),
  }
  await assert.rejects(
    () => service.deleteSession(ROOT),
    error => {
      assert.equal(error.code, 'session-running')
      assert.equal(error.sessionId, RUN_SUB, 'the refusal names the running subagent')
      return true
    },
  )
  assert.equal(await exists(sessionDirOf(ROOT)), true, 'the session directory survives a refusal')
  assert.equal(await exists(sessionDirOf(SUB_A)), true, 'the idle subagent directory survives a refusal')
  assert.equal(await exists(sessionDirOf(RUN_SUB)), true, 'the running subagent directory survives a refusal')
  assert.equal(await exists(cacheOf(ROOT)), true, 'the projection cache survives a refusal')
  assert.equal((await store.list(ROOT)).length, 1, 'the session snapshots survive a refusal')
  assert.equal(await exists(store.sessionDir(SUB_A)), true, 'the idle subagent snapshot directory survives a refusal')
  assert.equal(purgeOrder.length, 0, 'nothing was purged before the validation finished')
  assert.equal(archived.length, 0, 'nothing was even retired from the sidebar')
  assert.equal(memoryPurged.length, 0, 'no memory ledger was trimmed')
  ok('a running descendant refuses the cascade and deletes nothing')
}

// 6. The cascade deletes descendants first and the parent last, and leaves a
//    forked conversation alone.
{
  reset()
  for (const id of [ROOT, SUB_A, SUB_B, FORK]) await onDisk(id)
  controller = {
    list: async () => ({
      items: [
        summary(ROOT),
        summary(SUB_A, { origin: 'subagent', parentSessionId: ROOT }),
        summary(SUB_B, { origin: 'subagent', parentSessionId: SUB_A }),
        summary(FORK, { parentSessionId: ROOT }),
      ],
    }),
  }
  const removed = await service.deleteSession(ROOT)
  assert.deepEqual(purgeOrder, [SUB_B, SUB_A, ROOT], 'deepest descendant first, parent last')
  assert.deepEqual(removed.removedSubagents.map(entry => entry.sessionId), [SUB_B, SUB_A])
  assert.equal(removed.removedSubagents[0].checkpoints, true)
  assert.equal(removed.refused.length, 0)
  assert.equal(removed.checkpoints, true, 'the legacy checkpoints field keeps its meaning')
  assert.equal(removed.memory, true, 'the legacy memory field keeps its meaning')
  assert.equal(removed.sessionFiles.length, 1, 'the legacy sessionFiles field keeps its meaning')
  assert.equal(removed.projectionCache.length, 1, 'the legacy projectionCache field keeps its meaning')
  // The fake controller list is static and keeps answering with the row, so
  // `stillListed` reports exactly that, as it always has.
  assert.equal(removed.stillListed, true)
  assert.equal(await exists(sessionDirOf(ROOT)), false, 'the session directory is gone')
  assert.equal(await exists(store.sessionDir(SUB_A)), false, 'the subagent snapshots are gone')
  assert.equal(await exists(sessionDirOf(FORK)), true, 'a forked conversation is not part of the cascade')
  ok('cascade deletes descendants before the parent and spares a forked conversation')
}

// 7. A parent cycle terminates instead of recursing forever.
{
  reset()
  for (const id of [CYCLE_A, CYCLE_B]) await onDisk(id)
  controller = {
    list: async () => ({
      items: [
        summary(CYCLE_A, { origin: 'subagent', parentSessionId: CYCLE_B }),
        summary(CYCLE_B, { origin: 'subagent', parentSessionId: CYCLE_A }),
      ],
    }),
  }
  const preview = await service.previewDelete(CYCLE_A)
  assert.deepEqual(preview.subagents.map(entry => entry.sessionId), [CYCLE_B])
  assert.equal(preview.totalSessions, 2)
  const removed = await service.deleteSession(CYCLE_A)
  assert.deepEqual(purgeOrder, [CYCLE_B, CYCLE_A])
  assert.deepEqual(removed.removedSubagents.map(entry => entry.sessionId), [CYCLE_B])
  ok('a cyclic parent link does not loop forever')
}

// 8. No subagents: the result is the old one plus two empty arrays.
{
  reset()
  await onDisk(LONE)
  controller = { list: async () => ({ items: [summary(LONE)] }) }
  const removed = await service.deleteSession(LONE)
  assert.deepEqual(removed.removedSubagents, [], 'nothing was cascaded')
  assert.deepEqual(removed.refused, [], 'nothing failed')
  assert.equal(removed.sessionFiles.length, 1)
  assert.equal(await exists(cacheOf(LONE)), false, 'the projection cache is gone')
  assert.deepEqual(memoryPurged, [LONE], 'the memory ledger is purged')
  assert.equal(await exists(sessionDirOf(LONE)), false)
  ok('a session without subagents deletes exactly like before')
}

// 9. cascade: false deletes only the session itself.
{
  reset()
  for (const id of [ROOT, SUB_A]) await onDisk(id)
  controller = {
    list: async () => ({ items: [summary(ROOT), summary(SUB_A, { origin: 'subagent', parentSessionId: ROOT })] }),
  }
  const removed = await service.deleteSession(ROOT, { cascade: false })
  assert.deepEqual(removed.removedSubagents, [])
  assert.deepEqual(purgeOrder, [ROOT])
  assert.equal(await exists(sessionDirOf(SUB_A)), true, 'the subagent is left in place on request')
  ok('cascade can be turned off')
}

// 10. A listed subagent with no files on disk is reported, not fatal.
{
  reset()
  await onDisk(ROOT)
  controller = {
    list: async () => ({ items: [summary(ROOT), summary(SUB_MISSING, { origin: 'subagent', parentSessionId: ROOT })] }),
  }
  const removed = await service.deleteSession(ROOT)
  assert.deepEqual(removed.removedSubagents, [])
  assert.deepEqual(
    removed.refused.map(entry => entry.sessionId),
    [SUB_MISSING],
    'a subagent that could not be removed is reported instead of silently dropped',
  )
  assert.ok(removed.refused[0].reason.length > 0)
  assert.equal(await exists(sessionDirOf(ROOT)), false, 'the parent still deletes')
  ok('partial failures are reported in refused')
}

// 11. The old failure mode is unchanged: a session with no stored files still throws.
{
  reset()
  controller = { list: async () => ({ items: [summary(GONE)] }) }
  await assert.rejects(() => service.deleteSession(GONE), /no stored session files were found to delete/)
  ok('a session with no stored files still throws')
}

await fs.rm(root, { recursive: true, force: true })
console.log(`\n${checks.length}/${checks.length} checks passed`)
