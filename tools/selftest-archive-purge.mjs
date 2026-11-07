/**
 * Retention purge: archived rows must eventually be HARD-DELETED, but safely.
 *
 * The engine used to only ever lower a score and move rows into cold storage —
 * nothing was ever removed, so `list()` kept counting archived rows forever and
 * the user saw a library that only grew. This pins the replacement behaviour:
 *
 *   1. a cold row older than archiveRetentionDays is really deleted from disk;
 *   2. a row inside the retention window is NOT deleted, and freezing it
 *      restores it to the live pool (the "undo window" is real);
 *   3. frozen / secret / lesson-tagged / summary / explicitly pinned rows are
 *      never deleted — they are reported as skipped with a reason; (a plain
 *      high-affect row is NOT protected: 0.85 is the default tool-write affect)
 *   4. a row with NO archivedAt is backfilled on first sight and never deleted
 *      in that pass (this is what protects the 20 pre-existing archived rows on
 *      the day the feature is deployed);
 *   5. purge() is a DRY RUN by default; only apply:true writes;
 *   6. needsMaintenance() fires on a time gate even when the live fingerprint is
 *      unchanged (deleting a cold row does not dirty the fingerprint);
 *   7. the first real deletion backs up the cold files;
 *   8. repeated purges are idempotent; remove()/purgeSession() still work.
 *
 * Usage: node tools/selftest-archive-purge.mjs
 */

import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { MemoryEngine } from '../lib/memory-engine.js'

const checks = []
const DAY = 86400000
const ROOT = await fs.mkdtemp(path.join(os.tmpdir(), 'purge-test-'))
const CWD = path.join(ROOT, 'ws')
await fs.mkdir(CWD, { recursive: true })

const CONFIG = {
  decayDays: 30,
  newMemoryGraceDays: 7,
  maxUnusedDays: 90,
  archiveRetentionDays: 30,
  archivePurgeEnabled: true,
  purgeCheckIntervalMs: DAY,
  maxActiveEntries: 0, // capacity eviction is tested in its own selftest
  evictTarget: 0,
  maxTotalEntries: 0,
}

/** @returns {MemoryEngine} a fresh engine over an isolated sub-root */
let seq = 0
function engine() {
  seq += 1
  return new MemoryEngine({ root: path.join(ROOT, `case${seq}`), config: CONFIG })
}

/** Cold-store path for a scope. `e.root` already ends with /memory. */
function coldFile(root, scope, cwd) {
  return scope === 'global'
    ? path.join(root, 'cold', 'global.json')
    : path.join(root, 'cold', `${MemoryEngine.workspaceKey(cwd)}.json`)
}

/** Write a cold store directly, so archivedAt can be backdated precisely. */
async function setCold(e, scope, cwd, entries) {
  const file = coldFile(e.root, scope, cwd)
  await fs.mkdir(path.dirname(file), { recursive: true })
  await fs.writeFile(file, JSON.stringify({ version: 2, scope, entries }, null, 2), 'utf8')
  return file
}

/** Read a cold store directly. */
async function getCold(e, scope, cwd) {
  try {
    return JSON.parse(await fs.readFile(coldFile(e.root, scope, cwd), 'utf8'))
  } catch {
    return { version: 2, scope, entries: [] }
  }
}

/** A plain, UNPROTECTED archived row. Returns a fresh object each time. */
function archived(id, overrides = {}) {
  const at = Date.now() - 40 * DAY
  return {
    id, scope: 'global', workspaceKey: 'global', text: `待清理的归档记忆 ${id}`,
    kind: 'fact', tags: [], affect: 0.4, frozen: false, state: 'archived',
    accessCount: 1, createdAt: at, lastAccessAt: at, sessionId: null,
    source: 'test', digest: id, clusterId: null, summary: null,
    privacy: 'internal', score: 0.2, archivedAt: at,
    ...overrides,
  }
}

// ------------------------------------------------------------------ 1. expired is deleted
{
  const e = engine()
  const old = archived('expired-1', { archivedAt: Date.now() - 40 * DAY })
  await setCold(e, 'global', CWD, [old, archived('fresh-1', { archivedAt: Date.now() - 2 * DAY })])

  const dry = await e.purge({ cwd: CWD })
  assert.equal(dry.applied, false, 'purge() must be a dry run by default')
  assert.equal(dry.wouldPurge, 1, `dry run must report the one expired row, got ${dry.wouldPurge}`)
  assert.equal((await getCold(e, 'global', CWD)).entries.length, 2, 'dry run must not write anything')

  const applied = await e.purge({ cwd: CWD, apply: true })
  assert.equal(applied.applied, true)
  assert.equal(applied.purged, 1, `exactly one row deleted, got ${applied.purged}`)
  const remaining = (await getCold(e, 'global', CWD)).entries.map(row => row.id)
  assert.deepEqual(remaining, ['fresh-1'], 'only the expired row is gone from disk')
  assert.equal(applied.purgedRows[0].id, 'expired-1', 'the deleted id is reported')
  assert.ok(typeof applied.purgedRows[0].reason === 'string', 'the delete reason is reported')
  assert.ok(applied.backupDir && typeof applied.backupDir === 'string', 'a backup directory was created')

  // REGRESSION GUARD: the backup must be taken BEFORE #writeCold (an atomic
  // temp+rename). If the order is reversed, the backup holds only the SURVIVORS
  // and the purged row is unrecoverable. Assert the CONTENT, not just that the
  // directory exists — a directory-only assertion passed while the bug was live.
  const backupFiles = await fs.readdir(applied.backupDir)
  assert.ok(backupFiles.length > 0, 'the backup directory is not empty')
  let backupText = ''
  for (const name of backupFiles) {
    backupText += await fs.readFile(path.join(applied.backupDir, name), 'utf8')
  }
  assert.ok(
    backupText.includes('expired-1'),
    'the backup must contain the PURGED row so it can be restored',
  )
  assert.ok(backupText.includes('fresh-1'), 'and it must contain the surviving row too (pre-deletion snapshot)')
  checks.push('an expired archived row is really deleted; the backup holds the pre-deletion rows')
}

// ------------------------------------------------------------------ 2. undo window + restore
{
  const e = engine()
  const fresh = archived('undo-1', { archivedAt: Date.now() - 5 * DAY })
  await setCold(e, 'global', CWD, [fresh])

  const applied = await e.purge({ cwd: CWD, apply: true })
  assert.equal(applied.purged, 0, 'a row inside the retention window must survive')
  assert.equal((await getCold(e, 'global', CWD)).entries.length, 1)

  // Freezing an archived row restores it to the live pool (pre-existing update()).
  const restored = await e.update({ id: 'undo-1', scope: 'global', patch: { frozen: true } })
  assert.equal(restored.state, 'active', 'freezing restores the archived row')
  const live = await e.list({ cwd: CWD, scope: 'global' })
  assert.ok(live.some(row => row.id === 'undo-1' && row.archived !== true), 'restored row is live again')
  checks.push('the retention window is a real undo window (freeze restores)')
}

// ------------------------------------------------------------------ 3. protection whitelist
{
  const e = engine()
  const old = { archivedAt: Date.now() - 40 * DAY }
  await setCold(e, 'global', CWD, [
    archived('p-frozen', { ...old, frozen: true }),
    archived('p-secret', { ...old, privacy: 'secret' }),
    archived('p-lesson', { ...old, tags: ['错误教训'] }),
    archived('p-lesson2', { ...old, tags: ['pitfall'] }),
    archived('p-summary', { ...old, summary: true }),
    archived('p-pinned', { ...old, protected: true }),
  ])

  const applied = await e.purge({ cwd: CWD, apply: true })
  assert.equal(applied.purged, 0, 'no protected row may be deleted')
  assert.equal(applied.purgeProtectedSkipped, 6, `all 6 must be reported skipped, got ${applied.purgeProtectedSkipped}`)
  const reasons = applied.skippedProtected.map(row => row.reason)
  for (const reason of ['frozen', 'secret', 'lesson', 'summary', 'explicit']) {
    assert.ok(reasons.includes(reason), `reason ${reason} must appear in the report: ${reasons.join(',')}`)
  }
  assert.equal((await getCold(e, 'global', CWD)).entries.length, 6, 'all protected rows remain on disk')
  checks.push('frozen/secret/lesson/summary/pinned rows are never deleted')
}

// ------------------------------------------------------------------ 3a. high-affect is NOT protected
{
  // 0.85 is the DEFAULT affect for tool/explicit writes (memory-host.js L196/L427).
  // Treating it as protection made ~36% of the real library permanently immune
  // to eviction/purge. A plain high-affect archived row must be purgeable; affect
  // remains a scoring input (slower decay), not an immunity grant.
  const e = engine()
  const high = archived('p-high', { archivedAt: Date.now() - 40 * DAY, affect: 0.9 })
  await setCold(e, 'global', CWD, [high])
  const applied = await e.purge({ cwd: CWD, apply: true })
  assert.equal(applied.purged, 1, 'an expired high-affect row is purgeable')
  assert.equal(applied.purgeProtectedSkipped, 0, 'it is NOT reported as protected')
  checks.push('a plain high-affect (0.9) row is purgeable — affect is not immunity')
}

// ------------------------------------------------------------------ 3b. cluster members ARE purgeable
{
  // A cluster member's live summary stands in for it, so retaining the original
  // forever would defeat the purge. This is the flip side of the whitelist above.
  const e = engine()
  const member = archived('cluster-member-1', { archivedAt: Date.now() - 40 * DAY, clusterId: 'cluster_x' })
  await setCold(e, 'global', CWD, [member])
  const applied = await e.purge({ cwd: CWD, apply: true })
  assert.equal(applied.purged, 1, 'an expired cluster member is purgeable')
  assert.equal(applied.purgeProtectedSkipped, 0, 'it is not reported as protected')
  checks.push('an archived cluster member is purgeable (its live summary stands in for it)')
}

// ------------------------------------------------------------------ 4. missing archivedAt backfill
{
  const e = engine()
  const legacy = archived('legacy-1')
  delete legacy.archivedAt // simulate a row written by an older build
  await setCold(e, 'global', CWD, [legacy])

  const first = await e.purge({ cwd: CWD, apply: true })
  assert.equal(first.purged, 0, 'a legacy row must NOT be deleted on first sight')
  assert.equal(first.purgeBackfilled, 1, 'it is reported as backfilled')
  assert.equal(first.backfilled[0].id, 'legacy-1')
  const stored = (await getCold(e, 'global', CWD)).entries[0]
  assert.equal(typeof stored.archivedAt, 'number', 'archivedAt is now stamped on disk')
  assert.ok(Date.now() - stored.archivedAt < 60_000, 'the stamp is ~now, i.e. a full fresh window')

  // Backdate the freshly stamped row past the retention window and purge again.
  stored.archivedAt = Date.now() - 40 * DAY
  await setCold(e, 'global', CWD, [stored])
  const second = await e.purge({ cwd: CWD, apply: true })
  assert.equal(second.purged, 1, 'after a full window it can be deleted')
  assert.equal(second.purgeBackfilled, 0, 'no second backfill')
  checks.push('missing archivedAt is backfilled (never deleted on upgrade day)')
}

// ------------------------------------------------------------------ 5. idempotence
{
  const e = engine()
  await setCold(e, 'global', CWD, [archived('idem-1', { archivedAt: Date.now() - 40 * DAY })])
  const a = await e.purge({ cwd: CWD, apply: true })
  const b = await e.purge({ cwd: CWD, apply: true })
  assert.equal(a.purged, 1)
  assert.equal(b.purged, 0, 'a second purge finds nothing to delete')
  assert.equal((await getCold(e, 'global', CWD)).entries.length, 0)
  checks.push('the purge is idempotent')
}

// ------------------------------------------------------------------ 6. time gate in needsMaintenance
{
  const e = engine()
  await e.remember({ scope: 'workspace', cwd: CWD, text: '库里有一条正常记忆用于指纹' })
  await e.maintain(CWD) // sets lastMaintainedAt + lastPurgeAt = now
  assert.equal(await e.needsMaintenance(CWD), false, 'a clean library is quiet')

  // Pretend the last purge check was two days ago. The live fingerprint is
  // UNCHANGED, so only the time branch can make the pass due.
  const statusFile = path.join(e.root, 'maintenance.json')
  const status = JSON.parse(await fs.readFile(statusFile, 'utf8'))
  status.lastPurgeAt = Date.now() - 2 * DAY
  await fs.writeFile(statusFile, JSON.stringify(status), 'utf8')
  assert.equal(
    await e.needsMaintenance(CWD),
    true,
    'a wall-clock purge check must fire even with an unchanged fingerprint',
  )

  // A purge (cold-only deletion) must not leave the library looking dirty.
  const fp = status.lastFingerprint
  await e.purge({ cwd: CWD, apply: true })
  const after = JSON.parse(await fs.readFile(statusFile, 'utf8'))
  assert.equal(after.lastFingerprint, fp, 'deleting cold rows must not change the live fingerprint')
  checks.push('needsMaintenance has a time gate; cold deletion does not dirty the library')
}

// ------------------------------------------------------------------ 7. empty library stays quiet
{
  const e = engine()
  assert.equal(await e.needsMaintenance(CWD), false, 'an empty library never wakes the timer')
  checks.push('an empty library stays quiet (original invariant preserved)')
}

// ------------------------------------------------------------------ 8. list() counts archived + purgeDueAt
{
  const e = engine()
  const at = Date.now() - 10 * DAY
  await setCold(e, 'global', CWD, [archived('visible-1', { archivedAt: at })])
  const rows = await e.list({ cwd: CWD })
  assert.equal(rows.length, 1, 'archived rows ARE counted by list() — this is the 96/97 complaint')
  assert.equal(rows[0].archived, true)
  assert.equal(rows[0].score, 0, 'archived rows are scored 0 and never auto-injected')
  const expected = at + CONFIG.archiveRetentionDays * DAY
  assert.equal(rows[0].purgeDueAt, expected, 'the retention deadline is visible for inspection')
  checks.push('list() counts archived rows and exposes purgeDueAt')
}

// ------------------------------------------------------------------ 9. remove()/purgeSession() unaffected
{
  const e = engine()
  await setCold(e, 'global', CWD, [
    archived('rm-1', { archivedAt: Date.now() - 2 * DAY, sessionId: 'doomed' }),
    archived('rm-2', { archivedAt: Date.now() - 2 * DAY, sessionId: 'survivor' }),
  ])
  await e.remove({ scope: 'global', id: 'rm-1' })
  assert.equal((await getCold(e, 'global', CWD)).entries.length, 1, 'remove() still deletes one cold row')
  // purgeSession() only reaches the cold store when the live store has a matching
  // row (it returns early on an empty live store), so give it one.
  await e.remember({ scope: 'global', text: '该会话的活记忆', sessionId: 'survivor' })
  const purged = await e.purgeSession('survivor')
  assert.ok(purged.removed >= 1, 'purgeSession() still removes a session from cold')
  assert.equal((await getCold(e, 'global', CWD)).entries.length, 0, 'the session cold row is gone too')
  checks.push('remove() and purgeSession() still work after a purge')
}

// ------------------------------------------------------------------ 10. maintenance report is observable
{
  const e = engine()
  await setCold(e, 'global', CWD, [archived('auto-1', { archivedAt: Date.now() - 40 * DAY })])
  const report = await e.maintain(CWD)
  assert.equal(report.purged, 1, 'the automatic maintenance pass purges too (no new timer)')
  assert.ok(Array.isArray(report.purgedRows) && report.purgedRows.length === 1, 'the report lists what was purged')
  assert.ok(typeof report.purgeBackupDir === 'string', 'the report names the backup')
  checks.push('the 30-minute maintenance pass purges with a full audit trail')
}

await fs.rm(ROOT, { recursive: true, force: true })
console.log(checks.map((line, index) => `  ${index + 1}. ${line}`).join('\n'))
console.log(`\n${checks.length}/${checks.length} checks passed`)
