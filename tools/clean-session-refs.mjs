/**
 * Clean up references left behind by earlier deletions.
 *
 * Inventory found:
 *   • 30 archivedSessionIds in the workspace registry, 28 naming sessions with no
 *     file on disk. deleteSession now unarchives as its last step, so these predate
 *     that fix.
 *   • workspace sessionIds lists holding ids with no log: 3 in Radiate Budding, 1 in
 *     DSH Optimize.
 *
 * Both are harmless to look at but harmful in effect: a co-installed plugin that
 * reads the registry can still resolve a ghost id, which is the "deleted session
 * came back" report.
 *
 * Usage:
 *   node tools/clean-session-refs.mjs            # dry run
 *   node tools/clean-session-refs.mjs --apply    # back up, then clean
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const APPLY = process.argv.includes('--apply')
const home = path.join(os.homedir(), '.dsh')
const sessionsRoot = path.join(home, 'sessions')
const registryFile = path.join(home, 'storages', 'workspace.json')

// Every session id that still has a log on disk.
const live = new Set()
for (const ws of fs.readdirSync(sessionsRoot)) {
  const dir = path.join(sessionsRoot, ws)
  if (!fs.statSync(dir).isDirectory()) continue
  for (const sid of fs.readdirSync(dir)) {
    if (fs.existsSync(path.join(dir, sid, 'session.v4.jsonl.zstd'))) live.add(sid)
  }
}
console.log(`live sessions: ${live.size}`)

const registry = JSON.parse(fs.readFileSync(registryFile, 'utf8'))
const archived = registry.global?.archivedSessionIds ?? []
const ghostMarks = archived.filter(id => !live.has(id))
console.log(`\narchive marks: ${archived.length}, ghosts: ${ghostMarks.length}`)

const deadRefs = []
for (const [wsId, ws] of Object.entries(registry.tables?.workspaces ?? {})) {
  for (const sid of ws.sessionIds ?? []) {
    if (!live.has(sid)) deadRefs.push({ wsId, ws, sid })
  }
}
console.log(`workspace sessionIds with no log: ${deadRefs.length}`)
for (const ref of deadRefs) console.log(`  ${ref.ws.path}: ${ref.sid}`)

if (!APPLY) {
  console.log('\ndry run only; re-run with --apply to clean')
  process.exit(0)
}

const stamp = new Date().toISOString().replace(/[:.]/g, '-')
const backup = path.join(home, 'storages', 'dsh-session-suite', 'backups', stamp)
fs.mkdirSync(backup, { recursive: true })
fs.copyFileSync(registryFile, path.join(backup, 'workspace.json'))
console.log(`\nbacked up registry to ${backup}`)

registry.global.archivedSessionIds = archived.filter(id => live.has(id))
for (const ref of deadRefs) {
  const ws = registry.tables.workspaces[ref.wsId]
  ws.sessionIds = ws.sessionIds.filter(sid => sid !== ref.sid)
}
fs.writeFileSync(registryFile, `${JSON.stringify(registry, null, 2)}\n`, 'utf8')
console.log(`archive marks: ${archived.length} -> ${registry.global.archivedSessionIds.length}`)
console.log('done')
