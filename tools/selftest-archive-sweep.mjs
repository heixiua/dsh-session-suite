/**
 * Bulk archive cleanup: pure logic + one real-filesystem dry/apply cycle.
 *
 * The community report was "thousands of archived sessions with 0 snapshots".
 * Those are registry marks with no session log at all, so the sweep must clear
 * them separately from real conversations. These checks use a throwaway tree;
 * nothing under DSH_HOME is touched.
 */

import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {
  sweepArchived,
  sessionLogSizes,
  snapshotIndex,
  purgeRegistryGhosts,
  registrySessionIds,
} from '../lib/cleanup.js'

const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'dss-archive-sweep-'))
let n = 0
const check = (name, fn) => { fn(); console.log(`  ${++n}. ${name}`) }

try {
  const dshHome = path.join(tmp, 'home')
  const root = path.join(dshHome, 'storages', 'dsh-session-suite')

  // Three archived ids: one real log + snapshots, one ghost mark, one with
  // snapshots but no log (an orphaned snapshot tree).
  const real = 'session-real'
  const ghost = 'session-ghost'
  const orphan = 'session-orphan-snapshots'
  const scope = path.join(dshHome, 'sessions', '--proj--')
  await fs.mkdir(path.join(scope, real), { recursive: true })
  await fs.writeFile(path.join(scope, real, 'session.v4.jsonl.zstd'), 'LOG'.repeat(100))
  await fs.mkdir(path.join(root, 'sessions', real, 'blobs'), { recursive: true })
  await fs.writeFile(path.join(root, 'sessions', real, 'index.json'), JSON.stringify({
    version: 1, checkpoints: [{ id: 'a', createdAt: 1, files: 0, bytes: 0 }],
  }))
  await fs.writeFile(path.join(root, 'sessions', real, 'blobs', 'blob-a'), 'BLOB'.repeat(50))
  await fs.mkdir(path.join(root, 'sessions', orphan, 'blobs'), { recursive: true })
  await fs.writeFile(path.join(root, 'sessions', orphan, 'index.json'), JSON.stringify({
    version: 1, checkpoints: [{ id: 'b', createdAt: 1, files: 0, bytes: 0 }],
  }))
  await fs.writeFile(path.join(root, 'sessions', orphan, 'blobs', 'blob-b'), 'X'.repeat(20))

  const archivedIds = [real, ghost, orphan]
  const sizes = await sessionLogSizes(dshHome)
  const snaps = await snapshotIndex(root)

  check('physical log detection finds only the real session', () => {
    assert.deepEqual([...sizes.keys()], [real])
  })
  check('snapshot index reads index.json counts and blob bytes', () => {
    assert.equal(snaps.get(real).checkpoints, 1)
    assert.ok(snaps.get(real).bytes > 0, 'blob bytes must be counted')
    assert.equal(snaps.get(orphan).checkpoints, 1)
  })

  const previewSessions = await sweepArchived({ dshHome, checkpointRoot: root, archivedIds, target: 'sessions', apply: false })
  check('preview does not delete anything', async () => {})
  assert.equal(previewSessions.applied, false)
  assert.equal(previewSessions.removed.length, 0)
  assert.equal(previewSessions.candidates.length, 3)
  check('preview marks the ghost separately from the real session', () => {
    const byId = Object.fromEntries(previewSessions.candidates.map(row => [row.sessionId, row]))
    assert.equal(byId[real].hasLog, true)
    assert.equal(byId[ghost].hasLog, false)
    assert.equal(byId[orphan].hasLog, false)
    assert.equal(byId[real].checkpoints, 1)
  })
  check('preview size counts logs + snapshots for target=sessions', () => {
    assert.ok(previewSessions.bytes > 0)
  })

  const previewSnapshots = await sweepArchived({ dshHome, checkpointRoot: root, archivedIds, target: 'snapshots', apply: false })
  check('target=snapshots estimates only snapshot bytes, never log bytes', () => {
    const logSize = sizes.get(real).bytes
    assert.ok(previewSnapshots.bytes < previewSessions.bytes)
    assert.equal(previewSnapshots.bytes, previewSessions.bytes - logSize)
  })

  // Apply snapshots-only on a copy so we can still exercise the sessions path.
  const removedViaHook = []
  const applied = await sweepArchived({
    dshHome, checkpointRoot: root, archivedIds, target: 'sessions', apply: true,
    removeSession: async row => { removedViaHook.push(row) },
  })
  check('apply invokes the injected per-session delete for real logs', () => {
    assert.equal(applied.applied, true)
    assert.deepEqual(applied.removed, [real, ghost, orphan])
    assert.equal(applied.failed.length, 0)
  })
  check('the hook receives full rows so ghosts can be distinguished', () => {
    const byId = Object.fromEntries(removedViaHook.map(row => [row.sessionId, row]))
    assert.equal(byId[ghost].hasLog, false)
    assert.equal(byId[real].hasLog, true)
  })

  const snapOnly = await sweepArchived({ dshHome, checkpointRoot: root, archivedIds: [real], target: 'snapshots', apply: true })
  check('snapshots-only apply removes the checkpoint directory but keeps the log', async () => {})
  assert.equal(snapOnly.removed.length, 1)
  await assert.rejects(fs.stat(path.join(root, 'sessions', real)), { code: 'ENOENT' })
  await assert.doesNotReject(fs.stat(path.join(scope, real, 'session.v4.jsonl.zstd')))

  check('a running session is skipped and reported', async () => {})
  // (async assertions below)
  const guarded = await sweepArchived({
    dshHome, checkpointRoot: root, archivedIds: [real], runningIds: [real], target: 'sessions', apply: true,
    removeSession: async () => { throw new Error('must not be called') },
  })
  assert.equal(guarded.removed.length, 0)
  assert.equal(guarded.candidates[0].skipped, 'running')

  check('limit caps the preview work set exactly, with no phantom row', async () => {})
  const limited = await sweepArchived({ dshHome, checkpointRoot: root, archivedIds, target: 'sessions', apply: false, limit: 1 })
  assert.equal(limited.truncated, true)
  assert.equal(limited.candidates.length, 1)
  const full = await sweepArchived({ dshHome, checkpointRoot: root, archivedIds, target: 'sessions', apply: false })
  assert.equal(limited.bytes, full.candidates[0].bytes, 'preview bytes must equal the first candidate only')
  assert.ok(limited.bytes <= full.bytes)

  // Registry residue: ids with no log are pruned from every array.
  const registryFile = path.join(dshHome, 'storages', 'workspace.json')
  await fs.mkdir(path.dirname(registryFile), { recursive: true })
  await fs.writeFile(registryFile, JSON.stringify({
    unit: { name: 'workspace', version: 2 },
    global: { archivedSessionIds: [ghost, real], pinnedSessionIds: [ghost] },
    tables: { workspaces: { w1: { sessionIds: [ghost, real] } } },
  }))
  const registry = JSON.parse(await fs.readFile(registryFile, 'utf8'))
  check('registrySessionIds collects ids from all arrays', () => {
    assert.deepEqual(registrySessionIds(registry).sort(), [ghost, real].sort())
  })
  const purged = await purgeRegistryGhosts(dshHome, { apply: true })
  check('purgeRegistryGhosts drops ids without a log from every array', () => {
    assert.ok(purged.deadIds.includes(ghost))
    assert.ok(!purged.deadIds.includes(real))
    assert.equal(purged.changes.archived, 1)
    assert.equal(purged.changes.pinned, 1)
    assert.equal(purged.changes.workspaceIds, 1)
  })

  console.log(`\narchive sweep selftest: ${n} checks PASS`)
} finally {
  await fs.rm(tmp, { recursive: true, force: true })
}
