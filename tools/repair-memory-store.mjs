#!/usr/bin/env node
/**
 * Repair a memory store poisoned by the explicit-write self-trigger bug.
 *
 * Background: the explicit-write scan used to read every `role === 'user'`
 * message without checking `source.kind`. Harness pipeline messages carry that
 * role, and this plugin's own injected instruction footer — which contains the
 * literal example `【记住：…】` — is delivered inside one, so the plugin obeyed
 * itself and stored a memory whose entire body was "…". It did that 154 times,
 * and because punctuation-only text shingles to the empty set, the duplicate
 * check could not collapse the repeats, leaving 27 identical records.
 *
 * Real memories were not overwritten — the write path never rewrites text — so
 * they are recoverable from any pre-poisoning snapshot, including the atomic
 * write's leftover `.tmp` file.
 *
 * Usage:
 *   node tools/repair-memory-store.mjs           # dry run, reports the plan
 *   node tools/repair-memory-store.mjs --apply   # back up, then repair
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const APPLY = process.argv.includes('--apply')
const memoryDir = path.join(os.homedir(), '.dsh', 'storages', 'dsh-session-suite', 'memory')
const WORKSPACE = 'workspaces/7eccd40cf0eba35a.json'

/** @param {string} text @returns {boolean} whether the body is a real memory */
const isReal = text => String(text ?? '').trim().length > 2

/**
 * @param {string} rel store path relative to the memory dir
 * @returns {any[]} its entries, or [] when unreadable
 */
function readEntries(rel) {
  const file = path.join(memoryDir, rel)
  if (!fs.existsSync(file)) return []
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')).entries ?? []
  } catch {
    return []
  }
}

/**
 * Merge entry lists by id, keeping the record seen last for any id. Real text
 * always wins over a poisoned record of the same id.
 *
 * @param {any[][]} lists entry lists, oldest first
 * @returns {any[]} merged entries sorted by creation time
 */
function merge(lists) {
  const byId = new Map()
  for (const list of lists) {
    for (const entry of list) {
      const previous = byId.get(entry.id)
      if (previous && isReal(previous.text) && !isReal(entry.text)) continue
      byId.set(entry.id, entry)
    }
  }
  return [...byId.values()].sort((a, b) => (a.createdAt ?? 0) - (b.createdAt ?? 0))
}

// The leftover atomic-write `.tmp` from 15:21 is the last pre-poisoning view of
// the live store, so it is the authoritative source: it already reflects
// whatever the maintenance pass had archived by then. Re-merging the older
// 11-02 backup would resurrect entries that maintenance deliberately moved to
// cold storage, which would duplicate the cold copy and silently undo a normal
// lifecycle transition. The backup is therefore kept only as a safety copy, and
// its ids that are absent from the `.tmp` are reported so the difference is
// visible rather than silent.
const recoveryBackup = readEntries(`${WORKSPACE}.bak-1793592395555`)
const live = readEntries(WORKSPACE)
const fromTmp = readEntries(`${WORKSPACE}.23596.1793805661249.tmp`)

const tmpIds = new Set(fromTmp.map(entry => entry.id))
const onlyInBackup = recoveryBackup.filter(entry => !tmpIds.has(entry.id))
if (onlyInBackup.length > 0) {
  console.log('ids present in the 11-02 backup but not in the 15:21 snapshot')
  console.log('(these were archived by a maintenance pass; left in cold storage)')
  for (const entry of onlyInBackup) {
    console.log(`    ${entry.id} [${entry.state}] ${String(entry.text).replace(/\s+/g, ' ').slice(0, 60)}`)
  }
  console.log('')
}

const mergedWorkspace = merge([fromTmp, live]).filter(entry => isReal(entry.text))

const globalLive = readEntries('global.json')
const mergedGlobal = merge([globalLive]).filter(entry => isReal(entry.text))

console.log('recovery plan')
console.log(`  sources: tmp=${fromTmp.length} live=${live.length} (backup=${recoveryBackup.length} kept as safety copy)`)
console.log(`  workspace  ${live.length} -> ${mergedWorkspace.length} entries`)
console.log(`  global     ${globalLive.length} -> ${mergedGlobal.length} entries`)
const dropped = [...live, ...globalLive].filter(entry => !isReal(entry.text))
console.log(`  poisoned records removed: ${dropped.length}`)
console.log(`  dropped ids: ${dropped.map(entry => entry.id).join(', ')}`)

if (!APPLY) {
  console.log('\ndry run only; re-run with --apply to write')
  process.exit(0)
}

const stamp = new Date().toISOString().replace(/[:.]/g, '-')
const backupDir = path.join(memoryDir, 'backups', stamp)
fs.mkdirSync(backupDir, { recursive: true })
for (const rel of [WORKSPACE, 'global.json', `${WORKSPACE}.23596.1793805661249.tmp`]) {
  const file = path.join(memoryDir, rel)
  if (fs.existsSync(file)) fs.copyFileSync(file, path.join(backupDir, path.basename(rel)))
}
console.log(`\nbacked up to ${backupDir}`)

const writeStore = (rel, entries) => {
  const file = path.join(memoryDir, rel)
  const parsed = JSON.parse(fs.readFileSync(file, 'utf8'))
  parsed.entries = entries
  fs.writeFileSync(file, `${JSON.stringify(parsed, null, 2)}\n`, 'utf8')
}
writeStore(WORKSPACE, mergedWorkspace)
writeStore('global.json', mergedGlobal)

// The leftover atomic-write temp files are dead weight and, more importantly,
// a second copy of the corrupted state. Remove them now that they are backed up.
for (const name of fs.readdirSync(path.join(memoryDir))) {
  if (/\.json\.\d+\.\d+\.tmp$/.test(name)) {
    fs.rmSync(path.join(memoryDir, name), { force: true })
    console.log(`removed stray temp file ${name}`)
  }
}
for (const name of fs.readdirSync(path.join(memoryDir, 'workspaces'))) {
  if (/\.json\.\d+\.\d+\.tmp$/.test(name)) {
    fs.rmSync(path.join(memoryDir, 'workspaces', name), { force: true })
    console.log(`removed stray temp file workspaces/${name}`)
  }
}

console.log('\nrepaired. verify with: node tools/_recovery-inventory.mjs')
