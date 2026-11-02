/**
 * Prove that a forked session keeps its parent's snapshot history.
 *
 * Deleting a turn and rewinding both work by forking the event prefix and
 * retiring the original. Snapshots are stored per session id, so a fork used to
 * start with an empty panel: the continuation had no earlier state to restore
 * even though the conversation it continued did. This test pins both halves —
 * the snapshots arrive, and they can still restore real files.
 *
 * Usage: node tools/selftest-inherit.mjs
 */

import assert from 'node:assert/strict'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { CheckpointStore } from '../lib/checkpoints.js'

const checks = []
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-inherit-'))
const workspace = path.join(root, 'workspace')
fs.mkdirSync(workspace, { recursive: true })
const dataRoot = path.join(root, 'data')
const store = new CheckpointStore({ root: dataRoot, log: () => {} })

const parent = 'session-parent-1111'
const child = 'session-child-2222'

// 1. A parent with no snapshots hands nothing over. A fork of an empty session
//    must not invent history.
{
  const empty = await store.inherit({ from: parent, to: child })
  assert.equal(empty.inherited, 0)
  checks.push('an empty parent hands over nothing')
}

// 2. Build real history: two turns, each changing the tree.
{
  fs.writeFileSync(path.join(workspace, 'a.txt'), 'v1\n')
  await store.capture({ sessionId: parent, cwd: workspace, seq: 4, turn: 1, kind: 'auto' })
  fs.writeFileSync(path.join(workspace, 'a.txt'), 'v2\n')
  fs.writeFileSync(path.join(workspace, 'b.txt'), 'from turn 2\n')
  await store.capture({ sessionId: parent, cwd: workspace, seq: 9, turn: 2, kind: 'auto' })
  assert.equal((await store.list(parent)).length, 2)
  checks.push('parent recorded two snapshots')
}

// 3. The fork inherits them.
{
  const result = await store.inherit({ from: parent, to: child })
  assert.equal(result.inherited, 2, `expected 2 inherited, got ${result.inherited}`)
  const inherited = await store.list(child)
  assert.equal(inherited.length, 2, 'the fork sees its own copies')
  assert.deepEqual(
    inherited.map(item => item.turn).sort((a, b) => a - b),
    [1, 2],
    'the inherited snapshots keep their turns',
  )
  assert.equal(inherited.every(item => item.sessionId === child), true, 'they belong to the fork now')
  assert.equal(inherited.every(item => item.inheritedFrom === parent), true, 'provenance is recorded')
  checks.push('the fork inherits every snapshot')
}

// 4. Inherited blobs are shared, not duplicated. Content-addressed blobs are
//    immutable, so a hard link is the right currency here; copying would
//    multiply every snapshot by the number of forks.
{
  const result = await store.inherit({ from: parent, to: child })
  assert.equal(result.copied, 0, 'blobs must be linked, not copied')
  checks.push('blobs are shared instead of duplicated')
}

// 5. Inherited snapshots restore real files in the child's context. This is the
//    part that matters: the panel being populated is worthless if restore
//    cannot read the bytes.
{
  fs.writeFileSync(path.join(workspace, 'a.txt'), 'v3 after fork\n')
  fs.rmSync(path.join(workspace, 'b.txt'), { force: true })
  const target = (await store.list(child)).find(item => item.turn === 1)
  const outcome = await store.restore({ sessionId: child, checkpointId: target.id })
  assert.equal(outcome.written > 0, true, 'restore must write files')
  assert.equal(await fsp.readFile(path.join(workspace, 'a.txt'), 'utf8'), 'v1\n', 'turn 1 content comes back')
  assert.equal(fs.existsSync(path.join(workspace, 'b.txt')), false, 'a file from a later turn stays gone')
  checks.push('inherited snapshots restore real files')
}

// 6. A rewind carries only snapshots up to its cut point. Snapshots taken after
//    the cut describe a workspace the child never inherited.
{
  const partialRoot = path.join(root, 'partial')
  const partialStore = new CheckpointStore({ root: partialRoot, log: () => {} })
  const source = 'session-source-3333'
  const forked = 'session-forked-4444'
  fs.writeFileSync(path.join(workspace, 'c.txt'), 'one\n')
  await partialStore.capture({ sessionId: source, cwd: workspace, seq: 5, turn: 1, kind: 'auto' })
  fs.writeFileSync(path.join(workspace, 'c.txt'), 'two\n')
  await partialStore.capture({ sessionId: source, cwd: workspace, seq: 11, turn: 2, kind: 'auto' })
  fs.writeFileSync(path.join(workspace, 'c.txt'), 'three\n')
  await partialStore.capture({ sessionId: source, cwd: workspace, seq: 17, turn: 3, kind: 'auto' })

  const result = await partialStore.inherit({ from: source, to: forked, throughSeq: 11 })
  assert.equal(result.inherited, 2, 'only snapshots at or before seq 11 carry over')
  const turns = (await partialStore.list(forked)).map(item => item.turn).sort((a, b) => a - b)
  assert.deepEqual(turns, [1, 2], 'the future snapshot is not inherited')
  checks.push('a rewind only carries snapshots up to its cut point')
}

// 7. The budget still applies. A fork must not drag an unbounded history with
//    it, or every delete would grow the store.
{
  const budgetRoot = path.join(root, 'budget')
  const budgetStore = new CheckpointStore({ root: budgetRoot, log: () => {} })
  const many = 'session-many-5555'
  for (let turn = 1; turn <= 6; turn += 1) {
    fs.writeFileSync(path.join(workspace, `f${turn}.txt`), `turn ${turn}\n`)
    await budgetStore.capture({ sessionId: many, cwd: workspace, seq: turn * 5, turn, kind: 'auto', limits: { keep: 10 } })
  }
  const result = await budgetStore.inherit({ from: many, to: 'session-small-6666', keep: 3 })
  assert.equal(result.inherited, 3, 'the fork takes the newest three only')
  const turns = (await budgetStore.list('session-small-6666')).map(item => item.turn).sort((a, b) => a - b)
  assert.deepEqual(turns, [4, 5, 6], 'the newest snapshots win')
  checks.push('inheritance respects the snapshot budget')
}

// 8. The child's own capture still works after inheriting, and does not
//    disturb the parent's history.
{
  const beforeParent = (await store.list(parent)).length
  await store.capture({ sessionId: child, cwd: workspace, seq: 15, turn: 3, kind: 'auto' })
  const after = await store.list(child)
  assert.equal(after.length >= 3, true, 'the fork keeps inheriting and capturing')
  assert.equal((await store.list(parent)).length, beforeParent, 'the parent is untouched')
  checks.push('a forked session keeps capturing on its own')
}

fs.rmSync(root, { recursive: true, force: true })
console.log(JSON.stringify({ ok: true, checks }, null, 2))
