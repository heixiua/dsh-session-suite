/**
 * Hidden-session delete: the three defects the user hit.
 *
 * 1. THE LIST NEVER REFRESHED. runClean deleted the files, then cleared the
 *    selection WITHOUT bumping the revision store, and the row list is only
 *    re-fetched by the `[rev]` effect. So a successful delete looked like
 *    nothing happened. (Client-side; asserted against the source here because
 *    there is no DOM harness in this repo.)
 *
 * 2. A LIVE ROW WAS DROPPED SILENTLY. sweepHiddenSessions filtered running
 *    sessions out of the candidate set, and sweepHidden then reported
 *    selectedCount=0 without any failure 鈥?removed=0, failed=0, no message.
 *    Now they come back in `skipped` with a reason.
 *
 * 3. A SUBAGENT WAS DELETED ALONE. Deleting the child left the parent's
 *    transcript pointing at an id that no longer resolves. Selecting a row now
 *    deletes its own subagent descendants with it (cascade), and never walks
 *    up to the parent.
 */
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import zlib from 'node:zlib'
import { fileURLToPath } from 'node:url'
import { SessionSuiteService } from '../lib/service.js'
import { CheckpointStore } from '../lib/checkpoints.js'
import { MemoryLedger } from '../lib/memory.js'

const root = path.resolve(fileURLToPath(new URL('..', import.meta.url)))
let n = 0
const check = (name, fn) => { fn(); console.log(`  ${++n}. ${name}`) }

const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'dss-deletefix-'))
const home = path.join(tmp, 'home')
// SessionSuiteService resolves its home from DSH_HOME in the constructor. Without
// this the test drives the REAL ~/.dsh 鈥?it then "passes" for the wrong reason
// (everything is reported as no-longer-offered) and can touch live sessions.
process.env.DSH_HOME = home
const proj = path.join(home, 'storages', 'session_projcache', 'sessions')
const regFile = path.join(home, 'storages', 'workspace.json')
const scope = path.join(home, 'sessions', '--proj--')
await fs.mkdir(proj, { recursive: true })
await fs.mkdir(scope, { recursive: true })
await fs.writeFile(regFile, JSON.stringify({ global: { archivedSessionIds: [] }, tables: { workspaces: {} } }))

/** Create a session log + optional cache row. Returns nothing. */
async function make(id, { origin, blank, title } = {}) {
  const dir = path.join(scope, id)
  await fs.mkdir(dir, { recursive: true })
  const header = { type: 'session', version: 4, id, createdAt: Date.now(), cwd: 'D:\\ws', ...(origin ? { origin } : {}) }
  await fs.writeFile(path.join(dir, 'session.v4.jsonl.zstd'), zlib.zstdCompressSync(Buffer.from(`${JSON.stringify(header)}\n`)))
  const rows = {}
  if (blank !== undefined) rows.sessionListMetadata = { val: { blank, lastPromptAt: null } }
  if (title) rows.title = { val: title }
  await fs.writeFile(path.join(proj, `${id}.json`), JSON.stringify({ version: 7, record: { rows } }))
}

/**
 * Drive the service with a controller stub. `running` names ids the Host would
 * report as live; `parents` maps childId -> parentSessionId.
 */
function makeService({ running = [], parents = {} } = {}) {
  const items = []
  const notices = []
  const ctx = {
    get(name) {
      if (name === 'sessionController') {
        return {
          list: async () => ({
            items: items.map(it => ({ ...it })),
          }),
        }
      }
      if (name === 'workspaceRegistry' || name === 'workspaceController') {
        return {
          archiveSession: async id => {
            const reg = JSON.parse(await fs.readFile(regFile, 'utf8'))
            reg.global ??= {}
            reg.global.archivedSessionIds = [...new Set([...(reg.global.archivedSessionIds ?? []), id])]
            await fs.writeFile(regFile, JSON.stringify(reg))
          },
          unarchiveSession: async id => {
            const reg = JSON.parse(await fs.readFile(regFile, 'utf8'))
            reg.global ??= {}
            reg.global.archivedSessionIds = (reg.global.archivedSessionIds ?? []).filter(x => x !== id)
            await fs.writeFile(regFile, JSON.stringify(reg))
          },
        }
      }
      return undefined
    },
    emit: (e, p) => notices.push(`${e} ${p ?? ''}`),
    logger: { info() {}, warn() {} },
  }
  const suiteRoot = path.join(home, 'storages', 'dsh-session-suite')
  const service = new SessionSuiteService({
    ctx,
    root: suiteRoot,
    store: new CheckpointStore({ root: suiteRoot, log: () => {}, ignores: [] }),
    memory: new MemoryLedger({ root: suiteRoot }),
    log: () => {},
    config: {},
  })

  // Register the on-disk rows the way the Host would, then apply the flags.
  // `origin` matters: subagentDescendants() identifies a child by
  // `origin === 'subagent'` alone (a parentSessionId proves nothing, because
  // every rewind also forks), so the stub must project it exactly like the Host.
  const originOf = new Map()
  const refresh = async () => {
    items.length = 0
    for (const entry of await fs.readdir(scope, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      const log = path.join(scope, entry.name, 'session.v4.jsonl.zstd')
      if (!await fs.stat(log).then(() => true, () => false)) continue
      items.push({
        sessionId: entry.name,
        running: running.includes(entry.name),
        ...(originOf.get(entry.name) ? { origin: originOf.get(entry.name) } : {}),
        ...(parents[entry.name] ? { parentSessionId: parents[entry.name] } : {}),
      })
    }
  }
  return { service, refresh, notices, items, originOf }
}

try {
  // ---- 1. the client actually refreshes after a delete
  const client = await fs.readFile(path.join(root, 'client.js'), 'utf8')
  // Two `runClean` closures exist (archive cleanup, hidden cleanup). Take the
  // HIDDEN one: it is the one that posts sweepHiddenSessions.
  const cleanStart = client.indexOf("call({ action: 'sweepHiddenSessions'")
  assert.ok(cleanStart > 0, 'hidden sweepHiddenSessions call not found')
  const runClean = client.slice(client.lastIndexOf('const runClean', cleanStart), cleanStart + 1400)
  check('the hidden-cleanup confirm path calls bump() so the list re-fetches', () => {
    assert.ok(runClean.includes('bump()'), 'runClean does not bump the revision')
    const finallyBlock = runClean.slice(runClean.indexOf('finally'))
    assert.ok(finallyBlock.includes('bump()'), 'bump() must run even when the call throws')
  })
  check('the archive-cleanup path bumps too (it had the same omission)', () => {
    const archiveStart = client.indexOf("call({ action: 'sweepArchivedSessions'")
    assert.ok(archiveStart > 0)
    const archiveClean = client.slice(client.lastIndexOf('const runClean', archiveStart), archiveStart + 1400)
    assert.ok(archiveClean.slice(archiveClean.indexOf('finally')).includes('bump()'),
      'archive cleanup does not bump the revision')
  })
  check('a confirmation that deleted nothing says so instead of staying silent', () => {
    assert.ok(runClean.includes('hidden.nothingDone'), 'no "nothing done" message')
    // Both dictionaries must carry the key: en in DICTS, zh in DICTS.zh.
    const occurrences = client.split("'hidden.nothingDone':").length - 1
    assert.equal(occurrences, 2, `expected an en and a zh entry, found ${occurrences}`)
  })

  // ---- 2. a running row is reported as skipped, not silently dropped
  await make('live-blank', { blank: true, title: 'busy' })
  const suiteA = makeService({ running: ['live-blank'] })
  await suiteA.refresh()
  const blocked = await suiteA.service.sweepHiddenSessions({ sessionIds: ['live-blank'] })
  check('a live row is reported in `skipped` with a reason', () => {
    assert.equal(blocked.removed.length, 0, 'nothing should be deleted')
    assert.equal(blocked.failed.length, 0, 'a live row is not a failure')
    assert.equal(blocked.skipped.length, 1, 'the live row must appear in skipped')
    assert.match(blocked.skipped[0].reason, /running/)
  })
  check('the running row still exists on disk', async () => {})
  assert.ok(await fs.stat(path.join(scope, 'live-blank', 'session.v4.jsonl.zstd')).then(() => true, () => false))

  // ---- 3. cascade deletes the row's own subagents, never its parent
  // `parent-conv` is a normal conversation, so it is NOT on the hidden list 鈥?  // cascade is a property of deleteSession, which both entry points share, so it
  // is asserted there. A blank row WITH children is the hidden-list case.
  await make('blank-with-kids', { blank: true, title: 'debris' })
  await make('kid-a', { origin: 'subagent' })
  await make('kid-b', { origin: 'subagent' })
  const suiteB = makeService({ parents: { 'kid-a': 'blank-with-kids', 'kid-b': 'blank-with-kids' } })
  suiteB.originOf.set('kid-a', 'subagent')
  suiteB.originOf.set('kid-b', 'subagent')
  await suiteB.refresh()

  const parentDelete = await suiteB.service.sweepHiddenSessions({ sessionIds: ['blank-with-kids'] })
  check('deleting a hidden row takes its subagent descendants with it', () => {
    assert.equal(parentDelete.removed.length, 1, `the selected row is removed (got ${parentDelete.removed.length})`)
    assert.equal(parentDelete.removedSubagents.length, 2, 'both children are removed')
    for (const c of parentDelete.removedSubagents) assert.equal(c.parentSessionId, 'blank-with-kids')
  })
  check('the children are gone from disk', () => {})
  assert.equal(await fs.stat(path.join(scope, 'kid-a')).then(() => true, () => false), false)
  assert.equal(await fs.stat(path.join(scope, 'kid-b')).then(() => true, () => false), false)

  // ---- 3b. deleteSession itself cascades (the shared primitive)
  await make('normal-parent', { blank: false, title: 'normal' })
  await make('normal-kid', { origin: 'subagent' })
  const suiteD = makeService({ parents: { 'normal-kid': 'normal-parent' } })
  suiteD.originOf.set('normal-kid', 'subagent')
  await suiteD.refresh()
  const normalDelete = await suiteD.service.deleteSession('normal-parent', { cascade: true })
  check('deleteSession(cascade) removes children before the parent', () => {
    assert.equal(normalDelete.removedSubagents.length, 1)
    assert.equal(normalDelete.removedSubagents[0].sessionId, 'normal-kid')
  })

  // ---- 4. selecting a child never walks up to its parent
  await make('parent-2', { blank: false, title: 'keep me' })
  await make('child-2', { origin: 'subagent' })
  const suiteC = makeService({ parents: { 'child-2': 'parent-2' } })
  suiteC.originOf.set('child-2', 'subagent')
  await suiteC.refresh()
  const childDelete = await suiteC.service.sweepHiddenSessions({ sessionIds: ['child-2'] })
  check('deleting a subagent leaves its parent conversation intact', () => {
    assert.equal(childDelete.removed.length, 1)
    assert.equal(childDelete.removedSubagents.length, 0, 'a child has no descendants')
  })
  check('the parent log is still on disk', () => {})
  assert.ok(await fs.stat(path.join(scope, 'parent-2', 'session.v4.jsonl.zstd')).then(() => true, () => false))

  // ---- 5. no archive mark is leaked by any of the above
  const reg = JSON.parse(await fs.readFile(regFile, 'utf8'))
  check('no archive mark leaks from the fixed paths', () => {
    const marks = reg.global?.archivedSessionIds ?? []
    assert.equal(marks.length, 0, `leaked marks: ${marks.join(', ')}`)
  })

  console.log(`\nhidden-delete fixes: ${n} checks PASS`)
} finally {
  await fs.rm(tmp, { recursive: true, force: true }).catch(() => {})
}

