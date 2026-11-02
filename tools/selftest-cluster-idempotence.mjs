/**
 * Prove that repeated maintenance does not accumulate duplicate summaries.
 *
 * The bug this guards against was found in the live library: six cluster
 * summaries of one sentence under six different cluster ids, plus a live rule
 * with the same text — seven copies of one finding.
 *
 * The mechanism was a feedback loop between the two compression stages, not a
 * missing filter on the clusterer:
 *
 *   1. Stage 3 groups memories by tag and mints a rule whose text is those
 *      memories concatenated.
 *   2. Stage 2 clusters that rule with its siblings and archives them, moving
 *      the rule out of the live store and into the cold archive.
 *   3. The next pass asks "does a rule for this tag already exist?" and only
 *      looks at the live store. The rule it archived in step 2 is invisible, so
 *      it builds a new one under a new id.
 *   4. The new rule is clustered in the next pass, and step 3 runs again.
 *
 * A test that only runs stage 2 in isolation cannot catch this, because stage 2
 * on its own is idempotent. The test below has to let both stages interact,
 * which means the fixture must contain enough tagged memories to mint a rule.
 *
 * Usage: node tools/selftest-cluster-idempotence.mjs
 */

import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { MemoryEngine } from '../lib/memory-engine.js'

const checks = []
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-cluster-'))
const cwd = path.join(root, 'workspace')
fs.mkdirSync(cwd, { recursive: true })

const engine = new MemoryEngine({ root, config: { clusterMinSize: 2, ruleMinSize: 3 } })
const coldPath = path.join(root, 'memory', 'cold', `${MemoryEngine.workspaceKey(cwd)}.json`)

const everything = async () => {
  const live = await engine.list({ cwd, scope: 'workspace' })
  // The cold store is only written once something is archived, so it may not
  // exist yet on an early pass.
  const cold = fs.existsSync(coldPath) ? JSON.parse(fs.readFileSync(coldPath, 'utf8')) : { entries: [] }
  return { live, cold: cold.entries ?? [] }
}

// Three memories sharing two tags, so stage 3 has enough to mint rules. Their
// pairwise similarity sits above clusterSimilarity (0.5) but below
// duplicateSimilarity (0.82), so `remember` keeps them separate.
await engine.remember({
  scope: 'workspace',
  cwd,
  text: '缓存命中率归因：缓存是 endpoint 本地的，跟 provider 走而不跟模型名走',
  tags: ['dsh', '工作区'],
})
await engine.remember({
  scope: 'workspace',
  cwd,
  text: 'DSH 快照必须在 turn/end 拍，第 0 轮拍 baseline，否则回滚删光本轮产出',
  tags: ['dsh', '工作区'],
})
await engine.remember({
  scope: 'workspace',
  cwd,
  text: '插件 apply 抛异常会把插件标成 fiberPhase failed，HTTP 路由全 404',
  tags: ['dsh', '工作区'],
})

// 1. The rule count must converge. Measured on the buggy code this grows by
//    exactly 2 every pass forever (22 rules after six passes); on the fixed
//    code it settles at 8. The assertion is "does not grow", not "equals 8",
//    so it states the property rather than a snapshot of today's arithmetic.
{
  const counts = []
  for (let pass = 0; pass < 6; pass += 1) {
    await engine.maintain(cwd)
    const { live, cold } = await everything()
    counts.push([...live, ...cold].filter(entry => entry.kind === 'rule').length)
  }
  const settled = counts[counts.length - 1]
  const previous = counts[counts.length - 2]
  assert.equal(
    settled,
    previous,
    `rules still growing after six passes (${counts.join(' → ')}) — ` +
      'an archived rule is being rebuilt on the next pass',
  )
  checks.push(`rule count converges (${counts.join(' → ')})`)
}

// 2. The same for summaries: content decides identity, cluster ids do not.
{
  const { live, cold } = await everything()
  const summaryTexts = [...live, ...cold]
    .filter(entry => entry.summary)
    .map(entry => entry.text)
  const distinct = new Set(summaryTexts)
  assert.equal(
    distinct.size,
    summaryTexts.length,
    `${summaryTexts.length} summaries but only ${distinct.size} distinct texts`,
  )
  checks.push('no two summaries share the same text')
}

// 3. A settled library must report nothing left to do. This is what makes the
//    loop visible in production: a library that keeps "compressing" on every
//    pass is never settled.
{
  const report = await engine.maintain(cwd)
  assert.equal(report.clusters, 0, `a settled pass still created ${report.clusters} clusters`)
  assert.equal(report.rules, 0, `a settled pass still created ${report.rules} rules`)
  checks.push('a settled library creates no new clusters or rules')
}

// 4. Nothing may be orphaned: every summary keeps at least one member, live or
//    archived, so a summary never outlives the thing it summarised.
{
  const { live, cold } = await everything()
  const members = [...live, ...cold].filter(entry => entry.clusterId && !entry.summary)
  for (const summary of [...live, ...cold].filter(entry => entry.summary)) {
    const has = members.some(entry => entry.clusterId === summary.clusterId)
    assert.equal(has, true, `summary ${summary.id} has no member left`)
  }
  checks.push('every summary still has a member')
}

fs.rmSync(root, { recursive: true, force: true })

console.log(checks.map((line, index) => `  ${index + 1}. ${line}`).join('\n'))
console.log(`\n${checks.length}/${checks.length} checks passed`)
