/**
 * Purge the five junk memories produced by the "pain" extractor.
 *
 * They are not memories, they are tool output:
 *   - "错误: HTTP 503: {"code":"video_queue_full"...}"  → a transient API error
 *   - "当时的失败：edit error: old_string was not found in"  → a tool usage error
 *   - "用户说：这里布局不对 2、"                          → half a sentence
 *   - "用户说：还不对，agnes有5个账户..."                  → half a sentence
 *   - rule_23bbd6e0ade5                                   → those four concatenated
 *
 * All five carry source='pain'. Deleting them also removes the only reason they
 * can keep generating conflict pairs: with them gone, the contradiction queue
 * for this workspace has nothing left to argue about.
 *
 * Keeps a pre-state snapshot next to the store and verifies the write.
 */
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

const root = path.join(os.homedir(), '.dsh', 'storages', 'dsh-session-suite', 'memory')
const file = path.join(root, 'workspaces', 'adc4582d0a0aa098.json')

const TARGETS = new Set([
  'mem_c7834ba5d9bf',
  'mem_d7be8a6556a7',
  'mem_e85ebde941ed',
  'rule_23bbd6e0ade5',
  'mem_7c33c14ad2eb',
])

const before = JSON.parse(await fs.readFile(file, 'utf8'))
const entries = before.entries ?? []
const doomed = entries.filter(e => TARGETS.has(e.id))
const keep = entries.filter(e => !TARGETS.has(e.id))

console.log(`store: ${path.basename(file)}`)
console.log(`entries before: ${entries.length}`)
console.log(`\nremoving ${doomed.length}:`)
for (const e of doomed) {
  const why = e.source === 'pain' ? 'pain-extracted tool error' : e.source ?? '?'
  console.log(`  ${e.id.padEnd(22)} ${e.kind.padEnd(5)} ${why.padEnd(28)} ${String(e.text).slice(0, 56)}`)
}

// Every target must actually exist; refuse a half-matching id list.
const missing = [...TARGETS].filter(id => !entries.some(e => e.id === id))
if (missing.length > 0) {
  console.log(`\nREFUSING: these ids are not in the store: ${missing.join(', ')}`)
  process.exit(2)
}
// Nothing may be referenced by a survivor, or we would leave a dangling pointer.
const dangling = keep.filter(e => e.supersededBy && TARGETS.has(e.supersededBy))
if (dangling.length > 0) {
  console.log(`\nREFUSING: survivors still point at a removed id: ${dangling.map(e => e.id + '->' + e.supersededBy).join(', ')}`)
  process.exit(3)
}

const next = { ...before, entries: keep }
const tmp = `${file}.tmp-${process.pid}`
await fs.writeFile(tmp, JSON.stringify(next, null, 2))
await fs.rename(tmp, file)

const after = JSON.parse(await fs.readFile(file, 'utf8'))
console.log(`\nentries after: ${(after.entries ?? []).length}`)
for (const e of after.entries ?? []) {
  console.log(`  kept ${e.id.padEnd(22)} ${e.kind.padEnd(5)} ${String(e.text).slice(0, 60)}`)
}
console.log(`\nremoved: ${entries.length - (after.entries ?? []).length}`)
