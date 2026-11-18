/**
 * One-shot backfill of `tier` and `topic` for every stored memory.
 *
 * This is the C option: classify the whole library now, including the 84 archived
 * rows, instead of waiting for the next maintain() pass to reach them one at a
 * time. The same inference functions maintain() uses are applied here, so the
 * result is identical to what a pass would produce — this only does it once, and
 * reports what it decided.
 *
 * Dry run by default. `--apply` writes, keeping a per-store backup.
 */
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { MemoryEngine, LESSON_TAGS } from '../lib/memory-engine.js'
import { TIERS, inferTier, inferTopic } from '../lib/tiers.js'

const root = path.join(os.homedir(), '.dsh', 'storages', 'dsh-session-suite', 'memory')
// This environment exposes a trimmed `process` (no argv, no env), so the switch
// is a marker file beside the working directory: create `.backfill-apply` in the
// repo root to write. `import.meta.url` is percent-encoded for the spaces in this
// project path, which made the old path check silently false.
const apply = await fs.access(path.resolve('.backfill-apply')).then(() => true, () => false)
const readJson = async f => { try { return JSON.parse(await fs.readFile(f, 'utf8')) } catch { return undefined } }

const files = [{ file: path.join(root, 'global.json'), label: 'global' }]
for (const f of (await fs.readdir(path.join(root, 'workspaces'))).sort()) {
  if (!f.endsWith('.json')) continue
  files.push({ file: path.join(root, 'workspaces', f), label: `ws/${f.slice(0, 8)}` })
}
const coldFiles = []
for (const f of await fs.readdir(path.join(root, 'cold')).catch(() => [])) {
  if (!f.endsWith('.json')) continue
  coldFiles.push({ file: path.join(root, 'cold', f), label: `cold/${f.slice(0, 8)}` })
}

console.log(`mode: ${apply ? 'APPLY' : 'dry run'}`)
console.log(`live stores: ${files.length}, cold stores: ${coldFiles.length}\n`)

const tierCount = { base: 0, project: 0, detail: 0 }
const topicCount = new Map()
let touched = 0
let alreadyDone = 0
const noTopic = []

async function process(stores, isCold) {
  for (const store of stores) {
    const j = await readJson(store.file)
    if (!j || !Array.isArray(j.entries)) continue
    let changed = 0
    const backup = `${store.file}.bak-backfill-${Date.now()}`
    for (const entry of j.entries) {
      const hadTier = TIERS.includes(entry.tier)
      const hadTopic = typeof entry.topic === 'string'
      if (hadTier && hadTopic) { alreadyDone += 1; continue }
      if (!hadTier) entry.tier = inferTier(entry, { lessonTags: LESSON_TAGS })
      if (!hadTopic) entry.topic = inferTopic(entry.text, { explicit: entry.topic })
      tierCount[entry.tier] += 1
      if (entry.topic) topicCount.set(entry.topic, (topicCount.get(entry.topic) ?? 0) + 1)
      else noTopic.push({ label: store.label, text: String(entry.text).slice(0, 60) })
      changed += 1
    }
    if (changed > 0) {
      touched += changed
      console.log(`${store.label.padEnd(14)} ${String(j.entries.length).padStart(3)} 条  分类 ${changed}${isCold ? '  (cold)' : ''}`)
      if (apply) {
        await fs.copyFile(store.file, backup)
        const tmp = `${store.file}.tmp-${process.pid}`
        await fs.writeFile(tmp, JSON.stringify(j, null, 2))
        await fs.rename(tmp, store.file)
      }
    }
  }
}

await process(files, false)
await process(coldFiles, true)

console.log(`\n=== 分类结果 ===`)
console.log(`  base   ${tierCount.base}`)
console.log(`  project ${tierCount.project}`)
console.log(`  detail ${tierCount.detail}`)
console.log(`  已分类(跳过) ${alreadyDone}`)

console.log(`\n=== topic 分布（前 20）===`)
for (const [t, n] of [...topicCount.entries()].sort((a, b) => b[1] - a[1]).slice(0, 20)) {
  console.log(`  ${t.padEnd(12)} ${n}`)
}
console.log(`\n  有 topic: ${[...topicCount.values()].reduce((a, b) => a + b, 0)}`)
console.log(`  无 topic: ${noTopic.length}`)
if (noTopic.length > 0) {
  console.log('  无 topic 的样例（这些条目仍可被相似度召回，只是不参与主题预算）:')
  for (const item of noTopic.slice(0, 8)) console.log(`    [${item.label}] ${item.text}`)
}

console.log(`\n${apply ? '已写入' : '将写入'} ${touched} 条`)
