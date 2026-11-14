/**
 * Clear the one genuine orphan: a session id that has NO log on disk but is
 * still carried by the registry as an archive mark and as a workspace entry
 * point, plus a leftover projection cache.
 *
 * This is the "deleted session came back" shape: the files were removed, but the
 * id survived in `archivedSessionIds` and in `tables.workspaces[*].sessionIds`,
 * so co-installed plugins can still resolve and re-display it, and the workspace
 * advertises an entry point that opens nothing.
 *
 * Uses the plugin's own `purgeRegistryGhosts` (the same code path the panel uses)
 * plus `sweepGhostCaches`, so this is not a bespoke registry edit.
 *
 * Dry run by default; `--apply` writes.
 */
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { purgeRegistryGhosts, sweepGhostCaches, liveSessionIds, allRegistrySessionIds } from '../lib/cleanup.js'

const home = process.env.DSH_HOME ?? path.join(os.homedir(), '.dsh')
const apply = process.argv.includes('--apply')
const regFile = path.join(home, 'storages', 'workspace.json')

const registry = JSON.parse(await fs.readFile(regFile, 'utf8'))
const allIds = allRegistrySessionIds(registry)
const live = await liveSessionIds(home)
const dead = allIds.filter(id => !live.has(id))

console.log(`mode:        ${apply ? 'APPLY' : 'dry run'}`)
console.log(`registry ids: ${allIds.length}`)
console.log(`live (have a log): ${live.size}`)
console.log(`dead (no log):     ${dead.length}`)
for (const id of dead) {
  const inArchived = (registry.global?.archivedSessionIds ?? []).includes(id)
  const inWorkspace = Object.values(registry.tables?.workspaces ?? {}).some(r => (r.sessionIds ?? []).includes(id))
  const cache = await fs.stat(path.join(home, 'storages', 'session_projcache', 'sessions', `${id}.json`)).then(s => s.size, () => 0)
  console.log(`  ${id}`)
  console.log(`    archived mark: ${inArchived}   workspace entry: ${inWorkspace}   cache: ${cache} B`)
}

if (dead.length === 0) {
  console.log('\nnothing to clear')
  process.exit(0)
}

// Safety: never let this empty a workspace's entry list, and never touch an id
// that still owns a log.
for (const [wsId, row] of Object.entries(registry.tables?.workspaces ?? {})) {
  const ids = row?.sessionIds ?? []
  const survivors = ids.filter(id => !dead.includes(id))
  if (ids.length > 0 && survivors.length === 0) {
    console.log(`\nREFUSING: workspace "${row.title}" would be left with no session ids`)
    process.exit(2)
  }
}

const ghosts = await purgeRegistryGhosts(home, { apply })
console.log(`\nregistry: deadIds=${ghosts.deadIds.length} applied=${ghosts.applied}`)
console.log(`  changes: ${JSON.stringify(ghosts.changes)}`)

const caches = await sweepGhostCaches(home, { apply })
console.log(`caches:   orphans=${caches.orphans.length} removed=${caches.removed.length} freed=${caches.bytes} B`)
for (const id of caches.orphans) console.log(`  ${apply && caches.removed.includes(id) ? 'removed' : 'orphan '} ${id}`)

if (apply) {
  const after = JSON.parse(await fs.readFile(regFile, 'utf8'))
  console.log(`\nmarks now: ${(after.global?.archivedSessionIds ?? []).length}`)
  for (const id of after.global?.archivedSessionIds ?? []) console.log(`  ${id}`)
  console.log('workspace entry ids now:')
  for (const row of Object.values(after.tables?.workspaces ?? {})) {
    console.log(`  ${row.title}: ${(row.sessionIds ?? []).length} id(s)`)
  }
} else {
  console.log('\n(dry run — pass --apply to write)')
}
