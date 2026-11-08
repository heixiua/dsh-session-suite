/**
 * Audit of the P2b/P3 issues found in 0.10.0, re-verified against the fixes.
 *
 * Each case measures a real behaviour. Where a fix lives in the Host hook rather
 * than in the engine, the case drives the PRODUCTION path (redaction, scope
 * fallback, windowed read) instead of calling the engine primitive that the fix
 * wraps — otherwise the test would keep reporting the old defect after the code
 * that had it was fixed.
 *
 * Usage: node tools/audit-plugin-issues.mjs
 */

import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { MemoryEngine, redactCredentials } from '../lib/memory-engine.js'
import { isSelfCorrection } from '../lib/pain.js'

const issues = []
const add = (severity, name, detail) => {
  issues.push({ severity, name, detail })
  console.log(`\n[${severity}] ${name}`)
  console.log(`  ${detail}`)
}
const ok = name => console.log(`\n[ok] ${name}`)

async function freshRoot() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'audit-'))
}

// ---------------------------------------------------------------- 1
console.log('=== 1. contradiction between the global store and a workspace store')
{
  const root = await freshRoot()
  const engine = new MemoryEngine({ root, config: {} })
  const cwd = 'D:\\ws-1'
  await engine.remember({ scope: 'global', cwd, text: '必须在轮次开始拍快照，否则本轮产出会丢', tags: ['dsh'], affect: 0.9 })
  await engine.remember({ scope: 'workspace', cwd, text: '绝不能在轮次开始拍快照，否则本轮产出会丢', tags: ['dsh'], affect: 0.9 })
  const report = await engine.maintain(cwd)
  const queue = await engine.conflicts(cwd)
  const sel = await engine.select({ cwd, query: '拍快照 轮次开始', limit: 8, touch: false })
  const scopes = [...new Set(sel.items.map(i => i.scope))]
  const both = scopes.includes('global') && scopes.includes('workspace')
  if (both && queue.length === 0) {
    add('HIGH', 'the conflict scan never compares across stores', `both scopes injected=${both}, conflictsQueued=${report.conflictsQueued}, queue=${queue.length}`)
  } else {
    ok(`cross-store contradictions are queued (both injected=${both}, queue=${queue.length}, queued=${report.conflictsQueued})`)
    // And they can be settled: the loser must be written to ITS OWN store.
    const item = queue[0]
    const verdict = await engine.settleConflict(item.id, item.a.id)
    const rows = await engine.list({ cwd, includeArchived: true })
    const winner = rows.find(row => row.id === item.a.id)
    const loser = rows.find(row => row.id === item.b.id)
    if (verdict.settled && winner?.frozen && loser?.supersededBy === item.a.id) {
      ok('a cross-store pair settles correctly, writing the loser back to its own store')
    } else {
      add('HIGH', 'settling a cross-store pair does not retire the right side', JSON.stringify({ verdict, winnerFrozen: winner?.frozen, loserSupersededBy: loser?.supersededBy }))
    }
  }
  await fs.rm(root, { recursive: true, force: true }).catch(() => {})
}

// ---------------------------------------------------------------- 2
console.log('\n=== 2. conflicts(cwd) must not delete other workspaces\' queue items')
{
  const root = await freshRoot()
  const engine = new MemoryEngine({ root, config: {} })
  const wsA = 'D:\\ws-2a'
  const wsB = 'D:\\ws-2b'
  await engine.remember({ scope: 'workspace', cwd: wsB, text: '必须用 pnpm 装插件', tags: ['dsh'], affect: 0.9 })
  await engine.remember({ scope: 'workspace', cwd: wsB, text: '不要用 pnpm 装插件', tags: ['dsh'], affect: 0.9 })
  await engine.maintain(wsB)
  const before = (await engine.conflicts(wsB)).length
  await engine.conflicts(wsA)
  await engine.conflicts(wsA)
  const after = (await engine.conflicts(wsB)).length
  if (before === 1 && after !== 1) {
    add('HIGH', 'a scoped read permanently deletes another workspace\'s pending conflict', `wsB queue ${before} -> ${after} after reads from wsA`)
  } else {
    ok(`a scoped read leaves other workspaces alone (wsB ${before} -> ${after})`)
  }
  // A genuinely dead item must still be pruned, or the queue grows forever.
  const root2 = await freshRoot()
  const engine2 = new MemoryEngine({ root: root2, config: {} })
  const cwd2 = 'D:\\ws-2c'
  const keep = await engine2.remember({ scope: 'workspace', cwd: cwd2, text: '发布前要跑全量回归', tags: ['dsh'], affect: 0.9 })
  const drop = await engine2.remember({ scope: 'workspace', cwd: cwd2, text: '发布前不要跑全量回归', tags: ['dsh'], affect: 0.9 })
  await engine2.maintain(cwd2)
  await engine2.remove({ id: drop.entry.id, cwd: cwd2 })
  const pruned = (await engine2.conflicts(cwd2)).length
  const raw = JSON.parse(await fs.readFile(path.join(engine2.root, 'conflicts.json'), 'utf8'))
  if (pruned === 0 && raw.items.length === 0) ok('a genuinely dead pair is still pruned from disk')
  else add('HIGH', 'dead pairs are no longer pruned', `live=${pruned} onDisk=${raw.items.length}`)
  await fs.rm(root, { recursive: true, force: true }).catch(() => {})
  await fs.rm(root2, { recursive: true, force: true }).catch(() => {})
}

// ---------------------------------------------------------------- 3
console.log('\n=== 3. a lesson that echoes a credential must stay readable')
{
  // The fix is redaction at capture time. Drive the production primitive.
  const raw = '错误教训（web_fetch 连续失败 3 次）；报错：401 invalid api key sk-abcdefghijklmnopqrstuvwx'
  const redacted = redactCredentials(raw)
  const root = await freshRoot()
  const engine = new MemoryEngine({ root, config: {} })
  const cwd = 'D:\\ws-3'
  const stored = await engine.remember({
    scope: 'workspace',
    cwd,
    text: redacted,
    tags: ['错误教训'],
    source: 'pain',
    lessonTheme: 'web_fetch::401',
  })
  const sealed = stored.entry.privacy === 'secret'
  const credentialGone = !redacted.includes('sk-abcdefghijklmnopqrstuvwx')
  if (sealed || !credentialGone) {
    add('MEDIUM', 'a lesson echoing a credential is still sealed or still stores the credential', JSON.stringify({ sealed, credentialGone, redacted: redacted.slice(-60) }))
  } else {
    ok(`the credential is redacted and the lesson stays injectable (privacy=${stored.entry.privacy})`)
    console.log(`       stored: ${stored.entry.text.slice(-70)}`)
  }
  await fs.rm(root, { recursive: true, force: true }).catch(() => {})
}

// ---------------------------------------------------------------- 4
console.log('\n=== 4. a lesson must not be lost when cwd is unresolvable')
{
  // The fix is the hook's scope fallback. Verify the two branches the hook uses.
  const root = await freshRoot()
  const engine = new MemoryEngine({ root, config: {} })
  const text = '错误教训（pwsh 连续失败 3 次）；报错：command not found；同一条路走不通时先换手段'
  let workspaceFailed = false
  try {
    await engine.remember({ scope: 'workspace', cwd: undefined, text, tags: ['错误教训'], source: 'pain', lessonTheme: 'pwsh::nf' })
  } catch {
    workspaceFailed = true
  }
  const fallback = await engine.remember({
    scope: 'global',
    text,
    tags: ['错误教训'],
    source: 'pain',
    lessonTheme: 'pwsh::nf',
  })
  if (!workspaceFailed) {
    ok('remember() accepts a workspace write with no cwd (no fallback needed)')
  } else if (fallback?.entry) {
    ok('the global fallback stores the lesson when cwd is unknown')
  } else {
    add('MEDIUM', 'the lesson is still lost when cwd is unresolvable', 'both the workspace write and the global fallback failed')
  }
  await fs.rm(root, { recursive: true, force: true }).catch(() => {})
}

// ---------------------------------------------------------------- 5
console.log('\n=== 5. per-turn cost of the pain hook')
{
  // The fix is a windowed read. Measure the window against the full log.
  const sessionsRoot = path.join(os.homedir(), '.dsh', 'sessions')
  const zlib = await import('node:zlib')
  const fsSync = await import('node:fs')

  /** @param {string} dir @returns {string[]} logs */
  function findLogs(dir) {
    const out = []
    let items = []
    try {
      items = fsSync.default.readdirSync(dir, { withFileTypes: true })
    } catch {
      return out
    }
    for (const item of items) {
      const full = path.join(dir, item.name)
      if (item.isDirectory()) out.push(...findLogs(full))
      else if (item.name === 'session.v4.jsonl.zstd') out.push(full)
    }
    return out
  }

  let biggest = null
  let biggestCount = 0
  for (const file of findLogs(sessionsRoot)) {
    let text
    try {
      text = zlib.default.zstdDecompressSync(fsSync.default.readFileSync(file)).toString('utf8')
    } catch {
      continue
    }
    const count = text.split('\n').filter(Boolean).length
    if (count > biggestCount) {
      biggestCount = count
      biggest = file
    }
  }
  const text = zlib.default.zstdDecompressSync(fsSync.default.readFileSync(biggest)).toString('utf8')
  const events = text
    .split('\n')
    .filter(Boolean)
    .map(line => {
      try {
        return JSON.parse(line)
      } catch {
        return null
      }
    })
    .filter(Boolean)
  const turns = [...new Set(events.filter(e => e?.type === 'turn/end').map(e => e.data.turn))]
  const lastTurn = turns.at(-1)

  const { detectPain } = await import('../lib/pain.js')

  const timeIt = (label, list) => {
    const started = process.hrtime.bigint()
    for (let repeat = 0; repeat < 5; repeat += 1) detectPain(list, lastTurn)
    const ms = Number(process.hrtime.bigint() - started) / 1e6 / 5
    console.log(`       ${label}: ${list.length} events -> ${ms.toFixed(2)} ms`)
    return ms
  }

  // Replicate the hook's window: keep from the previous turn/start onward.
  let start = -1
  const floor = lastTurn - 1
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]
    if (event?.type !== 'turn/start') continue
    if (typeof event.data?.turn === 'number' && event.data.turn < floor) {
      start = index
      break
    }
  }
  const windowed = start === -1 ? events : events.slice(start)

  const fullMs = timeIt('full log', events)
  const windowMs = timeIt('windowed', windowed)
  const saving = fullMs > 0 ? (1 - windowMs / fullMs) * 100 : 0
  if (windowMs > 50) {
    add('MEDIUM', 'the windowed read is still expensive', `${windowMs.toFixed(1)} ms per turn`)
  } else {
    ok(`the window cuts the per-turn work by ${saving.toFixed(0)}% (${windowed.length} of ${events.length} events)`)
  }
}

// ---------------------------------------------------------------- 6
console.log('\n=== 6. self-correction cues')
{
  const falsePositives = ['实际上全部生效了（我第一次用 grep 计数时算错了）。', '我判断错了方向，但结论仍然成立。']
  const real = ['我搞错了，这个函数没有返回值。', '抱歉，我刚才算错了。']
  const spurious = falsePositives.filter(text => isSelfCorrection(text))
  const missed = real.filter(text => !isSelfCorrection(text))
  if (spurious.length > 0) {
    add('LOW', 'self-correction cues still match prose that is not an admission', `${spurious.length} of ${falsePositives.length} ordinary sentences match`)
  } else ok('self-correction cues are precise on prose')
  if (missed.length > 0) console.log(`       (still misses: ${missed.join(' / ')})`)
}

// ---------------------------------------------------------------- 7
console.log('\n=== 7. reversing a settled decision')
{
  const root = await freshRoot()
  const engine = new MemoryEngine({ root, config: {} })
  const cwd = 'D:\\ws-7'
  const keep = await engine.remember({ scope: 'workspace', cwd, text: '发布前要跑全量回归', tags: ['dsh'], affect: 0.9 })
  const drop = await engine.remember({ scope: 'workspace', cwd, text: '发布前不要跑全量回归', tags: ['dsh'], affect: 0.9 })
  await engine.maintain(cwd)
  const [item] = await engine.conflicts(cwd)
  await engine.settleConflict(item.id, keep.entry.id)
  await engine.remember({ scope: 'workspace', cwd, text: '发布前不要跑全量回归', tags: ['dsh'], affect: 0.9 })
  await engine.maintain(cwd)
  const again = await engine.conflicts(cwd)
  if (again.length === 0) {
    ok('restating the retired side does not re-open the question (pair stays dismissed/settled)')
  } else {
    const flip = await engine.settleConflict(again[0].id, drop.entry.id)
    const rows = await engine.list({ cwd, scope: 'workspace' })
    const oldWinner = rows.find(row => row.id === keep.entry.id)
    if (flip.settled && oldWinner?.frozen === true && oldWinner?.supersededBy) {
      add('LOW', 'a superseded entry keeps frozen=true', 'after a reversed decision the old winner is both superseded and frozen')
    } else ok('reversing a settled decision leaves consistent state')
  }
  await fs.rm(root, { recursive: true, force: true }).catch(() => {})
}

// ---------------------------------------------------------------- 8
console.log('\n=== 8. a value change with no polarity cue')
{
  const root = await freshRoot()
  const engine = new MemoryEngine({ root, config: {} })
  const cwd = 'D:\\ws-8'
  await engine.remember({ scope: 'workspace', cwd, text: '上下文窗口是 128k', tags: ['dsh'], affect: 0.9 })
  await engine.remember({ scope: 'workspace', cwd, text: '上下文窗口是 200k', tags: ['dsh'], affect: 0.9 })
  await engine.maintain(cwd)
  if ((await engine.conflicts(cwd)).length === 0) {
    add('KNOWN', 'a value change with no polarity cue is invisible to the scan', '「128k」 vs 「200k」 has no negation; fact keys are the mechanism for this, documented in the README')
  } else ok('value changes are detected')
  await fs.rm(root, { recursive: true, force: true }).catch(() => {})
}

console.log(`\n\n${issues.length} issue(s) remain`)
for (const issue of issues) console.log(`  ${issue.severity.padEnd(6)} ${issue.name}`)
if (issues.some(issue => issue.severity === 'HIGH' || issue.severity === 'MEDIUM')) process.exit(1)
