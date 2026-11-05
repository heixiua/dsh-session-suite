#!/usr/bin/env node
/**
 * Remove projection-cache rows and workspace-registry ids that point to
 * sessions with no log on disk.
 *
 * Earlier cleanups deleted session files but left these references. A
 * co-installed plugin that reads the projection cache can still resolve such an
 * id and show a session the user deleted — which is exactly the "deleted
 * session came back" report.
 *
 * Usage:
 *   node tools/clean-orphan-refs.mjs          # dry run
 *   node tools/clean-orphan-refs.mjs --apply  # back up, then remove
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const APPLY = process.argv.includes('--apply')
const home = path.join(os.homedir(), '.dsh')
const sessionsRoot = path.join(home, 'sessions')
const projRoot = path.join(home, 'storages', 'session_projcache', 'sessions')
const registryFile = path.join(home, 'storages', 'workspace.json')

const live = new Set()
for (const ws of fs.readdirSync(sessionsRoot)) {
  const dir = path.join(sessionsRoot, ws)
  if (!fs.statSync(dir).isDirectory()) continue
  for (const sid of fs.readdirSync(dir)) {
    if (fs.existsSync(path.join(dir, sid, 'session.v4.jsonl.zstd'))) live.add(sid)
  }
}

const orphanRows = fs.readdirSync(projRoot)
  .filter(name => name.endsWith('.json'))
  .map(name => ({ name, id: name.replace('.json', '') }))
  .filter(row => !live.has(row.id))
console.log(`orphan projection rows: ${orphanRows.length}`)
for (const row of orphanRows) console.log(`  ${row.name}`)

const registry = JSON.parse(fs.readFileSync(registryFile, 'utf8'))
const deadRefs = []
for (const [wsId, ws] of Object.entries(registry.tables?.workspaces ?? {})) {
  for (const sid of ws.sessionIds ?? []) {
    if (!live.has(sid)) deadRefs.push({ wsId, sid })
  }
}
console.log(`\ndead workspace-registry refs: ${deadRefs.length}`)
for (const ref of deadRefs) console.log(`  ${ref.wsId} -> ${ref.sid}`)

if (!APPLY) {
  console.log('\ndry run only; re-run with --apply to remove')
  process.exit(0)
}

const stamp = new Date().toISOString().replace(/[:.]/g, '-')
const backupDir = path.join(home, 'storages', 'dsh-session-suite', 'backups', stamp)
fs.mkdirSync(backupDir, { recursive: true })
fs.copyFileSync(registryFile, path.join(backupDir, 'workspace.json'))
console.log(`\nbacked up registry to ${backupDir}`)

for (const row of orphanRows) {
  fs.rmSync(path.join(projRoot, row.name), { force: true })
  console.log(`  removed ${row.name}`)
}
for (const ref of deadRefs) {
  const ws = registry.tables.workspaces[ref.wsId]
  ws.sessionIds = ws.sessionIds.filter(sid => sid !== ref.sid)
}
fs.writeFileSync(registryFile, `${JSON.stringify(registry, null, 2)}\n`, 'utf8')
console.log('\ndone')
