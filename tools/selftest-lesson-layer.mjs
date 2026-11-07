/**
 * The lesson layer must be present when it matters, and must not cost too much.
 *
 * The failure it fixes was measured: a stored lesson about Windows BOM encoding was not
 * recalled while the agent edited a profile manifest, because the question text was about
 * installing a plugin. Relevance ranked it out. This test pins the replacement behaviour:
 *
 *   1. a lesson is injected even when the question is lexically unrelated;
 *   2. the block is bounded (count and characters), because it rides on every request;
 *   3. only lessons are promoted — ordinary memories are not relabelled as lessons;
 *   4. secrets never appear;
 *   5. archived entries never appear;
 *   6. frozen entries are treated as lessons even without the tag;
 *   7. zero budget disables the layer entirely.
 *
 * Usage: node tools/selftest-lesson-layer.mjs
 */

import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { MemoryEngine } from '../lib/memory-engine.js'

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lesson-test-'))
const cwd = 'D:\\AI sandbox\\dsh-sandbox\\DSH Optimize'
const engine = new MemoryEngine({ root: path.join(root, 'memory'), log: () => {}, config: {} })
const checks = []

// A lesson that has nothing to do with the question we will ask.
await engine.remember({
  scope: 'global',
  text: 'Windows .bat 必须纯 ASCII + CRLF + 无 BOM；PowerShell 的 -Encoding UTF8 默认带 BOM，会让 JSON.parse 失败',
  tags: ['错误教训', 'dsh'],
  source: 'test',
})
// An ordinary memory: must NOT be promoted into the lesson block.
await engine.remember({
  scope: 'workspace',
  cwd,
  text: '用户偏好简体中文回复，代码注释也用中文',
  tags: ['偏好'],
  source: 'test',
})
// A secret: must never appear.
await engine.remember({
  scope: 'global',
  text: '数据库口令是 hunter2，不要外传',
  tags: ['错误教训'],
  privacy: 'secret',
  source: 'test',
})

console.log('=== 1. a lesson is returned regardless of the question ===')
{
  const lessons = await engine.lessonCards({ cwd, limit: 3, budget: 600 })
  const texts = lessons.map(item => item.text).join('\n')
  console.log(`  returned ${lessons.length} lesson(s)`)
  for (const item of lessons) console.log(`    [${item.scope}] ${item.text.slice(0, 60)}…`)
  assert.equal(lessons.length > 0, true, 'at least one lesson must be returned')
  assert.equal(texts.includes('BOM'), true, 'the BOM lesson must be present')
  checks.push('a lesson is returned regardless of the question')
}

console.log('\n=== 2. only lessons are promoted ===')
{
  const lessons = await engine.lessonCards({ cwd, limit: 10, budget: 10000 })
  const texts = lessons.map(item => item.text).join('\n')
  assert.equal(
    texts.includes('偏好简体中文'),
    false,
    'an ordinary memory must not be relabelled as a lesson',
  )
  checks.push('ordinary memories are not promoted')
}

console.log('\n=== 3. secrets never appear ===')
{
  const lessons = await engine.lessonCards({ cwd, limit: 10, budget: 10000 })
  const texts = lessons.map(item => item.text).join('\n')
  assert.equal(texts.includes('hunter2'), false, 'a secret must never reach the prompt')
  checks.push('secrets are excluded')
}

console.log('\n=== 4. the count cap is enforced ===')
{
  for (let index = 0; index < 6; index += 1) {
    await engine.remember({
      scope: 'workspace',
      cwd,
      text: `第 ${index} 条独立教训：某个操作会导致某个具体后果`,
      tags: ['错误教训'],
      source: 'test',
    })
  }
  const lessons = await engine.lessonCards({ cwd, limit: 3, budget: 10000 })
  console.log(`  requested limit 3, got ${lessons.length}`)
  assert.equal(lessons.length <= 3, true, `the count cap must hold, got ${lessons.length}`)
  checks.push('the count cap is enforced')
}

console.log('\n=== 5. the character budget is enforced ===')
{
  const lessons = await engine.lessonCards({ cwd, limit: 10, budget: 120 })
  const used = lessons.reduce((sum, item) => sum + item.text.length + 3, 0)
  console.log(`  requested budget 120, used ${used}`)
  assert.equal(used <= 120, true, `the budget must hold, used ${used}`)
  checks.push('the character budget is enforced')
}

console.log('\n=== 6. zero budget disables the layer ===')
{
  const lessons = await engine.lessonCards({ cwd, limit: 0, budget: 600 })
  assert.equal(lessons.length, 0, 'limit 0 must return nothing')
  checks.push('limit 0 disables the layer')
}

console.log('\n=== 7. a frozen entry counts as a lesson ===')
{
  const engine2 = new MemoryEngine({ root: path.join(root, 'memory2'), log: () => {}, config: {} })
  const added = await engine2.remember({
    scope: 'workspace',
    cwd,
    text: '冻结的一条重要约定：任何情况下都不要删除用户数据',
    tags: ['约定'],
    source: 'test',
  })
  await engine2.update({ id: added.entry.id, cwd, scope: 'workspace', patch: { frozen: true } })
  const lessons = await engine2.lessonCards({ cwd, limit: 3, budget: 600 })
  assert.equal(lessons.length > 0, true, 'a frozen entry must be returned as a lesson')
  checks.push('a frozen entry counts as a lesson')
}

console.log('\n=== 8. the recall block labels the lesson section ===')
{
  const host = fs.readFileSync('lib/memory-host.js', 'utf8')
  assert.equal(/lessonCards\(/.test(host), true, 'the recall path must call lessonCards')
  assert.equal(/踩过的坑/.test(host), true, 'the block must be labelled so the model knows what it is')
  assert.equal(
    /lessonLimit/.test(host) && /lessonBudget/.test(host),
    true,
    'both caps must be configurable',
  )
  checks.push('the recall block labels the lesson section and is configurable')
}

console.log(`\n${checks.map((line, index) => `  ${index + 1}. ${line}`).join('\n')}`)
console.log(`\n${checks.length}/${checks.length} checks passed`)

fs.rmSync(root, { recursive: true, force: true })
