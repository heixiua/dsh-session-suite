/**
 * Regression: a pasted TOOL ERROR must never become a "lesson".
 *
 * Observed in the wild. A user pasted real tool output into the chat:
 *
 *   错误: HTTP 503: {"code":"video_queue_full","message":"video queue is full..."}
 *   当时的失败：edit error: old_string was not found in
 *
 * The cue matcher found no correction phrase, `cueSentence()` fell back to the
 * head of the message, and `distillLessons()` wrote five entries whose "用户说："
 * slot held that error text verbatim. Lessons are exempt from eviction, so the
 * noise was permanent — and two of those stubs later surfaced as a conflict
 * panel asking the user to arbitrate between two pieces of stack trace.
 *
 * What this pins:
 *   1. looksLikeToolError recognises HTTP/JSON/log/traceback/errno shapes;
 *   2. it does NOT fire on ordinary human complaints;
 *   3. a cue-less message yields no correction quote (no "head of message" fallback);
 *   4. a turn whose only "correction" is pasted error text distils nothing;
 *   5. a genuine correction is still distilled, with the human's words quoted;
 *   6. a cue found INSIDE pasted error text is still rejected (belt and braces).
 *
 * Usage: node tools/selftest-pain-noise.mjs
 */
import assert from 'node:assert/strict'
import {
  CORRECTION_CUES,
  detectPain,
  distillLessons,
  looksLikeToolError,
  userCorrectionSentence,
} from '../lib/pain.js'

let n = 0
const check = (name, fn) => { fn(); n += 1; console.log(`  ✓ ${name}`) }

/** The exact strings that produced the junk entries. */
const REAL_JUNK = [
  '错误: HTTP 503: {"code":"video_queue_full","message":"video queue is full, please retry later (…',
  '当时的失败：edit error: old_string was not found in',
  'Error: connect ECONNREFUSED 127.0.0.1:7899',
  'TypeError: Cannot read properties of undefined (reading \'length\')',
  '    at Object.<anonymous> (D:\\app\\lib\\index.js:42:11)',
  'Traceback (most recent call last):',
  'HTTP 502 Bad Gateway',
  '{"code": "rate_limit_exceeded", "message": "slow down"}',
  'ZSTD_error_prefix_unknown',
  'old_string was not found in the target file',
]

console.log('looksLikeToolError')
for (const text of REAL_JUNK) {
  check(`rejects: ${text.slice(0, 48)}`, () => assert.equal(looksLikeToolError(text), true))
}

const HUMAN = [
  '这里布局不对 2、',
  '还不对，agnes有5个账户，有5个密钥，不同的账户走不同额度的模型池',
  '报错了，帮我看看',
  '这个按钮点不动，为什么',
  '做错了，我要的是导出按钮',
  '不对，左对齐就好了',
  '',
]
console.log('\nordinary human complaints stay eligible')
for (const text of HUMAN) {
  check(`allows: ${text === '' ? '(empty)' : text.slice(0, 40)}`, () =>
    assert.equal(looksLikeToolError(text), false))
}

console.log('\nno cue => no quote')
check('a cue-less message yields an empty quote, not its first 120 chars', () => {
  const pasted = 'HTTP 503: {"code":"video_queue_full","message":"video queue is full, please retry later"}'
  assert.equal(CORRECTION_CUES.test(pasted), false, 'precondition: no cue in the paste')
  assert.equal(userCorrectionSentence(pasted), '', 'must not fall back to the head of the message')
})

console.log('\ndistillation')
/** Build the turn the junk came from: user pastes an error, a tool error follows. */
function turnFromPaste(pasted) {
  return [
    { type: 'session', data: {} },
    { type: 'turn/start', data: { turn: 1 } },
    { type: 'tool/call', data: { turn: 1, callId: 'c1', name: 'edit' } },
    {
      type: 'tool/result',
      data: {
        turn: 1,
        message: { isError: true, toolCallId: 'c1', content: [{ type: 'text', text: pasted }] },
      },
    },
    // The paste arrives as a REAL user message (source.kind === 'user' would be
    // a human; here it is the same role, so it exercises the text guard).
    { type: 'user/message', data: { turn: 1, source: { kind: 'user' }, content: [{ type: 'text', text: pasted }] } },
    { type: 'turn/end', data: { turn: 1 } },
  ]
}

check('a turn whose only "correction" is a pasted error distils a tool-failure lesson at most, never a 用户说 quote', () => {
  const pain = detectPain(turnFromPaste(REAL_JUNK[0]), 1)
  // It may still be painful because the tool failed, but the human-correction
  // evidence must be empty — that is the slot that produced the junk.
  assert.equal(pain.userCorrections.length, 0, 'pasted error is not a human correction')
  const lessons = distillLessons(pain)
  for (const lesson of lessons) {
    assert.equal(
      /用户说：|用户纠正：/.test(lesson.text),
      false,
      `lesson quoted a human who never spoke: ${lesson.text}`,
    )
  }
})

check('a cue inside pasted error text is still rejected', () => {
  // 不对 is a strong cue, but this whole message is machine output.
  const sneaky = '不对 HTTP 503: {"code":"video_queue_full","message":"video queue is full"}'
  assert.equal(CORRECTION_CUES.test(sneaky), true, 'precondition: the cue is present')
  const pain = detectPain(turnFromPaste(sneaky), 1)
  assert.equal(pain.userCorrections.length, 0, 'machine output is rejected even with a cue')
})

check('a genuine correction still distils, quoting the human', () => {
  const real = '这里布局不对，我要的是左对齐不是居中'
  const events = [
    { type: 'session', data: {} },
    { type: 'turn/start', data: { turn: 1 } },
    { type: 'user/message', data: { turn: 1, source: { kind: 'user' }, content: [{ type: 'text', text: real }] } },
    { type: 'turn/end', data: { turn: 1 } },
  ]
  const pain = detectPain(events, 1)
  assert.equal(pain.userCorrections.length, 1, 'the real correction is kept')
  const lessons = distillLessons(pain)
  assert.equal(lessons.length, 1)
  assert.match(lessons[0].text, /用户说：/)
  assert.match(lessons[0].text, /布局不对/)
  assert.equal(looksLikeToolError(lessons[0].text), false)
})

console.log(`\n${n} pain-noise checks passed`)
