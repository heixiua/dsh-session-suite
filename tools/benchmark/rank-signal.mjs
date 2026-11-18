/**
 * Where do HITS vs NOISE sit in the ranking?
 *
 * If expected answers cluster near the top and incidental matches trail below,
 * the floor is really a RANK cutoff, which is a very different (and much safer)
 * rule than a magnitude cutoff on coverage/bm25.
 */
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { MemoryEngine } from '../../lib/memory-engine.js'

const spec = JSON.parse(await fs.readFile('tools/benchmark/queries.floor.json', 'utf8'))
const root = path.join(os.homedir(), '.dsh', 'storages', 'dsh-session-suite')
const cwd = 'D:\\AI sandbox\\dsh-sandbox\\DSH Optimize'
const engine = new MemoryEngine({ root, config: { wordRoute: false } })
const flatten = s => String(s ?? '').replace(/\s+/g, ' ').trim()
const live = await engine.list({ cwd })
const liveText = new Map(live.map(e => [e.id, flatten(e.text)]))
const resolve = want => {
  const ids = new Set()
  for (const f of want) for (const [id, text] of liveText) if (text.includes(flatten(f))) ids.add(id)
  return ids
}

for (const c of [...spec.cases, ...spec.junk]) {
  const expected = resolve(c.want)
  const sel = await engine.select({ cwd, query: c.q, limit: 6 })
  const positions = sel.items.map((i, n) => `${n + 1}:${expected.has(i.id) ? 'HIT' : '-'} cov${(i.coverage ?? 0).toFixed(2)}/bm${(i.bm25 ?? 0).toFixed(1)}`)
  console.log(`${c.want.length ? 'rel ' : 'junk'} ${c.q}`)
  console.log(`     ${positions.join('  ') || '(none)'}`)
}
