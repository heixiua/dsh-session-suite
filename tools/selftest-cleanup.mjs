/**
 * Session-residue cleanup contract tests.
 *
 * Pure registry functions are tested directly; filesystem helpers run against a
 * throwaway temp home so they never touch the real DSH data.
 *
 * Run: node tools/selftest-cleanup.mjs
 */
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {
  liveSessionIds,
  sweepGhostCaches,
  stripSessionFromRegistry,
  stripDeadIdsFromRegistry,
  registrySessionIds,
  purgeRegistryGhosts,
  purgeRegistryId,
} from '../lib/cleanup.js'

let n = 0
const check = async (name, fn) => { await fn(); n++; console.log(`  ok ${n} ${name}`) }

const SAMPLE = () => ({
  unit: { name: 'workspace', version: 2 },
  global: {
    initialized: true,
    workspaceIds: ['w1'],
    archivedSessionIds: ['dead-a', 'live-1', 'dead-b'],
    pinnedSessionIds: ['dead-a'],
  },
  tables: {
    workspaces: {
      w1: { path: 'D:/p', title: 'p', sessionIds: ['live-1', 'dead-b', 'live-2'] },
      w2: { path: 'D:/q', title: 'q', sessionIds: ['live-2'] },
    },
  },
})

await check('stripSessionFromRegistry removes one id from every array', () => {
  const r = SAMPLE()
  const { removed } = stripSessionFromRegistry(r, 'dead-a')
  assert.equal(removed.archived, true)
  assert.equal(removed.pinned, true)
  assert.deepEqual(removed.workspaces, [])
  assert.deepEqual(r.global.archivedSessionIds, ['live-1', 'dead-b'])
  assert.deepEqual(r.global.pinnedSessionIds, [])
})

await check('stripSessionFromRegistry also clears a workspace sessionIds entry', () => {
  const r = SAMPLE()
  const { removed } = stripSessionFromRegistry(r, 'dead-b')
  assert.deepEqual(removed.workspaces, ['w1'])
  assert.deepEqual(r.tables.workspaces.w1.sessionIds, ['live-1', 'live-2'])
  assert.deepEqual(r.global.archivedSessionIds, ['dead-a', 'live-1'])
})

await check('stripSessionFromRegistry is a no-op for an unknown id', () => {
  const r = SAMPLE()
  const before = JSON.stringify(r)
  const { removed } = stripSessionFromRegistry(r, 'nope')
  assert.equal(JSON.stringify(r), before)
  assert.deepEqual(removed, { archived: false, pinned: false, workspaces: [] })
})

await check('stripSessionFromRegistry tolerates missing arrays / malformed input', () => {
  assert.equal(stripSessionFromRegistry(null, 'x').removed.archived, false)
  assert.equal(stripSessionFromRegistry({}, 'x').removed.pinned, false)
  assert.equal(stripSessionFromRegistry({ global: {} }, 'x').removed.archived, false)
})

await check('registrySessionIds collects and de-duplicates all id arrays', () => {
  const ids = registrySessionIds(SAMPLE())
  assert.deepEqual(new Set(ids), new Set(['dead-a', 'live-1', 'dead-b', 'live-2']))
  assert.equal(ids.length, 4)
})

await check('stripDeadIdsFromRegistry removes only dead ids and reports counts', () => {
  const r = SAMPLE()
  const { registry, removedIds, changes } = stripDeadIdsFromRegistry(r, ['dead-a', 'dead-b'])
  assert.deepEqual(registry.global.archivedSessionIds, ['live-1'])
  assert.deepEqual(registry.global.pinnedSessionIds, [])
  assert.deepEqual(registry.tables.workspaces.w1.sessionIds, ['live-1', 'live-2'])
  assert.equal(changes.archived, 2)
  assert.equal(changes.pinned, 1)
  assert.equal(changes.workspaceIds, 1)
  assert.deepEqual(new Set(removedIds), new Set(['dead-a', 'dead-b']))
})

await check('stripDeadIdsFromRegistry leaves live ids untouched', () => {
  const r = SAMPLE()
  stripDeadIdsFromRegistry(r, [])
  assert.deepEqual(r.global.archivedSessionIds, ['dead-a', 'live-1', 'dead-b'])
})

// --- filesystem integration in a temp home ---
const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'dss-cleanup-'))
const home = path.join(tmp, 'home')
const scope = path.join(home, 'sessions', 'proj-a')
const pc = path.join(home, 'storages', 'session_projcache', 'sessions')
await fs.mkdir(path.join(scope, 'live-1'), { recursive: true })
await fs.writeFile(path.join(scope, 'live-1', 'session.v4.jsonl.zstd'), Buffer.from([0x28, 0xb5, 0x2f, 0xfd]))
await fs.mkdir(path.join(scope, 'live-2'), { recursive: true })
await fs.writeFile(path.join(scope, 'live-2', 'session.v3.jsonl'), '{}\n')
await fs.mkdir(pc, { recursive: true })
for (const id of ['live-1', 'live-2', 'ghost-a', 'ghost-b']) {
  await fs.writeFile(path.join(pc, `${id}.json`), `{"id":"${id}"}`)
}
const regFile = path.join(home, 'storages', 'workspace.json')
await fs.mkdir(path.dirname(regFile), { recursive: true })
await fs.writeFile(regFile, `${JSON.stringify(SAMPLE(), null, 2)}\n`)

await check('liveSessionIds finds any session.vN.jsonl[.zstd] log, version-agnostic', async () => {
  const ids = await liveSessionIds(home)
  assert.deepEqual([...ids].sort(), ['live-1', 'live-2'])
})

await check('sweepGhostCaches dry-run lists ghosts without deleting', async () => {
  const r = await sweepGhostCaches(home, { apply: false })
  assert.equal(r.scanned, 4)
  assert.deepEqual(new Set(r.orphans), new Set(['ghost-a', 'ghost-b']))
  assert.equal(r.removed.length, 0)
  assert.equal((await fs.readdir(pc)).length, 4)
})

await check('sweepGhostCaches apply deletes only ghost caches', async () => {
  const r = await sweepGhostCaches(home, { apply: true })
  assert.deepEqual(new Set(r.removed), new Set(['ghost-a', 'ghost-b']))
  assert.ok(r.bytes > 0)
  assert.deepEqual((await fs.readdir(pc)).sort(), ['live-1.json', 'live-2.json'])
})

await check('sweepGhostCaches onlyIds restricts a single delete', async () => {
  await fs.writeFile(path.join(pc, 'ghost-c.json'), '{"id":"ghost-c"}')
  await fs.writeFile(path.join(pc, 'ghost-d.json'), '{"id":"ghost-d"}')
  const r = await sweepGhostCaches(home, { apply: true, onlyIds: ['ghost-c'] })
  assert.deepEqual(r.orphans, ['ghost-c'])
  assert.equal(await fs.stat(path.join(pc, 'ghost-d.json')).then(() => true).catch(() => false), true)
  await fs.rm(path.join(pc, 'ghost-d.json'), { force: true })
})

await check('purgeRegistryGhosts dry-run does not write', async () => {
  const before = await fs.readFile(regFile, 'utf8')
  const r = await purgeRegistryGhosts(home, { apply: false })
  assert.deepEqual(new Set(r.deadIds), new Set(['dead-a', 'dead-b']))
  assert.equal(r.applied, false)
  assert.equal(await fs.readFile(regFile, 'utf8'), before)
})

await check('purgeRegistryGhosts apply strips dead ids but keeps live ones', async () => {
  const r = await purgeRegistryGhosts(home, { apply: true })
  assert.equal(r.applied, true)
  const reg = JSON.parse(await fs.readFile(regFile, 'utf8'))
  assert.deepEqual(reg.global.archivedSessionIds, ['live-1'])
  assert.deepEqual(reg.global.pinnedSessionIds, [])
  assert.deepEqual(reg.tables.workspaces.w1.sessionIds, ['live-1', 'live-2'])
  assert.deepEqual(reg.tables.workspaces.w2.sessionIds, ['live-2'])
})

await check('purgeRegistryId removes a single deleted id atomically', async () => {
  await fs.writeFile(regFile, `${JSON.stringify(SAMPLE(), null, 2)}\n`)
  const r = await purgeRegistryId(home, 'dead-a')
  assert.equal(r.changed, true)
  const reg = JSON.parse(await fs.readFile(regFile, 'utf8'))
  assert.equal(reg.global.archivedSessionIds.includes('dead-a'), false)
  assert.equal(reg.global.archivedSessionIds.includes('live-1'), true)
  const again = await purgeRegistryId(home, 'dead-a')
  assert.equal(again.changed, false)
})

await check('all helpers are no-ops on a missing home', async () => {
  const missing = path.join(tmp, 'nothing-here')
  assert.deepEqual([...(await liveSessionIds(missing))], [])
  assert.deepEqual(await sweepGhostCaches(missing, { apply: true }), { scanned: 0, orphans: [], removed: [], bytes: 0 })
  assert.equal((await purgeRegistryGhosts(missing, { apply: true })).applied, false)
})

await fs.rm(tmp, { recursive: true, force: true })
console.log(`\n${n} checks passed`)
