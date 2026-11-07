/**
 * Faster decay must not harm a young library.
 *
 * The old formula was `recency = exp(-days/decayDays)` with a 0.3 weight, which
 * has two problems: it starts eating a memory from the moment it is written, and
 * it has a SCORE FLOOR — frequency + affect + uniqueness can hold a row above
 * the archive line forever even with recency at zero. This pins the three-part
 * fix:
 *
 *   1. a `newMemoryGraceDays` plateau: rows younger than the grace window score
 *      at FULL recency (a 3-day or 7-day memory scores 1.0, no matter how short
 *      decayDays is) — this is why accelerating decay cannot hurt the shipped
 *      7-day-old library;
 *   2. a shorter `decayDays` makes old rows sink faster than the old 60-day
 *      setting;
 *   3. an explicit `maxUnusedDays` wall-clock rule archives genuinely stale
 *      rows even when their composite score is above the archive threshold —
 *      this is what breaks the floor.
 *
 * Also pinned: the `config > settings.json > DEFAULTS` priority (a library with
 * `decayDays: 60` persisted in settings.json must obey the bundle patch's 30),
 * a recently-used old row is NOT stale, protected rows are not force-archived,
 * and episodes still age from `occurredAt` at EPISODE_DECAY_FACTOR.
 *
 * Usage: node tools/selftest-decay-accel.mjs
 */

import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { MemoryEngine, scoreEntry, EPISODE_DECAY_FACTOR } from '../lib/memory-engine.js'

const checks = []
const DAY = 86400000
const ROOT = await fs.mkdtemp(path.join(os.tmpdir(), 'decay-'))

/** @returns {MemoryEngine} a fresh engine over an isolated sub-root */
let seq = 0
function engine(config = {}) {
  seq += 1
  return new MemoryEngine({ root: path.join(ROOT, `case${seq}`), config })
}

/** A plain fact with a controllable age. */
function entry(ageDays, overrides = {}) {
  const at = Date.now() - ageDays * DAY
  return {
    id: 'x', kind: 'fact', text: '一条普通事实', accessCount: 1,
    lastAccessAt: at, createdAt: at, affect: 0.4, frozen: false,
    ...overrides,
  }
}

/** Score the same entry under a config, using the engine's own settings() path. */
async function scoreViaEngine(e, cwd, row, ageDays) {
  await e.remember({ scope: 'workspace', cwd, text: row.text, affect: row.affect, tags: row.tags ?? [] })
  const storeFile = path.join(e.root, 'workspaces', `${MemoryEngine.workspaceKey(cwd)}.json`)
  const store = JSON.parse(await fs.readFile(storeFile, 'utf8'))
  const target = store.entries[0]
  target.lastAccessAt = Date.now() - ageDays * DAY
  target.createdAt = target.lastAccessAt
  await fs.writeFile(storeFile, JSON.stringify(store), 'utf8')
  const listed = await e.list({ cwd, scope: 'workspace' })
  return listed[0].score
}

// ------------------------------------------------------------------ 1. grace plateau
{
  const ctx = { maxAccess: 1, uniqueness: 1, decayDays: 30, graceDays: 7 }
  const d0 = scoreEntry(entry(0), ctx)
  const d3 = scoreEntry(entry(3), ctx)
  const d7 = scoreEntry(entry(7), ctx)
  assert.equal(d0.factors.recency, 1, 'a just-written memory is at full recency')
  assert.equal(d3.factors.recency, 1, 'a 3-day memory is at FULL recency')
  assert.equal(d7.factors.recency, 1, 'a 7-day memory is at FULL recency')
  // Under the OLD formula a 7-day row already lost recency.
  const old = Math.exp(-7 / 60)
  assert.ok(d7.factors.recency > old, 'the grace period is strictly safer than the old formula')
  checks.push('newMemoryGraceDays holds 0/3/7-day memories at full recency')
}

// ------------------------------------------------------------------ 2. faster decay after the plateau
{
  const fast = { maxAccess: 1, uniqueness: 1, decayDays: 30, graceDays: 7 }
  const slow = { maxAccess: 1, uniqueness: 1, decayDays: 60, graceDays: 0 } // old behaviour
  const at30 = scoreEntry(entry(30), fast).factors.recency
  const at30Old = scoreEntry(entry(30), slow).factors.recency
  const at60 = scoreEntry(entry(60), fast).factors.recency
  const at60Old = scoreEntry(entry(60), slow).factors.recency
  assert.ok(at30 < at30Old, `day 30 must decay faster than 60-day half-life: ${at30} vs ${at30Old}`)
  assert.ok(at60 < at60Old, `day 60 must decay faster: ${at60} vs ${at60Old}`)
  assert.ok(at30 > at60, 'and it keeps falling with age')
  checks.push('after the grace window, decayDays=30 sinks old rows faster than 60')
}

// ------------------------------------------------------------------ 3. config beats persisted settings.json
{
  const e = engine({
    decayDays: 30, newMemoryGraceDays: 7, maxUnusedDays: 90,
    archiveRetentionDays: 30, archivePurgeEnabled: false, purgeCheckIntervalMs: DAY,
    maxActiveEntries: 0, evictTarget: 0, maxTotalEntries: 0,
    clusterMinSize: 99, ruleMinSize: 99,
  })
  const cwd = path.join(ROOT, 'ws-config')
  await fs.mkdir(cwd, { recursive: true })
  // Simulate a library created by an older build: settings.json pins 60 days.
  const settingsFile = path.join(e.root, 'settings.json')
  await fs.mkdir(path.dirname(settingsFile), { recursive: true })
  await fs.writeFile(settingsFile, JSON.stringify({
    implicit: true, decayDays: 60,
    thresholds: { compress: 0.45, archive: 0.25 },
  }, null, 2), 'utf8')

  // With a 30-day half-life and a 7-day plateau, a 45-day row has recency
  // exp(-38/30) ~ 0.28; with the persisted 60 it would be exp(-45/60) ~ 0.47.
  // The CONFIG value must win, so list() must show the lower score.
  const score = await scoreViaEngine(e, cwd, entry(45), 45)
  const oldScore = scoreEntry(entry(45), { maxAccess: 1, uniqueness: 1, decayDays: 60, graceDays: 0 }).score
  const newScore = scoreEntry(entry(45), { maxAccess: 1, uniqueness: 1, decayDays: 30, graceDays: 7 }).score
  // list() computes uniqueness against the store itself; with one row it is 1.
  assert.ok(
    Math.abs(score - newScore) < 0.02,
    `config decayDays=30 must override settings.json=60, got ${score} (expected ~${newScore})`,
  )
  assert.ok(score < oldScore, 'and the resulting score is lower than the old formula')
  // The engine must NOT have rewritten the user's runtime settings file.
  const after = JSON.parse(await fs.readFile(settingsFile, 'utf8'))
  assert.equal(after.decayDays, 60, 'settings.json is never silently rewritten by the engine')
  checks.push('config > settings.json > DEFAULTS; the runtime settings file is never rewritten')
}

// ------------------------------------------------------------------ 4. maxUnusedDays breaks the score floor
{
  const e = engine({
    decayDays: 30, newMemoryGraceDays: 7, maxUnusedDays: 90,
    archiveRetentionDays: 30, archivePurgeEnabled: false, purgeCheckIntervalMs: DAY,
    maxActiveEntries: 0, evictTarget: 0, maxTotalEntries: 0,
    clusterMinSize: 99, ruleMinSize: 99,
  })
  const cwd = path.join(ROOT, 'ws-floor')
  await fs.mkdir(cwd, { recursive: true })
  // A high-affect, high-uniqueness, frequently-used row: even at recency 0 its
  // composite score stays above the 0.25 archive threshold forever.
  const { entry: high } = await e.remember({
    scope: 'workspace', cwd, text: '一条带有大量独特信息的高价值事实',
    affect: 0.8, tags: ['独特主题'],
  })
  const storeFile = path.join(e.root, 'workspaces', `${MemoryEngine.workspaceKey(cwd)}.json`)
  const store = JSON.parse(await fs.readFile(storeFile, 'utf8'))
  const target = store.entries.find(row => row.id === high.id)
  target.lastAccessAt = Date.now() - 200 * DAY
  target.createdAt = target.lastAccessAt
  target.accessCount = 20
  await fs.writeFile(storeFile, JSON.stringify(store), 'utf8')

  const before = (await e.list({ cwd, scope: 'workspace' })).find(row => row.id === high.id)
  assert.ok(before.score >= 0.25, `this row sits above the archive line on score alone, got ${before.score}`)

  const report = await e.maintain(cwd)
  assert.equal(report.staleArchived, 1, 'the wall-clock rule force-archives it anyway')
  const archived = (await e.list({ cwd, scope: 'workspace' })).filter(row => row.archived)
  assert.equal(archived.length, 1, 'it is in cold storage, not deleted')
  checks.push('maxUnusedDays force-archives a high-score row that the score floor would keep forever')
}

// ------------------------------------------------------------------ 5. recently-used old row is safe
{
  const e = engine({
    decayDays: 30, newMemoryGraceDays: 7, maxUnusedDays: 90,
    archiveRetentionDays: 30, archivePurgeEnabled: false, purgeCheckIntervalMs: DAY,
    maxActiveEntries: 0, evictTarget: 0, maxTotalEntries: 0,
    clusterMinSize: 99, ruleMinSize: 99,
  })
  const cwd = path.join(ROOT, 'ws-touched')
  await fs.mkdir(cwd, { recursive: true })
  const { entry: used } = await e.remember({ scope: 'workspace', cwd, text: '一条很老但一直在用的事实', affect: 0.4 })
  const storeFile = path.join(e.root, 'workspaces', `${MemoryEngine.workspaceKey(cwd)}.json`)
  const store = JSON.parse(await fs.readFile(storeFile, 'utf8'))
  const target = store.entries.find(row => row.id === used.id)
  target.createdAt = Date.now() - 400 * DAY
  target.lastAccessAt = Date.now() - 2 * DAY // recalled recently
  await fs.writeFile(storeFile, JSON.stringify(store), 'utf8')

  const report = await e.maintain(cwd)
  assert.equal(report.staleArchived, 0, 'a recently-used old row is not stale')
  const row = (await e.list({ cwd, scope: 'workspace' })).find(item => item.id === used.id)
  assert.equal(row.archived, undefined, 'it is still live')
  checks.push('an old row that keeps being used is never force-archived (#touch semantics)')
}

// ------------------------------------------------------------------ 6. protected rows are exempt from forced archiving
{
  const e = engine({
    decayDays: 30, newMemoryGraceDays: 7, maxUnusedDays: 90,
    archiveRetentionDays: 30, archivePurgeEnabled: false, purgeCheckIntervalMs: DAY,
    maxActiveEntries: 0, evictTarget: 0, maxTotalEntries: 0,
    clusterMinSize: 99, ruleMinSize: 99,
  })
  const cwd = path.join(ROOT, 'ws-protected')
  await fs.mkdir(cwd, { recursive: true })
  await e.remember({ scope: 'workspace', cwd, text: '冻结的旧约定', frozen: true, affect: 0.4 })
  await e.remember({ scope: 'workspace', cwd, text: '旧的错误教训', tags: ['错误教训'], affect: 0.4 })
  await e.remember({ scope: 'workspace', cwd, text: '机密的旧约定', privacy: 'secret', affect: 0.4 })
  const storeFile = path.join(e.root, 'workspaces', `${MemoryEngine.workspaceKey(cwd)}.json`)
  const store = JSON.parse(await fs.readFile(storeFile, 'utf8'))
  for (const row of store.entries) {
    row.lastAccessAt = Date.now() - 200 * DAY
    row.createdAt = row.lastAccessAt
  }
  await fs.writeFile(storeFile, JSON.stringify(store), 'utf8')

  const report = await e.maintain(cwd)
  assert.equal(report.staleArchived, 0, 'frozen / lesson / secret rows are never force-archived')
  assert.equal((await e.list({ cwd, scope: 'workspace' })).filter(row => row.archived).length, 0)
  checks.push('frozen / lesson / secret rows are exempt from forced archiving')
}

// ------------------------------------------------------------------ 6b. high-affect is NOT exempt from forced archiving
{
  // affect is a scoring input, not immunity. A stale 0.9 row must still be
  // force-archived by maxUnusedDays, otherwise the score-floor fix is defeated
  // for the majority of tool-written memories.
  const e = engine({
    decayDays: 30, newMemoryGraceDays: 7, maxUnusedDays: 90,
    archiveRetentionDays: 30, archivePurgeEnabled: false, purgeCheckIntervalMs: DAY,
    maxActiveEntries: 0, evictTarget: 0, maxTotalEntries: 0,
    clusterMinSize: 99, ruleMinSize: 99,
  })
  const cwd = path.join(ROOT, 'ws-stale-high')
  await fs.mkdir(cwd, { recursive: true })
  const { entry: high } = await e.remember({ scope: 'workspace', cwd, text: '陈旧但高 affect 的事实', affect: 0.9 })
  const storeFile = path.join(e.root, 'workspaces', `${MemoryEngine.workspaceKey(cwd)}.json`)
  const store = JSON.parse(await fs.readFile(storeFile, 'utf8'))
  const row = store.entries.find(item => item.id === high.id)
  row.lastAccessAt = Date.now() - 200 * DAY
  row.createdAt = row.lastAccessAt
  await fs.writeFile(storeFile, JSON.stringify(store), 'utf8')

  const report = await e.maintain(cwd)
  assert.equal(report.staleArchived, 1, 'a stale high-affect row is NOT exempt from forced archiving')
  checks.push('a stale high-affect (0.9) row is force-archived — affect is not immunity')
}

// ------------------------------------------------------------------ 7. episodes still age from occurredAt
{
  const now = Date.now()
  const old = now - 90 * DAY
  const ctx = { now, maxAccess: 1, uniqueness: 1, decayDays: 30, graceDays: 7 }
  const fact = scoreEntry({ ...entry(0), lastAccessAt: now, createdAt: now }, ctx)
  const episode = scoreEntry({
    ...entry(0), kind: 'episode', occurredAt: old, lastAccessAt: now, createdAt: now,
  }, ctx)
  assert.ok(
    episode.factors.recency < fact.factors.recency,
    `an old event written today must still look old: ${episode.factors.recency} vs ${fact.factors.recency}`,
  )
  assert.equal(EPISODE_DECAY_FACTOR > 0 && EPISODE_DECAY_FACTOR < 1, true, 'the episode multiplier still shortens the half-life')
  checks.push('episodes still decay from occurredAt at EPISODE_DECAY_FACTOR')
}

await fs.rm(ROOT, { recursive: true, force: true })
console.log(checks.map((line, index) => `  ${index + 1}. ${line}`).join('\n'))
console.log(`\n${checks.length}/${checks.length} checks passed`)
