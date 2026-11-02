#!/usr/bin/env node
// Diagnostic: how does recall actually rank the live store for real queries?
// Prints relevance / importance / final rank side by side so a bad ranking is
// attributable to the retrieval signal rather than to importance or the scope
// bonus. Read-only: it never touches access counts.

import os from 'node:os'
import path from 'node:path'
import { MemoryEngine, shingles, similarity } from '../lib/memory-engine.js'

const ROOT = path.join(os.homedir(), '.dsh', 'storages', 'dsh-session-suite')
const CWD = 'D:\\AI sandbox\\dsh-sandbox\\DSH Optimize'

// Queries a user would plausibly type, each with the memory that *should* win.
const CASES = [
  { q: '偏差001 用户点错 提示文案', want: 'mem_91823657b3e3' },
  { q: 'fork 快照继承', want: 'mem_84a1f10aea18' },
  { q: '缓存命中率为什么下降', want: 'mem_070065e00ae2' },
  { q: '压缩 切点 算错', want: 'mem_457e04052ffa' },
  { q: '插件 404 not found', want: 'mem_00d6a79511b8' },
  { q: '快照 什么时候拍', want: 'mem_c7dd9903ae06' },
]

const engine = new MemoryEngine({ root: ROOT, log: { info() {}, warn() {}, error() {} } })

// Probe the real implementation rather than re-deriving it: a hand-copied
// formula drifts the moment the engine changes, and then the probe lies.
const settings = await engine.settings()
const all = await engine.recall({ cwd: CWD, query: '', limit: 500, touch: false })

function explain(query) {
  return engine
    .recall({ cwd: CWD, query, limit: 500, touch: false })
    .then(rows => rows.filter(row => !row.archived))
}

let failures = 0
for (const testCase of CASES) {
  const rows = await explain(testCase.q)
  const winner = rows[0]
  const want = rows.find(row => row.id === testCase.want)
  const wantPos = rows.findIndex(row => row.id === testCase.want) + 1
  const pass = winner.id === testCase.want
  if (!pass) failures += 1
  console.log(`\n${pass ? 'PASS' : 'FAIL'}  "${testCase.q}"`)
  console.log(
    `  want #${wantPos}  ${testCase.want}  cov=${want?.coverage} imp=${want?.score} rank=${want?.rank?.toFixed(3)}`,
  )
  console.log(
    `  got  #1  ${winner.id}  cov=${winner.coverage} imp=${winner.score} rank=${winner.rank.toFixed(3)}`,
  )
  if (!pass) console.log(`  why: "${winner.text.slice(0, 60)}"`)
}

console.log(`\n${CASES.length - failures}/${CASES.length} queries rank the intended memory first`)
process.exitCode = failures === 0 ? 0 : 1
