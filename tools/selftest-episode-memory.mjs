/**
 * Episodic memory: the third cognitive kind the library was missing.
 *
 * Long-term memory splits into semantic facts, procedural rules, and episodes —
 * what happened, when, and how it turned out. The library had the first two and
 * filed everything else as a fact, which lost the two parts that make an event
 * useful: its time and its outcome.
 *
 * What this pins:
 *   1. an episode round-trips with occurredAt/context/outcome;
 *   2. it ages faster than a fact — an event stops being actionable sooner;
 *   3. the occurrence time is the decay clock, not the write time;
 *   4. an unknown or missing kind falls back to fact (an older prompt shape cannot
 *      corrupt the library);
 *   5. the kind survives the suggestion queue, so accepting a candidate later does
 *      not silently flatten it.
 *
 * Usage: node tools/selftest-episode-memory.mjs
 */

import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { MemoryEngine, KINDS, EPISODE_DECAY_FACTOR, scoreEntry } from '../lib/memory-engine.js'

const checks = []

/** @returns {Promise<string>} throwaway root */
async function freshRoot() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'episode-'))
}

// 1. An episode round-trips with its three extra fields.
{
  const root = await freshRoot()
  const engine = new MemoryEngine({ root, config: {} })
  const cwd = 'D:\\ws-episode'
  const occurredAt = Date.now() - 3 * 86400000
  const { entry } = await engine.remember({
    scope: 'workspace',
    cwd,
    text: '上周那份 PPT 被否了',
    kind: 'episode',
    occurredAt,
    context: '给新东方做的复盘汇报',
    outcome: '被否因为配色太花，下次先给骨架再上色',
    tags: ['汇报'],
    affect: 0.8,
  })
  assert.equal(entry.kind, 'episode')
  assert.equal(entry.occurredAt, occurredAt)
  assert.equal(entry.context, '给新东方做的复盘汇报')
  assert.equal(entry.outcome, '被否因为配色太花，下次先给骨架再上色')

  const listed = await engine.list({ cwd })
  const row = listed.find(item => item.id === entry.id)
  assert.equal(row?.kind, 'episode', 'the kind must survive a round trip to disk')
  assert.equal(row?.outcome, '被否因为配色太花，下次先给骨架再上色')
  checks.push('an episode round-trips with occurredAt, context, and outcome')
  await fs.rm(root, { recursive: true, force: true })
}

// 2. An episode ages faster than a fact written at the same moment.
{
  const now = Date.now()
  const ageDays = 45
  const aged = now - ageDays * 86400000
  const fact = scoreEntry(
    { id: 'f', kind: 'fact', text: '项目使用 pnpm', accessCount: 1, lastAccessAt: aged, createdAt: aged, affect: 0.6, frozen: false },
    { now, maxAccess: 1, decayDays: 60, uniqueness: 1 },
  )
  const episode = scoreEntry(
    { id: 'e', kind: 'episode', text: '部署那天挂了', accessCount: 1, lastAccessAt: aged, createdAt: aged, occurredAt: aged, affect: 0.6, frozen: false },
    { now, maxAccess: 1, decayDays: 60, uniqueness: 1 },
  )
  assert.equal(
    episode.factors.recency < fact.factors.recency,
    true,
    `an episode must decay faster (${episode.factors.recency} vs ${fact.factors.recency})`,
  )
  assert.equal(episode.score < fact.score, true, 'the composite score must be lower for the episode')
  checks.push('an episode ages faster than a fact')
}

// 3. The decay clock is the occurrence time, not the write time. An event recorded
//    late is not a fresh event.
{
  const now = Date.now()
  const oldEvent = now - 90 * 86400000
  // Written just now, but it happened 90 days ago.
  const writtenNow = scoreEntry(
    {
      id: 'e2',
      kind: 'episode',
      text: '很久以前发生的事',
      accessCount: 1,
      lastAccessAt: now,
      createdAt: now,
      occurredAt: oldEvent,
      affect: 0.6,
      frozen: false,
    },
    { now, maxAccess: 1, decayDays: 60, uniqueness: 1 },
  )
  assert.equal(
    writtenNow.factors.recency < 0.5,
    true,
    `an old event written today must still look old, got recency ${writtenNow.factors.recency}`,
  )
  checks.push('the decay clock is the occurrence time, not the write time')
}

// 4. An unknown or missing kind falls back to fact.
{
  const root = await freshRoot()
  const engine = new MemoryEngine({ root, config: {} })
  const cwd = 'D:\\ws-episode-4'
  const { entry: unknownKind } = await engine.remember({ scope: 'workspace', cwd, text: '未知类型应回退', kind: 'nonsense' })
  const { entry: noKind } = await engine.remember({ scope: 'workspace', cwd, text: '没给类型也应回退' })
  assert.equal(unknownKind.kind, 'fact', 'an unknown kind must fall back to fact')
  assert.equal(noKind.kind, 'fact', 'a missing kind must fall back to fact')
  assert.equal(KINDS.includes('episode'), true)
  checks.push('an unknown or missing kind falls back to fact')
  await fs.rm(root, { recursive: true, force: true })
}

// 5. The kind survives the suggestion queue: accepting a candidate later must not
//    flatten an episode into a fact.
{
  const root = await freshRoot()
  const engine = new MemoryEngine({ root, config: {} })
  const cwd = 'D:\\ws-episode-5'
  const suggestion = await engine.suggest({
    text: '上周调这个 bug 花了两小时',
    scope: 'workspace',
    cwd,
    kind: 'episode',
    context: '排查快照面板空白',
    outcome: '根因是父会话被误判为 subagent',
  })
  assert.equal(suggestion?.kind, 'episode', 'the suggestion must remember its kind')
  assert.equal(suggestion?.outcome, '根因是父会话被误判为 subagent')

  const settled = await engine.settle(suggestion.id, true)
  assert.equal(settled.stored, true)
  assert.equal(settled.entry.kind, 'episode', 'accepting must preserve the kind')
  assert.equal(settled.entry.context, '排查快照面板空白')
  checks.push('the kind survives the suggestion queue')
  await fs.rm(root, { recursive: true, force: true })
}

// 6. EPISODE_DECAY_FACTOR is a real multiplier, and it shortens rather than
//    extends the half-life.
{
  assert.equal(typeof EPISODE_DECAY_FACTOR, 'number')
  assert.equal(EPISODE_DECAY_FACTOR > 0 && EPISODE_DECAY_FACTOR < 1, true, 'the factor must shorten the half-life')
  checks.push('the episode decay factor shortens the half-life')
}

// 7. The extractor must actually ASK for episodes. Without this the type exists but
//    nothing ever produces one, which is the same as not having it.
{
  const hostSource = await fs.readFile('lib/memory-host.js', 'utf8')
  // Assert on the prompt TEXT specifically: a bare "episode" appears in the loop as
  // well, so a loose check passed even after the instruction was deleted.
  assert.equal(
    /episode：这一轮里实际/.test(hostSource),
    true,
    'the extraction prompt must ask for events, not just mention the kind',
  )
  assert.equal(
    /仅episode/.test(hostSource),
    true,
    'the prompt must tell the model which fields an episode carries',
  )
  // And the loop must pass the kind through rather than dropping it.
  assert.equal(
    /kind:\s*item\.kind === 'episode' \? 'episode' : 'fact'/.test(hostSource),
    true,
    'the extraction loop must forward the kind the model reported',
  )
  checks.push('the extractor asks for and forwards episodes')
}

console.log(checks.map((line, index) => `  ${index + 1}. ${line}`).join('\n'))
console.log(`\n${checks.length}/${checks.length} checks passed`)
