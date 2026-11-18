/**
 * Repair a workspace store whose key no longer matches the current algorithm.
 *
 * `MemoryEngine.workspaceKey()` hashes the normalized cwd. If that normalization
 * ever changed, every store written under the old key becomes UNREACHABLE: the
 * engine only ever addresses `workspaceKey(currentCwd)`, so the old file sits on
 * disk forever and its memories are silently dead.
 *
 * Found in the wild: 38f228fcff0195a6 holds 25 memories for
 * D:\AI sandbox\dsh-sandbox\Replicate_anything, while the current algorithm maps
 * that same path to adc4582d0a0aa098 (which exists and is empty).
 *
 * This MERGES the orphan into the live key, deduplicating by digest so a memory
 * already present is not stored twice, and keeps the orphan file as a backup.
 * Dry run by default; `--apply` writes.
 */
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { MemoryEngine } from '../lib/memory-engine.js'

const root = path.join(os.homedir(), '.dsh', 'storages', 'dsh-session-suite', 'memory')
const dir = path.join(root, 'workspaces')
const apply = process.argv.includes('--apply')
const readJson = async f => { try { return JSON.parse(await fs.readFile(f, 'utf8')) } catch { return undefined } }

const wsIndex = (await readJson(path.join(root, 'workspaces.json')))?.workspaces ?? {}

console.log(`mode: ${apply ? 'APPLY' : 'dry run'}\n`)
console.log('store key        entries  recorded cwd                              current key for that cwd  state')
const stores = []
for (const f of (await fs.readdir(dir)).sort()) {
  if (!f.endsWith('.json')) continue
  const key = f.replace(/\.json$/, '')
  const j = await readJson(path.join(dir, f))
  if (!j) continue
  const cwd = j.cwd ?? wsIndex[key]?.cwd ?? null
  const expected = cwd ? MemoryEngine.workspaceKey(cwd) : null
  const state = expected === null ? 'no cwd' : expected === key ? 'ok' : 'ORPHAN'
  stores.push({ key, file: path.join(dir, f), entries: j.entries ?? [], cwd, expected, state })
  console.log(
    `${key.padEnd(16)} ${String((j.entries ?? []).length).padStart(7)}  ${String(cwd ?? '-').padEnd(40)} ${String(expected ?? '-').padEnd(24)} ${state}`,
  )
}

const orphans = stores.filter(s => s.state === 'ORPHAN')
console.log(`\norphan stores: ${orphans.length}`)
if (orphans.length === 0) { console.log('nothing to repair'); process.exit(0) }

let moved = 0
let skipped = 0
for (const orphan of orphans) {
  const target = stores.find(s => s.key === orphan.expected)
  console.log(`\n${orphan.key} -> ${orphan.expected}`)
  console.log(`  ${orphan.entries.length} entries, cwd=${orphan.cwd}`)
  console.log(`  target exists: ${target ? `yes (${target.entries.length} entries)` : 'no'}`)

  // Never overwrite a live store; merge into it.
  const liveEntries = target ? target.entries : []
  const digests = new Set(liveEntries.map(e => e.digest).filter(Boolean))
  const incoming = []
  for (const entry of orphan.entries) {
    if (entry.digest && digests.has(entry.digest)) { skipped += 1; continue }
    incoming.push(entry)
    if (entry.digest) digests.add(entry.digest)
  }
  console.log(`  to move: ${incoming.length}, already present: ${orphan.entries.length - incoming.length}`)
  if (incoming.length === 0) continue

  if (!apply) { moved += incoming.length; continue }

  const merged = {
    version: 2,
    scope: 'workspace',
    workspaceKey: orphan.expected,
    cwd: orphan.cwd,
    entries: [...liveEntries, ...incoming],
  }
  await fs.writeFile(`${target?.file ?? path.join(dir, `${orphan.expected}.json`)}.tmp-${process.pid}`, JSON.stringify(merged, null, 2))
  await fs.rename(`${target?.file ?? path.join(dir, `${orphan.expected}.json`)}.tmp-${process.pid}`, target?.file ?? path.join(dir, `${orphan.expected}.json`))

  // Keep the orphan as a backup, renamed so it can never be addressed by the engine.
  const backup = `${orphan.file}.orphan-backup-${Date.now()}`
  await fs.rename(orphan.file, backup)
  console.log(`  merged into ${orphan.expected}; orphan kept at ${path.basename(backup)}`)
  moved += incoming.length
}

console.log(`\n${apply ? 'moved' : 'would move'} ${moved} entries, skipped ${skipped} duplicates`)
