/**
 * Unit tests for fact keys and supersession.
 *
 * The two assertions that matter most are the ones protecting against silent
 * data loss: a wrongly superseded entry stops being recalled forever, and a
 * catch-all key makes unrelated memories fight over one slot. Both failure
 * modes are invisible in normal use, so this file pins them explicitly — a
 * deliberately broken implementation must fail it (see the mutation log in the
 * task report), otherwise the assertions are decoration.
 *
 * Usage: node tools/selftest-factkeys.mjs
 */

import assert from 'node:assert/strict'
import fs from 'node:fs'
import {
  CATCH_ALL_SEGMENTS,
  applySupersession,
  converge,
  isCatchAllKey,
  normalizeFactKey,
} from '../lib/factkeys.js'

const checks = []

/**
 * A memory row as `remember` stores it, with the fields this module reads.
 * Timestamps are explicit so no test depends on the wall clock.
 */
function entry(id, factKey, createdAt, text = id) {
  return { id, factKey, createdAt, text }
}

/** Superseded ids, sorted, so comparisons ignore input order. */
function supersededIds(result) {
  return result.superseded.map(item => item.id).sort()
}

// 1. Every separator a model realistically emits must fold onto the canonical
//    half-width dot, otherwise the same fact stored twice never groups.
{
  const forms = ['她.身高', '她。身高', '她·身高', '她・身高', '她/身高', '她／身高', '她．身高']
  for (const form of forms) {
    assert.equal(normalizeFactKey(form), '她.身高', `${form} must normalise to 她.身高`)
  }
  assert.equal(normalizeFactKey('她\u3000.\u3000身高'), '她.身高', 'ideographic spaces must be dropped')
  checks.push('normalizeFactKey() unifies . 。 · ・ / ／ ． and whitespace')
}

// 2. ASCII is case-folded and leading/trailing dots are removed, so a key typed
//    carelessly still matches the tidy form of itself.
{
  assert.equal(normalizeFactKey('  She . Height. '), 'she.height')
  assert.equal(normalizeFactKey('.她.身高.'), '她.身高')
  assert.equal(normalizeFactKey('ＡＢＣ.身高'), 'abc.身高', 'full-width ASCII must fold to half-width')
  checks.push('normalizeFactKey() lowercases ASCII and trims edge dots')
}

// 3. Empty segments collapse rather than creating a phantom segment, which
//    would otherwise inflate the segment count and change the verdict.
{
  assert.equal(normalizeFactKey('她..身高.。体重'), '她.身高.体重')
  checks.push('normalizeFactKey() collapses empty segments')
}

// 4. Junk in must not become a usable key out. Anything unusable is null, and
//    converge treats null as "no key" — never as a shared key.
{
  for (const raw of [null, undefined, '', '   ', '...', '。·/', 42, {}, [], true]) {
    assert.equal(normalizeFactKey(raw), null, `${JSON.stringify(raw)} must not yield a key`)
  }
  checks.push('normalizeFactKey() returns null for empty, symbolic and non-string input')
}

// 5. A key with no dot names a category, not a fact: `身高` would collide with
//    every height ever mentioned.
{
  assert.equal(isCatchAllKey('身高'), true, 'a single-segment key is catch-all')
  assert.equal(isCatchAllKey('她.身高'), false, '对象.方面 is a real key')
  assert.equal(isCatchAllKey(' 她 . 身高 '), false, 'the judgement must normalise first')
  checks.push('isCatchAllKey() rejects single-segment keys and accepts 对象.方面')
}

// 6. A generic segment anywhere in the key condemns it. This is the check that
//    stops `信息.内容` from silently swallowing unrelated memories.
{
  for (const key of ['信息.内容', '内容.身高', '其他.身高', 'note.x', 'INFO.x', 'misc.x', 'general.general']) {
    assert.equal(isCatchAllKey(key), true, `${key} must be rejected as catch-all`)
  }
  assert.equal(isCatchAllKey('她.身高'), false)
  checks.push('isCatchAllKey() rejects generic segments case-insensitively')
}

// 7. Too many segments is the other kind of vagueness: nobody maintains a
//    four-level taxonomy by hand. Three is the ceiling.
{
  assert.equal(isCatchAllKey('a.b.c'), false)
  assert.equal(isCatchAllKey('a.b.c.d'), true)
  assert.equal(isCatchAllKey('约定.位置.城市'), false)
  checks.push('isCatchAllKey() rejects keys with more than three segments')
}

// 8. An absent key cannot group with anything, and must not be mistaken for a
//    shared one.
{
  assert.equal(isCatchAllKey(null), true)
  assert.equal(isCatchAllKey(''), true)
  assert.equal(isCatchAllKey('...'), true)
  checks.push('isCatchAllKey() treats a missing key as unusable')
}

// 9. Two entries on one slot: the newer survives, the older is retired with a
//    pointer to its replacement.
{
  const older = entry('m1', '她.身高', 1000)
  const newer = entry('m2', '她.身高', 2000)
  const result = converge([older, newer])
  assert.deepEqual(result.superseded, [{ id: 'm1', byId: 'm2', factKey: '她.身高' }])
  assert.deepEqual(result.kept, ['m2'])
  checks.push('converge() keeps the newest entry of a key and retires the older one')
}

// 10. Three on one slot: only the newest survives, and both losers are reported
//     — a converge that reported only one would lose track of the other.
{
  const result = converge([entry('m1', '约定.位置', 10), entry('m2', '约定.位置', 30), entry('m3', '约定.位置', 20)])
  assert.deepEqual(supersededIds(result), ['m1', 'm3'])
  assert.deepEqual(result.kept, ['m2'])
  for (const item of result.superseded) assert.equal(item.byId, 'm2')
  checks.push('converge() retires every older entry of a key, not just one')
}

// 11. THE critical boundary. Two entries stamped in the same millisecond have no
//     decidable order; retiring one would permanently bury a real memory. Both
//     must stay live, and neither may be annotated.
{
  const first = entry('m1', '她.身高', 5000)
  const second = entry('m2', '她.身高', 5000)
  const result = converge([first, second])
  assert.deepEqual(result.superseded, [], 'an exact timestamp tie must supersede nothing')
  assert.deepEqual(result.kept.sort(), ['m1', 'm2'], 'both entries of a tie must stay live')

  const applied = applySupersession([first, second])
  assert.equal('supersededBy' in applied[0], false, 'a tie must not annotate either entry')
  assert.equal('supersededBy' in applied[1], false, 'a tie must not annotate either entry')
  checks.push('converge() supersedes nothing when timestamps are exactly equal')
}

// 12. A tie between two entries must not spare a strictly older third one: the
//     two newest both stay, the truly older one still retires.
{
  const result = converge([entry('a', '她.身高', 5000), entry('b', '她.身高', 5000), entry('c', '她.身高', 1)])
  assert.deepEqual(supersededIds(result), ['c'])
  assert.deepEqual(result.kept.sort(), ['a', 'b'])
  assert.equal(result.superseded[0].byId, 'a', 'byId must be deterministic under a tie')
  checks.push('converge() keeps tied winners and still retires the older entry')
}

// 13. An entry with no key is not part of any slot. It must be kept, and it must
//     not be counted as competition for keyed entries.
{
  const result = converge([
    entry('m1', null, 1000),
    entry('m2', undefined, 1000),
    entry('m3', '', 1000),
    entry('m4', '她.身高', 2000),
    entry('m5', '她.身高', 1000),
  ])
  assert.deepEqual(result.superseded, [{ id: 'm5', byId: 'm4', factKey: '她.身高' }])
  assert.deepEqual(result.kept.sort(), ['m1', 'm2', 'm3', 'm4'], 'unkeyed entries must all survive')
  checks.push('converge() never retires entries that have no key')
}

// 14. Two entries sharing a catch-all key must not be deduped against each
//     other — that is exactly the silent burial a vague key causes.
{
  const result = converge([
    entry('m1', '信息.内容', 1000),
    entry('m2', '信息.内容', 2000),
    entry('m3', '事情', 1000),
    entry('m4', '事情', 3000),
  ])
  assert.deepEqual(result.superseded, [], 'catch-all keys must not supersede anything')
  assert.deepEqual(result.kept.sort(), ['m1', 'm2', 'm3', 'm4'])
  checks.push('converge() excludes catch-all keys from supersession')
}

// 15. Equality is judged on the canonical key, so a full-width spelling competes
//     with the ASCII one instead of forming a second slot.
{
  const result = converge([entry('m1', '她。身高', 1000), entry('m2', '她.身高', 2000)])
  assert.deepEqual(result.superseded, [{ id: 'm1', byId: 'm2', factKey: '她.身高' }])
  assert.deepEqual(result.kept, ['m2'])
  checks.push('converge() groups spellings that normalise to the same key')
}

// 16. Different slots are independent: converging one fact must not touch a
//     neighbour, which is how an over-eager grouping would eat the library.
{
  const result = converge([
    entry('m1', '她.身高', 1000),
    entry('m2', '她.体重', 2000),
    entry('m3', '拼团.状态', 3000),
  ])
  assert.deepEqual(result.superseded, [])
  assert.deepEqual(result.kept.sort(), ['m1', 'm2', 'm3'])
  checks.push('converge() leaves distinct keys alone')
}

// 17. An unreadable timestamp makes the order unknowable, so the pair is kept.
//     Guessing here would retire a memory on no evidence.
{
  const result = converge([
    entry('m1', '她.身高', 2000),
    entry('m2', '她.身高', undefined),
    entry('m3', '她.身高', 'not-a-date'),
  ])
  assert.deepEqual(result.superseded, [], 'entries with unusable timestamps must not be retired')
  assert.deepEqual(result.kept.sort(), ['m1', 'm2', 'm3'])
  checks.push('converge() keeps entries whose timestamps cannot be compared')
}

// 18. ISO strings are comparable, so a caller that stores dates as text is not
//     silently reduced to the conservative path.
{
  const result = converge([
    entry('m1', '她.身高', '2026-01-02T00:00:00Z'),
    entry('m2', '她.身高', '2026-03-04T00:00:00Z'),
  ])
  assert.deepEqual(supersededIds(result), ['m1'])
  assert.deepEqual(result.kept, ['m2'])
  checks.push('converge() compares ISO timestamp strings when given them')
}

// 19. Idempotence: repeated calls, and a call on the already-annotated output,
//     must agree. A converge that drifted between runs would retire more on
//     every pass.
{
  const list = [entry('m1', '她.身高', 1000), entry('m2', '她.身高', 2000), entry('m3', null, 500)]
  const first = converge(list)
  assert.deepEqual(converge(list), first)
  assert.deepEqual(converge(list), first)
  const annotated = converge(applySupersession(list))
  assert.deepEqual(supersededIds(annotated), supersededIds(first), 'a second pass must reach the same verdict')
  checks.push('converge() is idempotent across repeats and re-runs')
}

// 20. The verdict is a property of the entries, not of the array order. Only the
//     arbitrary `byId` choice may depend on order.
{
  const list = [entry('m1', '她.身高', 1000), entry('m2', '她.身高', 3000), entry('m3', '她.身高', 2000)]
  const shuffled = [list[2], list[0], list[1]]
  assert.deepEqual(supersededIds(converge(shuffled)), supersededIds(converge(list)))
  assert.deepEqual(converge(shuffled).kept.sort(), converge(list).kept.sort())
  checks.push('converge() reaches an order-independent verdict')
}

// 21. Neither function may write to the caller's objects. Frozen inputs make a
//     mutation throw instead of passing quietly.
{
  const list = Object.freeze([
    Object.freeze(entry('m1', '她.身高', 1000)),
    Object.freeze(entry('m2', '她.身高', 2000)),
    Object.freeze(entry('m3', null, 1000)),
  ])
  const kept = converge(list)
  assert.deepEqual(supersededIds(kept), ['m1'])
  const annotated = applySupersession(list)
  assert.equal(annotated.length, 3)
  assert.equal('supersededBy' in list[0], false, 'converge/applySupersession must not write to the input')
  assert.deepEqual(
    list.map(item => Object.keys(item).sort()),
    [['createdAt', 'factKey', 'id', 'text'], ['createdAt', 'factKey', 'id', 'text'], ['createdAt', 'factKey', 'id', 'text']],
  )
  checks.push('converge() and applySupersession() do not mutate their input')
}

// 22. applySupersession annotates in place of the loser's identity: same length,
//     same order, only the losers gain fields, and the stamp is the survivor's
//     own createdAt so the result is reproducible without a clock.
{
  const list = [entry('m1', '她.身高', 1000), entry('m2', '她.身高', 2000), entry('m3', '她.体重', 3000)]
  const original = structuredClone(list)
  const annotated = applySupersession(list)
  assert.equal(annotated !== list, true, 'a new array is required')
  assert.equal(annotated.length, 3)
  assert.deepEqual(annotated.map(item => item.id), ['m1', 'm2', 'm3'], 'order must be preserved')
  assert.equal(annotated[0].supersededBy, 'm2')
  assert.equal(annotated[0].supersededAt, 2000, 'supersededAt defaults to the survivor createdAt')
  assert.deepEqual(Object.keys(annotated[1]).sort(), ['createdAt', 'factKey', 'id', 'text'])
  assert.deepEqual(annotated[1], original[1], 'a survivor must pass through untouched')
  assert.deepEqual(annotated[2], original[2], 'an unrelated entry must pass through untouched')
  const overridden = applySupersession(list, { now: 123456 })
  assert.equal(overridden[0].supersededAt, 123456, 'an explicit stamp must be honoured')
  checks.push('applySupersession() annotates exactly the retired entries')
}

// 23. Undo path: dropping the two added fields restores the original record
//     byte for byte, which is what makes supersession revocable.
{
  const list = [entry('m1', '她.身高', 1000), entry('m2', '她.身高', 2000)]
  const original = structuredClone(list)
  const annotated = applySupersession(list)
  const { supersededBy, supersededAt, ...restored } = annotated[0]
  assert.equal(supersededBy, 'm2')
  assert.equal(supersededAt, 2000)
  assert.deepEqual(restored, original[0], 'removing the annotation must restore the entry')
  assert.deepEqual(annotated.slice(1).map(item => ({ ...item })), [original[1]])
  checks.push('applySupersession() output is reversible by dropping two fields')
}

// 24. Re-applying the annotation must not stack or change values, so a caller
//     can run it over a store that already carries markers.
{
  const list = [entry('m1', '她.身高', 1000), entry('m2', '她.身高', 2000)]
  const once = applySupersession(list)
  assert.deepEqual(applySupersession(once), once)
  checks.push('applySupersession() is idempotent on already-annotated entries')
}

// 25. Degenerate input must not throw: callers iterate stores that can be empty.
{
  assert.deepEqual(converge([]), { superseded: [], kept: [] })
  assert.deepEqual(converge(undefined), { superseded: [], kept: [] })
  assert.deepEqual(applySupersession([]), [])
  assert.deepEqual(applySupersession(undefined), [])
  checks.push('converge() and applySupersession() tolerate empty input')
}

// 26. The module promises purity: no imports and no clock reads. This keeps a
//     future edit from smuggling IO into what callers treat as a pure helper.
{
  const source = fs.readFileSync(new URL('../lib/factkeys.js', import.meta.url), 'utf8')
  assert.equal(/^\s*import\s/m.test(source), false, 'lib/factkeys.js must not import anything')
  assert.equal(/\brequire\s*\(/.test(source), false, 'lib/factkeys.js must not require anything')
  assert.equal(/\bDate\.now\s*\(/.test(source), false, 'lib/factkeys.js must not read the clock')
  assert.equal(CATCH_ALL_SEGMENTS.includes('信息'), true, 'the generic vocabulary must be exported')
  checks.push('lib/factkeys.js stays pure: no imports, no clock, generic list exported')
}

console.log(checks.map((line, index) => `  ${index + 1}. ${line}`).join('\n'))
console.log(`\n${checks.length}/${checks.length} checks passed`)
