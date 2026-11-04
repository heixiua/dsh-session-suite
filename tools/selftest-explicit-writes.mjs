/**
 * Regression tests for the self-poisoning bug.
 *
 * What happened: the explicit-write scan read every message with
 * `role === 'user'` and did not look at `source.kind`. The harness delivers
 * plugin-injected prompt text inside a `runtime-context` message, so the scan
 * re-read the footer of this plugin's own memory block —
 * `如果用户说【记住：…】…` — as a user instruction. It captured the ellipsis
 * placeholder and stored it, 154 times, producing 27 records whose entire body
 * was "…". Proof from the session logs: 154 captures of "…" from
 * source.kind=runtime-context, plus one from compact-checkpoint, against only
 * three captures from genuine user messages.
 *
 * Three guards are tested here: the source filter, the placeholder filter, and
 * the exact-text dedupe that would have collapsed the repeats anyway.
 *
 * Usage: node tools/selftest-explicit-writes.mjs
 */

import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { collectExplicitWrites } from '../lib/memory-host.js'
import { MemoryEngine } from '../lib/memory-engine.js'
import { isMeaningfulText, isUserAuthored } from '../lib/util.js'

const checks = []

/** The exact footer this plugin injects, verbatim from buildRecallText. */
const INJECTED_FOOTER =
  '如果用户说【记住：…】或【新增全局记忆：…】，立即照做；如果这些记忆已经过时，用 memory 工具更正。'

const userMessage = (text, kind) => ({
  role: 'user',
  source: kind === undefined ? undefined : { kind },
  content: [{ type: 'text', text }],
})

// 1. THE bug. The plugin's own injected footer must not be obeyed, no matter
//    which pipeline message carries it.
{
  const instructions = collectExplicitWrites([
    userMessage(INJECTED_FOOTER, 'runtime-context'),
    userMessage(INJECTED_FOOTER, 'compact-checkpoint'),
    userMessage(INJECTED_FOOTER, 'time-context'),
    userMessage(INJECTED_FOOTER, 'skill-catalog'),
    userMessage(INJECTED_FOOTER, 'agent-message'),
  ])
  assert.deepEqual(
    instructions,
    [],
    `harness pipeline messages must not be obeyed, got ${JSON.stringify(instructions)}`,
  )
  checks.push('an injected instruction footer is never obeyed from a pipeline message')
}

// 1b. The source filter must stand on its own, not merely ride on the
//     placeholder filter. A pipeline message carrying well-formed, meaningful
//     instruction text must still be ignored — that is the property that
//     matters, because injected prompt text is by nature meaningful. Mutation
//     testing is what exposed the gap: dropping the source filter alone used to
//     pass, because the footer's captures happened to be placeholders.
{
  const injected = collectExplicitWrites([
    userMessage('【记住：这条来自内部管道，绝不能被写入记忆】', 'runtime-context'),
    userMessage('【新增全局记忆：管道注入的全局记忆】', 'runtime-context'),
    userMessage('【记住：压缩检查点也不许写】', 'compact-checkpoint'),
  ])
  assert.deepEqual(
    injected,
    [],
    `meaningful text in a pipeline message must still be ignored, got ${JSON.stringify(injected)}`,
  )
  checks.push('the source filter rejects meaningful text from pipeline messages too')
}

// 2. A genuine user instruction still works, including with a missing
//    source.kind, which older logs and some callers omit.
{
  const bare = collectExplicitWrites([userMessage('【记住：永远不要用 PowerShell 改中文文件】')])
  assert.deepEqual(bare, [{ scope: 'workspace', text: '永远不要用 PowerShell 改中文文件' }])
  const explicit = collectExplicitWrites([userMessage('【记住：偏好用 tabs】', 'user')])
  assert.deepEqual(explicit, [{ scope: 'workspace', text: '偏好用 tabs' }])
  checks.push('a genuine user instruction is still obeyed, with or without source.kind')
}

// 3. All the bracket forms and both scopes keep working.
{
  assert.deepEqual(collectExplicitWrites([userMessage('【新增全局记忆：全局事实在这里】')]), [
    { scope: 'global', text: '全局事实在这里' },
  ])
  assert.deepEqual(collectExplicitWrites([userMessage('【本工作区记忆：本工作区事实】')]), [
    { scope: 'workspace', text: '本工作区事实' },
  ])
  assert.deepEqual(collectExplicitWrites([userMessage('[记住：方括号也可以]')]), [
    { scope: 'workspace', text: '方括号也可以' },
  ])
  checks.push('every bracket form and scope still parses')
}

// 4. The placeholder filter. Each of these is a non-empty string that would
//    otherwise be stored as a memory.
{
  for (const placeholder of ['…', '...', '。。', '——', '   ', '· ', '⋯', 'a', '。']) {
    const got = collectExplicitWrites([userMessage(`【记住：${placeholder}】`)])
    assert.deepEqual(got, [], `placeholder ${JSON.stringify(placeholder)} must be rejected`)
  }
  checks.push('placeholder-only captures are rejected')
}

// 5. The filter must not be so aggressive that it eats real content, including
//    content that is mostly punctuation around real words.
{
  for (const real of ['a1', '用 tabs', '…但其实这句话有内容', 'OK!']) {
    const got = collectExplicitWrites([userMessage(`【记住：${real}】`)])
    assert.equal(got.length, 1, `real content ${JSON.stringify(real)} must survive`)
  }
  checks.push('the filter keeps real content that merely looks odd')
}

// 6. Non-user roles and empty input are ignored.
{
  assert.deepEqual(
    collectExplicitWrites([{ role: 'assistant', content: [{ type: 'text', text: '【记住：不应记下】' }] }]),
    [],
  )
  assert.deepEqual(collectExplicitWrites([]), [])
  assert.deepEqual(collectExplicitWrites(undefined), [])
  checks.push('assistant messages and empty input are ignored')
}

// 7. Several instructions in one message are all collected, in order.
{
  const got = collectExplicitWrites([userMessage('【记住：第一件事】然后【新增全局记忆：第二件事】')])
  assert.deepEqual(got, [
    { scope: 'workspace', text: '第一件事' },
    { scope: 'global', text: '第二件事' },
  ])
  checks.push('multiple instructions in one message are all collected')
}

// 8. The predicates themselves.
{
  assert.equal(isUserAuthored(userMessage('x')), true)
  assert.equal(isUserAuthored(userMessage('x', 'user')), true)
  assert.equal(isUserAuthored(userMessage('x', 'runtime-context')), false)
  assert.equal(isUserAuthored({ role: 'assistant' }), false)
  assert.equal(isUserAuthored(undefined), false)
  assert.equal(isMeaningfulText('…'), false)
  assert.equal(isMeaningfulText(''), false)
  assert.equal(isMeaningfulText(undefined), false)
  assert.equal(isMeaningfulText('缓存'), true)
  assert.equal(isMeaningfulText('  ok  '), true)
  checks.push('isUserAuthored() and isMeaningfulText() behave at the boundaries')
}

// 9. The third guard: identical text reinforces instead of appending. Without
//    this, the placeholder writes would still have accumulated as separate
//    records even after the source filter made new ones impossible — and
//    punctuation-only text shingles to the empty set, so Jaccard scored the two
//    identical records 0 apart.
{
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'explicit-'))
  const cwd = path.join(root, 'ws')
  await fs.mkdir(cwd, { recursive: true })
  const engine = new MemoryEngine({ root })

  await engine.remember({ scope: 'workspace', cwd, text: '…' })
  await engine.remember({ scope: 'workspace', cwd, text: '…' })
  await engine.remember({ scope: 'workspace', cwd, text: '…' })
  const afterPlaceholder = await engine.list({ cwd })
  assert.equal(
    afterPlaceholder.filter(entry => entry.text === '…').length,
    1,
    'three writes of the same punctuation-only text must produce one record',
  )

  await engine.remember({ scope: 'workspace', cwd, text: '同一句话写两遍' })
  await engine.remember({ scope: 'workspace', cwd, text: '同一句话写两遍' })
  const afterNormal = await engine.list({ cwd })
  assert.equal(
    afterNormal.filter(entry => entry.text === '同一句话写两遍').length,
    1,
    'an exact repeat must reinforce, not duplicate',
  )
  checks.push('an exact repeat of any text reinforces instead of appending')

  await fs.rm(root, { recursive: true, force: true })
}

console.log(checks.map((line, index) => `  ${index + 1}. ${line}`).join('\n'))
console.log(`\n${checks.length}/${checks.length} checks passed`)
