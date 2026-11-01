/**
 * Prove that automatic maintenance runs only when something changed.
 *
 * The timer exists so a memory library nobody opens still compresses. But an
 * idle Host must not wake up every 30 minutes to rescore memory it has already
 * scored, and a pass that runs unconditionally also hides whether the timer is
 * alive at all. This checks the dirty signal on both sides: it fires when
 * memories change, and it stays quiet when they do not.
 *
 * Usage: node tools/selftest-maintenance.mjs
 */

import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { MemoryEngine } from '../lib/memory-engine.js'

const checks = []
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-maint-'))
const cwd = path.join(root, 'workspace')
fs.mkdirSync(cwd, { recursive: true })

const engine = new MemoryEngine({ root, config: { clusterMinSize: 2, ruleMinSize: 3 } })
const quiet = () => engine.needsMaintenance(cwd)

// 1. An empty library is never worth a pass. This is the "user has not touched
//    DSH in weeks" case: the timer must stay silent.
{
  assert.equal(await quiet(), false)
  checks.push('empty library needs no maintenance')
}

// 2. The first real memory makes a pass due.
{
  await engine.remember({ scope: 'workspace', cwd, text: '提交代码前必须运行 selftest 测试套件' })
  assert.equal(await quiet(), true)
  checks.push('a new memory makes a pass due')
}

// 3. After the pass, the library is clean again.
{
  const report = await engine.maintain(cwd)
  assert.equal(report.scored > 0, true)
  assert.equal(await quiet(), false)
  checks.push('a completed pass clears the dirty state')
}

// 4. A pass that runs writes its bookkeeping, so "did it ever run" is
//    answerable from the settings page.
{
  const status = await engine.status()
  assert.equal(typeof status.lastMaintainedAt, 'number')
  assert.equal(status.lastMaintainedAt > 0, true)
  assert.equal(typeof status.lastFingerprint, 'string')
  assert.equal(status.lastFingerprint.length > 0, true)
  assert.equal(typeof status.lastReport, 'object')
  assert.equal(status.lastReport.scored > 0, true)
  checks.push('a pass records when it ran and what it produced')
}

// 5. Running twice in a row is a no-op the second time: the pass itself must
//    not look like new input, or the timer would run forever.
{
  assert.equal(await quiet(), false)
  await engine.maintain(cwd)
  assert.equal(await quiet(), false, 'a second pass must not dirty the library')
  checks.push('a pass does not make itself look necessary')
}

// 6. A genuinely new memory re-arms the signal.
{
  await engine.remember({ scope: 'workspace', cwd, text: '导出分享前必须检查图片是否内联' })
  assert.equal(await quiet(), true)
  checks.push('a later memory re-arms the signal')
}

// 7. Deleting a memory also counts as change.
{
  await engine.maintain(cwd)
  const listed = await engine.list({ cwd, scope: 'workspace' })
  assert.equal(listed.length > 0, true)
  await engine.remove({ scope: 'workspace', cwd, id: listed[0].id })
  assert.equal(await quiet(), true)
  checks.push('a deletion re-arms the signal')
}

// 8. Archived entries are not "new input": they are out of the live set, so
//    archiving must not keep the library permanently dirty.
{
  await engine.maintain(cwd)
  const again = await engine.maintain(cwd)
  assert.equal(again.scored > 0, true)
  assert.equal(await quiet(), false)
  checks.push('archived entries do not keep the library dirty')
}

// 9. Repeated passes must not manufacture duplicate rules. A rule's identity is
//    the set of memories it summarizes; a size-derived id used to mint a fresh
//    duplicate every time the group changed size.
{
  const ruleRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-rules-'))
  const ruleCwd = path.join(ruleRoot, 'workspace')
  fs.mkdirSync(ruleCwd, { recursive: true })
  const ruleEngine = new MemoryEngine({ root: ruleRoot, config: { ruleMinSize: 3, clusterMinSize: 99 } })

  // Rules group by shared tag, so the tag has to be explicit. Clustering is
  // disabled here because it would fold these near-identical texts into one
  // summary and leave no group to build a rule from.
  for (const text of [
    '提交代码前必须运行 selftest 测试套件',
    '提交代码前必须运行 selftest 并查看输出',
    '提交代码前必须运行 selftest 确认没有回归',
  ]) {
    await ruleEngine.remember({ scope: 'workspace', cwd: ruleCwd, text, tags: ['提交规范'] })
  }

  const first = await ruleEngine.maintain(ruleCwd)
  assert.equal(first.rules, 1, 'one group should produce exactly one rule')

  // Run several more times, including after adding another member so the group
  // size changes, and confirm the rule count never grows.
  await ruleEngine.remember({
    scope: 'workspace',
    cwd: ruleCwd,
    text: '提交代码前必须运行 selftest 全套',
    tags: ['提交规范'],
  })
  for (let i = 0; i < 3; i += 1) {
    await ruleEngine.maintain(ruleCwd)
    const stored = await ruleEngine.list({ cwd: ruleCwd, scope: 'workspace' })
    const rules = stored.filter(entry => entry.kind === 'rule')
    assert.equal(rules.length, 1, `pass ${i + 1} produced ${rules.length} rules, expected 1`)
  }
  checks.push('repeated passes never duplicate a rule')

  fs.rmSync(ruleRoot, { recursive: true, force: true })
}

fs.rmSync(root, { recursive: true, force: true })
console.log(JSON.stringify({ ok: true, checks }, null, 2))
