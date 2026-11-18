/**
 * Read-only inventory of the memory subsystem, for the architecture review.
 *
 * Answers three questions with measurements instead of intent:
 *   1. what layers exist in the injected block, and what each is allowed to spend;
 *   2. how the stores are partitioned, and whether the partition is consistent;
 *   3. where the library actually sits relative to those layers.
 */
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { MemoryEngine } from '../lib/memory-engine.js'

const home = path.join(os.homedir(), '.dsh')
const root = path.join(home, 'storages', 'dsh-session-suite', 'memory')
const readJson = async f => { try { return JSON.parse(await fs.readFile(f, 'utf8')) } catch { return undefined } }

const engine = new MemoryEngine({ root, config: {} })

// ---- stores
const global = await readJson(path.join(root, 'global.json'))
const workspacesJson = await readJson(path.join(root, 'workspaces.json'))
const wsMap = workspacesJson?.workspaces ?? {}
const stores = []
for (const f of (await fs.readdir(path.join(root, 'workspaces')).catch(() => [])).sort()) {
  if (!f.endsWith('.json')) continue
  const j = await readJson(path.join(root, 'workspaces', f))
  if (!j) continue
  const key = f.replace(/\.json$/, '')
  const entries = j.entries ?? []
  const recorded = wsMap[key]?.cwd ?? null
  // Is this file still the store the CURRENT algorithm would address?
  const expected = recorded ? MemoryEngine.workspaceKey(recorded) : null
  stores.push({
    key,
    recordedCwd: recorded,
    expectedKeyForThatCwd: expected,
    consistent: expected === null ? null : expected === key,
    entries: entries.length,
    days: [...new Set(entries.map(e => new Date(e.createdAt ?? 0).toISOString().slice(0, 10)))].sort(),
    kinds: entries.reduce((m, e) => (m[e.kind ?? '?'] = (m[e.kind ?? '?'] ?? 0) + 1, m), {}),
  })
}
let cold = 0
for (const f of (await fs.readdir(path.join(root, 'cold')).catch(() => []))) {
  if (!f.endsWith('.json')) continue
  const j = await readJson(path.join(root, 'cold', f))
  cold += (j?.entries ?? []).length
}

console.log('=== 存储分区 ===')
console.log(`global.json: ${(global?.entries ?? []).length} 条`)
console.log('workspace stores:')
for (const s of stores) {
  const flag = s.consistent === false ? '  <-- KEY 已过期（当前算法指向别处）' : ''
  console.log(`  ${s.key}  ${String(s.entries).padStart(3)} 条  cwd=${s.recordedCwd ?? '(未记录)'}${flag}`)
  console.log(`     日期: ${s.days.join(', ') || '-'}`)
  console.log(`     类型: ${JSON.stringify(s.kinds)}`)
}
console.log(`cold（归档池）: ${cold} 条`)

const live = (global?.entries ?? []).length + stores.reduce((n, s) => n + s.entries, 0)
console.log(`\n活跃合计: ${live}，含归档: ${live + cold}`)

// ---- what the injector can afford
const cfg = await engine.settings().catch(() => ({}))
console.log('\n=== 注入层预算（配置值） ===')
const D = await import('../lib/memory-engine.js').then(m => m.DEFAULTS ?? {})
const row = (name, v, note) => console.log(`  ${name.padEnd(18)} ${String(v).padEnd(8)} ${note}`)
row('教训层 lessonLimit', cfg.lessonLimit ?? D.lessonLimit ?? 3, '无条件注入，按重要度而非相似度')
row('教训层 lessonBudget', cfg.lessonBudget ?? D.lessonBudget ?? 800, '字符预算，每轮都付')
row('召回层 recallLimit', cfg.recallLimit ?? D.recallLimit ?? 6, '按与本轮问题的相似度')
row('常驻层 residentLimit', cfg.residentLimit ?? D.residentLimit ?? 2, '概览卡片数')
row('常驻层 residentBudget', cfg.residentBudget ?? D.residentBudget ?? 600, '字符预算')
row('索引层 indexBudget', cfg.indexBudget ?? D.indexBudget ?? 600, 'indexMode 时的目录预算')
console.log(`  indexMode: ${cfg.indexMode === true ? '开' : '关（用扁平概览卡片）'}`)

// ---- where the library sits relative to the budget
const longest = (global?.entries ?? []).map(e => e.text ?? '').sort((a, b) => b.length - a.length)[0] ?? ''
console.log('\n=== 库 vs 预算 ===')
console.log(`  最长单条: ${longest.length} 字`)
const avg = Math.round((global?.entries ?? []).reduce((n, e) => n + (e.text ?? '').length, 0) / Math.max(1, (global?.entries ?? []).length))
console.log(`  global 平均长度: ${avg} 字`)
console.log(`  教训预算 800 字 ≈ ${Math.floor(800 / Math.max(1, avg))} 条（平均长度）`)
console.log(`  召回上限 6 条 ≈ ${6 * avg} 字`)
