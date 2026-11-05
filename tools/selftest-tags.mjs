/**
 * Tests for the controlled tag vocabulary.
 *
 * The complaint was 标签打得有点乱: the same domain stored as both `dsh` and
 * `DSH`, UI words (`快照`, `删除`) filed as if they were subjects, and
 * near-duplicates (`记忆` / `机制` / `项目经验`) fragmenting the filter list.
 * The fix must converge spellings without refusing genuinely new domains —
 * the user has been clear they want the system to decide, not to be asked.
 *
 * Usage: node tools/selftest-tags.mjs
 */

import assert from 'node:assert/strict'
import { normalizeTag, normalizeTags, TAG_STOPWORDS } from '../lib/tags.js'

const checks = []

// 1. Case and spacing fold to one canonical label. This is the collision that
//    actually existed in the live library.
{
  assert.equal(normalizeTag('DSH'), 'dsh')
  assert.equal(normalizeTag('dsh'), 'dsh')
  assert.equal(normalizeTag('  Dsh  '), 'dsh')
  assert.equal(normalizeTag('DeepSeek Harness'), 'dsh')
  checks.push('case, spacing, and aliases fold to one canonical label')
}

// 2. Aliases the user's own notes use collapse onto the canonical domain.
{
  assert.equal(normalizeTag('踩坑'), '错误教训')
  assert.equal(normalizeTag('教训'), '错误教训')
  assert.equal(normalizeTag('设置'), '配置')
  assert.equal(normalizeTag('搜索'), '检索')
  checks.push('domain synonyms collapse onto the canonical label')
}

// 3. UI words are refused. Filing a memory under `快照` makes a filter nobody
//    can use — those are features, not subjects.
{
  for (const word of ['快照', '删除', '回滚', '重发', '共装', '降链', '插件', '全部标签']) {
    assert.equal(normalizeTag(word), null, `${word} must be refused as a UI word`)
  }
  checks.push('UI words are refused')
}

// 4. English UI words are refused too, since the model may answer in English.
{
  for (const word of ['snapshot', 'delete', 'rollback', 'resend', 'plugin', 'tags']) {
    assert.equal(normalizeTag(word), null, `${word} must be refused`)
  }
  checks.push('English UI words are refused')
}

// 5. A genuinely new domain is accepted. Refusing all novelty would make the
//    feature useless the moment a new subject appears.
{
  assert.equal(normalizeTag('知识图谱'), '知识图谱')
  // Deliberately a generic hyphenated name: this test ships in a public repo, so
  // it must not embed the name of a private project as a fixture.
  assert.equal(normalizeTag('some-new-proj'), 'some-new-proj')
  checks.push('an unknown but plausible domain is accepted')
}

// 6. Junk shapes are refused: single characters and over-long fragments are what
//    auto-extraction produces when it splits a sentence badly.
{
  assert.equal(normalizeTag('a'), null, 'a single character is not a domain')
  assert.equal(normalizeTag('一'), null)
  assert.equal(normalizeTag('x'.repeat(40)), null, 'an over-long fragment is not a domain')
  assert.equal(normalizeTag('   '), null)
  assert.equal(normalizeTag(''), null)
  assert.equal(normalizeTag(null), null)
  assert.equal(normalizeTag(42), null)
  assert.equal(normalizeTag('、、、'), null, 'punctuation only is not a domain')
  checks.push('junk shapes are refused')
}

// 7. A list is normalised, de-duplicated case-insensitively, and kept in
//    first-seen order so the stored order is stable.
{
  const result = normalizeTags(['DSH', 'dsh', '快照', '错误教训', '踩坑', '技术方案'])
  assert.deepEqual(result, ['dsh', '错误教训', '技术方案'])
  checks.push('a tag list is normalised, de-duplicated, and order-stable')
}

// 8. Non-array input yields an empty list rather than throwing.
{
  assert.deepEqual(normalizeTags(undefined), [])
  assert.deepEqual(normalizeTags(null), [])
  assert.deepEqual(normalizeTags('dsh'), [])
  assert.deepEqual(normalizeTags([]), [])
  checks.push('non-array input yields an empty list')
}

// 9. Normalisation is idempotent: storing a canonical tag and re-ingesting it
//    must not change it, or repeated maintenance would keep rewriting entries.
{
  for (const input of ['DSH', '踩坑', '知识图谱', '配置']) {
    const once = normalizeTag(input)
    assert.equal(normalizeTag(once), once, `${input} must be stable under re-normalisation`)
  }
  checks.push('normalisation is idempotent')
}

// 10. The stopword list is what the engineering doc claims it is — a UI/plumbing
//     list, not a list of common subjects. Guard against someone adding a real
//     domain to it later and silently dropping genuine tags.
{
  for (const subject of ['错误教训', '技术方案', '记忆', '检索', '安全', '配置']) {
    assert.equal(TAG_STOPWORDS.has(subject), false, `${subject} is a subject and must not be a stopword`)
  }
  checks.push('the stopword list contains no real domains')
}

console.log(checks.map((line, index) => `  ${index + 1}. ${line}`).join('\n'))
console.log(`\n${checks.length}/${checks.length} checks passed`)
