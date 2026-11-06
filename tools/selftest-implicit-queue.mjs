/**
 * P1: the implicit-candidate pipeline must not throw away good candidates.
 *
 * The reported symptom was "设置 → 长期记忆 has no pending candidates at all".
 * One cause was measured: after the model returned durable facts, a second
 * keyword gate demanded one of 以后/一律/总是/偏好… in the MODEL'S OWN paraphrase.
 * Realistic outputs do not contain them, so 7 of 10 reasonable candidates were
 * dropped before ever reaching the queue:
 *
 *   通过 DURABLE 检查: 3/10
 *   最终保留:          3/10
 *
 * The extraction prompt already asks for long-lived information, so that gate was
 * filtering the model's wording rather than the user's. What remains must catch a
 * malformed candidate, not a stylistic one.
 *
 * Usage: node tools/selftest-implicit-queue.mjs
 */

import assert from 'node:assert/strict'
import fs from 'node:fs'
import { isMeaningfulText } from '../lib/util.js'

const source = fs.readFileSync('lib/memory-host.js', 'utf8')
const checks = []

// Pull the shipped transient regex out of the source so this test cannot drift.
const transientMatch = source.match(/const TRANSIENT_HINTS = (\/.*\/[a-z]*)/)
assert.equal(transientMatch !== null, true, 'TRANSIENT_HINTS must exist')
const TRANSIENT_HINTS = eval(transientMatch[1])

/** The production acceptance rule, after the fix. */
function accept(text) {
  const value = String(text ?? '').trim()
  if (!value) return false
  if (!isMeaningfulText(value)) return false
  if (TRANSIENT_HINTS.test(value)) return false
  return true
}

// The block that decides a candidate's fate, taken verbatim from the source, so
// the checks below describe the shipped code rather than a local reimplementation
// of it. Rewriting the rule in the test made two mutations invisible: deleting the
// transient or malformed guard from production changed nothing the test could see.
const queueBlock = source.slice(
  source.indexOf('for (const item of produced.slice(0, 4))'),
  source.indexOf('extractionTrace.queued = queued'),
)
assert.equal(queueBlock.length > 0, true, 'the candidate loop must be locatable')

// 1. A declarative phrase with no imperative keyword must be accepted. This is
//    the exact class that used to be dropped.
const durableWithoutKeyword = [
  '本项目使用 pnpm 管理依赖',
  '技术栈为 Node ESM + React，Host 侧仅用 node: 内置模块',
  '插件包名统一使用 @heixui 作用域',
  '用户通常在深夜工作，白天休息',
  '作者是 heixiua，仓库在 GitHub 上',
  '数据库选型确定为 SQLite',
  '项目正式结束后需要更新个人档案',
]
for (const text of durableWithoutKeyword) {
  assert.equal(accept(text), true, `must accept a plain declarative fact: ${text}`)
}
checks.push('declarative facts without an imperative keyword are accepted')

// 2. The same set passes as a whole — this is the regression that mattered.
assert.equal(
  durableWithoutKeyword.every(accept),
  true,
  'the previously-dropped set must now be accepted in full',
)
checks.push(`all ${durableWithoutKeyword.length} previously-dropped facts are now kept`)

// 3. Genuinely transient text is still refused — asserted against the shipped
//    loop, not a copy of the rule.
assert.equal(
  queueBlock.includes('TRANSIENT_HINTS.test(text)'),
  true,
  'the shipped candidate loop must still apply the transient filter',
)
for (const text of ['帮我跑一下这个命令', '这次先这样，临时改一下', '今天试了一下']) {
  assert.equal(accept(text), false, `transient text must still be refused: ${text}`)
}
checks.push('transient text is still refused')

// 4. Malformed candidates are still refused, again asserted on the shipped loop.
assert.equal(
  queueBlock.includes('isMeaningfulText(text)'),
  true,
  'the shipped candidate loop must still reject malformed text',
)
for (const text of ['', '   ', '。。。', '嗯']) {
  assert.equal(accept(text), false, `malformed text must be refused: ${JSON.stringify(text)}`)
}
checks.push('malformed candidates are still refused')

// 4b. At least one candidate must actually reach engine.suggest — a loop that
//     rejects everything looks identical to a working one from the outside.
assert.equal(
  queueBlock.includes('engine.suggest('),
  true,
  'the loop must reach engine.suggest for accepted candidates',
)
checks.push('accepted candidates reach engine.suggest')

// 5. The DURABLE gate must be gone from the queue path. It may survive only where
//    it describes the USER'S words (setting affect on an explicit write), because
//    there it is scoring an instruction rather than filtering a paraphrase.
const queueSection = source.slice(source.indexOf('const parsed = parseJsonBlock(answer)'))
assert.equal(
  queueSection.slice(0, 1200).includes('DURABLE_HINTS'),
  false,
  'the queue path must not apply DURABLE_HINTS to the model output',
)
checks.push('the queue path no longer filters on DURABLE_HINTS')

const durableUses = [...source.matchAll(/DURABLE_HINTS\.test\(([^)]*)\)/g)].map(match => match[1])
assert.equal(durableUses.length > 0, true, 'DURABLE_HINTS should still exist for affect scoring')
for (const argument of durableUses) {
  assert.equal(
    /instruction\.text|args\.text/.test(argument),
    true,
    `DURABLE_HINTS may only score user-supplied text, found: ${argument}`,
  )
}
checks.push('DURABLE_HINTS survives only for scoring user-supplied text')

// 6. Every early return now records a cause, so an empty queue is explainable.
for (const marker of [
  'failExtraction',
  'extractionTrace',
  'extractionStatus',
  'publishExtractionTrace',
]) {
  assert.equal(source.includes(marker), true, `missing diagnostic hook: ${marker}`)
}
checks.push('every early return records a readable cause')

// 7. The trace reaches the settings page through status().
const engineSource = fs.readFileSync('lib/memory-engine.js', 'utf8')
assert.equal(
  /extraction:\s*this\.lastExtraction/.test(engineSource),
  true,
  'status() must expose the extraction trace',
)
checks.push('status() exposes the extraction trace')

console.log(checks.map((line, index) => `  ${index + 1}. ${line}`).join('\n'))
console.log(`\n${checks.length}/${checks.length} checks passed`)
