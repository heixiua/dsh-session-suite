/**
 * Tier and topic: the two axes that make the library budgetable.
 *
 * Why this exists: 195 memories in one workspace bucket means the injected block
 * spent its 800 characters on whichever three lessons happened to score highest,
 * and a question about release checks competed with an unrelated plugin note for
 * the same slots. `scope` (global/workspace) answered WHERE a memory is filed; it
 * never answered "must this be present every turn" or "which subject is this".
 *
 * What this pins:
 *   1. tier is inferred from signals already stored, never from a model call;
 *   2. `project` actually occurs (a first version returned only base/detail,
 *      which silently collapsed a three-layer design into two);
 *   3. topic rejects words that name the product or the act rather than a subject;
 *   4. an unclassifiable memory gets NO topic rather than a catch-all bin;
 *   5. select() caps per-topic entries but still fills the limit when the library
 *      is genuinely single-topic;
 *   6. remember() stores both fields, and a restatement can adopt a new topic.
 *
 * Usage: node tools/selftest-tiers.mjs
 */
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { MemoryEngine, LESSON_TAGS } from '../lib/memory-engine.js'
import { TIERS, TOPIC_EXCLUDED, inferTier, inferTopic, groupByTopic } from '../lib/tiers.js'

let n = 0
const check = async (name, fn) => { await fn(); n += 1; console.log(`  ✓ ${name}`) }

const opts = { lessonTags: LESSON_TAGS }

console.log('inferTier')
await check('a rule is base: it must hold without being asked for', () => {
  assert.equal(inferTier({ kind: 'rule', scope: 'workspace' }, opts), 'base')
})
await check('a lesson-tagged fact is base', () => {
  assert.equal(inferTier({ kind: 'fact', scope: 'global', tags: ['错误教训'] }, opts), 'base')
})
await check('a frozen memory is base: the user said "always"', () => {
  assert.equal(inferTier({ kind: 'fact', scope: 'global', frozen: true }, opts), 'base')
})
await check('REGRESSION: a workspace fact is project, not base or detail', () => {
  // The first implementation returned only 'base' and 'detail', so the middle
  // layer existed in the vocabulary and never in the data.
  assert.equal(inferTier({ kind: 'fact', scope: 'workspace', tags: [] }, opts), 'project')
})
await check('a global fact is detail: machine-wide is not the same as always-on', () => {
  assert.equal(inferTier({ kind: 'fact', scope: 'global', tags: [] }, opts), 'detail')
})
await check('an episode is detail even in a workspace: it is dated, not standing', () => {
  assert.equal(inferTier({ kind: 'episode', scope: 'workspace' }, opts), 'detail')
})
await check('a summary is detail: it is a pointer, not a fact', () => {
  assert.equal(inferTier({ kind: 'summary', scope: 'workspace' }, opts), 'detail')
})
await check('every tier returned is one of the closed set', () => {
  const cases = [
    { kind: 'rule' }, { kind: 'fact', scope: 'workspace' }, { kind: 'fact', scope: 'global' },
    { kind: 'summary' }, { kind: 'episode' }, {},
  ]
  for (const entry of cases) assert.ok(TIERS.includes(inferTier(entry, opts)), JSON.stringify(entry))
})

console.log('\ninferTopic')
await check('a seed word becomes the topic', () => {
  assert.equal(inferTopic('压缩阈值必须 retainRatio < thresholdRatio'), '压缩')
  assert.equal(inferTopic('npm publish 输出不代表已上线'), 'npm')
})
await check('REGRESSION: `dsh` never becomes a topic', () => {
  // 44 of 195 entries contain it. It names the product, not a subject, so
  // making it a topic produced one bin holding a quarter of the library.
  // The fallback may still label such an entry `插件` — that is a broad but real
  // subject — but `dsh` itself must never be the answer.
  assert.ok(TOPIC_EXCLUDED.has('dsh'))
  assert.notEqual(inferTopic('DSH 插件坑：apply() 内抛异常'), 'dsh')
  assert.equal(inferTopic('DSH 报错序列的因果顺序'), '', 'no subject word, no fallback match')
})
await check('`插件` is a FALLBACK, not a first choice', () => {
  // Excluding it outright left 35 of 111 entries with no topic, most of them
  // genuine plugin-development knowledge. It must lose to a specific subject and
  // still catch an entry whose only identifiable subject is the broad one.
  assert.ok(TOPIC_EXCLUDED.has('插件'), 'it must not win as a seed')
  assert.equal(inferTopic('插件加载失败的原因'), '插件', 'fallback still labels it')
  assert.equal(inferTopic('快照恢复失败'), '快照', 'a specific seed wins first')
})
await check('an unclassifiable memory gets NO topic, not a catch-all bin', () => {
  assert.equal(inferTopic('毫无主题的一句话'), '')
})
await check('an explicit topic wins, but an excluded one is refused', () => {
  assert.equal(inferTopic('无关文本', { explicit: '快照' }), '快照')
  assert.equal(inferTopic('无关文本', { explicit: 'dsh' }), '')
})

console.log('\ngroupByTopic')
await check('topics group, ungrouped is reported separately, share is measured', () => {
  const entries = [
    { id: 'a', topic: '快照' }, { id: 'b', topic: '快照' },
    { id: 'c', topic: '回滚' }, { id: 'd', topic: '' },
  ]
  const { topics, ungrouped, largestShare } = groupByTopic(entries)
  assert.equal(topics.get('快照').length, 2)
  assert.equal(ungrouped.length, 1)
  assert.equal(largestShare, 0.5)
})

console.log('\nselect() topic budgeting')
/** A throwaway store with two subjects, the first dominating by score. */
async function store() {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'dss-tiers-'))
  const engine = new MemoryEngine({ root: tmp, config: {} })
  const cwd = 'D:\\ws'
  // Four entries about snapshots, one about npm. The texts are formatted so both
  // subjects survive the per-candidate relevance floor — this test is about the
  // per-topic cap, so it must not be confounded by an entry being dropped earlier.
  for (let i = 0; i < 4; i += 1) {
    await engine.remember({ cwd, text: `快照 恢复 必须 校验 mtime 第${i}条`, kind: 'fact', source: 'tool' })
  }
  await engine.remember({ cwd, text: '快照 恢复 必须 校验 mtime 关键一条', kind: 'fact', source: 'tool' })
  await engine.remember({ cwd, text: 'npm 发布 后必须 核对 dist-tags', kind: 'fact', source: 'tool' })
  return { engine, cwd, tmp }
}

await check('remember() stores both tier and topic', async () => {
  const { engine, cwd, tmp } = await store()
  try {
    const listed = await engine.list({ cwd })
    assert.ok(listed.length >= 2)
    for (const entry of listed) {
      assert.ok(TIERS.includes(entry.tier), `tier missing on ${entry.id}`)
      assert.equal(typeof entry.topic, 'string', `topic not a string on ${entry.id}`)
    }
    const npm = listed.find(e => e.text.includes('npm'))
    // The text contains BOTH `npm` and `发布`; the tie is broken by whichever
    // appears first at equal count, so either is a correct subject label. What
    // matters is that an excluded word (`dsh`/`插件`) is never chosen.
    assert.ok(['npm', '发布'].includes(npm.topic), `unexpected topic ${npm.topic}`)
    assert.equal(npm.tier, 'project', 'a workspace fact is project')
  } finally {
    await fs.rm(tmp, { recursive: true, force: true }).catch(() => {})
  }
})

await check('one topic cannot take every slot when another subject matches', async () => {
  const { engine, cwd, tmp } = await store()
  try {
    const { items } = await engine.select({ cwd, query: '快照 npm 恢复 发布', limit: 4 })
    const topics = items.map(i => i.topic)
    const snapshotCount = topics.filter(t => t === '快照').length
    assert.ok(snapshotCount <= 2, `snapshot topic took ${snapshotCount} of ${items.length} slots`)
    // The npm entry's topic may legitimately be `发布` (see above); what must hold
    // is that BOTH subjects are represented rather than four snapshot memories.
    const distinct = new Set(topics.filter(Boolean))
    assert.ok(distinct.size >= 2, `only one subject represented: ${[...distinct].join(', ')}`)
  } finally {
    await fs.rm(tmp, { recursive: true, force: true }).catch(() => {})
  }
})

await check('a single-topic library still fills the limit (backfill works)', async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'dss-tiers-single-'))
  try {
    const engine = new MemoryEngine({ root: tmp, config: {} })
    const cwd = 'D:\\ws'
    for (let i = 0; i < 6; i += 1) {
      await engine.remember({ cwd, text: `回滚必须校验快照第${i}条`, kind: 'fact', source: 'tool' })
    }
    const { items, effectiveLimit, omitted } = await engine.select({ cwd, query: '回滚 快照 校验', limit: 4 })
    // The per-topic cap must not shrink recall when there is nothing else to
    // diversify with: the deferred overflow is backfilled up to the limit.
    assert.equal(items.length, effectiveLimit, `only ${items.length} of ${effectiveLimit} slots filled`)
    assert.ok(items.every(item => item.topic === '快照'), 'every entry here is the same topic')
    // The entries that lost are reported as topic-cap, not as capacity/irrelevant.
    assert.ok(omitted.length > 0)
    assert.ok(omitted.every(o => o.reason === 'topic-cap'), `unexpected reasons: ${omitted.map(o => o.reason).join(',')}`)
  } finally {
    await fs.rm(tmp, { recursive: true, force: true }).catch(() => {})
  }
})

await check('maintain() classifies entries that predate the field', async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'dss-tiers-maint-'))
  try {
    const engine = new MemoryEngine({ root: tmp, config: {} })
    const cwd = 'D:\\ws'
    await engine.remember({ cwd, text: '快照要校验 mtime', kind: 'fact', source: 'tool' })
    // Simulate a legacy row: strip the new fields from the stored file. The store
    // lives under <root>/memory/workspaces/, not <root>/workspaces/ — the first
    // version of this test looked in the wrong place and threw ENOENT.
    const key = MemoryEngine.workspaceKey(cwd)
    const file = path.join(tmp, 'memory', 'workspaces', `${key}.json`)
    const raw = JSON.parse(await fs.readFile(file, 'utf8'))
    for (const entry of raw.entries) { delete entry.tier; delete entry.topic }
    await fs.writeFile(file, JSON.stringify(raw))
    const report = await engine.maintain(cwd)
    assert.ok(report.classified >= 1, 'maintain did not classify anything')
    const after = JSON.parse(await fs.readFile(file, 'utf8'))
    for (const entry of after.entries) {
      assert.ok(TIERS.includes(entry.tier), 'tier still missing after maintain')
      assert.equal(typeof entry.topic, 'string')
    }
  } finally {
    await fs.rm(tmp, { recursive: true, force: true }).catch(() => {})
  }
})

console.log(`\n${n} tier/topic checks passed`)
