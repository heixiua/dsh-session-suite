/**
 * Reproduction and regression test for repeated summary/rule generation.
 *
 * Measured on the user's real library: one sentence — the cache-hit-rate
 * conclusion — existed seven times (1 fact + 2 summaries + 3 archived rules) out
 * of 46 entries. The maintenance pass was feeding itself:
 *
 *   cluster a group → write summary → archive members
 *     → next pass clusters an equivalent group → writes another summary
 *
 * Two holes combined:
 *   • the summary probe searched only the live store, so an archived summary did
 *     not count as "already exists";
 *   • it compared raw joined text, so a different member ORDER produced a
 *     different string and slipped past the check.
 *
 * The rule generator had already been fixed for the first hole; the clusterer had
 * not. This test drives maintain() repeatedly against a fixture that reproduces
 * the shape of the real library and asserts the count stops growing.
 *
 * Usage: node tools/selftest-memory-dedupe.mjs
 */

import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { MemoryEngine } from '../lib/memory-engine.js'

const checks = []

/** @returns {Promise<string>} a throwaway storage root */
async function freshRoot() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'mem-dedupe-'))
}

/**
 * A library shaped like the broken one: several memories on ONE topic, tagged so
 * both the clusterer and the rule generator act on them.
 *
 * @param {MemoryEngine} engine engine
 * @param {string} cwd workspace
 */
async function seed(engine, cwd) {
  const facts = [
    '缓存是 endpoint 本地的，跟 provider 走而不跟模型名走',
    'deepseek-account 实测缓存命中率 99.6%',
    'trae 441 步缓存命中率全为 0%',
    '命中率下降先查 provider 切换，别归因压缩',
  ]
  for (const text of facts) {
    await engine.remember({ scope: 'workspace', cwd, text, tags: ['dsh', '缓存'], affect: 0.7 })
  }
}

/** @param {MemoryEngine} engine @param {string} cwd @returns {Promise<{summaries:number, rules:number, total:number}>} */
async function census(engine, cwd) {
  const entries = await engine.list({ cwd })
  return {
    summaries: entries.filter(entry => entry.summary).length,
    rules: entries.filter(entry => entry.kind === 'rule').length,
    total: entries.length,
  }
}

// 1. Repeated passes must converge, not grow.
{
  const root = await freshRoot()
  const engine = new MemoryEngine({ root, config: {} })
  const cwd = 'D:\\ws-dedupe'
  await seed(engine, cwd)

  const counts = []
  for (let pass = 0; pass < 6; pass += 1) {
    await engine.maintain(cwd)
    counts.push(await census(engine, cwd))
  }

  console.log('  pass  summaries  rules  total')
  for (const [index, row] of counts.entries()) {
    console.log(`  ${String(index + 1).padStart(4)}  ${String(row.summaries).padStart(9)}  ${String(row.rules).padStart(5)}  ${String(row.total).padStart(5)}`)
  }

  const summaryGrowth = counts[counts.length - 1].summaries - counts[1].summaries
  const ruleGrowth = counts[counts.length - 1].rules - counts[1].rules
  assert.equal(
    summaryGrowth,
    0,
    `summaries must stop growing after the first pass, grew by ${summaryGrowth}`,
  )
  assert.equal(ruleGrowth, 0, `rules must stop growing, grew by ${ruleGrowth}`)
  checks.push('six maintenance passes converge instead of growing')
  await fs.rm(root, { recursive: true, force: true })
}

// 2. A summary written in one pass is recognised on the next one even though its
//    members were archived by that pass.
{
  const root = await freshRoot()
  const engine = new MemoryEngine({ root, config: {} })
  const cwd = 'D:\\ws-dedupe-2'
  await seed(engine, cwd)
  // Run until the clusterer has actually produced something: with this fixture the
  // first pass only forms rules, and the summary appears on the second one. The
  // assertion is about idempotence AFTER a summary exists, so the baseline has to
  // be the first pass that wrote one.
  let baseline = 0
  for (let pass = 0; pass < 4 && baseline === 0; pass += 1) {
    await engine.maintain(cwd)
    baseline = (await census(engine, cwd)).summaries
  }
  assert.equal(baseline > 0, true, 'the fixture must eventually produce a summary')
  await engine.maintain(cwd)
  const after = await census(engine, cwd)
  assert.equal(
    after.summaries,
    baseline,
    `a further pass must not add a summary (${baseline} → ${after.summaries})`,
  )
  checks.push('an archived summary still counts as existing')
  await fs.rm(root, { recursive: true, force: true })
}

// 3. Member ORDER must not make a summary look new. The digest sorts the member
//    texts, so the same set in a different order is the same summary.
{
  const root = await freshRoot()
  const engine = new MemoryEngine({ root, config: {} })
  const cwd = 'D:\\ws-dedupe-3'
  await engine.remember({ scope: 'workspace', cwd, text: '甲甲甲的缓存事实', tags: ['组'], affect: 0.6 })
  await engine.remember({ scope: 'workspace', cwd, text: '乙乙乙的缓存事实', tags: ['组'], affect: 0.6 })
  await engine.maintain(cwd)
  const before = await census(engine, cwd)
  // Re-add equivalent members in the opposite order: a new pass must not create a
  // second summary for what is the same content set.
  await engine.remember({ scope: 'workspace', cwd, text: '乙乙乙的缓存事实', tags: ['组'], affect: 0.6 })
  await engine.remember({ scope: 'workspace', cwd, text: '甲甲甲的缓存事实', tags: ['组'], affect: 0.6 })
  await engine.maintain(cwd)
  const after = await census(engine, cwd)
  assert.equal(
    after.summaries,
    before.summaries,
    `member order must not create a new summary (${before.summaries} → ${after.summaries})`,
  )
  checks.push('member order does not create a duplicate summary')
  await fs.rm(root, { recursive: true, force: true })
}

// 4. The dedupe probe must actually search the cold archive, not just the live
//    store. Asserted on the source so removing the archive lookup fails here.
{
  const source = await fs.readFile('lib/memory-engine.js', 'utf8')
  const clusterRegion = source.slice(
    source.indexOf('const clusterable = store.entries.filter('),
    source.indexOf('// 3. Abstract repeated tags'),
  )
  assert.equal(
    clusterRegion.includes('...cold.entries'),
    true,
    'the summary probe must include the cold archive',
  )
  assert.equal(
    /summaryDigest\s*=\s*sha256Text/.test(clusterRegion),
    true,
    'the summary identity must be a normalised digest, not the raw joined text',
  )
  checks.push('the summary probe searches the cold archive by normalised digest')
}

// 5. Nothing above may have archived real user content into oblivion: every source
//    memory must still be findable, either live or archived.
{
  const root = await freshRoot()
  const engine = new MemoryEngine({ root, config: {} })
  const cwd = 'D:\\ws-dedupe-5'
  await seed(engine, cwd)
  for (let pass = 0; pass < 3; pass += 1) await engine.maintain(cwd)
  const live = await engine.list({ cwd })
  const everything = await engine.list({ cwd, includeArchived: true })
  assert.equal(
    everything.length >= live.length,
    true,
    'the archive-inclusive view must be at least as large as the live view',
  )
  const texts = everything.map(entry => String(entry.text))
  assert.equal(
    texts.some(text => text.includes('缓存是 endpoint 本地的')),
    true,
    'a seeded memory must still exist somewhere after maintenance',
  )
  checks.push('maintenance archives rather than deletes')
  await fs.rm(root, { recursive: true, force: true })
}

console.log(checks.map((line, index) => `  ${index + 1}. ${line}`).join('\n'))
console.log(`\n${checks.length}/${checks.length} checks passed`)
