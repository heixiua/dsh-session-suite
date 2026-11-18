/**
 * What should a TOPIC be? Let the data answer, not intuition.
 *
 * Proposes topics from the library itself and measures how well each candidate
 * partitions it:
 *   - how many entries each topic covers,
 *   - how evenly (a topic holding 80% is not a topic, it is a bin),
 *   - and whether the split crosses workspace boundaries the way a real topic
 *     should (a topic that only ever appears in one workspace is a folder, not
 *     a subject).
 *
 * Candidates come from three independent signals so we can compare them:
 *   A. the existing tags (already curated by whoever wrote the memory)
 *   B. the leading noun phrases of the text
 *   C. the workspace a memory lives in
 */
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

const root = path.join(os.homedir(), '.dsh', 'storages', 'dsh-session-suite', 'memory')
const readJson = async f => { try { return JSON.parse(await fs.readFile(f, 'utf8')) } catch { return undefined } }

const entries = []
const add = (j, store) => {
  for (const e of (j?.entries ?? [])) entries.push({ ...e, _store: store })
}
add(await readJson(path.join(root, 'global.json')), 'global')
for (const f of await fs.readdir(path.join(root, 'workspaces'))) {
  if (!f.endsWith('.json')) continue
  add(await readJson(path.join(root, 'workspaces', f)), f.replace(/\.json$/, '').slice(0, 8))
}
const wsIndex = (await readJson(path.join(root, 'workspaces.json')))?.workspaces ?? {}
console.log(`library: ${entries.length} live entries\n`)

// ---- A. existing tags, split into "type" and "subject"
// A tag is a TYPE when it answers "what kind of memory is this" — it recurs on
// nearly everything and carries no retrieval signal.
const tagCount = new Map()
for (const e of entries) for (const t of (e.tags ?? [])) tagCount.set(t, (tagCount.get(t) ?? 0) + 1)
const ranked = [...tagCount.entries()].sort((a, b) => b[1] - a[1])
const TYPE_TAGS = new Set(ranked.filter(([, n]) => n / entries.length > 0.25).map(([t]) => t))

console.log('=== A. 现有 tags ===')
console.log('判定为"类型标签"（覆盖率 >25%，无检索区分度）:')
for (const [t, n] of ranked) {
  if (TYPE_TAGS.has(t)) console.log(`  ${t.padEnd(12)} ${String(n).padStart(4)} / ${entries.length}  (${Math.round(n / entries.length * 100)}%)`)
}
const subjectTags = ranked.filter(([t]) => !TYPE_TAGS.has(t))
console.log('\n可当主题的标签（覆盖率 ≤25%）:')
const tagTopicStats = []
for (const [t, n] of subjectTags) {
  const holders = entries.filter(e => (e.tags ?? []).includes(t))
  const stores = new Set(holders.map(e => e._store))
  tagTopicStats.push({ topic: t, n, stores: stores.size })
  console.log(`  ${t.padEnd(12)} ${String(n).padStart(4)} 条  跨 ${stores.size} 个库${stores.size > 1 ? '  ✓跨工作区' : ''}`)
}
const spread = tagTopicStats.filter(s => s.stores > 1).length
console.log(`\n  跨工作区的主题: ${spread}/${tagTopicStats.length}`)

// ---- B. leading topic words mined from the text itself
const SEEDS = ['插件', '压缩', '记忆', '会话', '快照', '回滚', '模型', '缓存', '安装', '发布', 'npm', 'git', '画布', 'QQ', '权限', '沙箱', '提示词', '检索', '召回', '工具']
console.log('\n=== B. 直接在正文里出现的主题词 ===')
const mined = []
for (const seed of SEEDS) {
  const holders = entries.filter(e => String(e.text ?? '').includes(seed))
  if (holders.length === 0) continue
  const stores = new Set(holders.map(e => e._store))
  mined.push({ seed, n: holders.length, stores: stores.size })
}
for (const m of mined.sort((a, b) => b.n - a.n)) {
  console.log(`  ${m.seed.padEnd(10)} ${String(m.n).padStart(4)} 条  跨 ${m.stores} 个库${m.stores > 1 ? '  ✓' : ''}`)
}

// ---- C. workspace as the only current dimension
console.log('\n=== C. 当前唯一维度：工作区 ===')
const byStore = new Map()
for (const e of entries) byStore.set(e._store, (byStore.get(e._store) ?? 0) + 1)
for (const [s, n] of [...byStore.entries()].sort((a, b) => b[1] - a[1])) {
  const cwd = wsIndex[s]?.cwd ?? (s === 'global' ? '(全局)' : '(未记录)')
  console.log(`  ${s.padEnd(10)} ${String(n).padStart(4)} 条  ${cwd}`)
}

// ---- What would the ideal topic set look like?
console.log('\n=== 判定标准（给候选主题打分）===')
console.log('  覆盖率 5–20%  → 合适（太大是桶，太小是碎片）')
console.log('  跨 ≥2 个工作区 → 真主题（只在一个库里的是文件夹）')
console.log('  有检索区分度   → 该词在该条目里是主语，不是修饰语')
const ok = tagTopicStats.concat(mined.map(m => ({ topic: m.seed, n: m.n, stores: m.stores })))
  .filter(t => t.n / entries.length >= 0.05 && t.n / entries.length <= 0.20 && t.stores >= 2)
console.log(`\n就现在这份数据，同时满足三条的候选: ${ok.length} 个`)
for (const t of ok) console.log(`  ${t.topic} (${t.n} 条, 跨 ${t.stores} 库)`)
