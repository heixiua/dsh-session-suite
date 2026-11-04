/**
 * Integration tests for fact keys: the engine's write and read paths.
 *
 * The unit tests in selftest-factkeys.mjs cover the pure module. These cover the
 * wiring, which is where a correct module still causes damage — storing a key
 * that should have been rejected, superseding on a keyless write, recalling a
 * fact alongside its own replacement, or forking a second record when a fact is
 * restated.
 *
 * Usage: node tools/selftest-factkey-integration.mjs
 */

import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { MemoryEngine } from '../lib/memory-engine.js'

const checks = []
const root = await fs.mkdtemp(path.join(os.tmpdir(), 'factkey-'))
const cwd = path.join(root, 'ws')
await fs.mkdir(cwd, { recursive: true })
const engine = new MemoryEngine({ root })

/** @param {string} id @returns {Promise<any | undefined>} stored entry */
const find = async id => (await engine.list({ cwd })).find(entry => entry.id === id)

// 1. A well-formed key is canonicalised and stored.
{
  const { entry } = await engine.remember({
    scope: 'workspace',
    cwd,
    text: '她的身高是一米七',
    factKey: '  她 ． 身高  ',
  })
  assert.equal(entry.factKey, '她.身高', `key must be canonicalised, got ${JSON.stringify(entry.factKey)}`)
  checks.push('a fact key is canonicalised before it is stored')
}

// 2. A catch-all key is refused, and refusing must not fail the write. The
//    entry simply opts out of supersession.
{
  const { entry } = await engine.remember({ scope: 'workspace', cwd, text: '这是一条没有具体主题的记录', factKey: '信息.内容' })
  assert.equal(entry.factKey, null, 'a catch-all key must not be stored')
  assert.equal((await find(entry.id)) !== undefined, true, 'the entry itself must still be stored')
  const single = await engine.remember({ scope: 'workspace', cwd, text: '另外一个只有单段键的记录', factKey: '身高' })
  assert.equal(single.entry.factKey, null, 'a single-segment key must not be stored')
  checks.push('a catch-all or single-segment key is refused without losing the memory')
}

// 3. The core behaviour: a newer entry on the same key supersedes the older one,
//    and recall stops offering the old value.
{
  const older = (await engine.list({ cwd })).find(entry => entry.factKey === '她.身高')
  const { entry: newer } = await engine.remember({ scope: 'workspace', cwd, text: '现在身高已经变成一米八了', factKey: '她.身高' })

  const afterOld = await find(older.id)
  assert.equal(afterOld.supersededBy, newer.id, 'the older entry must point at its replacement')
  assert.equal(afterOld.supersededBy !== undefined, true, 'the superseded entry must keep the replacement id')
  const afterNew = await find(newer.id)
  assert.equal(afterNew.supersededBy, undefined, 'the newest entry must not itself be superseded')

  const recalled = await engine.recall({ cwd, query: '她身高多少', limit: 500, touch: false })
  const recalledIds = recalled.map(item => item.id)
  assert.equal(recalledIds.includes(older.id), false, 'the superseded value must not be recalled')
  assert.equal(recalledIds.includes(newer.id), true, 'the current value must be recallable')
  checks.push('a newer entry on the same key supersedes the older one at recall time')
}

// 4. History survives. Supersession must hide, not delete — the settings page
//    shows what a fact used to say.
{
  const listed = await engine.list({ cwd })
  const superseded = listed.filter(entry => entry.supersededBy)
  assert.equal(superseded.length >= 1, true, 'the superseded entry must still be listed')
  assert.equal(
    superseded.some(entry => String(entry.text).includes('一米七')),
    true,
    'the superseded text must still be readable',
  )
  checks.push('supersession hides the old value without deleting it')
}

// 5. A keyless write must never retire anything. Getting this wrong would let an
//    unrelated memory silently retire a keyed one.
{
  // Pick the *live* entry for that key: list() returns store order, so a naive
  // find() lands on the already-superseded record and the assertion would then
  // be testing nothing.
  const keyed = (await engine.list({ cwd })).find(entry => entry.factKey === '她.身高' && !entry.supersededBy)
  assert.equal(keyed !== undefined, true, 'there must be a live entry for the key')
  await engine.remember({ scope: 'workspace', cwd, text: '一条完全不相关的新记忆', factKey: undefined })
  const stillLive = await find(keyed.id)
  assert.equal(stillLive.supersededBy, undefined, 'a keyless write must not supersede a keyed entry')
  checks.push('a keyless write supersedes nothing')
}

// 6. Restating a superseded fact revives it instead of forking a second record.
//    The id is derived from the text, so a fresh insert would collide — this is
//    the case where "just insert again" is not available.
{
  const superseded = (await engine.list({ cwd })).find(entry => entry.supersededBy && String(entry.text).includes('一米七'))
  const before = (await engine.list({ cwd })).length
  const result = await engine.remember({ scope: 'workspace', cwd, text: superseded.text, factKey: '她.身高' })

  assert.equal(result.duplicateOf !== undefined, true, 'restating the same text must reinforce')
  const after = await engine.list({ cwd })
  assert.equal(after.length, before, 'restating must not add a record')
  assert.equal(
    after.filter(entry => entry.text === superseded.text).length,
    1,
    'restating must not fork a duplicate id',
  )
  const revived = after.find(entry => entry.id === superseded.id)
  assert.equal(revived.supersededBy, undefined, 'the restated entry must be revived')
  checks.push('restating a superseded fact revives that record instead of forking')
}

// 7. Entries written before fact keys existed keep working: absent key, no
//    supersession, fully recallable.
{
  const root2 = await fs.mkdtemp(path.join(os.tmpdir(), 'factkey-legacy-'))
  const cwd2 = path.join(root2, 'ws')
  await fs.mkdir(cwd2, { recursive: true })
  const legacy = new MemoryEngine({ root: root2 })
  const { entry } = await legacy.remember({ scope: 'workspace', cwd: cwd2, text: '一条老格式的记忆没有任何键' })
  assert.equal(entry.factKey, null, 'a missing key must be stored as null')
  const rows = await legacy.recall({ cwd: cwd2, query: '老格式记忆', limit: 10, touch: false })
  assert.equal(rows.some(row => row.id === entry.id), true, 'a keyless entry must still be recallable')
  await fs.rm(root2, { recursive: true, force: true })
  checks.push('keyless entries behave exactly as before')
}

await fs.rm(root, { recursive: true, force: true })
console.log(checks.map((line, index) => `  ${index + 1}. ${line}`).join('\n'))
console.log(`\n${checks.length}/${checks.length} checks passed`)
