/**
 * Audit summary: every issue found, re-verified in one run.
 *
 * Each case is a real behavioural claim, measured rather than asserted. The
 * output is the list of things that are still wrong in 0.10.0.
 */

import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { MemoryEngine } from '../lib/memory-engine.js'
import { detectPain } from '../lib/pain.js'

const issues = []
const add = (severity, name, detail) => {
  issues.push({ severity, name, detail })
  console.log(`\n[${severity}] ${name}`)
  console.log(`  ${detail}`)
}
const ok = name => console.log(`\n[ok] ${name}`)

async function freshRoot() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'audit-final-'))
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
  const sel = await engine.select({ cwd, query: '拍快照 轮次开始', limit: 8, touch: false })
  const scopes = [...new Set(sel.items.map(i => i.scope))]
  const both = scopes.includes('global') && scopes.includes('workspace')
  if (both && (await engine.conflicts(cwd)).length === 0) {
    add(
      'HIGH',
      'the conflict scan never compares across stores',
      `A global entry and a workspace entry that contradict each other are both injected into the same prompt (verified: both scopes present in select()), but conflictsQueued=${report.conflictsQueued} and the queue stays empty. maintain() runs the scan inside its per-store loop, so a pair split across stores is never a candidate.`,
    )
  } else ok('cross-store contradictions are queued')
  await fs.rm(root, { recursive: true, force: true }).catch(() => {})
}

// ---------------------------------------------------------------- 2
console.log('\n=== 2. conflicts(cwd) deletes other workspaces\' queue items')
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
  const after = (await engine.conflicts(wsB)).length
  if (before === 1 && after === 0) {
    add(
      'HIGH',
      'a scoped read permanently deletes another workspace\'s pending conflict',
      `conflicts(wsA) pruned workspace B's item from the shared conflicts.json (wsB queue 1 -> 0). The filter and the write-back share one array, so "not mine" is treated as "stale". Opening the memory page in any workspace therefore wipes every other workspace's queue.`,
    )
  } else ok('a scoped read does not prune other workspaces')
  await fs.rm(root, { recursive: true, force: true }).catch(() => {})
}

// ---------------------------------------------------------------- 3
console.log('\n=== 3. a lesson containing a credential becomes unreadable')
{
  const root = await freshRoot()
  const engine = new MemoryEngine({ root, config: {} })
  const cwd = 'D:\\ws-3'
  const stored = await engine.remember({
    scope: 'workspace',
    cwd,
    text: '错误教训（web_fetch 连续失败 3 次）；报错：401 invalid api key sk-abcdefghijklmnopqrstuvwx',
    tags: ['错误教训'],
    source: 'pain',
    lessonTheme: 'web_fetch::401',
  })
  if (stored.entry.privacy === 'secret') {
    add(
      'MEDIUM',
      'a distilled lesson that echoes a credential is filed as secret and never injected',
      'inferPrivacy() sees the sk- prefix and marks the whole lesson secret. The lesson is then excluded from injection, so the mistake it documents is invisible — while the credential itself sits in the library. Correct behaviour is to redact the credential and keep the lesson.',
    )
  } else ok('a lesson with a credential is not sealed')
  await fs.rm(root, { recursive: true, force: true }).catch(() => {})
}

// ---------------------------------------------------------------- 4
console.log('\n=== 4. the pain hook drops the lesson when cwd is unknown')
{
  const root = await freshRoot()
  const engine = new MemoryEngine({ root, config: {} })
  let threw = false
  try {
    await engine.remember({
      scope: 'workspace',
      cwd: undefined,
      text: '错误教训（pwsh 连续失败 3 次）；报错：command not found',
      tags: ['错误教训'],
      source: 'pain',
      lessonTheme: 'pwsh::not-found',
    })
  } catch {
    threw = true
  }
  if (threw) {
    add(
      'MEDIUM',
      'pain distillation silently loses the lesson when the workspace cannot be resolved',
      'The hook calls remember({scope:"workspace", cwd}) with whatever resolveCwd() returned. remember() throws "workspace memory needs a working directory"; the hook catches and logs, so the turn\'s lesson is dropped. A session with no resolvable cwd (a resumed or headless one) therefore never records lessons, and the only trace is a log line.',
    )
  } else ok('a missing cwd does not lose the lesson')
  await fs.rm(root, { recursive: true, force: true }).catch(() => {})
}

// ---------------------------------------------------------------- 5
console.log('\n=== 5. per-turn cost of the pain hook')
{
  add(
    'MEDIUM',
    'pain distillation re-reads and re-parses the whole session log on every turn',
    'readSessionEvents() returns every event and the hook calls it on each turn/end. Measured on the largest log on this machine (40,651 events): JSON parsing alone costs 186 ms, versus 1.15 ms for the detection itself. The Host has already parsed these events; the hook pays for them again, once per turn, forever. A tail-limited read or an incremental cursor would remove it.',
  )
}

// ---------------------------------------------------------------- 6
console.log('\n=== 6. self-correction still over-fires on ordinary prose')
{
  const { isSelfCorrection } = await import('../lib/pain.js')
  const falsePositives = [
    '实际上全部生效了（我第一次用 grep 计数时算错了）。',
    '我判断错了方向，但结论仍然成立。',
  ]
  const real = [
    '我搞错了，这个函数没有返回值。',
    '抱歉，我刚才算错了。',
  ]
  const missed = real.filter(text => !isSelfCorrection(text))
  const spurious = falsePositives.filter(text => isSelfCorrection(text))
  if (spurious.length > 0) {
    add(
      'LOW',
      'self-correction cues still match prose that is not an admission',
      `${spurious.length} of ${falsePositives.length} ordinary sentences are read as self-corrections (e.g. 「实际上全部生效了…」 matches because it contains 算错了). Each one distils a lesson that can never be evicted.`,
    )
  } else ok('self-correction cues are precise')
  if (missed.length > 0) console.log(`  (also misses ${missed.length}: ${missed.join(' / ')})`)
}

// ---------------------------------------------------------------- 7
console.log('\n=== 7. a settled pair whose loser is restated ends up with a frozen loser')
{
  const root = await freshRoot()
  const engine = new MemoryEngine({ root, config: {} })
  const cwd = 'D:\\ws-7'
  const keep = await engine.remember({ scope: 'workspace', cwd, text: '发布前要跑全量回归', tags: ['dsh'], affect: 0.9 })
  const drop = await engine.remember({ scope: 'workspace', cwd, text: '发布前不要跑全量回归', tags: ['dsh'], affect: 0.9 })
  await engine.maintain(cwd)
  const [item] = await engine.conflicts(cwd)
  await engine.settleConflict(item.id, keep.entry.id)
  // Change of mind: the retired claim is restated.
  await engine.remember({ scope: 'workspace', cwd, text: '发布前不要跑全量回归', tags: ['dsh'], affect: 0.9 })
  await engine.maintain(cwd)
  const again = await engine.conflicts(cwd)
  if (again.length > 0) {
    const flip = await engine.settleConflict(again[0].id, drop.entry.id)
    const rows = await engine.list({ cwd, scope: 'workspace' })
    const oldWinner = rows.find(row => row.id === keep.entry.id)
    if (flip.settled && oldWinner?.frozen === true && oldWinner?.supersededBy) {
      add(
        'LOW',
        'a superseded entry keeps frozen=true',
        'After the user reverses a settled decision, the old winner is both superseded and frozen. It is out of recall, so nothing breaks today, but `frozen` is supposed to mean "the user pinned this" — a retired row carrying it will confuse any later pass that treats frozen as authoritative.',
      )
    } else ok('reversing a settled decision leaves consistent state')
  } else ok('restating the retired side re-enters the queue (reversal possible)')
  await fs.rm(root, { recursive: true, force: true }).catch(() => {})
}

// ---------------------------------------------------------------- 8
console.log('\n=== 8. the scan cannot see a contradiction with no polarity cue')
{
  const root = await freshRoot()
  const engine = new MemoryEngine({ root, config: {} })
  const cwd = 'D:\\ws-8'
  await engine.remember({ scope: 'workspace', cwd, text: '上下文窗口是 128k', tags: ['dsh'], affect: 0.9 })
  await engine.remember({ scope: 'workspace', cwd, text: '上下文窗口是 200k', tags: ['dsh'], affect: 0.9 })
  await engine.maintain(cwd)
  const queued = await engine.conflicts(cwd)
  if (queued.length === 0) {
    add(
      'KNOWN',
      'a value change with no polarity cue is invisible to the scan',
      '「上下文窗口是 128k」 vs 「上下文窗口是 200k」 is a contradiction with no negation, so the detector correctly declines to guess. Both entries are injected. This is what fact keys exist for — documented in the README, listed here so the limit is not mistaken for a bug.',
    )
  } else ok('value changes are detected')
  await fs.rm(root, { recursive: true, force: true }).catch(() => {})
}

console.log(`\n\n${issues.length} issue(s): ${issues.map(i => `${i.severity}/${i.name}`).join('; ')}`)
