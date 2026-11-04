#!/usr/bin/env node
// Retrieval quality, measured with the three standard metrics instead of a
// single pass/fail on the top hit.
//
// The earlier version reported "6/6 queries rank the intended memory first",
// which is recall@1 dressed up as a score. It hides the difference between a
// query that puts the right memory at rank 1 and one that puts it at rank 5 —
// both count as a miss, so a change that moves it from 5 to 2 looks like no
// progress at all, and a change that trades a rank-1 hit for two rank-2 hits
// looks like a regression when it may be an improvement.
//
//   recall@k  did the right memory appear in the first k results?
//   MRR       mean of 1/rank of the first correct result
//   nDCG@k    the whole ranking's quality, later positions discounted
//
// Read-only: it never touches access counts.
//
// Usage: node tools/probe-recall.mjs [--k 5]

import os from 'node:os'
import path from 'node:path'
import { MemoryEngine } from '../lib/memory-engine.js'

const ROOT = path.join(os.homedir(), '.dsh', 'storages', 'dsh-session-suite')
const CWD = 'D:\\AI sandbox\\dsh-sandbox\\DSH Optimize'

const argIndex = process.argv.indexOf('--k')
const K = argIndex > -1 ? Number(process.argv[argIndex + 1]) : 5

// Each case lists every memory that legitimately answers the query, not just
// one. nDCG needs a graded relevance judgement: two relevant memories at ranks
// 1 and 2 must score better than one relevant memory at rank 1 and noise below.
const CASES = [
  { q: '偏差001 用户点错 提示文案', want: ['mem_91823657b3e3'] },
  { q: 'fork 快照继承', want: ['mem_84a1f10aea18'] },
  { q: '缓存命中率为什么下降', want: ['mem_070065e00ae2'] },
  { q: '压缩 切点 算错', want: ['mem_457e04052ffa'] },
  { q: '插件 404 not found', want: ['mem_00d6a79511b8'] },
  { q: '快照 什么时候拍', want: ['mem_c7dd9903ae06'] },
]

// DSS_WORD_ROUTE=0 runs the two lexical routes alone, for the ablation in
// tools/ablate-word-route.mjs.
const engine = new MemoryEngine({
  root: ROOT,
  log: { info() {}, warn() {}, error() {} },
  config: { wordRoute: process.env.DSS_WORD_ROUTE !== '0' },
})

/** Discounted gain for a graded-relevance ranking, normalised by the ideal. */
function ndcg(ranks, relevantCount, k) {
  let dcg = 0
  for (let position = 1; position <= k; position += 1) {
    const gain = ranks.includes(position) ? 1 : 0
    dcg += gain / Math.log2(position + 1)
  }
  let idcg = 0
  for (let position = 1; position <= Math.min(relevantCount, k); position += 1) {
    idcg += 1 / Math.log2(position + 1)
  }
  return idcg === 0 ? 0 : dcg / idcg
}

let hits = 0
let reciprocalSum = 0
let ndcgSum = 0

for (const testCase of CASES) {
  const rows = (await engine.recall({ cwd: CWD, query: testCase.q, limit: 500, touch: false })).filter(
    row => !row.archived,
  )
  const ranks = testCase.want
    .map(id => rows.findIndex(row => row.id === id) + 1)
    .filter(position => position > 0)

  const firstRank = ranks.length > 0 ? Math.min(...ranks) : Infinity
  const recallAtK = ranks.some(position => position <= K)
  const mrr = firstRank === Infinity ? 0 : 1 / firstRank
  const score = ndcg(ranks, testCase.want.length, K)

  if (recallAtK) hits += 1
  reciprocalSum += mrr
  ndcgSum += score

  const verdict = recallAtK ? 'HIT ' : 'MISS'
  console.log(`${verdict}  "${testCase.q}"`)
  console.log(
    `      rank=${firstRank === Infinity ? 'none' : firstRank}  ` +
      `recall@${K}=${recallAtK ? 1 : 0}  rr=${mrr.toFixed(3)}  ndcg@${K}=${score.toFixed(3)}`,
  )
  if (!recallAtK) {
    console.log(`      top hit: "${rows[0]?.text.slice(0, 60) ?? '(nothing)'}"`)
  }
}

const n = CASES.length
console.log('')
console.log(`recall@${K}  ${(hits / n).toFixed(3)}  (${hits}/${n} queries found the memory in the top ${K})`)
console.log(`MRR        ${(reciprocalSum / n).toFixed(3)}  (mean reciprocal rank of the first correct hit)`)
console.log(`nDCG@${K}    ${(ndcgSum / n).toFixed(3)}  (whole-ranking quality, later positions discounted)`)

// MRR is the gate: a memory that lands at rank 1 for every query scores 1.0.
// Anything below 0.8 means the ranking is still putting the answer out of reach
// often enough to matter, even if recall@k happens to look fine.
const mrr = reciprocalSum / n
if (mrr < 0.8) {
  console.log(`\nMRR ${mrr.toFixed(3)} is below the 0.8 gate`)
  process.exitCode = 1
} else {
  console.log(`\nMRR ${mrr.toFixed(3)} passes the 0.8 gate`)
}
