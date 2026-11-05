/**
 * The edit-resend dialog must describe what the code actually does.
 *
 * This bundle has now shipped two "the message says X but the code does Y"
 * defects: the delete toast claimed a rewind, and this dialog claimed a branch
 * plus dropped memories when the implementation forks nothing and only trims
 * memories after the turn. Users report those as bugs because they are bugs —
 * the wording is part of the contract, so it is tested like one.
 *
 * Usage: node tools/selftest-edit-wording.mjs
 */

import assert from 'node:assert/strict'
import fs from 'node:fs'

const source = fs.readFileSync('client.js', 'utf8')
const service = fs.readFileSync('lib/service.js', 'utf8')
const checks = []

/** @param {string} key dictionary key @returns {string[]} every body text */
function bodiesFor(key) {
  const out = []
  const re = new RegExp(`'${key}':\\s*\\n?\\s*'((?:[^'\\\\]|\\\\.)*)'`, 'g')
  let match
  while ((match = re.exec(source)) !== null) out.push(match[1])
  return out
}

const bodies = bodiesFor('message.editBody')
assert.equal(bodies.length, 2, `expected an en and a zh body, found ${bodies.length}`)

// The completion toast is a SEPARATE key from the dialog body. Missing it is how
// "已在新分支重发" survived a fix that rewrote the dialog text — so every string
// the resend flow can show is collected and checked, not just the one that was
// noticed.
const allResendStrings = [
  ...bodies,
  ...bodiesFor('message.resendDone'),
  ...bodiesFor('message.resendStaged'),
  ...bodiesFor('message.edit'),
  ...bodiesFor('message.editTitle'),
  ...bodiesFor('message.editConfirm'),
]
assert.equal(
  allResendStrings.length >= 10,
  true,
  `expected every resend string, collected ${allResendStrings.length}`,
)
checks.push('every string the resend flow can show is collected')

// 1. The implementation must not fork. If this ever changes, the wording test
//    below has to change with it — that is the point of asserting both sides.
assert.equal(
  service.includes('Resend happens in the SAME session'),
  true,
  'resend is documented as staying in the same session',
)
// Narrow check: look inside resendTurn for a fork call or a child id being sent
// a prompt. `truncateConversation` legitimately returns one for delete/rewind,
// and the comment mentions childId to explain its absence, so match on calls.
const resendStart = service.indexOf('async resendTurn(')
const resendEnd = service.indexOf('\n  async ', resendStart + 10)
const resendBody = service.slice(resendStart, resendEnd === -1 ? undefined : resendEnd)
assert.equal(
  /truncateConversation\s*\(/.test(resendBody),
  false,
  'resendTurn must not call truncateConversation, because that is what forks',
)
assert.equal(
  /#promptInSession\(\s*result\.childId/.test(resendBody),
  false,
  'resendTurn must not prompt a child session',
)
assert.equal(
  /#promptInSession\(\s*sessionId/.test(resendBody),
  true,
  'resendTurn must prompt the current session',
)
checks.push('the implementation does not fork')

// 2. No string may promise a branch, because there is none. This covers the
//    completion toast as well as the dialog body.
for (const text of allResendStrings) {
  for (const word of ['分支', 'branch']) {
    assert.equal(
      text.includes(word),
      false,
      `no resend string may promise a branch: ${text.slice(0, 60)}`,
    )
  }
}
checks.push('no resend string promises a branch')

// 3. Nothing may claim memories are simply dropped, because the code trims only
//    what was recorded after that turn.
for (const text of allResendStrings) {
  for (const claim of ['记忆会被丢弃', 'memories recorded during it are dropped']) {
    assert.equal(
      text.includes(claim),
      false,
      `no resend string may claim all memories are dropped: ${text.slice(0, 60)}`,
    )
  }
}
checks.push('the wording does not overstate what happens to memories')

// 4. Both languages must say that the log is append-only, so the old exchange
//    stays visible. This is the single fact users were most surprised by.
const notes = [
  [/只追加/, 'zh'],
  [/append-only/, 'en'],
]
for (const [pattern, language] of notes) {
  assert.equal(
    bodies.some(body => pattern.test(body)),
    true,
    `${language} body must mention the append-only log`,
  )
}
checks.push('both languages tell the user the log is append-only')

// 5. Both languages must state the file guarantee, which is the thing users
//    actually fear losing.
for (const [pattern, language] of [[/工作区文件不会有任何改动/, 'zh'], [/workspace files are not touched/, 'en']]) {
  assert.equal(
    bodies.some(body => pattern.test(body)),
    true,
    `${language} body must state that workspace files are untouched`,
  )
}
checks.push('both languages state the file guarantee')

console.log(checks.map((line, index) => `  ${index + 1}. ${line}`).join('\n'))
console.log(`\n${checks.length}/${checks.length} checks passed`)
