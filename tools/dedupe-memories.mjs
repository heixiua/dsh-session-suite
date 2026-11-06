/**
 * Merge duplicate memories already in the library.
 *
 * Maintenance used to refill the library with near-identical summaries and rules;
 * the generator is fixed, but the entries it produced are still there. Measured on
 * the user's library: one sentence — the cache-hit-rate conclusion — existed seven
 * times out of 46 entries.
 *
 * Policy:
 *   • never delete. Duplicates are archived to the cold store and tagged with
 *     `mergedInto`, so the history view can still explain what happened;
 *   • keep the most complete survivor per group — the one longest by text, then
 *     the highest score;
 *   • only touch entries the maintenance pass itself created (`kind: 'rule'` or
 *     `summary: true`). A user-written fact is never merged away, because two
 *     facts that look similar may differ in a detail the user cares about.
 *
 * Usage:
 *   node tools/dedupe-memories.mjs            # dry run
 *   node tools/dedupe-memories.mjs --apply    # back up, then merge
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'

const APPLY = process.argv.includes('--apply')
const root = path.join(os.homedir(), '.dsh', 'storages', 'dsh-session-suite', 'memory')

/** @param {string} text @returns {string} stable content key */
function contentKey(text) {
  // Strip the generated prefixes so a rule's framing does not hide that two
  // entries say the same thing.
  const normalized = String(text ?? '')
    .replace(/^规则（[^）]*）：/, '')
    .replace(/\s+/g, '')
    .trim()
  return createHash('sha256').update(normalized).digest('hex').slice(0, 16)
}

/** @param {string} dir @returns {string[]} json files that hold entries */
function storeFiles(dir) {
  const out = []
  if (!fs.existsSync(dir)) return out
  for (const name of fs.readdirSync(dir)) {
    if (!name.endsWith('.json') || name.includes('.bak-') || name.includes('.tmp')) continue
    out.push(path.join(dir, name))
  }
  return out
}

const targets = [...storeFiles(root), ...storeFiles(path.join(root, 'workspaces'))]
console.log(`store files: ${targets.length}`)

let mergedTotal = 0
const plan = []

for (const file of targets) {
  const store = JSON.parse(fs.readFileSync(file, 'utf8'))
  const entries = Array.isArray(store.entries) ? store.entries : []
  // Only the maintenance pass's own output is eligible.
  const generated = entries.filter(entry => entry.kind === 'rule' || entry.summary === true)
  if (generated.length < 2) continue

  const groups = new Map()
  for (const entry of generated) {
    const key = contentKey(entry.text)
    if (!groups.has(key)) groups.set(key, [])
    groups.get(key).push(entry)
  }

  for (const [key, group] of groups) {
    if (group.length < 2) continue
    // Survivor: longest text (most complete), then highest affect, then newest.
    const sorted = [...group].sort(
      (a, b) =>
        String(b.text ?? '').length - String(a.text ?? '').length ||
        (b.affect ?? 0) - (a.affect ?? 0) ||
        (b.createdAt ?? 0) - (a.createdAt ?? 0),
    )
    const survivor = sorted[0]
    const losers = sorted.slice(1)
    plan.push({ file, key, survivor, losers, store })
    mergedTotal += losers.length
  }
}

console.log(`\n=== plan ===`)
for (const item of plan) {
  console.log(`\n  group ${item.key} in ${path.basename(item.file)}`)
  console.log(`    keep   ${item.survivor.id} (${String(item.survivor.text ?? '').length} chars, ${item.survivor.kind ?? 'summary'})`)
  for (const loser of item.losers) {
    console.log(`    merge  ${loser.id} (${String(loser.text ?? '').length} chars, ${loser.kind ?? 'summary'})`)
  }
  console.log(`    text   ${String(item.survivor.text ?? '').replace(/\s+/g, ' ').slice(0, 90)}`)
}
console.log(`\nentries to merge: ${mergedTotal}`)

if (mergedTotal === 0) {
  console.log('nothing to do')
  process.exit(0)
}
if (!APPLY) {
  console.log('\ndry run only; re-run with --apply to merge')
  process.exit(0)
}

const stamp = new Date().toISOString().replace(/[:.]/g, '-')
const backup = path.join(root, 'backups', stamp)
fs.mkdirSync(backup, { recursive: true })
for (const file of new Set(plan.map(item => item.file))) {
  fs.copyFileSync(file, path.join(backup, path.basename(file)))
}
console.log(`\nbacked up to ${backup}`)

// Archive the losers in the cold store of the same scope, then drop them from the
// live store. Nothing is destroyed: the cold store keeps the full text.
const byFile = new Map()
for (const item of plan) {
  if (!byFile.has(item.file)) byFile.set(item.file, [])
  byFile.get(item.file).push(item)
}

for (const [file, items] of byFile) {
  const store = JSON.parse(fs.readFileSync(file, 'utf8'))
  const coldFile = path.join(root, 'cold', path.basename(file))
  const cold = fs.existsSync(coldFile) ? JSON.parse(fs.readFileSync(coldFile, 'utf8')) : { version: 1, entries: [] }
  if (!Array.isArray(cold.entries)) cold.entries = []

  for (const item of items) {
    for (const loser of item.losers) {
      const archived = { ...loser, state: 'archived', archivedAt: Date.now(), mergedInto: item.survivor.id }
      if (!cold.entries.some(entry => entry.id === archived.id)) cold.entries.push(archived)
      store.entries = store.entries.filter(entry => entry.id !== loser.id)
    }
  }

  fs.mkdirSync(path.dirname(coldFile), { recursive: true })
  fs.writeFileSync(coldFile, `${JSON.stringify(cold, null, 2)}\n`, 'utf8')
  fs.writeFileSync(file, `${JSON.stringify(store, null, 2)}\n`, 'utf8')
}

console.log(`merged ${mergedTotal} duplicate entries into cold storage`)
