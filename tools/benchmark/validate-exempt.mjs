/**
 * Validate the HIGH-COVERAGE EXEMPTION before touching product code.
 *
 * Problem found by selftest-tiers: in a small fixture (6 short entries, all
 * about the query), coverage=1.0 for every entry but bm25 is low because short
 * documents cannot accumulate term frequency. A pure min() gate rejected all 6.
 *
 * Proposed: a candidate clears the gate if EITHER
 *   (a) both metrics clear their floors — min >= 1.0, OR
 *   (b) coverage is extremely high (>= 0.8) — a near-total query coverage is
 *       strong evidence on its own, especially for short documents.
 *
 * This must not re-admit the junk set. Verify with the labelled queries first.
 */
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { MemoryEngine } from '../../lib/memory-engine.js'

const spec = JSON.parse(await fs.readFile('tools/benchmark/queries.floor.json', 'utf8'))
const root = path.join(os.homedir(), '.dsh', 'storages', 'dsh-session-suite')
const cwd = 'D:\\AI sandbox\\dsh-sandbox\\DSH Optimize'
const engine = new MemoryEngine({ root, config: { wordRoute: false } })
const COV_FLOOR = 0.28
const BM_FLOOR = 3.0
const EXEMPT_COV = 0.8

let rejected = 0
for (const c of [...spec.cases.map(x => ({ ...x, kind: 'rel' })), ...spec.junk.map(x => ({ ...x, kind: 'junk' }))]) {
  const sel = await engine.select({ cwd, query: c.q, limit: 6, tiered: false })
  const scored = sel.items.map(i => {
    const cov = i.coverage ?? 0
    const bm = i.bm25 ?? 0
    return {
      cov, bm,
      pass: Math.min(cov / COV_FLOOR, bm / BM_FLOOR) >= 1.0 || cov >= EXEMPT_COV,
    }
  })
  const admit = scored.some(s => s.pass)
  if (c.kind === 'rel' && !admit) rejected += 1
  const best = scored.reduce((m, s) => !m || s.cov > m.cov ? s : m, null)
  console.log(
    `${(admit ? 'ADMIT ' : 'REJECT').padEnd(7)} cov=${(best?.cov ?? 0).toFixed(2)} bm=${(best?.bm ?? 0).toFixed(2)}  ${c.kind}  ${c.q}`,
  )
}
console.log(`\nrelevant rejected: ${rejected}/${spec.cases.length}`)
if (rejected > 0) process.exit(1)
console.log('PASS: no relevant query rejected by the exempting gate')
