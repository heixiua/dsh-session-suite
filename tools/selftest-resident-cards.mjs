/**
 * The resident layer must be an overview of the library, not extra search hits.
 *
 * The user's report made the failure concrete: they typed a question into the
 * settings probe, saw six entries, and concluded the memory that matched had been
 * missed. It had matched — rank 1, bm25 14.4 — but the block appended two
 * highest-scoring entries regardless of the question and presented the lot under
 * one heading, so a reader could not tell which line answered their question.
 *
 * What this test pins:
 *   1. cards group by topic and count their members;
 *   2. the card count limit and the character budget are both enforced;
 *   3. an empty library yields no cards (so nothing is injected);
 *   4. the rendered block labels the two halves separately;
 *   5. a card's summary line comes from the most valuable member, not an arbitrary
 *      one — frozen beats score beats recency.
 *
 * Usage: node tools/selftest-resident-cards.mjs
 */

import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { MemoryEngine } from '../lib/memory-engine.js'

const checks = []

/** @returns {Promise<string>} throwaway root */
async function freshRoot() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'resident-cards-'))
}

// 1. Cards group by the first tag and count members.
{
  const root = await freshRoot()
  const engine = new MemoryEngine({ root, config: {} })
  const cwd = 'D:\\ws-cards'
  await engine.remember({ scope: 'workspace', cwd, text: '缓存是 endpoint 本地的', tags: ['缓存'], affect: 0.8 })
  await engine.remember({ scope: 'workspace', cwd, text: '命中率下降先查 provider 切换', tags: ['缓存'], affect: 0.6 })
  await engine.remember({ scope: 'workspace', cwd, text: '快照必须在 turn/end 拍', tags: ['快照'], affect: 0.7 })

  const cards = await engine.residentCards({ cwd })
  assert.equal(cards.length, 2, `expected two topic cards, got ${cards.length}`)
  const cacheCard = cards.find(card => card.topic === '缓存')
  assert.equal(cacheCard?.count, 2, 'the cache card must count both members')
  assert.equal(cards[0].topic, '缓存', 'the larger group must come first')
  checks.push('cards group by topic and count members')
  await fs.rm(root, { recursive: true, force: true })
}

// 2. The summary line comes from the most valuable member: frozen wins, then score,
//    then recency.
{
  const root = await freshRoot()
  const engine = new MemoryEngine({ root, config: {} })
  const cwd = 'D:\\ws-cards-2'
  // remember() returns { entry } — not the entry itself.
  const low = (await engine.remember({ scope: 'workspace', cwd, text: '低分条目', tags: ['主题'], affect: 0.1 })).entry
  await engine.remember({ scope: 'workspace', cwd, text: '高分条目', tags: ['主题'], affect: 0.9 })
  await engine.update({ id: low.id, scope: 'workspace', cwd, patch: { frozen: true } })

  const cards = await engine.residentCards({ cwd })
  const card = cards.find(entry => entry.topic === '主题')
  assert.equal(card?.summary, '低分条目', 'a frozen entry must lead the card regardless of score')
  checks.push('frozen beats score when choosing the summary line')
  await fs.rm(root, { recursive: true, force: true })
}

// 3. The limit and the budget are both real constraints.
{
  const root = await freshRoot()
  const engine = new MemoryEngine({ root, config: {} })
  const cwd = 'D:\\ws-cards-3'
  // Texts must be mutually dissimilar, or remember()'s duplicate detection folds
  // them into one entry and there is only ever one card to cap.
  const subjects = [
    ['快照', '快照必须在每轮结束时拍摄才能回滚'],
    ['导出', '导出文件时要把图片内联成 data URL'],
    ['删除', '删除会话要先清掉指向它的归档标记'],
    ['检索', '检索要用查询覆盖率而不是对称相似度'],
    ['记忆', '记忆单条上限三百字符拒绝而非截断'],
    ['插件', '插件加载失败要先看 fiberPhase'],
    ['压缩', '压缩是追加写入摘要事件不改原文'],
    ['降级', '降级链的触发码要包含超时'],
  ]
  for (const [tag, text] of subjects) {
    await engine.remember({ scope: 'workspace', cwd, text, tags: [tag], affect: 0.5 })
  }
  const limited = await engine.residentCards({ cwd, limit: 3 })
  assert.equal(limited.length, 3, `limit must cap the card count, got ${limited.length}`)

  const tight = await engine.residentCards({ cwd, limit: 8, budget: 60 })
  const rendered = MemoryEngine.formatCards(tight).join('\n')
  assert.equal(
    rendered.length <= 200,
    true,
    `a tight budget must cut the block short, got ${rendered.length} characters`,
  )
  assert.equal(tight.length >= 1, true, 'a tight budget must still yield at least one card')
  checks.push('the card limit and the character budget are enforced')
  await fs.rm(root, { recursive: true, force: true })
}

// 4. An empty library yields no cards, so nothing is injected for it.
{
  const root = await freshRoot()
  const engine = new MemoryEngine({ root, config: {} })
  const cards = await engine.residentCards({ cwd: 'D:\\ws-empty' })
  assert.deepEqual(cards, [], 'an empty library must produce no cards')
  checks.push('an empty library produces no cards')
  await fs.rm(root, { recursive: true, force: true })
}

// 5. Archived entries are not card material.
//
// The fixture writes the cold store directly: archive() is private and maintain()
// only archives below a score threshold, so driving it through the public API would
// make this test depend on the scoring model rather than on the filter it is meant
// to check. What matters here is that a cold entry never becomes a card.
{
  const root = await freshRoot()
  const engine = new MemoryEngine({ root, config: {} })
  const cwd = 'D:\\ws-cards-5'
  const created = (await engine.remember({ scope: 'workspace', cwd, text: '将被归档的条目', tags: ['归档测试'], affect: 0.9 })).entry

  // Move it from the live store to the cold store by hand, mirroring what
  // #archive does. NOTE: the constructor appends 'memory' to the root it is given,
  // so the effective store lives under <root>/memory/.
  const key = MemoryEngine.workspaceKey(cwd)
  const storeRoot = path.join(root, 'memory')
  const liveFile = path.join(storeRoot, 'workspaces', `${key}.json`)
  const live = JSON.parse(await fs.readFile(liveFile, 'utf8'))
  const moved = live.entries.find(entry => entry.id === created.id)
  live.entries = live.entries.filter(entry => entry.id !== created.id)
  await fs.writeFile(liveFile, `${JSON.stringify(live, null, 2)}\n`, 'utf8')
  const coldFile = path.join(storeRoot, 'cold', `${key}.json`)
  await fs.mkdir(path.dirname(coldFile), { recursive: true })
  await fs.writeFile(
    coldFile,
    `${JSON.stringify({ version: 1, entries: [{ ...moved, state: 'archived', archivedAt: Date.now() }] }, null, 2)}\n`,
    'utf8',
  )

  const cards = await engine.residentCards({ cwd })
  assert.equal(
    cards.some(card => card.topic === '归档测试'),
    false,
    'an archived entry must not appear as a card',
  )
  // list() always includes the cold store, marking those rows archived — so the
  // assertion above could pass merely because the row was lost. Check the flag.
  const listed = await engine.list({ cwd })
  const row = listed.find(entry => entry.id === created.id)
  assert.equal(Boolean(row), true, 'the archived entry must still be listed')
  assert.equal(row.archived, true, 'the row must be marked archived')
  checks.push('archived entries are not card material')
  await fs.rm(root, { recursive: true, force: true })
}

// 5b. A verbose lead memory is truncated in the card, because one long entry
//     otherwise consumes the whole budget and hides every other topic.
{
  const root = await freshRoot()
  const engine = new MemoryEngine({ root, config: {} })
  const cwd = 'D:\\ws-cards-5b'
  const long = '甲乙丙丁戊己庚辛壬癸'.repeat(28) // 280 chars, under the 300 write ceiling
  await engine.remember({ scope: 'workspace', cwd, text: long, tags: ['冗长'], affect: 0.9 })
  const cards = await engine.residentCards({ cwd })
  const card = cards.find(entry => entry.topic === '冗长')
  assert.equal(Boolean(card), true, 'the card must exist')
  assert.equal(
    card.summary.length <= 70,
    true,
    `the card summary must be capped, got ${card.summary.length} characters`,
  )
  checks.push('a verbose lead memory is truncated in the card')
  await fs.rm(root, { recursive: true, force: true })
}

// 6. The rendered block labels the two halves, so the settings probe cannot be read
//    as "these are all my search results".
{
  const source = await fs.readFile('lib/memory-host.js', 'utf8')
  assert.equal(
    source.includes('与本次提问相关'),
    true,
    'the injection must label the matched half',
  )
  assert.equal(
    source.includes('库内概览'),
    true,
    'the injection must label the overview half',
  )
  assert.equal(
    source.includes('与本次提问无关'),
    true,
    'the overview half must say it is unrelated to the question',
  )
  checks.push('the injected block labels the two halves separately')
}

console.log(checks.map((line, index) => `  ${index + 1}. ${line}`).join('\n'))
console.log(`\n${checks.length}/${checks.length} checks passed`)
