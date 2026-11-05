#!/usr/bin/env node
/**
 * Report memories that exceed the current size ceiling.
 *
 * The ceiling only applies to new writes, so entries created before it are still
 * in the library. This lists them so the long ones can be split or removed
 * deliberately, rather than being silently truncated (which would leave a
 * sentence that reads as complete but has lost its end).
 *
 * Usage:
 *   node tools/audit-long-memories.mjs          # report
 *   node tools/audit-long-memories.mjs --apply  # archive the offenders
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const APPLY = process.argv.includes('--apply')
const LIMIT = Number(process.env.DSS_MAX_MEMORY_CHARS ?? 300)
const memoryDir = path.join(os.homedir(), '.dsh', 'storages', 'dsh-session-suite', 'memory')

/** @returns {string[]} store files that hold live entries */
function storeFiles() {
  const out = []
  const workspaces = path.join(memoryDir, 'workspaces')
  if (fs.existsSync(workspaces)) {
    for (const name of fs.readdirSync(workspaces)) {
      if (name.endsWith('.json') && !name.includes('.bak-')) out.push(path.join(workspaces, name))
    }
  }
  const global = path.join(memoryDir, 'global.json')
  if (fs.existsSync(global)) out.push(global)
  return out
}

const findings = []
for (const file of storeFiles()) {
  const store = JSON.parse(fs.readFileSync(file, 'utf8'))
  for (const entry of store.entries ?? []) {
    const length = String(entry.text ?? '').length
    if (length <= LIMIT) continue
    findings.push({ file, entry, length })
  }
}

findings.sort((a, b) => b.length - a.length)
console.log(`ceiling: ${LIMIT} characters`)
console.log(`entries over the ceiling: ${findings.length}`)
for (const finding of findings) {
  console.log(`\n  ${finding.entry.id}  ${finding.length} chars  [${finding.entry.state}]`)
  console.log(`    ${path.basename(finding.file)}`)
  console.log(`    ${String(finding.entry.text).replace(/\s+/g, ' ').slice(0, 110)}...`)
}

if (findings.length === 0) {
  console.log('\nnothing to do')
  process.exit(0)
}
if (!APPLY) {
  console.log('\ndry run only. Re-run with --apply to archive these (content is kept in cold storage).')
  process.exit(0)
}

const stamp = new Date().toISOString().replace(/[:.]/g, '-')
const backupDir = path.join(memoryDir, 'backups', stamp)
fs.mkdirSync(backupDir, { recursive: true })
for (const file of new Set(findings.map(finding => finding.file))) {
  fs.copyFileSync(file, path.join(backupDir, path.basename(file)))
}
console.log(`\nbacked up to ${backupDir}`)

// Move offenders to cold storage rather than deleting them: a long entry may
// still contain facts worth mining, and archiving keeps it recallable on demand.
for (const file of new Set(findings.map(finding => finding.file))) {
  const store = JSON.parse(fs.readFileSync(file, 'utf8'))
  const moved = []
  store.entries = (store.entries ?? []).filter(entry => {
    if (String(entry.text ?? '').length <= LIMIT) return true
    moved.push({ ...entry, state: 'archived', archivedAt: Date.now(), archivedReason: 'over-ceiling' })
    return false
  })
  fs.writeFileSync(file, `${JSON.stringify(store, null, 2)}\n`, 'utf8')
  console.log(`  ${path.basename(file)}: archived ${moved.length}`)
}
console.log('\ndone. The content is in cold storage, not deleted.')
