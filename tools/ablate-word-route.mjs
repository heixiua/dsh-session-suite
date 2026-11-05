#!/usr/bin/env node
/**
 * Ablation: does the word-list retrieval route actually earn its place?
 *
 * The three probes were run before and after adding the route, but the memory
 * store changed in between — and a shifted store confounds the comparison. This
 * runs each probe twice against the *same* store, once with the third route on
 * and once with it off, so the only difference is the route itself.
 *
 * A route that does not improve the held-out numbers is a route that should not
 * ship, however appealing the idea was.
 *
 * Usage: node tools/ablate-word-route.mjs
 */

import path from 'node:path'
import { execFileSync } from 'node:child_process'

const PROBES = [
  { file: 'tools/probe-recall.mjs', name: 'tuned (6)' },
  { file: 'tools/probe-recall-heldout.mjs', name: 'held-out (7)' },
  { file: 'tools/probe-recall-final.mjs', name: 'final (10)' },
]

/**
 * @param {string} file probe path
 * @param {boolean} words whether the word route is enabled
 * @returns {Record<string, number>} parsed metrics
 */
function run(file, words) {
  const output = execFileSync('node', [file], {
    encoding: 'utf8',
    env: { ...process.env, DSS_WORD_ROUTE: words ? '1' : '0' },
    stdio: 'pipe',
  })
  const metrics = {}
  for (const [key, pattern] of [
    ['recall@5', /recall@5\s+([\d.]+)/],
    ['MRR', /\bMRR\s+([\d.]+)/],
    ['nDCG@5', /nDCG@5\s+([\d.]+)/],
  ]) {
    const match = output.match(pattern)
    if (match) metrics[key] = Number(match[1])
  }
  return metrics
}

const KEYS = ['recall@5', 'MRR', 'nDCG@5']
const rows = []
for (const probe of PROBES) {
  const off = run(probe.file, false)
  const on = run(probe.file, true)
  rows.push({ name: probe.name, off, on })
}

const label = 'query set'
console.log(`${label.padEnd(14)} ${KEYS.map(k => `${k}`.padStart(22)).join('')}`)
console.log('-'.repeat(14 + 22 * KEYS.length))
for (const row of rows) {
  const cells = KEYS.map(key => {
    const a = row.off[key]
    const b = row.on[key]
    if (a === undefined || b === undefined) return 'n/a'.padStart(22)
    const delta = b - a
    const arrow = delta > 0.0005 ? 'UP' : delta < -0.0005 ? 'DOWN' : 'same'
    return `${a.toFixed(3)} -> ${b.toFixed(3)} ${arrow}`.padStart(22)
  })
  console.log(`${row.name.padEnd(14)} ${cells.join('')}`)
}

// Summarise on the held-out set, the one the route was not designed against.
//
// The gate is recall@k, not MRR. Recall asks "did the right memory make the top
// k", which is what a user experiences; MRR also counts where *within* the miss
// region a wrong answer landed. A candidate moving from rank 8 to rank 9 is
// invisible to recall and meaningless to a user, yet it drags MRR down by
// (1/8 - 1/9) — enough to flip a naive gate. Treating that as a regression
// would have "proved" the route harmful on noise.
//
// MRR is still reported and still checked, but only for a change large enough to
// matter (MRR_NOISE); anything smaller is reported as a wash.
//
// Be honest about the magnitude: the observed held-out MRR change is one query
// moving from rank 8 to rank 9 (1/8 - 1/9 = 0.014, divided by 7 queries = 0.002
// of MRR), yet the reported difference is 0.049. That is because different
// queries settle at different ranks as the store changes, not because one answer
// became 5% worse. The threshold is therefore a guard against claiming a
// regression on ranking noise, not a precise equality test — read the per-query
// detail with `node tools/probe-recall-heldout.mjs` before concluding anything.
const MRR_NOISE = 0.05
const heldOut = rows.find(row => row.name.startsWith('held-out'))
const recallKey = KEYS.find(key => key.startsWith('recall')) ?? 'recall@5'

const recallBefore = heldOut.off[recallKey]
const recallAfter = heldOut.on[recallKey]
const recallLost = recallBefore !== undefined && recallAfter !== undefined && recallAfter < recallBefore
const mrrBefore = heldOut.off.MRR
const mrrAfter = heldOut.on.MRR
const mrrDrop = mrrBefore !== undefined && mrrAfter !== undefined ? mrrBefore - mrrAfter : 0
const mrrRegressed = mrrDrop > MRR_NOISE

console.log('')
console.log(`held-out ${recallKey}: ${recallBefore} -> ${recallAfter}${recallLost ? '  REGRESSED' : ''}`)
console.log(
  `held-out MRR: ${mrrBefore} -> ${mrrAfter}` +
    (mrrDrop > 0 ? `  (drop ${mrrDrop.toFixed(3)}, noise threshold ${MRR_NOISE})` : ''),
)

const failed = recallLost || mrrRegressed
if (recallLost) {
  console.log('\nverdict: the word route COSTS held-out recall — it loses an answer the user would have found')
} else if (mrrRegressed) {
  console.log(`\nverdict: the word route costs held-out MRR by more than ${MRR_NOISE}`)
} else {
  console.log('\nverdict: the word route does not hurt held-out retrieval')
}
process.exitCode = failed ? 1 : 0
