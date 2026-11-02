/**
 * Self-test for the long-term memory engine.
 *
 * Run: node tools/selftest-memory.mjs
 */

import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { MemoryEngine, coverage, scoreEntry, similarity, shingles, stateForScore } from '../lib/memory-engine.js'

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dss-memory-'))
const engine = new MemoryEngine({ root })
const cwdA = path.join(root, 'ws-a')
const cwdB = path.join(root, 'ws-b')

// --- similarity works for Chinese and English alike ------------------------
assert.ok(similarity(shingles('优先使用 Trae 的积分'), shingles('优先使用 Trae 积分')) > 0.8)
assert.ok(similarity(shingles('prefer trae credits'), shingles('prefer workbuddy credits')) < 0.6)
assert.ok(similarity(shingles('用户偏好用中文回复'), shingles('插件代码只依赖 node 内置模块')) < 0.1)
assert.equal(similarity(shingles(''), shingles('x')), 0)

// --- thresholds map a score to a state -------------------------------------
assert.equal(stateForScore(0.9), 'active')
assert.equal(stateForScore(0.35), 'compressed')
assert.equal(stateForScore(0.1), 'archived')

// --- scoring: frequent and recent beats stale ------------------------------
const fresh = { accessCount: 8, lastAccessAt: Date.now(), affect: 0.9, frozen: false }
const stale = { accessCount: 1, lastAccessAt: Date.now() - 200 * 86400000, affect: 0.2, frozen: false }
const freshScore = scoreEntry(fresh, { maxAccess: 8, uniqueness: 1, decayDays: 60 }).score
const staleScore = scoreEntry(stale, { maxAccess: 8, uniqueness: 1, decayDays: 60 }).score
assert.ok(freshScore > 0.8, `frequent memory scores high, got ${freshScore}`)
assert.ok(staleScore < 0.4, `stale memory decays, got ${staleScore}`)
assert.ok(freshScore - staleScore > 0.45, 'fresh and stale are clearly separated')
assert.equal(scoreEntry({ ...stale, frozen: true }, { maxAccess: 8, uniqueness: 1, decayDays: 60 }).factors.recency, 1, 'frozen pins the clock')

// --- two isolated stores ---------------------------------------------------
const g1 = await engine.remember({ scope: 'global', text: 'DSH 调度策略：优先消耗 WorkBuddy/Trae 积分', tags: ['调度'] })
const w1 = await engine.remember({ scope: 'workspace', cwd: cwdA, text: '本工作区约定：插件代码只依赖 node 内置模块', tags: ['dsh'] })
const other = await engine.remember({ scope: 'workspace', cwd: cwdB, text: '另一个工作区的偏好', tags: [] })

const listA = await engine.list({ cwd: cwdA })
const listB = await engine.list({ cwd: cwdB })
assert.equal(listA.filter(item => item.scope === 'workspace').length, 1, 'workspace A sees only its own entry')
assert.equal(listB.filter(item => item.scope === 'workspace').length, 1, 'workspace B is isolated')
assert.ok(listA.some(item => item.scope === 'global' && item.id === g1.entry.id), 'global memory is visible everywhere')

// --- recall ranks the relevant entry first and refreshes its clock ---------
const recalled = await engine.recall({ cwd: cwdA, query: 'Trae 积分怎么用', limit: 3 })
assert.equal(recalled[0].id, g1.entry.id, 'the matching memory ranks first')
assert.ok(recalled[0].relevance > 0)
const after = (await engine.list({ cwd: cwdA })).find(item => item.id === g1.entry.id)
assert.ok(after.accessCount >= 2, 'recall counts as an access')
assert.ok(after.lastAccessAt > g1.entry.lastAccessAt, 'recall refreshes the decay clock')

// --- a near-duplicate reinforces instead of duplicating --------------------
const dupe = await engine.remember({ scope: 'global', text: 'DSH 调度策略：优先消耗 WorkBuddy/Trae 积分', tags: ['调度'] })
assert.ok(dupe.duplicateOf, 'a near-duplicate is merged into the existing entry')
assert.equal((await engine.list({ cwd: cwdA })).filter(item => item.scope === 'global').length, 1)

// --- clustering compresses similar entries into one summary ----------------
await engine.remember({ scope: 'workspace', cwd: cwdA, text: '代码任务优先使用 Trae 的积分', tags: ['调度'] })
await engine.remember({ scope: 'workspace', cwd: cwdA, text: '代码任务优先用 Trae 积分', tags: ['调度'] })
const report = await engine.maintain(cwdA)
assert.ok(report.clusters >= 1, `a cluster is formed, got ${JSON.stringify(report)}`)
const withSummary = (await engine.list({ cwd: cwdA })).find(item => item.summary === true)
assert.ok(withSummary, 'a summary entry stands in for the cluster')

// --- freezing survives decay ----------------------------------------------
const frozenTarget = (await engine.list({ cwd: cwdA })).find(item => item.scope === 'workspace' && !item.summary)
await engine.update({ cwd: cwdA, scope: 'workspace', id: frozenTarget.id, patch: { frozen: true } })
await engine.maintain(cwdA)
const stillThere = (await engine.list({ cwd: cwdA })).find(item => item.id === frozenTarget.id)
assert.ok(stillThere, 'a frozen memory is never archived')

// --- implicit suggestions need confirmation -------------------------------
const suggestion = await engine.suggest({ text: '用户偏好用中文回复', scope: 'workspace', cwd: cwdA })
assert.ok(suggestion?.id)
const pendingList = await engine.pending(cwdA)
assert.equal(pendingList.length, 1, 'an implicit suggestion waits for confirmation')
await engine.settle(suggestion.id, true)
assert.equal((await engine.pending(cwdA)).length, 0, 'settling clears the queue')
assert.ok((await engine.list({ cwd: cwdA })).some(item => item.text.includes('中文回复')), 'an accepted suggestion becomes memory')

// --- removal and cold archive ---------------------------------------------
const before = (await engine.list({ cwd: cwdA })).length
await engine.remove({ cwd: cwdA, id: w1.entry.id })
assert.ok((await engine.list({ cwd: cwdA })).length < before)

// A stale entry (old and rarely used) decays into the cold archive, stays
// recallable on demand, and can be cleared explicitly.
await engine.remember({ scope: 'workspace', cwd: cwdB, text: '很久以前的临时约定', tags: [] })
const staleEntry = (await engine.list({ cwd: cwdB })).find(item => item.text.includes('临时约定'))
const staleFile = path.join(root, 'memory', 'workspaces', `${staleEntry.workspaceKey}.json`)
const store = JSON.parse(await fs.readFile(staleFile, 'utf8'))
const target = store.entries.find(item => item.id === staleEntry.id)
target.lastAccessAt = Date.now() - 400 * 86400000
target.accessCount = 0
target.affect = 0.1
await fs.writeFile(staleFile, JSON.stringify(store), 'utf8')
const decay = await engine.maintain(cwdB)
assert.ok(decay.archived >= 1, `a stale entry is archived, got ${JSON.stringify(decay)}`)
assert.ok((await engine.list({ cwd: cwdB, scope: 'workspace' })).some(item => item.archived), 'the archived entry is still listed')
await engine.remove({ scope: 'workspace', cwd: cwdB })
assert.equal((await engine.list({ cwd: cwdB, scope: 'workspace' })).filter(item => item.archived).length, 0, 'clearing the cold archive empties it')

// --- retrieval ranks by coverage, not by symmetric similarity --------------
// A long memory that answers the query must beat a shorter, more "important"
// memory that does not. This is the property Jaccard silently broke: a 10
// shingle query against a 90 shingle memory caps at 0.11 even when every
// query term is present, so importance decided every ranking.
await engine.remember({
  scope: 'workspace',
  cwd: cwdB,
  text: '回滚时若工作区文件被删除，只能恢复本工作区内的文件；工作区之外的删除无法通过回滚找回，因为快照只覆盖 cwd。回滚还会同时恢复会话记忆和对话上下文。',
})
await engine.remember({
  scope: 'workspace',
  cwd: cwdB,
  text: '用户偏好简洁回复',
})
const ranked = await engine.recall({ cwd: cwdB, query: '回滚 工作区 之外 文件', limit: 5, touch: false })
assert.ok(
  ranked[0].text.includes('工作区之外'),
  `a long on-topic memory outranks a short unrelated one, got "${ranked[0].text.slice(0, 30)}"`,
)
assert.ok(ranked[0].coverage > 0.5, `coverage reflects the query, got ${ranked[0].coverage}`)
// Coverage is query-length normalized, so it is not capped by document length.
const longDoc = shingles('回滚 工作区 之外 文件'.padEnd(200, ' 填充词'))
assert.equal(coverage(shingles('回滚 工作区 之外 文件'), longDoc), 1, 'coverage ignores document length')
assert.equal(coverage(shingles(''), longDoc), 0, 'an empty query covers nothing')
// Jaccard still guards deduplication, where both sides are memories.
assert.ok(similarity(shingles('用户偏好简洁回复'), shingles('用户偏好简洁回复')) === 1)

await fs.rm(root, { recursive: true, force: true })
console.log(JSON.stringify({ ok: true, clusters: report.clusters, archived: decay.archived }, null, 2))
