/**
 * Tests for the memory limits and filters.
 *
 * Two user complaints drove this: a single 3250-character entry that read like a
 * document rather than a memory, and a library long enough that scanning it was
 * not worth the effort. The fix is a hard ceiling on one entry's size and
 * server-side filtering, so the page and the export agree on what a query means.
 *
 * Usage: node tools/selftest-memory-limits.mjs
 */

import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { MemoryEngine } from '../lib/memory-engine.js'

const checks = []
const root = await fs.mkdtemp(path.join(os.tmpdir(), 'limits-'))
const cwd = path.join(root, 'ws')
await fs.mkdir(cwd, { recursive: true })
const engine = new MemoryEngine({ root, config: { maxMemoryChars: 300 } })

// 1. An over-long memory is refused, not truncated. A truncated fact reads as a
//    complete one and would be silently wrong.
{
  const long = '这是一条非常长的记忆。'.repeat(60) // ~600 chars
  await assert.rejects(
    () => engine.remember({ scope: 'workspace', cwd, text: long }),
    /limit is 300/i,
    'an over-long memory must be refused',
  )
  const rows = await engine.list({ cwd })
  assert.equal(rows.length, 0, 'a refused memory must not be stored at all')
  checks.push('an over-long memory is refused rather than truncated')
}

// 2. The message names the actual length and the limit, so the caller can act.
{
  const long = 'x'.repeat(400)
  await assert.rejects(() => engine.remember({ scope: 'workspace', cwd, text: long }), error => {
    assert.match(error.message, /400 characters/)
    assert.match(error.message, /limit is 300/)
    return true
  })
  checks.push('the refusal names the length and the limit')
}

// 3. A memory at the limit is accepted; the boundary must be inclusive.
{
  const exact = '记'.repeat(300)
  const result = await engine.remember({ scope: 'workspace', cwd, text: exact })
  assert.equal(result.entry.text.length, 300)
  checks.push('a memory exactly at the limit is accepted')
}

// 4. The limit is configurable and 0 disables it.
{
  const unlimited = new MemoryEngine({ root: path.join(root, 'unlimited'), config: { maxMemoryChars: 0 } })
  await fs.mkdir(cwd, { recursive: true })
  const result = await unlimited.remember({ scope: 'workspace', cwd, text: 'y'.repeat(500) })
  assert.equal(result.entry.text.length, 500, 'maxMemoryChars 0 must disable the ceiling')
  checks.push('the ceiling can be disabled')
}

// 5. Tag filtering is exact, not a substring match. `dsh` must not also select
//    `dsh-foo`, because silently widening a filter is how a short list becomes
//    long again.
{
  const tagged = new MemoryEngine({ root: path.join(root, 'tags') })
  await tagged.remember({ scope: 'workspace', cwd, text: '第一条带 dsh 标签的记忆', tags: ['dsh'] })
  await tagged.remember({ scope: 'workspace', cwd, text: '第二条带 dsh-foo 标签的记忆', tags: ['dsh-foo'] })
  await tagged.remember({ scope: 'workspace', cwd, text: '第三条没有标签的记忆', tags: [] })

  const onlyDsh = await tagged.list({ cwd, tag: 'dsh' })
  assert.equal(onlyDsh.length, 1, `tag filter must be exact, got ${onlyDsh.length}`)
  assert.equal(onlyDsh[0].text.includes('第一条'), true)
  checks.push('tag filtering is exact, not a substring match')
}

// 6. Tag matching ignores case and surrounding space, because tags arrive from
//    model output and hand entry alike.
{
  const tagged = new MemoryEngine({ root: path.join(root, 'tags') })
  const rows = await tagged.list({ cwd, tag: '  DSH  ' })
  assert.equal(rows.length, 1, 'tag matching must be case- and space-insensitive')
  checks.push('tag matching ignores case and surrounding space')
}

// 7. Time filtering keeps recent entries and drops old ones, using the newer of
//    creation and last access — an old fact that keeps being recalled is current.
{
  const timed = new MemoryEngine({ root: path.join(root, 'time') })
  const old = await timed.remember({ scope: 'workspace', cwd, text: '很久以前的一条记忆' })
  const fresh = await timed.remember({ scope: 'workspace', cwd, text: '刚刚写入的一条记忆' })

  // Backdate the old one on disk.
  const storeFile = path.join(root, 'time', 'memory', 'workspaces', `${timed.constructor.workspaceKey(cwd)}.json`)
  const store = JSON.parse(await fs.readFile(storeFile, 'utf8'))
  const target = store.entries.find(entry => entry.id === old.entry.id)
  target.createdAt = Date.now() - 90 * 86400000
  target.lastAccessAt = Date.now() - 90 * 86400000
  await fs.writeFile(storeFile, JSON.stringify(store), 'utf8')

  const recent = await timed.list({ cwd, sinceDays: 30 })
  assert.equal(recent.length, 1, `only the recent entry must survive, got ${recent.length}`)
  assert.equal(recent[0].id, fresh.entry.id)
  checks.push('time filtering keeps recent entries and drops old ones')
}

// 8. A recently-touched old entry counts as recent: recency means use, not age.
{
  const timed = new MemoryEngine({ root: path.join(root, 'time') })
  const storeFile = path.join(root, 'time', 'memory', 'workspaces', `${timed.constructor.workspaceKey(cwd)}.json`)
  const store = JSON.parse(await fs.readFile(storeFile, 'utf8'))
  const target = store.entries.find(entry => entry.text === '很久以前的一条记忆')
  target.createdAt = Date.now() - 90 * 86400000
  target.lastAccessAt = Date.now() - 2 * 86400000 // recalled recently
  await fs.writeFile(storeFile, JSON.stringify(store), 'utf8')

  const recent = await timed.list({ cwd, sinceDays: 30 })
  assert.equal(recent.length, 2, 'an old memory recalled recently is still current')
  checks.push('a recently recalled old entry counts as recent')
}

// 9. No filter means everything, so the default view is unchanged.
{
  const all = await engine.list({ cwd })
  assert.equal(all.length, 1, 'an unfiltered list must return everything')
  checks.push('no filter returns everything')
}

// 10. Both filters combine as AND.
{
  const both = new MemoryEngine({ root: path.join(root, 'tags') })
  const rows = await both.list({ cwd, tag: 'dsh', sinceDays: 1 })
  assert.equal(rows.length, 1, 'a tag plus a time window is an AND, not an OR')
  const none = await both.list({ cwd, tag: 'missing-tag', sinceDays: 1 })
  assert.equal(none.length, 0)
  checks.push('tag and time filters combine as AND')
}

await fs.rm(root, { recursive: true, force: true })
console.log(checks.map((line, index) => `  ${index + 1}. ${line}`).join('\n'))
console.log(`\n${checks.length}/${checks.length} checks passed`)
