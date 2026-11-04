// Held-out queries: none of these was used while tuning the coverage rerank.
//
// The six cases in probe-recall.mjs are the queries the rerank was built
// against, so scoring 1.000 on them proves only that the code fits its own
// training set. These are deliberately phrased the way a user would type —
// synonyms, no identifiers, everyday wording — because that is where a
// shingle-based retriever is expected to fail.
//
// Usage: node tools/probe-recall-heldout.mjs

import os from 'node:os'
import path from 'node:path'
import { MemoryEngine } from '../lib/memory-engine.js'

const ROOT = path.join(os.homedir(), '.dsh', 'storages', 'dsh-session-suite')
const CWD = 'D:\\AI sandbox\\dsh-sandbox\\DSH Optimize'

// `want` is what a human would accept as an answer; `note` records why it is
// hard, so a failure is attributable to a specific retrieval weakness.
const CASES = [
  {
    q: 'checkpoint 是什么时候拍的',
    want: ['mem_c7dd9903ae06'],
    note: 'English word checkpoint vs the stored Chinese 快照 — pure synonym miss',
  },
  {
    q: '为什么提示说回滚其实是删除',
    want: ['mem_a4c74b2c3a0b', 'mem_91823657b3e3'],
    note: 'no shared identifier; must match on meaning',
  },
  {
    q: '插件加载失败怎么办',
    want: ['mem_00d6a79511b8'],
    note: '插件 + 失败 both appear, so this should hit',
  },
  {
    q: '对话压缩会不会丢信息',
    want: ['mem_457e04052ffa'],
    note: '压缩 appears; 丢信息 is a paraphrase of 追加式/不改写',
  },
  {
    q: '换模型以后缓存还有效吗',
    want: ['mem_070065e00ae2'],
    note: '缓存 + 模型 both appear — should hit despite the paraphrase',
  },
  {
    q: '怎么让 fork 出来的会话带上快照',
    want: ['mem_84a1f10aea18'],
    note: 'fork + 快照 both appear',
  },
  {
    q: '记忆为什么排错序',
    want: ['mem_dafbfb2901b5'],
    note: '排错序 vs 检索排序 — a paraphrase with no shared bigram',
  },
]

// DSS_WORD_ROUTE=0 runs the two lexical routes alone, for the ablation in
// tools/ablate-word-route.mjs.
const engine = new MemoryEngine({
  root: ROOT,
  log: { info() {}, warn() {}, error() {} },
  config: { wordRoute: process.env.DSS_WORD_ROUTE !== '0' },
})

let hits = 0
let reciprocalSum = 0

for (const testCase of CASES) {
  const rows = (await engine.recall({ cwd: CWD, query: testCase.q, limit: 500, touch: false })).filter(
    row => !row.archived,
  )
  const ranks = testCase.want
    .map(id => rows.findIndex(row => row.id === id) + 1)
    .filter(position => position > 0)
  const firstRank = ranks.length > 0 ? Math.min(...ranks) : Infinity
  const hit = firstRank <= 5
  if (hit) hits += 1
  reciprocalSum += firstRank === Infinity ? 0 : 1 / firstRank

  console.log(`${hit ? 'HIT ' : 'MISS'}  "${testCase.q}"  (${rows.length} candidates)`)
  console.log(`      rank=${firstRank === Infinity ? 'none' : firstRank}   ${testCase.note}`)
  if (!hit) {
    for (const row of rows.slice(0, 3)) {
      console.log(
        `      cov=${String(row.coverage).padEnd(5)} matched=${String(row.matchedShingles).padEnd(2)} ${row.text.slice(0, 46)}`,
      )
    }
  }
}

const n = CASES.length
const mrr = reciprocalSum / n
console.log('')
console.log(`recall@5  ${(hits / n).toFixed(3)}  (${hits}/${n})`)
console.log(`MRR       ${mrr.toFixed(3)}`)
