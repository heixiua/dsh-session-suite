/**
 * Hidden-session cleanup: sessions the Host hides (`blank` / `subagent`) but
 * `@` still lists. These are NOT archived, so the archive sweep cannot reach
 * them. All checks use a throwaway tree.
 */

import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import zlib from 'node:zlib'
import { hiddenSessions, sweepHidden } from '../lib/cleanup.js'

const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'dss-hidden-'))
let n = 0
const check = (name, fn) => { fn(); console.log(`  ${++n}. ${name}`) }

const home = path.join(tmp, 'home')
const roots = path.join(home, 'sessions', '--proj--')
const proj = path.join(home, 'storages', 'session_projcache', 'sessions')
const registry = path.join(home, 'storages', 'workspace.json')
await fs.mkdir(proj, { recursive: true })
await fs.mkdir(roots, { recursive: true })

/** Create a session log (plain jsonl, no compression) + optional projection rows. */
async function make(id, { origin, blank, title, registered = false, bytes = 100 } = {}) {
  const dir = path.join(roots, id)
  await fs.mkdir(dir, { recursive: true })
  const header = { type: 'session', version: 4, id, createdAt: Date.now(), cwd: 'D:\\ws', ...(origin ? { origin } : {}) }
  await fs.writeFile(path.join(dir, 'session.v4.jsonl'), `${JSON.stringify(header)}\n${'x'.repeat(bytes)}\n`)
  if (blank !== undefined || title) {
    const rows = {}
    if (blank !== undefined) rows.sessionListMetadata = { val: { blank, lastPromptAt: null } }
    if (title) rows.title = { val: title }
    if (origin === 'subagent') rows.subagent = { val: {} }
    await fs.writeFile(path.join(proj, `${id}.json`), JSON.stringify({ version: 7, record: { rows } }))
  }
  if (registered) {
    let reg = { global: {}, tables: { workspaces: { w1: { title: 'ws', sessionIds: [] } } } }
    try { reg = JSON.parse(await fs.readFile(registry, 'utf8')) } catch { /* new */ }
    reg.tables.workspaces.w1.sessionIds.push(id)
    await fs.writeFile(registry, JSON.stringify(reg))
  }
}

try {
  await make('hidden-blank', { blank: true, title: 'Chief' })
  await make('hidden-sub', { origin: 'subagent', blank: false, title: '调研任务' })
  await make('normal', { blank: false, title: '正常对话' })
  await make('registered-blank', { blank: true, registered: true })
  await make('current-blank', { blank: true })

  const rows = await hiddenSessions(home, {
    archivedIds: [],
    registeredIds: ['registered-blank'],
    currentSessionId: 'current-blank',
  })
  check('only blank/subagent rows are listed', () => {
    assert.deepEqual(rows.map(r => r.sessionId).sort(), ['hidden-blank', 'hidden-sub'])
  })
  check('normal conversations are never offered', () => {
    assert.equal(rows.some(r => r.sessionId === 'normal'), false)
  })
  check('a registered blank placeholder is protected', () => {
    assert.equal(rows.some(r => r.sessionId === 'registered-blank'), false)
  })
  check('the current blank session is protected', () => {
    assert.equal(rows.some(r => r.sessionId === 'current-blank'), false)
  })
  check('rows carry the fields the UI needs', () => {
    const blank = rows.find(r => r.sessionId === 'hidden-blank')
    assert.equal(blank.blank, true)
    assert.equal(blank.subagent, false)
    assert.equal(blank.title, 'Chief')
    assert.ok(blank.bytes > 0)
    const sub = rows.find(r => r.sessionId === 'hidden-sub')
    assert.equal(sub.subagent, true)
  })

  // ---- sweep: explicit selection, whitelist, preview/apply parity ----
  const preview = await sweepHidden({
    dshHome: home, hidden: rows, selectedIds: ['hidden-blank'], apply: false,
  })
  check('preview is read-only and covers only the selected id', () => {
    assert.equal(preview.applied, false)
    assert.equal(preview.selectedCount, 1)
    assert.equal(preview.removed.length, 0)
    assert.ok(preview.bytes > 0)
  })

  const deleted = []
  const applied = await sweepHidden({
    dshHome: home, hidden: rows, selectedIds: ['hidden-blank'], apply: true,
    removeSession: async row => { deleted.push(row.sessionId) },
  })
  check('apply deletes exactly the selected hidden row', () => {
    assert.deepEqual(applied.removed, ['hidden-blank'])
    assert.deepEqual(deleted, ['hidden-blank'])
    assert.equal(applied.failed.length, 0)
    assert.equal(applied.bytes, preview.bytes)
  })

  check('a forged/normal id is ignored and reported', async () => {})
  const forgedSeen = []
  const forged = await sweepHidden({
    dshHome: home, hidden: rows, selectedIds: ['hidden-blank', 'normal', 'does-not-exist'], apply: true,
    removeSession: async row => { forgedSeen.push(row.sessionId) },
  })
  assert.equal(forged.selectedCount, 1)
  assert.deepEqual(forged.removed, ['hidden-blank'])
  assert.deepEqual(forgedSeen, ['hidden-blank'], 'only the whitelisted id reaches the hook')
  assert.deepEqual(forged.ignoredIds, ['normal', 'does-not-exist'])

  check('an empty selection is a no-op', async () => {})
  const empty = await sweepHidden({
    dshHome: home, hidden: rows, selectedIds: [], apply: true,
    removeSession: async () => { throw new Error('must not be called') },
  })
  assert.equal(empty.selectedCount, 0)
  assert.equal(empty.removed.length, 0)

  check('a failing delete is reported, not hidden', async () => {})
  const partial = await sweepHidden({
    dshHome: home, hidden: rows, selectedIds: ['hidden-blank', 'hidden-sub'], apply: true,
    removeSession: async row => { if (row.sessionId === 'hidden-sub') throw new Error('locked') },
  })
  assert.deepEqual(partial.removed, ['hidden-blank'])
  assert.equal(partial.failed.length, 1)
  assert.equal(partial.failed[0].sessionId, 'hidden-sub')

  // ---- mutation: remove the blank protection and the placeholder comes back ----
  check('MUTATION: dropping the registered-id guard exposes a live placeholder', async () => {})
  const unprotected = await hiddenSessions(home, { archivedIds: [], registeredIds: [], currentSessionId: 'current-blank' })
  assert.ok(unprotected.some(r => r.sessionId === 'registered-blank'), 'guard is doing real work')

  // ---- compressed-log support ----
  check('zstd-compressed logs are readable too', async () => {})
  const zdir = path.join(roots, 'hidden-zstd')
  await fs.mkdir(zdir, { recursive: true })
  const zheader = { type: 'session', version: 4, id: 'hidden-zstd', createdAt: Date.now(), cwd: 'D:\\ws', origin: 'subagent' }
  await fs.writeFile(path.join(zdir, 'session.v4.jsonl.zstd'), zlib.zstdCompressSync(Buffer.from(`${JSON.stringify(zheader)}\n`)))
  const withZstd = await hiddenSessions(home, { archivedIds: [], registeredIds: ['registered-blank'], currentSessionId: 'current-blank' })
  assert.ok(withZstd.some(r => r.sessionId === 'hidden-zstd'))

  // ---- corrupt zstd frames: regression for the host-killing delete race ----
  // Deleting a subagent session can rewrite/truncate a log while this sweep
  // reads it. ZstdDecompress then emits an async error that readline does NOT
  // forward into `for await`; on Node 24 that used to escape as an uncaught
  // exception and kill the whole host. Both shapes must degrade instead.
  const goodFrame = zlib.zstdCompressSync(Buffer.from(`${JSON.stringify(zheader)}\n`))
  const badMagic = Buffer.from(goodFrame)
  badMagic.fill(0, 0, 4)

  async function sweepWithBadFrame(id, frame, { sourceError = false } = {}) {
    const dir = path.join(roots, id)
    await fs.mkdir(dir, { recursive: true })
    // Keep the .zstd suffix even for the source-error case: that is the path
    // where `input.pipe(zstd)` is used, and `pipe()` does NOT forward source
    // errors — which is exactly why the pre-fix reader crashed. Without the
    // transform, readline absorbs the error by itself and the case is vacuous.
    const logName = 'session.v4.jsonl.zstd'
    if (sourceError) {
      // A directory where the log should be makes fs.ReadStream emit EISDIR,
      // deterministically standing in for the ENOENT/EACCES a delete race
      // produces. `input.pipe()` does not forward source errors, so this is
      // the path that escaped as an uncaught exception before the guard.
      await fs.mkdir(path.join(dir, logName), { recursive: true })
    } else {
      await fs.writeFile(path.join(dir, logName), frame)
    }
    // A blank projection keeps the row a hidden-session candidate even when
    // its header is unreadable, so the sweep definitely opens the bad file.
    await fs.writeFile(path.join(proj, `${id}.json`), JSON.stringify({
      version: 7,
      record: { rows: { sessionListMetadata: { val: { blank: true, lastPromptAt: null } } } },
    }))
    let uncaught = 0
    const onUncaught = () => { uncaught += 1 }
    process.on('uncaughtException', onUncaught)
    let swept
    try {
      swept = await hiddenSessions(home, {
        archivedIds: [],
        registeredIds: ['registered-blank'],
        currentSessionId: 'current-blank',
      })
      // A stream 'error' lands on a later tick than the read loop.
      await new Promise(resolve => setImmediate(resolve))
    } finally {
      process.off('uncaughtException', onUncaught)
    }
    return { swept, uncaught }
  }

  check('a truncated zstd frame degrades to header-less, never crashes', async () => {})
  const truncated = await sweepWithBadFrame(
    'hidden-zstd-truncated',
    goodFrame.subarray(0, Math.max(8, goodFrame.length - 5)),
  )
  assert.equal(truncated.uncaught, 0, 'no uncaught zstd error escaped the sweep')
  assert.ok(truncated.swept.some(r => r.sessionId === 'hidden-zstd-truncated'))

  check('a zstd frame with a corrupted magic degrades, never crashes', async () => {})
  const corrupted = await sweepWithBadFrame('hidden-zstd-badmagic', badMagic)
  assert.equal(corrupted.uncaught, 0, 'no uncaught zstd error escaped the sweep')
  assert.ok(corrupted.swept.some(r => r.sessionId === 'hidden-zstd-badmagic'))

  check('a source-side read error cannot escape as an uncaught exception', async () => {})
  const sourceError = await sweepWithBadFrame('hidden-source-error', null, { sourceError: true })
  assert.equal(sourceError.uncaught, 0, 'no uncaught source error escaped the sweep')
  assert.ok(sourceError.swept.some(r => r.sessionId === 'hidden-source-error'))

  console.log(`\nhidden-session selftest: ${n} checks PASS`)
} finally {
  await fs.rm(tmp, { recursive: true, force: true })
}
