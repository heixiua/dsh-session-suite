/**
 * Self-test for the checkpoint engine and the memory ledger.
 *
 * Run with: node tools/selftest.mjs
 * It uses a throwaway directory and never touches the real DSH home.
 */

import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { CheckpointStore } from '../lib/checkpoints.js'
import { MemoryLedger } from '../lib/memory.js'

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dss-suite-'))
const workspace = path.join(root, 'workspace')
const data = path.join(root, 'data')
await fs.mkdir(path.join(workspace, 'src'), { recursive: true })
await fs.mkdir(path.join(workspace, 'node_modules', 'left-pad'), { recursive: true })

const write = async (rel, text) => {
  const file = path.join(workspace, rel)
  await fs.mkdir(path.dirname(file), { recursive: true })
  await fs.writeFile(file, text)
}
const read = rel => fs.readFile(path.join(workspace, rel), 'utf8')
const exists = async rel => {
  try {
    await fs.stat(path.join(workspace, rel))
    return true
  } catch {
    return false
  }
}

await write('src/a.js', 'export const a = 1\n')
await write('src/b.js', 'export const b = 2\n')
await write('README.md', '# demo\n')
await write('node_modules/left-pad/index.js', 'ignored\n')
await write('debug.log', 'ignored log\n')

const logs = []
const store = new CheckpointStore({ root: data, log: message => logs.push(message) })

// --- capture #1 -------------------------------------------------------------
const first = await store.capture({ sessionId: 's1', cwd: workspace, seq: 10, turn: 1, kind: 'auto', label: 'before turn 1' })
assert.equal(first.checkpoint.files, 3, `expected 3 tracked files, got ${first.checkpoint.files}`)
assert.equal(first.truncated, false)
const skippedText = first.skipped.join(' ')
assert.equal(skippedText.includes('node_modules'), false, 'ignored directories are not reported as skipped files')

// --- mutate -----------------------------------------------------------------
await write('src/a.js', 'export const a = 99\n')
await fs.rm(path.join(workspace, 'src/b.js'))
await write('src/c.js', 'export const c = 3\n')

const second = await store.capture({ sessionId: 's1', cwd: workspace, seq: 20, turn: 2, kind: 'auto', label: 'before turn 2' })
assert.equal(second.checkpoint.files, 3, 'the second checkpoint tracks the new tree')

// unchanged files must not be re-stored: only c.js is genuinely new content
const listed = await store.list('s1')
assert.equal(listed.length, 2)

// --- restore #1 -------------------------------------------------------------
const restored = await store.restore({ sessionId: 's1', checkpointId: first.checkpoint.id })
assert.equal(await read('src/a.js'), 'export const a = 1\n', 'a.js must be rewound')
assert.equal(await read('src/b.js'), 'export const b = 2\n', 'deleted b.js must come back')
assert.equal(await exists('src/c.js'), false, 'c.js created after the checkpoint must be removed')
assert.equal(await exists('node_modules/left-pad/index.js'), true, 'ignored files must never be deleted')
assert.ok(restored.written >= 2)

// --- a file the user created outside the session is never deleted -----------
await write('notes.tmp.txt', 'user file\n')
await store.restore({ sessionId: 's1', checkpointId: first.checkpoint.id })
assert.equal(await exists('notes.tmp.txt'), true, 'unknown user files stay')

// --- locking and pruning ----------------------------------------------------
await store.setLocked('s1', first.checkpoint.id, true)
for (let index = 0; index < 14; index += 1) {
  await write('src/a.js', `export const a = ${index + 100}\n`)
  await store.capture({
    sessionId: 's1',
    cwd: workspace,
    seq: 100 + index,
    turn: 3 + index,
    kind: 'auto',
    limits: { keep: 10 },
  })
}
const afterPrune = await store.list('s1')
const budgeted = afterPrune.filter(item => item.kind === 'auto')
assert.equal(budgeted.length, 10, `automatic checkpoints must be capped at 10, got ${budgeted.length}`)
assert.ok(afterPrune.some(item => item.id === first.checkpoint.id), 'a locked checkpoint survives pruning')

const stats = await store.stats('s1')
assert.ok(stats.bytes > 0)

// --- undo bundle ------------------------------------------------------------
const undo = await store.capture({ sessionId: 's1', cwd: workspace, seq: 200, turn: 20, kind: 'pre-rollback', label: 'before rollback', ttlMs: 400 })
const undoList = await store.list('s1')
assert.ok(undoList.some(item => item.id === undo.checkpoint.id))
await new Promise(resolve => setTimeout(resolve, 500))
const afterExpiry = await store.list('s1')
assert.equal(afterExpiry.some(item => item.id === undo.checkpoint.id), false, 'temporary bundles expire')

// --- memory ledger ----------------------------------------------------------
const memory = new MemoryLedger({ root: data })
const older = await memory.add('s1', { text: 'prefers pnpm', seq: 5 })
await memory.add('s1', { text: 'uses Windows', seq: 25 })
assert.equal((await memory.list('s1')).length, 2)
const trimmed = await memory.trimTo('s1', 10)
assert.equal(trimmed.removed, 1, 'memory after the rewind point is dropped')
assert.deepEqual((await memory.list('s1')).map(entry => entry.id), [older.id])

const snapshot = await memory.snapshot('s1')
await memory.add('s1', { text: 'temporary', seq: 30 })
await memory.restore('s1', snapshot)
assert.equal((await memory.list('s1')).length, 1)

// --- purge ------------------------------------------------------------------
await store.purgeSession('s1')
assert.deepEqual(await store.list('s1'), [])

await fs.rm(root, { recursive: true, force: true })
console.log(JSON.stringify({ ok: true, checks: 18, logs: logs.length }, null, 2))
