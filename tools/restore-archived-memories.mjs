#!/usr/bin/env node
/**
 * Restore memories that were archived by an over-aggressive size audit.
 *
 * The audit used the memory ceiling (300 chars) as its threshold, which is
 * correct for *refusing new writes* but wrong for *retroactively archiving*
 * existing ones: entries of 400-800 characters are legitimate technical memories
 * that happen to predate the ceiling. Only genuinely document-sized entries
 * should be moved. This puts everything else back.
 *
 * Usage:
 *   node tools/restore-archived-memories.mjs <backup-dir>          # dry run
 *   node tools/restore-archived-memories.mjs <backup-dir> --apply  # restore
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const APPLY = process.argv.includes('--apply')
const backupArg = process.argv.find(arg => !arg.startsWith('--') && arg.endsWith('/')) ?? process.argv[2]
const memoryDir = path.join(os.homedir(), '.dsh', 'storages', 'dsh-session-suite', 'memory')
const workspacesDir = path.join(memoryDir, 'workspaces')

const backupDir = backupArg && fs.existsSync(backupArg) ? backupArg : path.join(memoryDir, 'backups')
if (!fs.existsSync(backupDir)) {
  console.log(`no backup directory at ${backupDir}`)
  process.exit(1)
}

// The newest backup directory wins.
const entries = fs.readdirSync(backupDir, { withFileTypes: true })
const candidates = entries.filter(entry => entry.isDirectory()).map(entry => entry.name).sort()
const latest = candidates[candidates.length - 1]
const chosen = latest ? path.join(backupDir, latest) : backupDir
console.log(`using backup: ${chosen}`)

// Threshold that should have been used: only genuinely document-sized entries.
const DOCUMENT_THRESHOLD = 1000

let restored = 0
let leftAlone = 0

for (const name of fs.readdirSync(chosen)) {
  if (!name.endsWith('.json')) continue
  const backupFile = path.join(chosen, name)
  const liveFile = fs.existsSync(path.join(workspacesDir, name))
    ? path.join(workspacesDir, name)
    : path.join(memoryDir, name)
  if (!fs.existsSync(liveFile)) {
    console.log(`  skip ${name}: live store not found`)
    continue
  }

  const backup = JSON.parse(fs.readFileSync(backupFile, 'utf8'))
  const live = JSON.parse(fs.readFileSync(liveFile, 'utf8'))
  const liveIds = new Set((live.entries ?? []).map(entry => entry.id))

  for (const entry of backup.entries ?? []) {
    if (liveIds.has(entry.id)) continue
    const length = String(entry.text ?? '').length
    if (length > DOCUMENT_THRESHOLD) {
      leftAlone += 1
      console.log(`  leave archived (${length} chars): ${entry.id}`)
      continue
    }
    live.entries.push(entry)
    restored += 1
  }
  if (APPLY) fs.writeFileSync(liveFile, `${JSON.stringify(live, null, 2)}\n`, 'utf8')
}

console.log(`\nwould restore: ${restored}`)
console.log(`left archived (over ${DOCUMENT_THRESHOLD} chars): ${leftAlone}`)
if (!APPLY) {
  console.log('\ndry run only; re-run with --apply to restore')
} else {
  console.log('\nrestored. Long documents stay in cold storage.')
}
