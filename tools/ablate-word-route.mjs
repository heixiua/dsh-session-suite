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

// Summarise: the route must not regress the held-out set, which is the set it
// was not designed against.
const heldOut = rows.find(row => row.name.startsWith('held-out'))
const regressed = KEYS.filter(key => {
  const a = heldOut.off[key]
  const b = heldOut.on[key]
  return a !== undefined && b !== undefined && b < a - 0.0005
})
const improved = KEYS.filter(key => {
  const a = heldOut.off[key]
  const b = heldOut.on[key]
  return a !== undefined && b !== undefined && b > a + 0.0005
})
console.log('')
console.log(`held-out regressed on: ${regressed.length > 0 ? regressed.join(', ') : 'nothing'}`)
console.log(`held-out improved on:  ${improved.length > 0 ? improved.join(', ') : 'nothing'}`)
console.log(regressed.length === 0 ? '\nverdict: the word route does not hurt held-out retrieval' : '\nverdict: the word route COSTS held-out quality')
process.exitCode = regressed.length === 0 ? 0 : 1
