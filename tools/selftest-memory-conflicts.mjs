/**
 * Conflict queue: two memories that cannot both be true.
 *
 * The library converges a fact that carries a `factKey` (same key, newest wins),
 * but most entries — including every extracted one — have no key. A corrected
 * belief is therefore stored *next to* the belief it corrects, and injection can
 * carry both into the same prompt. The model then picks by recency, which is a
 * coin flip wearing a confident face.
 *
 * What this pins:
 *   1. the XOR polarity rule — agreement pairs stay out of the queue;
 *   2. the similarity band — weak-topical and already-duplicate pairs stay out;
 *   3. pairKey is order-insensitive, so a scan cannot queue one pair twice;
 *   4. maintain() detects and queues, and never resolves on its own;
 *   5. a queued pair whose entries moved on drops out of the listing;
 *   6. resolve(winner) supersedes the loser and freezes the survivor;
 *   7. resolve(null) dismisses, and a dismissed pair is never re-queued.
 *
 * Usage: node tools/selftest-memory-conflicts.mjs
 */

import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { MemoryEngine, shingles, similarity } from '../lib/memory-engine.js'
import { CONFLICT_BAND, detectConflict, hasNegation, pairKey, polarityOf } from '../lib/conflicts.js'

const checks = []

/** @returns {Promise<string>} a throwaway storage root */
async function freshRoot() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'mem-conflicts-'))
}

/** @param {string} a first @param {string} b second @returns {number} similarity */
function sim(a, b) {
  return similarity(shingles(a), shingles(b))
}

// 1. The XOR rule. Exactly one side negating is the signal; both forbidding is
//    agreement, which is the shape most of the noise would take if we used OR.
{
  const conflictPairs = [
    ['必须在轮次开始拍快照', '绝不在轮次开始拍快照'],
    ['pnpm 会写 bundles 目录', 'pnpm 不会写 bundles 目录'],
    ['发布前要跑全量回归', '发布前不要跑全量回归'],
  ]
  for (const [a, b] of conflictPairs) {
    const verdict = detectConflict({ text: a }, { text: b }, 0.6)
    assert.equal(verdict.conflict, true, `must flag as conflict: ${a} / ${b}`)
    // The positive side carries an explicit requirement cue only in the first
    // pair; the other two are still contradictions, just expressed without one,
    // and they are reported as the weaker reason so a caller can filter.
    assert.ok(
      verdict.reason === 'opposite-polarity' || verdict.reason === 'polarity-mismatch',
      `conflict reason must name the polarity, got ${verdict.reason}`,
    )
  }
  assert.equal(
    detectConflict({ text: '必须在轮次开始拍快照' }, { text: '绝不在轮次开始拍快照' }, 0.6).reason,
    'opposite-polarity',
  )
  const agreementPairs = [
    ['不要用 workbuddy', '别用 workbuddy'],
    ['禁止直接改 node_modules', '严禁直接改 node_modules'],
    ['必须用 pnpm.cmd', '应当用 pnpm.cmd'],
  ]
  for (const [a, b] of agreementPairs) {
    const verdict = detectConflict({ text: a }, { text: b }, 0.6)
    assert.equal(verdict.conflict, false, `must NOT flag agreement: ${a} / ${b}`)
    assert.ok(
      verdict.reason === 'both-negated' || verdict.reason === 'neither-negated',
      `agreement reason must name the polarity, got ${verdict.reason}`,
    )
  }
  checks.push('XOR polarity: opposite sides flagged, agreement pairs ignored')
}

// 2. The band. Below the floor the two entries only share a domain; at or above
//    the ceiling the write path already treated them as one memory.
{
  const a = { text: '必须在轮次开始拍快照' }
  const b = { text: '绝不在轮次开始拍快照' }
  assert.equal(detectConflict(a, b, CONFLICT_BAND.min - 0.01).conflict, false)
  assert.equal(detectConflict(a, b, CONFLICT_BAND.min - 0.01).reason, 'below-topic-floor')
  assert.equal(detectConflict(a, b, CONFLICT_BAND.max).conflict, false)
  assert.equal(detectConflict(a, b, CONFLICT_BAND.max).reason, 'above-duplicate-threshold')
  assert.equal(detectConflict(a, b, CONFLICT_BAND.min).conflict, true, 'floor is inclusive')
  // A caller may narrow the window without touching the default.
  assert.equal(detectConflict(a, b, 0.6, { min: 0.7, max: 0.9 }).conflict, false)
  checks.push('similarity band: floor inclusive, ceiling exclusive, overridable')
}

// 2b. A text that both requires and negates is not making a single polar claim:
//     the negation is subordinate. Real regression that motivated this — the
//     rule generator stopped producing rules because 「…必须运行 selftest 确认
//     没有回归」 was read as "forbids" and thus contradicted its sibling.
{
  const subordinate = '提交代码前必须运行 selftest 确认没有回归'
  const sibling = '提交代码前必须运行 selftest 测试套件'
  assert.equal(polarityOf(subordinate), 'mixed')
  assert.equal(polarityOf(sibling), 'positive')
  const verdict = detectConflict({ text: subordinate }, { text: sibling }, 0.6)
  assert.equal(verdict.conflict, false, 'a subordinate negation is not a stance')
  assert.equal(verdict.reason, 'subordinate-negation')
  // Stripping the negation before looking for a requirement is what keeps a
  // plain prohibition ("不要用 X", which contains 要) from reading as mixed.
  assert.equal(polarityOf('不要用 workbuddy'), 'negative')
  assert.equal(polarityOf('禁止直接改 node_modules'), 'negative')
  checks.push('subordinate negation is not a stance; plain prohibitions stay negative')
}

// 3. pairKey is order-insensitive and stable.
{
  assert.equal(pairKey('mem_a', 'mem_b'), pairKey('mem_b', 'mem_a'))
  assert.notEqual(pairKey('mem_a', 'mem_b'), pairKey('mem_a', 'mem_c'))
  checks.push('pairKey: (a,b) and (b,a) are one pair')
}

// 4. maintain() queues the pair and leaves both entries alone.
{
  const root = await freshRoot()
  const engine = new MemoryEngine({ root, config: {} })
  const cwd = 'D:\\ws-conflict'
  const first = await engine.remember({
    scope: 'workspace', cwd, text: '必须在轮次开始拍快照', tags: ['dsh'], affect: 0.9,
  })
  const second = await engine.remember({
    scope: 'workspace', cwd, text: '绝不在轮次开始拍快照', tags: ['dsh'], affect: 0.9,
  })
  const band = sim(first.entry.text, second.entry.text)
  assert.ok(
    band >= CONFLICT_BAND.min && band < CONFLICT_BAND.max,
    `fixture must land inside the band, got ${band.toFixed(3)}`,
  )

  const report = await engine.maintain(cwd)
  assert.equal(report.conflictsQueued, 1, 'one pair queued')
  const queued = await engine.conflicts(cwd)
  assert.equal(queued.length, 1)
  assert.equal(queued[0].reason, 'opposite-polarity')
  assert.equal(queued[0].pair, pairKey(first.entry.id, second.entry.id))

  // Detection must not resolve. Both sides are still active and un-superseded.
  const after = await engine.list({ cwd })
  for (const id of [first.entry.id, second.entry.id]) {
    const entry = after.find(row => row.id === id)
    assert.ok(entry, `entry survived: ${id}`)
    assert.equal(entry.supersededBy, undefined, 'detection must not supersede')
    assert.equal(entry.state, 'active', 'detection must not archive')
  }
  // Nor may the clustering step fold the pair into one summary. A summary of a
  // contradiction says both things at once ("必须…；绝不…"), which is strictly
  // worse than either memory alone, and it archives both sides so the queue
  // could no longer show them.
  assert.equal(after.filter(row => row.summary).length, 0, 'a contradicting pair is never summarised')
  assert.equal(after.filter(row => row.clusterId).length, 0, 'a contradicting pair is never clustered')
  assert.equal(after.filter(row => row.kind === 'rule').length, 0, 'a contradicting pair is never quoted in a rule')

  // A second pass must not queue the same pair again.
  const again = await engine.maintain(cwd)
  assert.equal(again.conflictsQueued, 0, 'pair is queued once')
  assert.equal((await engine.conflicts(cwd)).length, 1)
  checks.push('maintain(): detects and queues, never resolves, never duplicates')
}

// 5. A pair whose entries moved on drops out of the listing.
{
  const root = await freshRoot()
  const engine = new MemoryEngine({ root, config: {} })
  const cwd = 'D:\\ws-conflict-stale'
  await engine.remember({ scope: 'workspace', cwd, text: '发布前要跑全量回归', tags: ['dsh'], affect: 0.9 })
  const b = await engine.remember({ scope: 'workspace', cwd, text: '发布前不要跑全量回归', tags: ['dsh'], affect: 0.9 })
  await engine.maintain(cwd)
  assert.equal((await engine.conflicts(cwd)).length, 1)

  await engine.remove({ id: b.entry.id, cwd })
  assert.equal((await engine.conflicts(cwd)).length, 0, 'a deleted side empties the pair')
  // The stale item is pruned from disk too, not just filtered on read.
  const raw = JSON.parse(await fs.readFile(path.join(engine.root, 'conflicts.json'), 'utf8'))
  assert.equal(raw.items.length, 0)
  checks.push('conflicts(): a pair whose entries moved on is dropped and pruned')
}

// 6. resolve(winner) supersedes the loser and freezes the survivor.
{
  const root = await freshRoot()
  const engine = new MemoryEngine({ root, config: {} })
  const cwd = 'D:\\ws-conflict-resolve'
  const keep = await engine.remember({
    scope: 'workspace', cwd, text: 'pnpm 会写 bundles 目录', tags: ['dsh'], affect: 0.9,
  })
  const drop = await engine.remember({
    scope: 'workspace', cwd, text: 'pnpm 不会写 bundles 目录', tags: ['dsh'], affect: 0.9,
  })
  await engine.maintain(cwd)
  const [item] = await engine.conflicts(cwd)
  assert.ok(item, 'pair was queued')

  const verdict = await engine.settleConflict(item.id, keep.entry.id)
  assert.equal(verdict.settled, true)
  assert.equal(verdict.action, 'superseded')
  assert.equal(verdict.detail.loserId, drop.entry.id)

  const rows = await engine.list({ cwd })
  const winner = rows.find(row => row.id === keep.entry.id)
  const loser = rows.find(row => row.id === drop.entry.id)
  assert.equal(winner.frozen, true, 'the survivor is frozen against a later automatic pass')
  assert.equal(winner.frozenReason, 'conflict-settled')
  assert.equal(winner.supersededBy, undefined)
  assert.equal(loser.supersededBy, keep.entry.id)
  assert.ok(loser.supersededAt > 0)

  // A settled pair must not come back on the next scan: one side is superseded,
  // and the scan skips superseded entries.
  const report = await engine.maintain(cwd)
  assert.equal(report.conflictsQueued, 0)
  assert.equal((await engine.conflicts(cwd)).length, 0)

  // An id that is not part of the pair is rejected, not silently accepted.
  const bogus = await engine.settleConflict(item.id, 'mem_not_in_pair')
  assert.equal(bogus.settled, false)
  checks.push('settleConflict(winner): loser superseded, survivor frozen, pair stays settled')
}

// 7. resolve(null) dismisses, and a dismissed pair is never re-queued.
{
  const root = await freshRoot()
  const engine = new MemoryEngine({ root, config: {} })
  const cwd = 'D:\\ws-conflict-dismiss'
  await engine.remember({ scope: 'workspace', cwd, text: '要用 pnpm 装插件', tags: ['dsh'], affect: 0.9 })
  await engine.remember({ scope: 'workspace', cwd, text: '不用 pnpm 装插件', tags: ['dsh'], affect: 0.9 })
  await engine.maintain(cwd)
  const [item] = await engine.conflicts(cwd)
  assert.ok(item, 'pair was queued')

  const verdict = await engine.settleConflict(item.id, null)
  assert.equal(verdict.settled, true)
  assert.equal(verdict.action, 'dismissed')
  assert.equal((await engine.conflicts(cwd)).length, 0)

  // Both sides stay true — dismissing is "keep both", not "retire one".
  const rows = await engine.list({ cwd })
  assert.equal(rows.filter(row => row.supersededBy).length, 0)
  assert.equal(rows.filter(row => row.frozen).length, 0)

  // Dismissal is permanent for the pair: the scan still finds the contradiction,
  // but the queue refuses to re-add it. Without this the user would be asked the
  // same question every maintenance pass.
  await engine.maintain(cwd)
  assert.equal((await engine.conflicts(cwd)).length, 0, 'a dismissed pair is not re-queued')
  checks.push('settleConflict(null): keeps both, and the pair never returns')
}

// 8. The scan can be switched off, and the negation detector stays narrow.
{
  assert.equal(hasNegation('不要用 workbuddy'), true)
  assert.equal(hasNegation('必须用 pnpm.cmd'), false)
  assert.equal(hasNegation(''), false)

  const root = await freshRoot()
  const engine = new MemoryEngine({ root, config: { conflictScan: false } })
  const cwd = 'D:\\ws-conflict-off'
  await engine.remember({ scope: 'workspace', cwd, text: '必须在轮次开始拍快照', tags: ['dsh'], affect: 0.9 })
  await engine.remember({ scope: 'workspace', cwd, text: '绝不在轮次开始拍快照', tags: ['dsh'], affect: 0.9 })
  const report = await engine.maintain(cwd)
  assert.equal(report.conflictsQueued, 0)
  assert.equal((await engine.conflicts(cwd)).length, 0)
  checks.push('conflictScan:false disables the scan; negation detector stays narrow')
}

// 9. A correction inside a LONG memory. Real entries are 100–300 characters and
//    contain several clauses, so whole-text polarity has no answer for them: the
//    library measures 29 of 64 active entries as "both requires and negates". The
//    first version bailed out on those and was blind to 20 of 45 constructed
//    contradictions. Clause-level comparison is what makes the long case work.
{
  const original =
    '【通用规则·幂等性】幂等性必须跨阶段验证：单看阶段2确实幂等，回路在阶段之间；第一版测试只测阶段2所以回退代码也通过。测试必须让 fixture 含够多带 tag 的记忆以触发阶段3。'
  const corrected = original.replace('必须', '绝对不要')
  assert.ok(original.length > 60, 'fixture must be a realistic length')
  assert.equal(polarityOf(original), 'positive')
  assert.equal(polarityOf(corrected), 'negative')
  const verdict = detectConflict({ text: original }, { text: corrected }, 0.88)
  assert.equal(verdict.conflict, true, 'a one-clause correction inside a long memory must be caught')
  assert.equal(verdict.reason, 'opposite-polarity')
  // The clause that changed is named, so the queue can show what moved.
  assert.ok(verdict.clauseB?.includes('绝对不要'), `expected the changed clause, got ${verdict.clauseB}`)

  // And it must be caught even when the whole text is "mixed" on both sides —
  // that is the shape most real memories have.
  const a = '快照必须在 turn/end 拍，第 0 轮拍 baseline；在轮次开始拍会导致回滚把本轮产出全删光'
  const b = '快照绝不要在 turn/end 拍，第 0 轮拍 baseline；在轮次开始拍会导致回滚把本轮产出全删光'
  const mixedVerdict = detectConflict({ text: a }, { text: b }, 0.9)
  assert.equal(mixedVerdict.conflict, true, 'a contradiction between two long mixed-stance texts must be caught')
  checks.push('clause-level detection: a one-clause correction in a long memory is caught')
}

// 10. The write path must not SWALLOW a correction. Above `duplicateSimilarity`
//     (0.82) remember() reinforces the existing entry; a one-clause correction of
//     a 95-character rule scores 0.879, so the corrected text was discarded and
//     the OLD claim reinforced — no error, no trace. That is worse than a missed
//     conflict: the library keeps the wrong claim and looks confident about it.
{
  const root = await freshRoot()
  const engine = new MemoryEngine({ root, config: {} })
  const cwd = 'D:\\ws-conflict-swallow'
  const original =
    '【通用规则·幂等性】幂等性必须跨阶段验证：单看阶段2确实幂等，回路在阶段之间；第一版测试只测阶段2所以回退代码也通过。测试必须让 fixture 含够多带 tag 的记忆以触发阶段3。'
  const corrected = original.replace('必须', '绝对不要')
  const similarityValue = sim(original, corrected)
  assert.ok(similarityValue >= 0.82, `fixture must exceed the duplicate threshold, got ${similarityValue.toFixed(3)}`)

  await engine.remember({ scope: 'workspace', cwd, text: original, tags: ['错误教训'] })
  const second = await engine.remember({ scope: 'workspace', cwd, text: corrected, tags: ['错误教训'] })
  assert.equal(Boolean(second.duplicateOf), false, 'a correction with opposite polarity is not a duplicate')
  const rows = await engine.list({ cwd, scope: 'workspace' })
  assert.equal(rows.length, 2, 'both the old claim and the correction survive')
  assert.ok(rows.some(row => row.text === corrected), 'the corrected text is stored, not discarded')

  // A near-identical text with the SAME stance is still a duplicate — the fix
  // must not turn ordinary deduplication off.
  const restated = original.replace(/。$/, '')
  assert.ok(sim(restated, original) >= 0.82, 'the restatement must be a near-duplicate by similarity')
  const third = await engine.remember({ scope: 'workspace', cwd, text: restated, tags: ['错误教训'] })
  assert.equal(Boolean(third.duplicateOf), true, 'a same-stance restatement still reinforces')
  assert.equal((await engine.list({ cwd, scope: 'workspace' })).length, 2, 'and does not add a row')
  checks.push('remember(): a near-duplicate correction is stored, a same-stance restatement is not')
}

// 11. The scan must see a contradiction SPLIT ACROSS STORES.
//
//    maintain() runs its scan inside the per-store loop, so the first version
//    compared entries within one store only. But recall and injection MERGE the
//    global store with the workspace store: a global rule and a workspace rule
//    that contradict each other land in the same prompt, which is exactly what
//    the queue exists to prevent. Measured before the fix: 0.737 similarity,
//    both scopes injected, queue empty.
{
  const root = await freshRoot()
  const engine = new MemoryEngine({ root, config: {} })
  const cwd = 'D:\\ws-cross-store'
  await engine.remember({
    scope: 'global', cwd, text: '必须在轮次开始拍快照，否则本轮产出会丢', tags: ['dsh'], affect: 0.9,
  })
  await engine.remember({
    scope: 'workspace', cwd, text: '绝不能在轮次开始拍快照，否则本轮产出会丢', tags: ['dsh'], affect: 0.9,
  })
  const report = await engine.maintain(cwd)
  assert.equal(report.conflictsQueued, 1, 'a global/workspace contradiction is queued')
  const [item] = await engine.conflicts(cwd)
  assert.ok(item, 'the pair is listed')
  // Both sides reach the prompt — that is the premise, so assert it rather than
  // assume it.
  const sel = await engine.select({ cwd, query: '拍快照 轮次开始', limit: 8, touch: false })
  const scopes = new Set(sel.items.map(row => row.scope))
  assert.equal(scopes.has('global') && scopes.has('workspace'), true, 'both sides are injected')

  // Settling must write the loser back to ITS OWN store, not to the item's scope.
  const verdict = await engine.settleConflict(item.id, item.a.id)
  assert.equal(verdict.settled, true)
  const rows = await engine.list({ cwd, includeArchived: true })
  const winner = rows.find(row => row.id === item.a.id)
  const loser = rows.find(row => row.id === item.b.id)
  assert.equal(winner.frozen, true, 'the survivor is frozen')
  assert.equal(loser.supersededBy, item.a.id, 'the loser is retired in whichever store it lives')
  checks.push('cross-store contradictions are detected and settled across two stores')
}

// 12. A scoped read must not delete another workspace's queue items.
//
//    The queue is one shared file, and conflicts(cwd) used to filter the array by
//    workspace and write the filtered array back — so "not mine" became "stale",
//    and opening the memory page in one workspace wiped every other workspace's
//    pending conflicts (measured: 1 -> 0). Only items the call actually inspected
//    may be pruned.
{
  const root = await freshRoot()
  const engine = new MemoryEngine({ root, config: {} })
  const wsA = 'D:\\ws-cross-a'
  const wsB = 'D:\\ws-cross-b'
  await engine.remember({ scope: 'workspace', cwd: wsB, text: '必须用 pnpm 装插件', tags: ['dsh'], affect: 0.9 })
  await engine.remember({ scope: 'workspace', cwd: wsB, text: '不要用 pnpm 装插件', tags: ['dsh'], affect: 0.9 })
  await engine.maintain(wsB)
  assert.equal((await engine.conflicts(wsB)).length, 1)
  assert.equal((await engine.conflicts(wsA)).length, 0, 'wsA sees nothing of its own')
  assert.equal((await engine.conflicts(wsA)).length, 0)
  assert.equal((await engine.conflicts(wsB)).length, 1, 'wsB keeps its pending conflict after wsA reads')

  // A genuinely dead pair must STILL be pruned, or the queue grows forever.
  const keep = await engine.remember({ scope: 'workspace', cwd: wsA, text: '发布前要跑全量回归', tags: ['dsh'], affect: 0.9 })
  const drop = await engine.remember({ scope: 'workspace', cwd: wsA, text: '发布前不要跑全量回归', tags: ['dsh'], affect: 0.9 })
  await engine.maintain(wsA)
  assert.equal((await engine.conflicts(wsA)).length, 1)
  await engine.remove({ id: drop.entry.id, cwd: wsA })
  assert.equal((await engine.conflicts(wsA)).length, 0, 'a dead pair drops out')
  // wsB's item is still on disk — that is the whole point of the fix — so the
  // assertion is about WHICH item survives, not about the file being empty.
  const raw = JSON.parse(await fs.readFile(path.join(engine.root, 'conflicts.json'), 'utf8'))
  assert.equal(raw.items.length, 1, 'only the dead pair was pruned')
  assert.equal(raw.items[0].workspaceKey, MemoryEngine.workspaceKey(wsB), "the survivor is wsB's, not wsA's")
  assert.equal((await engine.conflicts(wsB)).length, 1, 'while wsB is still untouched')
  checks.push('a scoped read never prunes another workspace; dead pairs still are')
}

// 13. A retired row must not keep `frozen`.
//
//    `frozen` means "the user pinned this" and outranks every automatic pass.
//    Reversing a settled decision used to leave the old winner both superseded
//    and frozen, which makes a retired memory look authoritative.
{
  const root = await freshRoot()
  const engine = new MemoryEngine({ root, config: {} })
  const cwd = 'D:\\ws-cross-flip'
  const keep = await engine.remember({ scope: 'workspace', cwd, text: '发布前要跑全量回归', tags: ['dsh'], affect: 0.9 })
  const drop = await engine.remember({ scope: 'workspace', cwd, text: '发布前不要跑全量回归', tags: ['dsh'], affect: 0.9 })
  await engine.maintain(cwd)
  const [item] = await engine.conflicts(cwd)
  await engine.settleConflict(item.id, keep.entry.id)
  // Change of mind: the retired claim is restated, then settled the other way.
  await engine.remember({ scope: 'workspace', cwd, text: '发布前不要跑全量回归', tags: ['dsh'], affect: 0.9 })
  await engine.maintain(cwd)
  const [again] = await engine.conflicts(cwd)
  assert.ok(again, 'the restated claim re-opens the question')
  const flip = await engine.settleConflict(again.id, drop.entry.id)
  assert.equal(flip.settled, true)
  const rows = await engine.list({ cwd, scope: 'workspace' })
  const oldWinner = rows.find(row => row.id === keep.entry.id)
  assert.equal(Boolean(oldWinner.supersededBy), true, 'the old winner is retired')
  assert.equal(oldWinner.frozen, false, 'a retired row does not keep the pin flag')
  checks.push('a superseded entry never keeps frozen=true')
}

console.log('')
for (const check of checks) console.log(`  ✓ ${check}`)
console.log(`\n${checks.length} conflict-queue checks passed\n`)
