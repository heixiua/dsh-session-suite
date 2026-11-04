/**
 * Tests for how many memories actually get injected, and why the rest did not.
 *
 * The bug this guards against: a fixed recall budget spends six slots on a
 * question that matched one memory, and the prompt then asserts six things are
 * relevant. The second half — naming the reason each candidate was dropped — is
 * what makes a silent decision distinguishable from a broken feature.
 *
 * Usage: node tools/selftest-injection.mjs
 */

import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { MemoryEngine, injectionTier } from '../lib/memory-engine.js'

const checks = []
const root = await fs.mkdtemp(path.join(os.tmpdir(), 'injection-'))
const cwd = path.join(root, 'ws')
await fs.mkdir(cwd, { recursive: true })
const engine = new MemoryEngine({ root })

// 1. The tier function itself, at every boundary. These are the numbers the
//    recall probes produced, so the boundaries are meaningful rather than round.
{
  assert.equal(injectionTier(0.9), Number.MAX_SAFE_INTEGER, 'a strong match may use the full budget')
  assert.equal(injectionTier(0.6), Number.MAX_SAFE_INTEGER, '0.6 is the strong threshold, inclusive')
  assert.equal(injectionTier(0.55), 4, 'a usable match gets four slots')
  assert.equal(injectionTier(0.5), 4, '0.5 is the usable threshold, inclusive')
  assert.equal(injectionTier(0.45), 3, 'a marginal match gets three slots')
  assert.equal(injectionTier(0.4), 3, '0.4 is the marginal threshold, inclusive')
  assert.equal(injectionTier(0.39), 1, 'just below marginal gets one slot')
  checks.push('injectionTier() steps down at 0.6 / 0.5 / 0.4')
}

// 2. Garbage input must take the conservative branch, not the generous one.
//    This is the assertion that would have caught `undefined >= 0.4`.
{
  assert.equal(injectionTier(undefined), 1)
  assert.equal(injectionTier(null), 1)
  assert.equal(injectionTier(Number.NaN), 1)
  assert.equal(injectionTier(-1), 1)
  checks.push('injectionTier() treats missing or invalid scores as weak')
}

// Fixture: five obviously distinct memories.
const seeds = [
  '缓存命中率跟 provider 走而不跟模型名走',
  '插件 apply 抛异常会把 fiberPhase 标成 failed',
  '快照必须在 turn 结束之后拍，否则回滚会删光产出',
  '导出必须白名单 user 来源，否则管道事件会泄漏',
  '删除消息要切在该轮提问之前而不是回复之前',
]
for (const text of seeds) await engine.remember({ scope: 'workspace', cwd, text })

// 3. A genuine match is injected, and it is the right one.
{
  const picked = await engine.select({ cwd, query: '回滚的时候快照是什么时候拍的', limit: 6 })
  assert.equal(picked.items.length > 0, true, 'a matching question must inject something')
  assert.equal(
    picked.items[0].text.includes('快照'),
    true,
    `the snapshot memory must rank first, got: ${picked.items[0].text}`,
  )
  checks.push('select() injects the memory that answers the question')
}

// 4. Every omission carries a reason, and the reasons are from a closed set.
//    An unexplained omission is the thing that makes a memory system look broken.
{
  const picked = await engine.select({ cwd, query: '回滚的时候快照是什么时候拍的', limit: 2 })
  assert.equal(picked.omitted.length > 0, true, 'the fixture must leave something out')
  for (const entry of picked.omitted) {
    assert.equal(
      ['no-match', 'capacity'].includes(entry.reason),
      true,
      `unexpected omission reason: ${entry.reason}`,
    )
    assert.equal(typeof entry.id, 'string', 'an omission must name the entry it dropped')
    assert.equal(typeof entry.rank, 'number', 'an omission must carry the rank it had')
  }
  checks.push('every omitted candidate carries a reason from a closed set')
}

// 5. A question that matches nothing must inject nothing rather than padding the
//    budget with unrelated memories. This is the core behaviour change.
{
  const picked = await engine.select({ cwd, query: 'qqqzzz', limit: 6 })
  assert.equal(
    picked.items.length,
    0,
    `no match must inject nothing, got ${picked.items.length}: ${picked.items.map(i => i.text)}`,
  )
  assert.equal(picked.omitted.length, seeds.length, 'all candidates are reported as omitted')
  assert.equal(
    picked.omitted.every(entry => entry.reason === 'no-match'),
    true,
    'all omissions must be attributed to the match test',
  )
  checks.push('a question matching nothing injects nothing')
}

// 6. Without a question the budget is governed by importance alone, and the
//    configured limit still wins over the tier.
{
  const picked = await engine.select({ cwd, limit: 3 })
  assert.equal(picked.items.length, 3, 'no question means no match filter, so the limit applies')
  // Assert the count positively. `[].every(...)` is true, so checking only the
  // reason of each entry would pass even if capacity omissions were never
  // reported at all — mutation testing caught exactly that hole.
  assert.equal(
    picked.omitted.length,
    seeds.length - 3,
    `every candidate past the limit must be reported (expected ${seeds.length - 3}, got ${picked.omitted.length})`,
  )
  assert.equal(
    picked.omitted.some(entry => entry.reason === 'capacity'),
    true,
    'at least one omission must be attributed to the limit',
  )
  assert.equal(
    picked.omitted.every(entry => entry.reason === 'capacity'),
    true,
    'without a question nothing can be dropped for failing to match',
  )
  checks.push('select() honours the configured limit when no question is asked')
}

// 7. The tier must actually shrink the injection for weak evidence, and the
//    `tiered: false` escape hatch must restore the old behaviour.
{
  const weak = await engine.select({ cwd, query: '缓存', limit: 6 })
  const untiered = await engine.select({ cwd, query: '缓存', limit: 6, tiered: false })
  assert.equal(
    weak.items.length <= untiered.items.length,
    true,
    `tiering must never inject more than the untiered path (${weak.items.length} vs ${untiered.items.length})`,
  )
  assert.equal(untiered.effectiveLimit, 6, 'tiered:false must use the caller budget unchanged')
  checks.push('tiering never injects more than the untiered path')
}

// 8. Only the entries actually injected are counted as accessed. Counting the
//    dropped ones would let a memory climb the ranking by being repeatedly
//    considered and rejected.
{
  const before = new Map((await engine.list({ cwd })).map(entry => [entry.id, entry.accessCount ?? 0]))
  const picked = await engine.select({ cwd, query: '导出泄漏管道事件', limit: 1 })
  const after = new Map((await engine.list({ cwd })).map(entry => [entry.id, entry.accessCount ?? 0]))
  const selectedIds = new Set(picked.items.map(item => item.id))
  const bumped = [...after].filter(([id, count]) => count > (before.get(id) ?? 0)).map(([id]) => id)
  assert.deepEqual(
    bumped.sort(),
    [...selectedIds].sort(),
    'exactly the injected entries must have their access count raised',
  )
  checks.push('only injected entries are counted as accessed')
}

// 9. The last selection is retained so the settings page can explain itself
//    without replaying the query.
{
  await engine.select({ cwd, query: '缓存命中率', limit: 6 })
  assert.equal(engine.lastSelection !== null && engine.lastSelection !== undefined, true, 'lastSelection must be recorded')
  assert.equal(engine.lastSelection.query, '缓存命中率')
  assert.equal(typeof engine.lastSelection.topScore, 'number')
  checks.push('select() records the last selection for the UI')
}

// 10. `select` must not mutate the ranking `recall` returns, or the probes that
//     measure full ranking quality would change underneath us.
{
  const ranked = await engine.recall({ cwd, query: '快照回滚', limit: 500, touch: false })
  const again = await engine.recall({ cwd, query: '快照回滚', limit: 500, touch: false })
  assert.deepEqual(
    ranked.map(item => item.id),
    again.map(item => item.id),
    'recall must be deterministic',
  )
  assert.equal(ranked.length, seeds.length, 'recall must still return every candidate, not a filtered subset')
  checks.push('recall() still returns the full ranking that the probes measure')
}

await fs.rm(root, { recursive: true, force: true })
console.log(checks.map((line, index) => `  ${index + 1}. ${line}`).join('\n'))
console.log(`\n${checks.length}/${checks.length} checks passed`)
