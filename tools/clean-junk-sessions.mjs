#!/usr/bin/env node
/**
 * Remove test/junk sessions and everything keyed to them.
 *
 * A junk session is one created by a "hello"/empty test: a handful of events,
 * no real conversation. Everything that names its id must go — session log,
 * projection cache row, this bundle's snapshot directory, per-session memory,
 * workspace registry membership, and archive marks. That last point is the one
 * that has bitten us before: deleting only the files leaves an id behind that a
 * co-installed plugin can still resolve and display.
 *
 * Usage:
 *   node tools/clean-junk-sessions.mjs           # dry run, prints the plan
 *   node tools/clean-junk-sessions.mjs --apply   # back up, then remove
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const APPLY = process.argv.includes('--apply')
const home = path.join(os.homedir(), '.dsh')
const sessionsRoot = path.join(home, 'sessions')
const projRoot = path.join(home, 'storages', 'session_projcache', 'sessions')
const snapRoot = path.join(home, 'storages', 'dsh-session-suite', 'sessions')
const registryFile = path.join(home, 'storages', 'workspace.json')
const memoryDir = path.join(home, 'storages', 'dsh-session-suite', 'memory')

// Explicit allowlist: only ids we have inspected and classified as junk. An
// automatic "short session" rule would risk deleting a real conversation that
// happens to be short (the "你好" greeting sessions are exactly that risk, so
// they are listed here deliberately rather than inferred).
const JUNK = [
  'session-5eea91e9-1ae7-4c0d-9496-8f6f6d82c3a0', // 4 events, no prompt
  'session-db2ee5f0-06b3-4ff1-9057-0ae3f0d6c9d1', // 4 events, no prompt
  'session-b49fc75d-528d-469c-acfb-806f77e6110f',  // "你好"
  'session-6f3414f1-5ba9-431a-be5e-c9df1f1fcb87',  // "你好，你是什么模型？"
  '063a013f-a162-439b-9739-66631b02f069',          // failed subagent, 0 replies
]

console.log(`junk sessions: ${JUNK.length}`)

const plan = []
for (const id of JUNK) {
  const entry = { id, paths: [], found: false }
  // Where is the session log?
  for (const ws of fs.readdirSync(sessionsRoot)) {
    const dir = path.join(sessionsRoot, ws, id)
    if (fs.existsSync(dir)) {
      entry.paths.push(dir)
      entry.found = true
    }
  }
  const cache = path.join(projRoot, `${id}.json`)
  if (fs.existsSync(cache)) entry.paths.push(cache)
  const snap = path.join(snapRoot, id)
  if (fs.existsSync(snap)) entry.paths.push(snap)
  for (const dir of [memoryDir, path.join(memoryDir, 'workspaces'), path.join(memoryDir, 'cold')]) {
    if (!fs.existsSync(dir)) continue
    for (const name of fs.readdirSync(dir)) {
      if (name.includes(id)) entry.paths.push(path.join(dir, name))
    }
  }
  plan.push(entry)
  console.log(`\n  ${id}  ${entry.found ? 'log found' : 'no log'}`)
  for (const p of entry.paths) console.log(`     ${p.replace(home, '~')}`)
}

// Registry changes are reported, not done silently.
const registry = JSON.parse(fs.readFileSync(registryFile, 'utf8'))
const archivedBefore = (registry.global?.archivedSessionIds ?? []).length
const registryHits = []
for (const [wsId, ws] of Object.entries(registry.tables?.workspaces ?? {})) {
  const kept = (ws.sessionIds ?? []).filter(sid => !JUNK.includes(sid))
  const removed = (ws.sessionIds ?? []).filter(sid => JUNK.includes(sid))
  if (removed.length) registryHits.push({ wsId, ws, kept, removed })
}
console.log(`\nregistry: ${registryHits.length} workspace(s) reference junk ids`)
for (const hit of registryHits) console.log(`  ${hit.wsId}: remove ${hit.removed.join(', ')}`)
console.log(`archive marks before: ${archivedBefore}`)

if (!APPLY) {
  console.log('\ndry run only; re-run with --apply to remove')
  process.exit(0)
}

const stamp = new Date().toISOString().replace(/[:.]/g, '-')
const backupDir = path.join(home, 'storages', 'dsh-session-suite', 'backups', stamp)
fs.mkdirSync(backupDir, { recursive: true })
fs.copyFileSync(registryFile, path.join(backupDir, 'workspace.json'))
console.log(`\nbacked up registry to ${backupDir}`)

for (const entry of plan) {
  for (const p of entry.paths) {
    try {
      fs.rmSync(p, { recursive: true, force: true })
      console.log(`  removed ${p.replace(home, '~')}`)
    } catch (error) {
      console.log(`  FAILED ${p.replace(home, '~')}: ${error.message}`)
    }
  }
}

for (const hit of registryHits) registry.tables.workspaces[hit.wsId].sessionIds = hit.kept
registry.global.archivedSessionIds = (registry.global.archivedSessionIds ?? []).filter(sid => !JUNK.includes(sid))
registry.global.pinnedSessionIds = (registry.global.pinnedSessionIds ?? []).filter(sid => !JUNK.includes(sid))
fs.writeFileSync(registryFile, `${JSON.stringify(registry, null, 2)}\n`, 'utf8')
console.log(`\nregistry rewritten: ${archivedBefore} -> ${registry.global.archivedSessionIds.length} archive marks`)
console.log('done')
