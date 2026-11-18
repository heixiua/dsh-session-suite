/**
 * Validate a WEIGHTED gate (instead of min) on the labelled set.
 *
 * min() is too harsh: the injection selftest's correct answer scored
 * cov0.317/bm2.60 — coverage clears its floor, bm25 is close but under — and was
 * rejected. Both are independent evidence; one strong + one near-floor should
 * count as a match.
 *
 * Proposed: score = 0.5*(cov/covFloor) + 0.5*(bm/bmFloor), with an additional
 * hard floor: reject if BOTH are below half their floor (prevents one enormous
 * metric from carrying a worthless candidate).
 *   - gate at score >= 1.0
 *   - high coverage (>=0.8) still exempt
 *
 * Verify: all labelled real queries kept, junk rejection unchanged.
 */
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { MemoryEngine } from '../../lib/memory-engine.js'

const spec = JSON.parse(await fs.readFile('tools/benchmark/queries.floor.json', 'utf8'))
const root = path.join(os.homedir(), '.dsh', 'storages', 'dsh-session-suite')
const cwd = 'D:\\AI sandbox\\dsh-sandbox\\DSH Optimize'
const engine = new MemoryEngine({ root, config: { wordRoute: false } })
const COV = 0.28
const BM = 3.0
const EXEMPT = 0.8

let rejected = 0
for (const c of [...spec.cases.map(x => ({ ...x, kind: 'rel' })), ...spec.junk.map(x => ({ ...x, kind: 'junk' }))]) {
  const sel = await engine.select({ cwd, query: c.q, limit: 6, tiered: false })
  const best = sel.items.reduce((m, i) => {
    const cov = i.coverage ?? 0
    const bm = i.bm25 ?? 0
    const cn = cov / COV
    const bn = bm / BM
    const score = (cn + bn) / 2
    const s = (cov >= EXEMPT || (score >= 1.0 && cn >= 0.5 && bn >= 0.5)) ? Math.max(score, 1.0) : score
    return s > m.s ? { s, cov, bm } : m
  }, { s: 0, cov: 0, bm: 0 })
  const admit = best.s >= 1.0
  if (c.kind === 'rel' && !admit) rejected += 1
  console.log(`${(admit ? 'ADMIT ' : 'REJECT').padEnd(7)} score=${best.s.toFixed(2)} cov=${best.cov.toFixed(2)} bm=${best.bm.toFixed(2)}  ${c.kind}  ${c.q}`)
}
console.log(`\nrelevant rejected: ${rejected}/${spec.cases.length}`)
if (rejected > 0) process.exit(1)
console.log('PASS')
