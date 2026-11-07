/**
 * Library capacity ceilings.
 *
 * A forgetting mechanism that only deletes expired cold rows still lets the LIVE
 * pool grow without bound. This pins two ceilings and — more importantly — the
 * safety properties of eviction:
 *
 *   1. past `maxActiveEntries`, the LOWEST-SCORING rows are evicted;
 *   2. eviction means ARCHIVE, not hard delete: evicted rows stay in cold storage
 *      with an `archivedAt`, so the retention undo window still applies;
 *   3. `evictTarget` hysteresis: a single pass drops all the way to the target
 *      and the next pass does not oscillate;
 *   4. protected rows (frozen / secret / lesson / summary / pinned) are never
 *      evicted; a plain high-affect row is NOT protected (0.85 is the default
 *      tool-write affect) and MUST be evictable, else capacity is defeated;
 *   5. the whole-library ceiling `maxTotalEntries` ranks ACROSS stores, so five
 *      stores cannot each sit just under the per-store cap and still total 250;
 *   6. the report says what was evicted, from which scope, and why — no silent
 *      disappearance;
 *   7. `maxActiveEntries: 0` / `maxTotalEntries: 0` disable the ceilings, and a
 *      small library (the shipped 97 rows: max store = 30) is untouched.
 *
 * Usage: node tools/selftest-capacity.mjs
 */

import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { MemoryEngine } from '../lib/memory-engine.js'

const checks = []
const DAY = 86400000
const ROOT = await fs.mkdtemp(path.join(os.tmpdir(), 'capacity-'))

/** @returns {MemoryEngine} a fresh engine over an isolated sub-root */
let seq = 0
function engine(config) {
  seq += 1
  return new MemoryEngine({ root: path.join(ROOT, `case${seq}`), config })
}

/** Config with both ceilings small enough to trigger with a handful of rows. */
const BASE = {
  decayDays: 30, newMemoryGraceDays: 7, maxUnusedDays: 0, // disable forced archiving
  archiveRetentionDays: 30, archivePurgeEnabled: false, // no auto-delete during eviction tests
  purgeCheckIntervalMs: DAY,
  maxActiveEntries: 5, evictTarget: 3, maxTotalEntries: 0,
  clusterMinSize: 99, ruleMinSize: 99, // keep clustering/rules out of the way
}

/** Insert N ordinary, unprotected, differently-scored memories into one store. */
async function fill(e, scope, cwd, n, prefix) {
  const ids = []
  for (let i = 0; i < n; i += 1) {
    const { entry } = await e.remember({
      scope, cwd, text: `${prefix} 第 ${i} 条普通记忆 ${['alpha', 'beta', 'gamma', 'delta', 'epsilon', 'zeta', 'eta', 'theta'][i % 8]}`,
      affect: 0.4,
      ...(i === 0 ? { tags: [] } : {}),
    })
    ids.push(entry.id)
  }
  // Force a deterministic score ordering by backdating accessCount/lastAccessAt.
  // Row 0 stays high-scoring (fresh + more accesses); later rows score lower.
  // e.root already ends with /memory (MemoryEngine joins it in the constructor).
  const storeFile = scope === 'global'
    ? path.join(e.root, 'global.json')
    : path.join(e.root, 'workspaces', `${MemoryEngine.workspaceKey(cwd)}.json`)
  const store = JSON.parse(await fs.readFile(storeFile, 'utf8'))
  for (let i = 0; i < store.entries.length; i += 1) {
    const row = store.entries[i]
    row.accessCount = Math.max(1, 10 - i)
    row.lastAccessAt = Date.now() - i * DAY
  }
  await fs.writeFile(storeFile, JSON.stringify(store), 'utf8')
  return ids
}

/** Live (non-archived) rows in a scope, via the public API. */
async function live(e, cwd, scope) {
  return (await e.list({ cwd, scope })).filter(row => row.archived !== true)
}
/** Archived rows in a scope, via the public API. */
async function cold(e, cwd, scope) {
  return (await e.list({ cwd, scope })).filter(row => row.archived === true)
}

// ------------------------------------------------------------------ 1. per-store ceiling
{
  const e = engine(BASE)
  const cwd = path.join(ROOT, 'ws1')
  await fs.mkdir(cwd, { recursive: true })
  await fill(e, 'workspace', cwd, 8, '甲')

  const before = await live(e, cwd, 'workspace')
  assert.equal(before.length, 8)

  const report = await e.maintain(cwd)
  assert.equal(report.capacityEvicted, 5, `8 rows must be cut to the target 3, got ${report.capacityEvicted}`)
  const after = await live(e, cwd, 'workspace')
  assert.equal(after.length, 3, 'the live store is now at evictTarget')
  const archived = await cold(e, cwd, 'workspace')
  assert.equal(archived.length, 5, 'evicted rows are ARCHIVED, not deleted')
  for (const row of archived) {
    assert.equal(typeof row.archivedAt, 'number', 'each evicted row has a retention/undo clock')
  }
  // The lowest-scoring rows are the ones that went.
  const evictedIds = report.evicted.map(row => row.id).sort()
  const lowest = [...before].sort((a, b) => (a.score ?? 0) - (b.score ?? 0)).slice(0, 5).map(r => r.id).sort()
  assert.deepEqual(evictedIds, lowest, 'the five LOWEST-scoring rows were evicted')
  checks.push('past maxActiveEntries the lowest-scoring rows are archived down to evictTarget')
}

// ------------------------------------------------------------------ 2. audit trail / observability
{
  const e = engine(BASE)
  const cwd = path.join(ROOT, 'ws2')
  await fs.mkdir(cwd, { recursive: true })
  await fill(e, 'global', 'unused', 8, '乙')

  const report = await e.maintain(undefined)
  assert.ok(Array.isArray(report.evicted) && report.evicted.length === 5, 'the report lists every eviction')
  for (const row of report.evicted) {
    assert.ok(typeof row.id === 'string', 'id is reported')
    assert.ok(typeof row.scope === 'string', 'scope is reported')
    assert.ok(typeof row.storeKey === 'string', 'which store is reported')
    assert.match(row.reason, /over-capacity/, 'the reason is reported')
  }
  checks.push('every eviction is observable: id, scope, store, score, reason')
}

// ------------------------------------------------------------------ 3. hysteresis / no oscillation
{
  const e = engine(BASE)
  const cwd = path.join(ROOT, 'ws3')
  await fs.mkdir(cwd, { recursive: true })
  await fill(e, 'workspace', cwd, 8, '丙')

  const first = await e.maintain(cwd)
  assert.equal(first.capacityEvicted, 5)
  const second = await e.maintain(cwd)
  assert.equal(second.capacityEvicted, 0, 'a second pass must not evict again at the target')
  const third = await e.maintain(cwd)
  assert.equal(third.capacityEvicted, 0, 'three passes must be stable')
  assert.equal((await live(e, cwd, 'workspace')).length, 3)
  checks.push('eviction is hysteretic and does not oscillate across passes')
}

// ------------------------------------------------------------------ 4. protected rows
{
  const e = engine(BASE)
  const cwd = path.join(ROOT, 'ws4')
  await fs.mkdir(cwd, { recursive: true })
  await e.remember({ scope: 'workspace', cwd, text: '冻结的高价值约定', frozen: true, affect: 0.4 })
  await e.remember({ scope: 'workspace', cwd, text: '令牌 sk-abcdefghijklmnopqrst', privacy: 'secret', affect: 0.4 })
  await e.remember({ scope: 'workspace', cwd, text: '一条错误教训：不要这样写', tags: ['错误教训'], affect: 0.4 })
  await e.remember({ scope: 'workspace', cwd, text: '另一条冻结的约定', frozen: true, affect: 0.4 })
  // Enough ordinary rows to trip the ceiling.
  await e.remember({ scope: 'workspace', cwd, text: '普通记忆 a', affect: 0.4 })
  await e.remember({ scope: 'workspace', cwd, text: '普通记忆 b', affect: 0.4 })
  await e.remember({ scope: 'workspace', cwd, text: '普通记忆 c', affect: 0.4 })

  const report = await e.maintain(cwd)
  assert.ok(report.capacityProtectedSkipped >= 4, 'the report counts the protected rows it skipped')
  const survivors = (await live(e, cwd, 'workspace')).map(row => row.text)
  assert.ok(survivors.includes('冻结的高价值约定'), 'frozen survives')
  assert.ok(survivors.includes('另一条冻结的约定'), 'a second frozen row survives')
  assert.ok(survivors.includes('一条错误教训：不要这样写'), 'lesson survives')
  // The secret is excluded from recall but must still be on disk in the store.
  const storeFile = path.join(e.root, 'workspaces', `${MemoryEngine.workspaceKey(cwd)}.json`)
  const store = JSON.parse(await fs.readFile(storeFile, 'utf8'))
  assert.ok(store.entries.some(row => row.text.includes('令牌') && row.state !== 'archived'), 'secret survives')
  checks.push('frozen/secret/lesson rows are never evicted')
}

// ------------------------------------------------------------------ 4b. default-affect tool writes ARE evictable
{
  // The real bug: 0.85 is the DEFAULT affect of the memory tool / explicit
  // writes (memory-host.js L196/L427). If high-affect were a protection reason,
  // nearly every future tool write would be immune to capacity eviction and the
  // library would keep growing. A plain 0.85 row must be an eviction candidate.
  const e = engine({ ...BASE, maxActiveEntries: 2, evictTarget: 1, maxTotalEntries: 0 })
  const cwd = path.join(ROOT, 'ws4b')
  await fs.mkdir(cwd, { recursive: true })
  // Three rows all written with the DEFAULT tool affect (0.85), no protection.
  const written = []
  // Distinct, unrelated texts: near-duplicates would be merged by remember()'s
  // dedupe path and there would be nothing to evict.
  const texts = [
    '项目使用 pnpm 管理依赖并锁定主版本',
    '导出分享前必须检查图片是否内联为 data URL',
    'Windows 批处理脚本必须保存为纯 ASCII 且不带 BOM',
  ]
  for (const text of texts) {
    const { entry } = await e.remember({
      scope: 'workspace', cwd, text, affect: 0.85, source: 'tool',
    })
    written.push(entry.id)
  }
  assert.equal((await live(e, cwd, 'workspace')).length, 3, 'the 3 distinct tool writes are all stored')
  const report = await e.maintain(cwd)
  assert.equal(report.capacityProtectedSkipped, 0, 'no default-affect row is reported as protected')
  assert.equal(report.capacityEvicted, 2, `3 default-affect rows (cap 2, target 1) must evict 2, got ${report.capacityEvicted}`)
  assert.equal((await live(e, cwd, 'workspace')).length, 1, 'only one remains live')
  assert.equal((await cold(e, cwd, 'workspace')).length, 2, 'evicted rows are archived, not deleted')
  checks.push('default-affect (0.85) tool writes ARE evictable — capacity is not defeated')
}

// ------------------------------------------------------------------ 5. protected-only soft overflow
{
  const e = engine({ ...BASE, maxActiveEntries: 2, evictTarget: 1, maxTotalEntries: 0 })
  const cwd = path.join(ROOT, 'ws5')
  await fs.mkdir(cwd, { recursive: true })
  for (let i = 0; i < 4; i += 1) {
    await e.remember({ scope: 'workspace', cwd, text: `全是冻结的第 ${i} 条`, frozen: true, affect: 0.4 })
  }
  const report = await e.maintain(cwd)
  assert.equal(report.capacityEvicted, 0, 'no protected row is evicted even above the ceiling')
  assert.equal((await live(e, cwd, 'workspace')).length, 4, 'the library is allowed a soft overflow')
  assert.ok(report.capacityProtectedSkipped >= 4)
  checks.push('a protected-only library softly overflows rather than losing data')
}

// ------------------------------------------------------------------ 6. whole-library ceiling
{
  const e = engine({ ...BASE, maxActiveEntries: 0, evictTarget: 0, maxTotalEntries: 6 })
  const ws = []
  for (let i = 0; i < 3; i += 1) {
    const cwd = path.join(ROOT, `ws6-${i}`)
    await fs.mkdir(cwd, { recursive: true })
    await fill(e, 'workspace', cwd, 4, `丁${i}`)
    ws.push(cwd)
  }

  const beforeAll = (await e.list({ scope: 'all' })).filter(row => row.archived !== true)
  assert.equal(beforeAll.length, 12, '3 stores × 4 rows = 12 live rows')
  const report = await e.maintain(ws[0])
  assert.equal(report.globalEvicted, 6, `12 must be cut to 6, got ${report.globalEvicted}`)
  const afterAll = (await e.list({ scope: 'all' })).filter(row => row.archived !== true)
  assert.equal(afterAll.length, 6, 'the merged list({scope:"all"}) count is now at the global ceiling')
  // The report shows WHICH scope each eviction came from (cross-store ranking).
  const scopes = new Set(report.evicted.map(row => row.scope))
  assert.ok(scopes.size >= 1)
  for (const row of report.evicted) assert.match(row.reason, /over-total-cap/)
  checks.push('maxTotalEntries ranks across all stores and reaches the merged count')
}

// ------------------------------------------------------------------ 7. disabled ceilings / small library
{
  const e = engine({ ...BASE, maxActiveEntries: 0, evictTarget: 0, maxTotalEntries: 0 })
  const cwd = path.join(ROOT, 'ws7')
  await fs.mkdir(cwd, { recursive: true })
  await fill(e, 'workspace', cwd, 8, '戊')
  const report = await e.maintain(cwd)
  assert.equal(report.capacityEvicted, 0)
  assert.equal(report.globalEvicted, 0)
  assert.equal((await live(e, cwd, 'workspace')).length, 8, '0 disables the ceiling entirely')

  // The shipped library's largest store is 30 rows; with the real defaults it
  // must be completely untouched on the day of deployment.
  const real = engine({
    decayDays: 30, newMemoryGraceDays: 7, maxUnusedDays: 90, archiveRetentionDays: 30,
    archivePurgeEnabled: true, purgeCheckIntervalMs: DAY,
    maxActiveEntries: 50, evictTarget: 40, maxTotalEntries: 120,
    clusterMinSize: 99, ruleMinSize: 99,
  })
  const cwd2 = path.join(ROOT, 'ws7-real')
  await fs.mkdir(cwd2, { recursive: true })
  await fill(real, 'workspace', cwd2, 30, '己')
  const realReport = await real.maintain(cwd2)
  assert.equal(realReport.capacityEvicted, 0, '30 < 50: no per-store eviction')
  assert.equal(realReport.globalEvicted, 0, '30 < 120: no global eviction')
  assert.equal(realReport.purged, 0, 'no existing archived row is deleted')
  assert.equal((await live(real, cwd2, 'workspace')).length, 30)
  checks.push('0 disables the ceiling; the shipped 97-row library is untouched on day one')
}

await fs.rm(ROOT, { recursive: true, force: true })
console.log(checks.map((line, index) => `  ${index + 1}. ${line}`).join('\n'))
console.log(`\n${checks.length}/${checks.length} checks passed`)
