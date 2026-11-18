/**
 * Re-derive `topic` for entries whose topic came from the earlier seed list.
 *
 * The first backfill used a vocabulary that excluded `插件` outright, which left
 * 35 of 111 entries with no topic — most of them genuine plugin-development
 * knowledge. `inferTopic` now falls back to a broad label, so the stored values
 * must be recomputed rather than trusted.
 *
 * Only `topic` is recomputed; `tier` is untouched (its inputs did not change).
 * Dry run by default: create `.backfill-apply` in the repo root to write.
 */
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { inferTopic } from '../lib/tiers.js'

const root = path.join(os.homedir(), '.dsh', 'storages', 'dsh-session-suite', 'memory')
const apply = await fs.access(path.resolve('.backfill-apply')).then(() => true, () => false)
const readJson = async f => { try { return JSON.parse(await fs.readFile(f, 'utf8')) } catch { return undefined } }

const stores = [{ file: path.join(root, 'global.json'), label: 'global' }]
for (const f of await fs.readdir(path.join(root, 'workspaces')).then(a => a.sort())) {
  if (f.endsWith('.json')) stores.push({ file: path.join(root, 'workspaces', f), label: `ws/${f.slice(0, 8)}` })
}
for (const f of await fs.readdir(path.join(root, 'cold')).catch(() => []).then(a => (a ?? []).sort())) {
  if (f.endsWith('.json')) stores.push({ file: path.join(root, 'cold', f), label: `cold/${f.slice(0, 8)}` })
}

console.log(`mode: ${apply ? 'APPLY' : 'dry run'}`)
let changed = 0
let emptied = 0
const before = new Map()
const after = new Map()

for (const store of stores) {
  const j = await readJson(store.file)
  if (!j?.entries?.length) continue
  let n = 0
  for (const entry of j.entries) {
    const old = entry.topic ?? ''
    const next = inferTopic(entry.text, { explicit: '' })
    if (old === next) continue
    before.set(old || '(空)', (before.get(old || '(空)') ?? 0) + 1)
    after.set(next || '(空)', (after.get(next || '(空)') ?? 0) + 1)
    if (!next) emptied += 1
    entry.topic = next
    n += 1
  }
  if (n > 0) {
    changed += n
    console.log(`${store.label.padEnd(14)} 重算 ${n}`)
    if (apply) {
      const tmp = `${store.file}.tmp-${process.pid ?? 0}`
      await fs.writeFile(tmp, JSON.stringify(j, null, 2))
      await fs.rename(tmp, store.file)
    }
  }
}

console.log(`\n${apply ? '已写入' : '将写入'} ${changed} 条，其中变为空主题 ${emptied} 条`)
console.log('\n旧主题 -> 新主题 变化（前 12）:')
for (const [k, v] of [...before.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12)) console.log(`  ${k.padEnd(10)} ${v}`)
console.log('\n新主题分布（前 12）:')
for (const [k, v] of [...after.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12)) console.log(`  ${k.padEnd(10)} ${v}`)
