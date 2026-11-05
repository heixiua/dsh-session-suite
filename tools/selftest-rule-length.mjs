/**
 * The rule-length ceiling.
 *
 * A rule is a recurring conclusion drawn from a tag group, not a transcript of
 * the group. Joining every member produced entries over three thousand
 * characters — unusable as memories and expensive to inject. These tests pin the
 * cap and the fact that the members themselves survive.
 *
 * Usage: node tools/selftest-rule-length.mjs
 */

import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { MemoryEngine } from '../lib/memory-engine.js'

const checks = []
const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rulelen-'))
const cwd = path.join(root, 'ws')
await fs.mkdir(cwd, { recursive: true })
const engine = new MemoryEngine({ root, config: { clusterMinSize: 99, ruleMinSize: 3, maxMemoryChars: 300 } })

// Seed a tag group whose members are individually legal but collectively far too
// long for one rule. Each member is ~120 characters, so a naive join of six
// produces ~700 — comfortably over the ceiling.
const MEMBERS = [
  '缓存命中率归因要按 provider 分开统计，不要看模型名，因为缓存是端点本地的，换端点就是换缓存域，这个结论已经被实测数据反复确认过一遍了。',
  '插件 apply 抛异常会把整行标成 fiberStatus failed，所有 HTTP 路由都会 404 报 not found，所以排查插件问题第一步永远是先看插件行的状态字段而不是先读代码。',
  '快照必须在 turn 结束后拍，因为语义是「第 N 轮之后的工作区」，在轮次开始拍会让回滚把本轮产出全部删掉，这个坑踩过一次并且有回归测试守着。',
  'fork 之后必须以 sessionId 为键显式继承插件自己的数据，框架只搬走对话日志，快照和记忆和 undo 包都不会自动跟过去，子会话 id 是全新的。',
  '导出必须白名单 source.kind 等于 user 才算用户提问，否则 runtime-context 与 skill-catalog 这些内部管道会泄漏进导出内容里，用户会看到不属于自己的东西。',
  '记忆检索要用查询覆盖率而不是对称相似度，因为查询短记忆长时对称相似度的上限很低，乘以权重之后相关性形同虚设，排序完全被重要度决定。',
]

for (const text of MEMBERS) {
  await engine.remember({ scope: 'workspace', cwd, text, tags: ['dsh'] })
}

// 1. The pass produces a rule at all — otherwise the cap is untested.
const report = await engine.maintain(cwd)
assert.equal(report.rules >= 1, true, 'a rule must be produced from the tag group')

const rules = (await engine.list({ cwd })).filter(entry => entry.kind === 'rule')
assert.equal(rules.length, 1, `expected exactly one rule, got ${rules.length}`)

// 2. The rule respects the ceiling.
const rule = rules[0]
assert.equal(
  rule.text.length <= 300,
  true,
  `the rule must respect the ceiling, got ${rule.text.length} characters`,
)
checks.push('a rule is capped at the memory ceiling')

// 3. The naive join would have been much longer, so the cap is doing real work
//    rather than being satisfied by luck.
const naiveLength = `规则（dsh）：${MEMBERS.join('；')}`.length
assert.equal(naiveLength > 300, true, `the fixture must exceed the ceiling if uncapped (${naiveLength})`)
checks.push('the fixture would exceed the ceiling without the cap')

// 4. Every member survives individually. The rule summarises; it must not
//    consume its sources.
const all = await engine.list({ cwd })
const memberTexts = all.filter(entry => entry.kind !== 'rule').map(entry => entry.text)
for (const text of MEMBERS) {
  assert.equal(memberTexts.includes(text), true, `member must survive: ${text.slice(0, 20)}`)
}
checks.push('every group member survives as its own memory')

// 5. The rule keeps the newest members, not the oldest: a rule states what is
//    currently true.
const newestMember = MEMBERS[MEMBERS.length - 1]
assert.equal(
  rule.text.includes(newestMember.slice(0, 20)),
  true,
  'the rule must include the newest member',
)
checks.push('the rule keeps the newest members')

// 6. A tag group small enough to fit is joined whole — the cap must not truncate
//    a rule that never needed truncating.
{
  const smallRoot = path.join(root, 'small')
  const smallEngine = new MemoryEngine({ root: smallRoot, config: { clusterMinSize: 99, ruleMinSize: 3, maxMemoryChars: 300 } })
  const smallCwd = path.join(smallRoot, 'ws')
  await fs.mkdir(smallCwd, { recursive: true })
  const short = ['短记忆一', '短记忆二', '短记忆三']
  for (const text of short) await smallEngine.remember({ scope: 'workspace', cwd: smallCwd, text, tags: ['small'] })
  await smallEngine.maintain(smallCwd)
  const smallRules = (await smallEngine.list({ cwd: smallCwd })).filter(entry => entry.kind === 'rule')
  assert.equal(smallRules.length, 1)
  for (const text of short) {
    assert.equal(smallRules[0].text.includes(text), true, 'a short group must be joined whole')
  }
  checks.push('a short group is joined whole')
}

// 7. The rule digest covers its content, not just its tag: two rules built from
//    the same tag over different members must not look identical.
{
  const a = new MemoryEngine({ root: path.join(root, 'digest-a'), config: { ruleMinSize: 3, clusterMinSize: 99 } })
  const cwdA = path.join(root, 'digest-a', 'ws')
  await fs.mkdir(cwdA, { recursive: true })
  for (const text of ['甲组第一条', '甲组第二条', '甲组第三条']) {
    await a.remember({ scope: 'workspace', cwd: cwdA, text, tags: ['same'] })
  }
  await a.maintain(cwdA)
  const b = new MemoryEngine({ root: path.join(root, 'digest-b'), config: { ruleMinSize: 3, clusterMinSize: 99 } })
  const cwdB = path.join(root, 'digest-b', 'ws')
  await fs.mkdir(cwdB, { recursive: true })
  for (const text of ['乙组第一条', '乙组第二条', '乙组第三条']) {
    await b.remember({ scope: 'workspace', cwd: cwdB, text, tags: ['same'] })
  }
  await b.maintain(cwdB)
  const digestA = (await a.list({ cwd: cwdA })).find(entry => entry.kind === 'rule')?.digest
  const digestB = (await b.list({ cwd: cwdB })).find(entry => entry.kind === 'rule')?.digest
  assert.notEqual(digestA, digestB, 'rules with the same tag but different members must have different digests')
  checks.push('the rule digest covers content, not just the tag')
}

await fs.rm(root, { recursive: true, force: true })
console.log(checks.map((line, index) => `  ${index + 1}. ${line}`).join('\n'))
console.log(`\n${checks.length}/${checks.length} checks passed`)
