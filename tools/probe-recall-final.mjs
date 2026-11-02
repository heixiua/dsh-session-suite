#!/usr/bin/env node
// A third query set, written *before* any P2 code change and not used to
// design it.
//
// probe-recall.mjs holds the six queries the coverage rerank was tuned on.
// probe-recall-heldout.mjs holds seven queries written after that work to
// expose its blind spots. Both are now development data: the synonym aliases
// and the hybrid route get designed while looking at how they fail, which
// means they can no longer be trusted as evidence that the design generalises.
//
// These ten queries are the final check. They are written from the memory
// contents only, phrased the way a user would type them, and the baseline is
// recorded before the change so the comparison is a real before/after rather
// than a post-hoc story.
//
// Usage: node tools/probe-recall-final.mjs

import os from 'node:os'
import path from 'node:path'
import { MemoryEngine } from '../lib/memory-engine.js'

const ROOT = path.join(os.homedir(), '.dsh', 'storages', 'dsh-session-suite')
const CWD = 'D:\\AI sandbox\\dsh-sandbox\\DSH Optimize'

const CASES = [
  { q: '导出的时候内部提示词泄露了', want: ['mem_1f5eefa6a14f'] },
  { q: '客户端代码里能 import 什么', want: ['mem_59920f19e258'] },
  { q: '删掉一段对话文件会不会跟着没', want: ['mem_84a1f10aea18', 'mem_a4c74b2c3a0b'] },
  { q: '为什么记忆一直显示待办', want: ['mem_330db2421287', 'mem_b7dd4be2c822'] },
  { q: '压缩以后还能不能回到压缩前的位置', want: ['mem_457e04052ffa', 'mem_c7dd9903ae06'] },
  { q: 'snapshot 面板是空的', want: ['mem_84a1f10aea18'] },
  { q: '规则越来越多是不是有问题', want: ['mem_0d0303f1c679'] },
  { q: '怎么衡量搜索准不准', want: ['mem_4fa49d7f76a3'] },
  { q: '配置里没写模型名会怎样', want: ['mem_b7dd4be2c822'] },
  { q: '同一个词既像快照又像回滚', want: ['mem_c7dd9903ae06', 'mem_a4c74b2c3a0b'] },
]

const engine = new MemoryEngine({ root: ROOT, log: { info() {}, warn() {}, error() {} } })

let hits = 0
let reciprocalSum = 0
let ndcgSum = 0

function ndcg(ranks, relevantCount, k) {
  let dcg = 0
  for (let position = 1; position <= k; position += 1) {
    if (ranks.includes(position)) dcg += 1 / Math.log2(position + 1)
  }
  let idcg = 0
  for (let position = 1; position <= Math.min(relevantCount, k); position += 1) {
    idcg += 1 / Math.log2(position + 1)
  }
  return idcg === 0 ? 0 : dcg / idcg
}

const K = 5

for (const testCase of CASES) {
  const rows = (await engine.recall({ cwd: CWD, query: testCase.q, limit: 500, touch: false })).filter(
    row => !row.archived,
  )
  const ranks = testCase.want
    .map(id => rows.findIndex(row => row.id === id) + 1)
    .filter(position => position > 0)
  const firstRank = ranks.length > 0 ? Math.min(...ranks) : Infinity
  const hit = firstRank <= K
  if (hit) hits += 1
  reciprocalSum += firstRank === Infinity ? 0 : 1 / firstRank
  ndcgSum += ndcg(ranks, testCase.want.length, K)

  console.log(`${hit ? 'HIT ' : 'MISS'}  "${testCase.q}"  rank=${firstRank === Infinity ? 'none' : firstRank}`)
}

const n = CASES.length
console.log('')
console.log(`recall@${K}  ${(hits / n).toFixed(3)}  (${hits}/${n})`)
console.log(`MRR       ${(reciprocalSum / n).toFixed(3)}`)
console.log(`nDCG@${K}   ${(ndcgSum / n).toFixed(3)}`)
