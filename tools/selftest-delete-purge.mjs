/**
 * Deleting a session must also delete its MEMORY and its SNAPSHOTS.
 *
 * The existing cascade test mocks `store.purgeSession` and only asserts that the method
 * was CALLED (`removed.checkpoints === true`). That is a weaker claim than "the files are
 * gone", and the implementation sets those flags unconditionally:
 *
 *     await this.store.purgeSession(sessionId).catch(() => {})
 *     removed.checkpoints = true          // ← true even if the call threw
 *     await this.memory.purge(sessionId).catch(() => {})
 *     removed.memory = true               // ← same
 *
 * So this test writes REAL files, calls the real purge paths, and asserts on what is
 * actually left on disk. Two kinds of memory exist and both are checked:
 *
 *   • the per-session ledger (lib/memory.js, MemoryLedger) — session notes;
 *   • the long-term library (lib/memory-engine.js, MemoryEngine) — durable facts.
 *
 * The second one is the interesting case: a durable fact carries a `sessionId` of the
 * conversation that produced it, so a purge that ignores it leaves orphans behind.
 *
 * Usage: node tools/selftest-delete-purge.mjs
 */

import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { CheckpointStore } from '../lib/checkpoints.js'
import { MemoryLedger } from '../lib/memory.js'
import { MemoryEngine } from '../lib/memory-engine.js'

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'purge-test-'))
const checks = []

const doomed = 'session-doomed-0001'
const survivor = 'session-survivor-0002'
const cwd = 'D:\\AI sandbox\\dsh-sandbox\\DSH Optimize'

const store = new CheckpointStore({ root: path.join(root, 'sessions'), log: () => {} })
const ledger = new MemoryLedger({ root: path.join(root, 'memory') })
const engine = new MemoryEngine({ root: path.join(root, 'memory'), log: () => {}, config: {} })

// A real file tree so a snapshot has something to capture.
const workspace = path.join(root, 'workspace')
fs.mkdirSync(workspace, { recursive: true })
fs.writeFileSync(path.join(workspace, 'note.txt'), 'hello', 'utf8')

for (const sessionId of [doomed, survivor]) {
  await store.capture({
    sessionId,
    cwd: workspace,
    seq: 1,
    turn: 1,
    phase: 'end',
    kind: 'auto',
    label: 'after turn 1',
    limits: { keep: 10 },
  })
  await ledger.add(sessionId, { text: `session note for ${sessionId}`, tags: ['test'] })
  await engine.remember({
    scope: 'workspace',
    cwd,
    text: `durable fact from ${sessionId}`,
    source: 'test',
    sessionId,
  })
}

const before = {
  doomedSnapshots: (await store.list(doomed)).length,
  survivorSnapshots: (await store.list(survivor)).length,
  doomedNotes: (await ledger.list(doomed)).length,
  durableTotal: (await engine.list({ cwd })).length,
}

console.log('=== before purge ===')
console.log(`  ${doomed}: ${before.doomedSnapshots} snapshot(s), ${before.doomedNotes} session note(s)`)
console.log(`  ${survivor}: ${before.survivorSnapshots} snapshot(s)`)
console.log(`  durable facts in the workspace library: ${before.durableTotal}`)

assert.equal(before.doomedSnapshots > 0, true, 'the doomed session must have a snapshot to delete')
assert.equal(before.doomedNotes > 0, true, 'the doomed session must have a session note to delete')
assert.equal(before.durableTotal >= 2, true, 'both sessions must have written a durable fact')

// ---------------------------------------------------------------- purge
const checkpointResult = await store.purgeSession(doomed)
const ledgerResult = await ledger.purge(doomed)

console.log('\n=== purge results ===')
console.log(`  checkpoints: ${JSON.stringify(checkpointResult)}`)
console.log(`  ledger     : ${JSON.stringify(ledgerResult)}`)

const after = {
  doomedSnapshots: (await store.list(doomed)).length,
  survivorSnapshots: (await store.list(survivor)).length,
  doomedNotes: (await ledger.list(doomed)).length,
  durableTotal: (await engine.list({ cwd })).length,
}

console.log('\n=== after purge ===')
console.log(`  ${doomed}: ${after.doomedSnapshots} snapshot(s), ${after.doomedNotes} session note(s)`)
console.log(`  ${survivor}: ${after.survivorSnapshots} snapshot(s)`)
console.log(`  durable facts in the workspace library: ${after.durableTotal}`)

// ---------------------------------------------------------------- assertions
{
  assert.equal(after.doomedSnapshots, 0, `snapshots must be gone, found ${after.doomedSnapshots}`)
  const dir = path.join(root, 'sessions', doomed)
  assert.equal(fs.existsSync(dir), false, `the snapshot directory must not exist: ${dir}`)
  checks.push('snapshots are removed from disk, directory included')
}

{
  assert.equal(after.doomedNotes, 0, `session notes must be gone, found ${after.doomedNotes}`)
  checks.push('per-session memory ledger is removed')
}

{
  assert.equal(
    after.survivorSnapshots,
    before.survivorSnapshots,
    `the surviving session must keep its snapshots (${before.survivorSnapshots} -> ${after.survivorSnapshots})`,
  )
  checks.push('a different session keeps its snapshots')
}

// The durable library must now be purged too. Before 0.8.2 it was not: deleting a
// session removed the per-session ledger but left its durable facts behind as orphans —
// still injected into later prompts, unattributable once the session was gone.
{
  const purged = await engine.purgeSession(doomed)
  console.log(`\n  engine.purgeSession(${doomed}) -> ${JSON.stringify(purged)}`)
  assert.equal(
    purged.removed > 0,
    true,
    `the doomed session's durable facts must be removed, removed=${purged.removed}`,
  )

  const after2 = {
    doomedFacts: (await engine.list({ cwd })).filter(entry => entry.sessionId === doomed).length,
    survivorFacts: (await engine.list({ cwd })).filter(entry => entry.sessionId === survivor).length,
  }
  assert.equal(after2.doomedFacts, 0, `the doomed session's facts must be gone, found ${after2.doomedFacts}`)
  // And the other session's facts must survive: a purge that removes everything would
  // pass the check above and fail this one.
  assert.equal(after2.survivorFacts > 0, true, 'the surviving session must keep its facts')
  checks.push('durable facts of the deleted session are purged, other sessions spared')
}

console.log(`\n${checks.map((line, index) => `  ${index + 1}. ${line}`).join('\n')}`)
console.log(`\n${checks.length}/${checks.length} checks passed`)

fs.rmSync(root, { recursive: true, force: true })
