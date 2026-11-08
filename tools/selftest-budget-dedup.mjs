/**
 * Tests for the two P0 mechanisms added after surveying competing memory
 * plugins (kovey/dsh-memory's tool-output budget; the injection block's own
 * duplication observed live in this workspace).
 *
 * 1. `applyToolBudget` — a tool RESULT is appended to the conversation and
 *    stays in every later request, so it is the cost that compounds. The
 *    policy: writes never refused; reads cut at a per-call cap and a
 *    session-cumulative cap; a refusal must explain itself.
 *
 * 2. `buildRecallText` — the lesson layer (by importance) and the recall layer
 *    (by similarity) could print the SAME memory twice. One memory, one line.
 *
 * Usage: node tools/selftest-budget-dedup.mjs
 */

import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { MemoryEngine } from '../lib/memory-engine.js'
import { applyToolBudget, buildRecallText } from '../lib/memory-host.js'

const checks = []
const freshRow = () => ({ chars: 0, calls: 0, refused: 0, lastAt: 0 })
const makeMemories = (count, each = 200) =>
  Array.from({ length: count }, (_, index) => ({
    id: `mem_${index}`,
    text: `记忆 ${index}：` + 'x'.repeat(Math.max(0, each - 12)),
    scope: 'workspace',
    tags: [],
  }))

// --- 1. applyToolBudget ------------------------------------------------------

// 1.1 A small read passes through untouched and is booked.
{
  const row = freshRow()
  const value = { memories: makeMemories(2) }
  const size = JSON.stringify(value).length
  const out = applyToolBudget(row, value, true, { perCallChars: 4000, sessionChars: 20000 })
  assert.equal(out, value, 'a small read must pass through unchanged')
  assert.equal(row.chars, size, 'the read must be booked at its serialized size')
  assert.equal(row.calls, 1)
  checks.push('applyToolBudget: a small read passes through and is booked')
}

// 1.2 A read past the per-call cap is TRIMMED, not refused, and the ledger is
//     corrected to what was actually returned.
{
  const row = freshRow()
  const value = { memories: makeMemories(30) } // ~6000 chars
  const out = applyToolBudget(row, value, true, { perCallChars: 1000, sessionChars: 20000 })
  assert.equal(out.truncated, true, 'an oversized read must be marked truncated')
  assert.equal(
    out.memories.length < 30 && out.memories.length > 0,
    true,
    `must return a non-empty subset, got ${out.memories.length}`,
  )
  assert.equal(typeof out.note, 'string', 'truncation must explain itself')
  assert.ok(out.note.length > 0, 'the truncation note must not be empty')
  const keptSize = JSON.stringify(out).length
  assert.equal(row.chars, keptSize, 'the ledger must charge the exact serialized trimmed result')
  checks.push('applyToolBudget: an oversized read is trimmed and charged at the trimmed size')
}

// 1.3 The session-cumulative cap refuses with an explanation once the session
//     has spent its budget — and only for reads.
{
  const row = freshRow()
  const limits = { perCallChars: 100_000, sessionChars: 1500 }
  const first = applyToolBudget(row, { memories: makeMemories(5) }, true, limits)
  assert.equal(first.budget_exhausted, undefined, 'the first read must succeed')
  const second = applyToolBudget(row, { memories: makeMemories(5) }, true, limits)
  assert.equal(second.budget_exhausted, true, 'the second read must hit the session cap')
  assert.ok(typeof second.note === 'string' && second.note.includes('recall'), 'a refusal must name the way forward')
  assert.equal(second.session_budget_chars, 1500, 'a refusal must state the budget')
  assert.equal(row.refused, 1)
  checks.push('applyToolBudget: reads past the session budget are refused with an explanation')
}

// 1.4 Even a refused call lets a SMALL precise slice through — the model must
//     not be locked out of the one fact it asked for precisely.
{
  const row = freshRow()
  // Fill the ledger with a read that fits, then ask for one slightly bigger
  // than the remainder: it must be refused AND still return its small slice.
  const filler = { memories: makeMemories(5, 120) }
  const fillerSize = JSON.stringify(filler).length
  const limits = { perCallChars: 4000, sessionChars: fillerSize + 200 }
  const first = applyToolBudget(row, filler, true, limits)
  assert.equal(first.budget_exhausted, undefined, 'the filler read must fit')
  assert.equal(row.chars, fillerSize)
  const second = applyToolBudget(row, { memories: makeMemories(1, 200) }, true, limits)
  assert.equal(second.budget_exhausted, true, 'a read past the remainder must be refused')
  assert.equal(second.small_query_allowed, true, 'a small precise answer must still get through')
  assert.equal(second.memories.length, 1)
  checks.push('applyToolBudget: a refused call still returns a small precise slice')
}

// 1.5 A WRITE is never refused, however exhausted the session is. Refusing to
//     remember would be the opposite of the point.
{
  const row = freshRow()
  const limits = { perCallChars: 100, sessionChars: 1 }
  applyToolBudget(row, { memories: makeMemories(5) }, true, limits) // exhaust reads
  const value = { stored: { id: 'mem_new' }, duplicate: false }
  const refusedBefore = row.refused
  const out = applyToolBudget(row, value, false, limits)
  assert.equal(out, value, 'a write must pass through unchanged')
  assert.equal(out.budget_exhausted, undefined, 'a write must never come back as a refusal')
  assert.equal(row.refused, refusedBefore, 'a write must not add a refusal')
  checks.push('applyToolBudget: writes are never gated')
}

// --- 2. buildRecallText dedupe ------------------------------------------------

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'budget-dedup-'))
const cwd = path.join(root, 'ws')
await fs.mkdir(cwd, { recursive: true })
const engine = new MemoryEngine({ root, log: () => {} })

// A lesson that ALSO answers the question — the exact live case (the 装插件铁律
// printed under both sections). Plus filler so recall has something else to pick.
const lessonText = '装插件铁律：先退出全部 DSH 进程再 pnpm add，绝不手拷 node_modules'
const stored = await engine.remember({
  scope: 'workspace',
  cwd,
  text: lessonText,
  tags: ['错误教训'],
})
assert.equal(typeof stored.entry.id, 'string', 'lessonCards must expose ids for dedup')
for (const text of [
  '缓存命中率跟 provider 走而不跟模型名走',
  '导出必须白名单 user 来源否则管道事件泄漏',
  '快照必须在 turn 结束之后拍否则回滚删光产出',
  '客户端代码只能 require react 不能 import 其他包',
]) {
  await engine.remember({ scope: 'workspace', cwd, text })
}

// 2.1 The overlapping lesson appears exactly once, and the footer says why.
{
  const text = await buildRecallText({
    engine,
    cwd,
    question: '装插件 pnpm add 之前要先退出 DSH 进程吗',
    config: { lessonLimit: 6, lessonBudget: 1600, residentLimit: 0 },
  })
  const occurrences = text.split(lessonText).length - 1
  assert.equal(occurrences, 1, `an overlapping lesson must appear exactly once, got ${occurrences}:\n${text}`)
  assert.ok(text.includes('### 踩过的坑'), 'the lesson must render under the lesson section')
  assert.ok(!text.includes(`### 与本次提问相关\n\n- ${lessonText.slice(0, 8)}`), 'it must not also lead the recall section')
  assert.match(text, /与教训层去重 \d+ 条/, 'the footer must account for the dedup')
  checks.push('buildRecallText: a lesson that also matches is printed once, footered')
}

// 2.2 Non-overlapping recall is unaffected — dedup must not eat unrelated lines.
{
  const text = await buildRecallText({
    engine,
    cwd,
    question: '缓存命中率是跟什么走的',
    config: { lessonLimit: 6, lessonBudget: 1600, residentLimit: 0 },
  })
  assert.ok(text.includes('缓存命中率跟 provider 走'), 'an unrelated-but-matched memory must still be injected')
  assert.ok(!text.includes('与教训层去重'), 'no dedup note when nothing was deduped')
  checks.push('buildRecallText: dedup only removes the overlap, never the recall itself')
}

// 2.3 lessonCards carries ids (the mechanism the dedup relies on).
{
  const cards = await engine.lessonCards({ cwd, limit: 6, budget: 1600 })
  assert.ok(cards.length > 0, 'the fixture must produce at least one lesson card')
  assert.ok(cards.every(card => typeof card.id === 'string'), 'every lesson card must carry its entry id')
  checks.push('lessonCards: cards carry entry ids for cross-layer dedup')
}

await fs.rm(root, { recursive: true, force: true })
console.log(checks.map((line, index) => `  ${index + 1}. ${line}`).join('\n'))
console.log(`\n${checks.length}/${checks.length} checks passed`)
