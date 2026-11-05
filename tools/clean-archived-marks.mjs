#!/usr/bin/env node
/**
 * Remove archived-session marks whose session no longer exists.
 *
 * An archive mark is meant to hide a session from the sidebar while its files
 * still exist. Once the files are gone the mark is meaningless — worse, it keeps
 * a dead id in the workspace registry, where a co-installed plugin that reads the
 * registry can still resolve it and show a session the user deleted. That is the
 * "deleted session came back" report: the files were removed, the mark survived.
 *
 * The fix in `#purgeSession` stops new ghosts from being created. This cleans up
 * the ones already there.
 *
 * Usage:
 *   node tools/clean-archived-marks.mjs           # dry run
 *   node tools/clean-archived-marks.mjs --apply   # back up, then rewrite
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const APPLY = process.argv.includes('--apply')
const home = path.join(os.homedir(), '.dsh')
const registryFile = path.join(home, 'storages', 'workspace.json')
const sessionsRoot = path.join(home, 'sessions')

if (!fs.existsSync(registryFile)) {
  console.log(`no registry at ${registryFile}`)
  process.exit(0)
}

/** @returns {Set<string>} session ids that still have a log on disk */
function liveSessionIds() {
  const ids = new Set()
  if (!fs.existsSync(sessionsRoot)) return ids
  for (const workspace of fs.readdirSync(sessionsRoot)) {
    const dir = path.join(sessionsRoot, workspace)
    if (!fs.statSync(dir).isDirectory()) continue
    for (const id of fs.readdirSync(dir)) {
      if (fs.existsSync(path.join(dir, id, 'session.v4.jsonl.zstd'))) ids.add(id)
    }
  }
  return ids
}

const parsed = JSON.parse(fs.readFileSync(registryFile, 'utf8'))
const archived = Array.isArray(parsed?.global?.archivedSessionIds) ? parsed.global.archivedSessionIds : []
const live = liveSessionIds()

// Only drop marks for ids with no log at all. A session that is archived but
// still on disk is genuinely archived and must keep its mark.
const ghosts = archived.filter(id => !live.has(id))
const kept = archived.filter(id => live.has(id))

console.log(`archived marks: ${archived.length}`)
console.log(`  still on disk (keep the mark): ${kept.length}`)
console.log(`  no log on disk (remove the mark): ${ghosts.length}`)
for (const id of ghosts) console.log(`    - ${id}`)

if (ghosts.length === 0) {
  console.log('\nnothing to clean')
  process.exit(0)
}
if (!APPLY) {
  console.log('\ndry run only; re-run with --apply to write')
  process.exit(0)
}

const stamp = new Date().toISOString().replace(/[:.]/g, '-')
const backup = `${registryFile}.bak-${stamp}`
fs.copyFileSync(registryFile, backup)
console.log(`\nbacked up to ${backup}`)

parsed.global.archivedSessionIds = kept
fs.writeFileSync(registryFile, `${JSON.stringify(parsed, null, 2)}\n`, 'utf8')
console.log(`removed ${ghosts.length} ghost mark(s); ${kept.length} real archive mark(s) remain`)
