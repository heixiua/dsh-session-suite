/**
 * Context-aware retrieval: a short follow-up must carry enough of the conversation to
 * resolve what it is about.
 *
 * The gap this closes is concrete. Searching for 「那它为什么慢？」 searches seven
 * characters, one of which is a pronoun with no referent in the query. No amount of
 * ranking fixes that: the memory that explains the slowness shares no vocabulary with
 * 「它」. The previous turns have to be folded in.
 *
 * What this pins:
 *   1. a short follow-up is prefixed with the previous user turns;
 *   2. the CURRENT question comes last, so its terms dominate the score;
 *   3. a self-contained question is searched unchanged — no context is appended to
 *      something that does not need it;
 *   4. assistant replies are never included (they would drown the query);
 *   5. the tail is capped in characters, not turns;
 *   6. the cap can be disabled.
 *
 * Usage: node tools/selftest-context-query.mjs
 */

import assert from 'node:assert/strict'
import fs from 'node:fs'

const host = fs.readFileSync('lib/memory-host.js', 'utf8')

// The function is module-private, so extract its body and run it. This keeps the test
// honest: it exercises the shipped source, not a copy that could drift.
const start = host.indexOf('function contextualQuery(')
assert.equal(start >= 0, true, 'contextualQuery must exist')
const end = host.indexOf('\nfunction ', start + 1)
const body = host.slice(start, end > start ? end : host.length)

/** @param {string} code @returns {any} the function */
function load(code) {
  // The helper needs lastUserText and contentText; both are simple, so provide minimal
  // equivalents rather than importing the whole module.
  const sandbox = `
    function contentText(content) {
      if (typeof content === 'string') return content
      if (!Array.isArray(content)) return ''
      return content.map(part => (part && part.type === 'text' ? part.text : '')).join(' ').trim()
    }
    function lastUserText(messages) {
      for (let index = (messages?.length ?? 0) - 1; index >= 0; index -= 1) {
        const message = messages[index]
        if (message?.role !== 'user') continue
        const text = contentText(message.content)
        if (text) return text
      }
      return ''
    }
    ${code}
    return contextualQuery
  `
  // eslint-disable-next-line no-new-func
  return new Function(sandbox)()
}

const contextualQuery = load(body)
const checks = []

/** @param {Array<[string, string]>} turns @returns {any[]} messages */
const conversation = turns => turns.map(([role, text]) => ({ role, content: [{ type: 'text', text }] }))

// 1. A short follow-up carries the previous user turn.
{
  const messages = conversation([
    ['user', '记忆检索为什么排序不对'],
    ['assistant', '因为用了对称相似度，我改成了覆盖率。'],
    ['user', '那它为什么慢？'],
  ])
  const query = contextualQuery(messages)
  assert.equal(query.includes('记忆检索为什么排序不对'), true, `the earlier turn must be included, got: ${query}`)
  assert.equal(query.includes('那它为什么慢？'), true, 'the current question must be included')
  assert.equal(
    query.endsWith('那它为什么慢？'),
    true,
    `the current question must come LAST, got: ${query}`,
  )
  checks.push('a short follow-up carries the previous user turn, current question last')
}

// 2. A self-contained question is searched unchanged.
//
//    The rule is pronoun presence, not length: a short question that names its own
//    subject needs no help, while a long one full of 「它」 does. Length was the first
//    rule and it misclassified a clear 20-character question.
{
  const messages = conversation([
    ['user', '前面的问题'],
    ['user', '导出会话时图片为什么变成断链的占位符'],
  ])
  const query = contextualQuery(messages)
  assert.equal(
    query,
    '导出会话时图片为什么变成断链的占位符',
    `a self-contained question must not be padded, got: ${query}`,
  )
  checks.push('a self-contained question is searched unchanged')
}

// 2b. A long question made of pronouns still gets context — length is not the signal.
{
  const messages = conversation([
    ['user', '记忆检索的排序问题'],
    ['user', '那这个呢，还有刚才说的那个，它到底是怎么回事呢，我想知道具体的原因'],
  ])
  const query = contextualQuery(messages)
  assert.equal(
    query.includes('记忆检索的排序问题'),
    true,
    `a pronoun-led question must get context even when long, got: ${query}`,
  )
  checks.push('a long pronoun-led question still gets context')
}

// 3. Assistant replies are never included.
{
  const messages = conversation([
    ['user', '短问题'],
    ['assistant', '这是一段很长的助手回复，不应该出现在查询里，因为它的词不是用户说过的'],
    ['user', '那它继续说'],
  ])
  const query = contextualQuery(messages)
  assert.equal(query.includes('助手回复'), false, `assistant text must not leak into the query, got: ${query}`)
  checks.push('assistant replies are excluded')
}

// 4. The character budget is enforced.
{
  const long = '很长的一段用户提问'.repeat(30)
  const messages = conversation([
    ['user', long],
    ['user', '那它呢'],
  ])
  const query = contextualQuery(messages, { chars: 40 })
  // Context is capped, but the question itself is always present.
  assert.equal(query.includes('那它呢'), true, 'the current question is never dropped')
  assert.equal(
    query.length < long.length,
    true,
    `the context must be capped, got ${query.length} characters`,
  )
  checks.push('the character budget is enforced')
}

// 5. The turn budget is enforced.
{
  const messages = conversation([
    ['user', '第一轮'],
    ['user', '第二轮'],
    ['user', '第三轮'],
    ['user', '第四轮'],
    ['user', '那它呢'],
  ])
  const query = contextualQuery(messages, { turns: 2 })
  // Newest two earlier turns are 第三轮/第四轮; 第一轮 must be out.
  assert.equal(query.includes('第四轮'), true, `the newest earlier turn must be kept, got: ${query}`)
  assert.equal(query.includes('第一轮'), false, `the oldest turn must be dropped, got: ${query}`)
  checks.push('the turn budget is enforced')
}

// 6. Zero context disables the behaviour.
{
  const messages = conversation([
    ['user', '前面的问题'],
    ['user', '那它呢'],
  ])
  const query = contextualQuery(messages, { chars: 0 })
  assert.equal(query, '那它呢', `a zero budget must fall back to the bare question, got: ${query}`)
  checks.push('a zero character budget disables context')
}

// 7. The behaviour is wired into the recall path, and configurable.
{
  assert.equal(
    /const question = contextualQuery\(messages/.test(host),
    true,
    'the recall path must use contextualQuery',
  )
  assert.equal(/lastUserText\(messages\)/.test(host), true, 'lastUserText must still exist for other callers')
  const patch = fs.readFileSync('cordis.patch.yml', 'utf8')
  assert.equal(/contextQueryChars:/.test(patch), true, 'the character budget must be configurable')
  assert.equal(/contextQueryTurns:/.test(patch), true, 'the turn budget must be configurable')
  checks.push('the recall path uses contextualQuery and both budgets are configurable')
}

console.log(checks.map((line, index) => `  ${index + 1}. ${line}`).join('\n'))
console.log(`\n${checks.length}/${checks.length} checks passed`)
