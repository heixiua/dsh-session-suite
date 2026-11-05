#!/usr/bin/env node
/**
 * Normalise the tags already stored, using the same vocabulary the write path
 * now applies. Without this, the fix only affects new memories and the existing
 * library keeps its `dsh` / `DSH` split and its UI-word tags.
 *
 * Entries whose tags all get dropped keep an empty list rather than being
 * deleted — an untagged memory is still a memory, and losing content to tidy a
 * label would be a bad trade.
 *
 * Usage:
 *   node tools/normalize-stored-tags.mjs           # dry run
 *   node tools/normalize-stored-tags.mjs --apply   # back up, then rewrite
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { normalizeTags } from '../lib/tags.js'

const APPLY = process.argv.includes('--apply')
const root = path.join(os.homedir(), '.dsh', 'storages', 'dsh-session-suite', 'memory')

const files = []
const wsDir = path.join(root, 'workspaces')
if (fs.existsSync(wsDir)) {
  for (const name of fs.readdirSync(wsDir)) {
    if (name.endsWith('.json') && !name.includes('.bak-')) files.push(path.join(wsDir, name))
  }
}
const globalFile = path.join(root, 'global.json')
if (fs.existsSync(globalFile)) files.push(globalFile)

const changes = []
for (const file of files) {
  const store = JSON.parse(fs.readFileSync(file, 'utf8'))
  for (const entry of store.entries ?? []) {
    const before = Array.isArray(entry.tags) ? entry.tags : []
    const after = normalizeTags(before)
    if (JSON.stringify(before) === JSON.stringify(after)) continue
    changes.push({ file, entry, before, after })
  }
}

console.log(`files: ${files.length}`)
console.log(`entries needing change: ${changes.length}`)
for (const change of changes) {
  console.log(`\n  ${change.entry.id}`)
  console.log(`    before: ${JSON.stringify(change.before)}`)
  console.log(`    after : ${JSON.stringify(change.after)}`)
  console.log(`    ${String(change.entry.text).replace(/\s+/g, ' ').slice(0, 70)}`)
}

if (changes.length === 0) {
  console.log('\nnothing to do')
  process.exit(0)
}
if (!APPLY) {
  console.log('\ndry run only; re-run with --apply to rewrite')
  process.exit(0)
}

const stamp = new Date().toISOString().replace(/[:.]/g, '-')
const backupDir = path.join(root, 'backups', stamp)
fs.mkdirSync(backupDir, { recursive: true })
for (const file of new Set(changes.map(change => change.file))) {
  fs.copyFileSync(file, path.join(backupDir, path.basename(file)))
}
console.log(`\nbacked up to ${backupDir}`)

// Apply the changes to the in-memory stores we already parsed, then write each
// file exactly once. Re-reading a file here would discard the edits made above
// — that is the bug the first version of this script shipped with, and it left
// one entry still tagged `DSH` after the pass claimed success.
const storesByFile = new Map()
for (const change of changes) {
  if (!storesByFile.has(change.file)) {
    storesByFile.set(change.file, JSON.parse(fs.readFileSync(change.file, 'utf8')))
  }
  const store = storesByFile.get(change.file)
  const target = (store.entries ?? []).find(entry => entry.id === change.entry.id)
  if (target) target.tags = change.after
}

for (const [file, store] of storesByFile) {
  fs.writeFileSync(file, `${JSON.stringify(store, null, 2)}\n`, 'utf8')
}
console.log(`rewrote ${storesByFile.size} file(s)`)
