/**
 * Pain-turn distillation: a turn that went badly becomes a lesson that is kept.
 *
 * The library stores lessons only when the model calls `remember` at the moment it
 * learns something — which is exactly when it is least likely, because a failing
 * turn is a turn spent recovering. So the library fills with what worked and stays
 * silent about what did not, and the same mistake stays available.
 *
 * What this pins:
 *   1. a lone failed tool call is routine and distils nothing;
 *   2. the same tool failing repeatedly in one turn is a loop and distils a lesson;
 *   3. a human correction is pain even when every tool call succeeded;
 *   4. pipeline messages are not user corrections;
 *   5. the error signature ignores paths, ids, line numbers and durations, so the
 *      same bug on two days yields the same theme;
 *   6. a recurring theme reinforces the existing lesson instead of filing a new
 *      protected entry (lesson tags are exempt from capacity eviction);
 *   7. distilled lessons carry a lesson tag, so they are protected from eviction;
 *   8. no more than maxLessonsPerTurn entries per turn.
 *
 * Usage: node tools/selftest-pain-distill.mjs
 */

import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { MemoryEngine, LESSON_TAGS } from '../lib/memory-engine.js'
import {
  CORRECTION_CUES,
  PAIN_DEFAULTS,
  SELF_CORRECTION_CUES,
  detectPain,
  distillLessons,
  errorSignature,
  failureTheme,
} from '../lib/pain.js'

const checks = []

/** @returns {Promise<string>} a throwaway storage root */
async function freshRoot() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'mem-pain-'))
}

/** @param {number} turn @param {string} text @returns {any} user message event */
function userMessage(turn, text, kind = 'user') {
  return {
    type: 'user/message',
    data: { turn, source: kind === undefined ? undefined : { kind }, content: [{ type: 'text', text }] },
  }
}

/** @param {number} turn @param {string} text @returns {any} assistant message event */
function assistantMessage(turn, text) {
  return { type: 'assistant/message', data: { turn, message: { content: [{ type: 'text', text }] } } }
}

/** @param {number} turn @param {string} callId @param {string} name @returns {any} tool call event */
function toolCall(turn, callId, name) {
  return { type: 'tool/call', data: { turn, callId, name, arguments: '{}' } }
}

/** @param {number} turn @param {string} callId @param {string} text @param {boolean} isError @returns {any} tool result event */
function toolResult(turn, callId, text, isError) {
  return {
    type: 'tool/result',
    data: {
      turn,
      message: { toolCallId: callId, isError, content: [{ type: 'text', text }] },
    },
  }
}

// 1. A single failed tool call is routine. Measured on this project's own log:
//    179 failed tool results in one session, nearly all of them an `edit`
//    refused for not having read the file first. Those must not become
//    protected lessons, or the library is buried in noise it cannot evict.
{
  const events = [
    userMessage(1, '把 README 里的标题改一下'),
    toolCall(1, 'c1', 'edit'),
    toolResult(1, 'c1', 'Error: cannot modify "a.md": file has not been read — read the file, then retry', true),
    assistantMessage(1, '已改好。'),
  ]
  const pain = detectPain(events, 1)
  assert.equal(pain.painful, false, 'one failed call is not a painful turn')
  assert.equal(pain.toolFailures.length, 1, 'the failure is still counted in the trace')
  assert.deepEqual(distillLessons(pain), [])
  checks.push('a lone failed tool call is recorded but distils nothing')
}

// 2. The same tool failing repeatedly is a loop — the model kept doing the same
//    thing — and that is worth a lesson.
{
  const events = [
    userMessage(2, '跑一下测试'),
    toolCall(2, 'c1', 'pwsh'),
    toolResult(2, 'c1', 'Error: command not found: pnmp', true),
    toolCall(2, 'c2', 'pwsh'),
    toolResult(2, 'c2', 'Error: command not found: pnmp', true),
    toolCall(2, 'c3', 'pwsh'),
    toolResult(2, 'c3', 'Error: command not found: pnmp', true),
  ]
  const pain = detectPain(events, 2)
  assert.equal(pain.painful, true)
  assert.ok(pain.reasons.includes('repeat-failure'))
  assert.equal(pain.loops.length, 1)
  assert.equal(pain.loops[0].tool, 'pwsh')
  assert.equal(pain.loops[0].count, 3)
  const lessons = distillLessons(pain)
  assert.equal(lessons.length, 1)
  assert.match(lessons[0].text, /pwsh/)
  assert.match(lessons[0].text, /连续失败 3 次/)
  assert.ok(lessons[0].tags.some(tag => LESSON_TAGS.has(tag)), 'a distilled lesson must carry a lesson tag')
  checks.push('a repeated failure is a loop and distils a tagged lesson')
}

// 3. A human correction is pain even when every tool call succeeded: the work was
//    wrong in a way no tool could detect.
{
  const events = [
    userMessage(3, '把发布脚本改成分两步'),
    toolCall(3, 'c1', 'edit'),
    toolResult(3, 'c1', 'ok', false),
    assistantMessage(3, '已经合并成一步了。'),
    userMessage(3, '不对，我要的是两步，你搞错了'),
  ]
  const pain = detectPain(events, 3)
  assert.equal(pain.painful, true)
  assert.ok(pain.reasons.includes('user-correction'))
  assert.equal(pain.userCorrections.length, 1)
  const lessons = distillLessons(pain)
  assert.equal(lessons.length, 1)
  assert.match(lessons[0].text, /被用户纠正/)
  assert.match(lessons[0].text, /不对/)
  checks.push('a user correction distils a lesson even with no tool failure')
}

// 4. Pipeline messages share the user role. Reading them as corrections made the
//    plugin obey its own instruction text once already (the 154-placeholder
//    incident); the same guard applies here.
{
  const events = [
    userMessage(4, '不对，应该是 runtime-context 的内容', 'runtime-context'),
    userMessage(4, '错误：你搞错了，重来', 'compact-checkpoint'),
  ]
  const pain = detectPain(events, 4)
  assert.equal(pain.painful, false, 'pipeline messages are not user corrections')
  assert.equal(pain.userCorrections.length, 0)
  // A real user message in the same turn still counts.
  const mixed = detectPain([...events, userMessage(4, '不对，改回来')], 4)
  assert.equal(mixed.painful, true)
  assert.equal(mixed.userCorrections.length, 1)
  checks.push('only user-authored messages count as corrections')
}

// 5. The signature must be stable across runs of the same bug, or every
//    recurrence files a new protected entry.
{
  const one = errorSignature(
    'Error: cannot modify "D:\\AI sandbox\\proj\\a.js": file has not been read (line 42) after 120ms id 3f2a9c1b7d4e5f60',
  )
  const two = errorSignature(
    'Error: cannot modify "D:\\other\\b.js": file has not been read (line 7) after 33ms id 9988776655443322',
  )
  assert.equal(one, two, 'same bug, same signature')
  assert.equal(failureTheme('edit', one), failureTheme('edit', two))
  assert.notEqual(failureTheme('edit', one), failureTheme('write', one), 'the tool is part of the identity')
  checks.push('error signatures ignore paths, ids, line numbers and durations')
}

// 6 + 7 + 8. The engine side: a recurrence reinforces instead of duplicating, and
//         the distilled entry is protected.
{
  const root = await freshRoot()
  const engine = new MemoryEngine({ root, config: {} })
  const cwd = 'D:\\ws-pain'

  const first = await engine.remember({
    scope: 'workspace',
    cwd,
    text: '错误教训（pwsh 连续失败 3 次）；报错：command not found；同一条路走不通时先换手段，不要重试同一个调用',
    tags: ['错误教训'],
    affect: 0.85,
    source: 'pain',
    lessonTheme: 'pwsh::command not found',
  })
  assert.equal(Boolean(first.duplicateOf), false, 'first occurrence is a new entry')

  // Same theme, different words and a different path — the second occurrence.
  const second = await engine.remember({
    scope: 'workspace',
    cwd,
    text: '错误教训（pwsh 连续失败 4 次）；报错：command not found: pnmp；用户纠正：应该是 pnpm；同一条路走不通时先换手段',
    tags: ['错误教训'],
    affect: 0.85,
    source: 'pain',
    lessonTheme: 'pwsh::command not found',
  })
  assert.equal(second.recurrence, true, 'the second occurrence is a recurrence')
  assert.equal(second.entry.id, first.entry.id, 'a recurrence reinforces the existing lesson')
  assert.equal(second.entry.recurrences, 2, 'the recurrence count is what makes a repeat visible')

  const rows = await engine.list({ cwd, scope: 'workspace' })
  const lessons = rows.filter(row => (row.tags ?? []).some(tag => LESSON_TAGS.has(tag)))
  assert.equal(lessons.length, 1, 'a recurring theme never files a second protected entry')
  // Lessons are exempt from capacity eviction, which is why duplicates would be
  // permanent — this assertion is the reason the theme identity exists.
  assert.equal(lessons[0].frozen, false, 'a distilled lesson is not frozen; the tag is what protects it')

  // A different theme is a different lesson.
  const third = await engine.remember({
    scope: 'workspace',
    cwd,
    text: '错误教训（edit 连续失败 3 次）；报错：old_string not found；同一条路走不通时先换手段',
    tags: ['错误教训'],
    affect: 0.85,
    source: 'pain',
    lessonTheme: 'edit::old_string not found',
  })
  assert.equal(Boolean(third.duplicateOf), false)
  assert.equal((await engine.list({ cwd, scope: 'workspace' })).filter(row => row.lessonTheme).length, 2)

  // maxLessonsPerTurn caps a turn that failed several ways.
  const busy = detectPain(
    [
      userMessage(9, '修一下'),
      ...[1, 2, 3, 4].flatMap(n => [
        toolCall(9, `a${n}`, 'pwsh'),
        toolResult(9, `a${n}`, `Error: distinct failure ${n}`, true),
      ]),
      ...[1, 2, 3].flatMap(n => [
        toolCall(9, `b${n}`, 'edit'),
        toolResult(9, `b${n}`, `Error: another failure ${n}`, true),
      ]),
    ],
    9,
    { repeatThreshold: 3 },
  )
  const capped = distillLessons(busy, { maxLessonsPerTurn: 2 })
  assert.equal(capped.length, 2, 'a turn yields at most maxLessonsPerTurn lessons')
  for (const lesson of capped) {
    assert.ok(lesson.text.length <= PAIN_DEFAULTS.maxTextChars, 'a lesson stays inside the injection budget')
  }
  checks.push('engine: recurrence reinforces, distinct themes stay separate, lessons capped per turn')
}

// 9. The cue lists stay narrow. 不要 is a preference ("do not use X"), not a
//    complaint about the last turn; flagging it would distil a lesson out of
//    every ordinary instruction.
{
  assert.equal(CORRECTION_CUES.test('不要用 workbuddy，改用 trae'), false)
  assert.equal(CORRECTION_CUES.test('以后都用 pnpm.cmd'), false)
  assert.equal(CORRECTION_CUES.test('不对，应该是 pnpm.cmd'), true)
  assert.equal(CORRECTION_CUES.test('还是不行，重来'), true)
  assert.equal(SELF_CORRECTION_CUES.test('抱歉，我刚才搞错了'), true)
  assert.equal(SELF_CORRECTION_CUES.test('已经改好了'), false)
  checks.push('correction cues stay narrow: a preference is not a complaint')
}

// 10. Turns are isolated: evidence in another turn must not distil a lesson here.
{
  const events = [
    userMessage(11, '不对，应该是这样'),
    toolCall(12, 'c1', 'pwsh'),
    toolResult(12, 'c1', 'Error: boom', true),
  ]
  const pain = detectPain(events, 12)
  assert.equal(pain.painful, false, 'a correction in another turn does not count')
  assert.equal(pain.userCorrections.length, 0)
  const other = detectPain(events, 11)
  assert.equal(other.painful, true)
  assert.equal(other.toolFailures.length, 0, 'a failure in another turn does not count')
  checks.push('pain detection is per-turn: nothing leaks across turns')
}

// 11. The lesson ceiling. Lesson tags are exempt from capacity eviction — which is
//     correct, a lesson must not decay away — but nothing else removes one, and
//     distillation writes them automatically. Measured on real transcripts, 13.4%
//     of turns qualify, so without a ceiling the library gains a protected entry
//     forever. Eviction must ARCHIVE (undo window), never delete.
{
  const root = await freshRoot()
  const engine = new MemoryEngine({ root, config: { maxDistilledLessons: 3 } })
  const cwd = 'D:\\ws-pain-cap'
  // Genuinely different texts, because two lessons that differ by one digit are
  // caught by the ordinary text dedupe and never reach the theme path — which is
  // correct, and would make this fixture test the wrong thing.
  const themes = [
    'pwsh::command not found pnpm',
    'edit::old string not found in file',
    'plugin_market::target index url is required',
    'cordis_inspect_query::input must be an object',
    'write::file changed since it was read',
    'grep::rg exited with status two',
  ]
  for (const [index, theme] of themes.entries()) {
    const stored = await engine.remember({
      scope: 'workspace',
      cwd,
      text: `错误教训（第 ${index} 个主题）；${theme}；同一条路走不通时先换手段`,
      tags: ['错误教训'],
      affect: 0.85,
      source: 'pain',
      lessonTheme: theme,
    })
    assert.equal(Boolean(stored.duplicateOf), false, `theme ${theme} must be a new lesson, not a text duplicate`)
  }
  // The first two get recurrences so the ranking has something to preserve.
  for (const theme of [themes[0], themes[1]]) {
    await engine.remember({
      scope: 'workspace',
      cwd,
      text: `错误教训（${theme} 再次发生）`,
      tags: ['错误教训'],
      source: 'pain',
      lessonTheme: theme,
    })
  }
  const report = await engine.maintain(cwd)
  assert.equal(report.distilledArchived, 3, 'six lessons over a cap of three archives three')
  const live = (await engine.list({ cwd, scope: 'workspace' })).filter(
    row => row.source === 'pain' && !row.archived,
  )
  assert.equal(live.length, 3, 'the live distilled set is capped')
  const keptThemes = live.map(row => row.lessonTheme)
  assert.ok(keptThemes.includes(themes[0]), 'a lesson that recurred is kept over one that did not')
  assert.ok(keptThemes.includes(themes[1]))
  // Archived, not deleted: the row is still recoverable inside the undo window.
  const all = await engine.list({ cwd, scope: 'workspace', includeArchived: true })
  assert.equal(all.filter(row => row.source === 'pain').length, 6, 'eviction archives, it does not delete')

  // A manual lesson (source: 'user') is NOT subject to this ceiling — the cap is
  // about automatic growth, not about what the user chose to keep.
  const manual = await engine.remember({
    scope: 'workspace',
    cwd,
    text: '错误教训（用户自己写的一条，讲的是另一件事）',
    tags: ['错误教训'],
    source: 'user',
  })
  assert.equal(Boolean(manual.duplicateOf), false)
  await engine.maintain(cwd)
  const after = await engine.list({ cwd, scope: 'workspace' })
  assert.ok(after.some(row => row.id === manual.entry.id), 'a hand-written lesson is not capped')
  checks.push('distilled lessons have their own ceiling; eviction archives, never deletes')
}

console.log('')
for (const check of checks) console.log(`  ✓ ${check}`)
console.log(`\n${checks.length} pain-distillation checks passed\n`)
