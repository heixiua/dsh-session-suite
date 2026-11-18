/**
 * Validate a DATA-DERIVED gate, without touching product code.
 *
 * Current gate:  reject if (bestCov < 0.28 && bestBm < 3.8)
 *   → an AND, so ANY single metric above its floor admits the block. Measured:
 *     `明天天气` cov0.299/bm0 passes on coverage; `世界杯` cov0.164/bm3.85
 *     passes on bm25. Both are junk.
 *
 * Proposed gate: for ONE candidate at a time, require BOTH metrics to clear a
 * floor. Score each candidate as min(cov / covFloor, bm / bmFloor), take the
 * best candidate's score, reject the block if it is below 1.0.
 *
 * Floors are derived from the labelled set, not guessed:
 *   covFloor = 0.28 (unchanged — relevant min is 0.325, junk max 0.299)
 *   bmFloor  = 3.0  (LOWERED from 3.8 — the weakest relevant hit is 3.11,
 *                    so a 3.8 floor would have rejected a real answer)
 *
 * Prints a full confusion matrix. Exits 1 if any relevant query is rejected.
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

let relevantRejected = 0
let junkAdmitted = 0

console.log('kind  score  cov    bm     decision  query')
for (const c of [...spec.cases.map(x => ({ ...x, kind: 'rel' })), ...spec.junk.map(x => ({ ...x, kind: 'junk' }))]) {
  // tiered:false bypasses the CURRENT gate so we see the raw ranking.
  const sel = await engine.select({ cwd, query: c.q, limit: 6, tiered: false })
  const scored = sel.items.map(i => ({
    cov: i.coverage ?? 0,
    bm: i.bm25 ?? 0,
    // min => a candidate only counts as strong if BOTH metrics clear the floor
    score: Math.min((i.coverage ?? 0) / COV_FLOOR, (i.bm25 ?? 0) / BM_FLOOR),
  }))
  const best = scored.reduce((m, s) => s.score > m.score ? s : m, { cov: 0, bm: 0, score: 0 })
  const admit = best.score >= 1.0
  if (c.kind === 'rel' && !admit) relevantRejected += 1
  if (c.kind === 'junk' && admit) junkAdmitted += 1
  console.log(
    `${c.kind.padEnd(5)} ${best.score.toFixed(2).padStart(5)}  ${best.cov.toFixed(3)}  ${best.bm.toFixed(2).padStart(5)}  ` +
    `${admit ? 'ADMIT ' : 'REJECT'}   ${c.q}`,
  )
}

console.log(`\nrelevant rejected: ${relevantRejected}/${spec.cases.length}  (must be 0)`)
console.log(`junk admitted    : ${junkAdmitted}/${spec.junk.length}  (want 0; a quoted query is expected to leak)`)
if (relevantRejected > 0) {
  console.error('\nFAILED: the proposed gate rejects a real answer')
  process.exit(1)
}
console.log('\nPASS: no real answer is rejected')
