/**
 * Measure whether the dense stage actually helps, using the real library and the
 * real model.
 *
 * This exists because the first live run showed something suspicious: a candidate
 * with dense=0.623 ranked BELOW one with dense=0.579. Adding a signal that reorders
 * the list is not automatically an improvement — that claim has to be measured, and
 * the honest default is to distrust it.
 *
 * Method: a small hold-out set of paraphrase queries (written now, not tuned
 * against), run twice — dense off and dense on — comparing recall@5 and MRR against
 * a known target for each query.
 */

import os from 'node:os'
import path from 'node:path'
import { MemoryEngine } from '../lib/memory-engine.js'

const root = path.join(os.homedir(), '.dsh', 'storages', 'dsh-session-suite')
const cwd = 'D:\\AI sandbox\\dsh-sandbox\\DSH Optimize'

// Each case names the phrase that must appear in the recalled memory. The queries
// are deliberately paraphrases — the case where lexical retrieval is weakest and
// the dense route is supposed to earn its place.
const CASES = [
  { query: 'checkpoint 怎么回滚', expect: '快照与回滚' },
  { query: '缓存命中率为什么走低', expect: '缓存命中率归因' },
  { query: '删除之后又被找回来', expect: '被找回' },
  { query: '记忆为什么排错序', expect: '检索排序' },
  { query: '插件加载不上怎么办', expect: 'fiberPhase' },
  { query: '发版之后版本没更新', expect: 'dist-tags' },
  { query: '压缩会不会把对话弄丢', expect: '压缩' },
  { query: '会话删掉之后还能看到', expect: '被找回' },
]

/** @param {boolean} dense @returns {Promise<{recall:number, mrr:number, rows:any[]}>} metrics */
async function measure(dense) {
  const config = dense
    ? { embedding: { enabled: true, provider: 'local', modelDir: 'D:\\AI agent cache\\dsh\\models\\bge-base-zh-v1.5' } }
    : {}
  const engine = new MemoryEngine({ root, config })
  let hits = 0
  let rr = 0
  const rows = []
  for (const item of CASES) {
    const ranked = await engine.recall({ cwd, query: item.query, limit: 5, touch: false })
    const position = ranked.findIndex(entry => String(entry.text ?? '').includes(item.expect))
    const hit = position >= 0
    if (hit) {
      hits += 1
      rr += 1 / (position + 1)
    }
    rows.push({
      query: item.query,
      expect: item.expect,
      position: hit ? position + 1 : null,
      dense: typeof ranked[0]?.dense === 'number',
    })
  }
  return { recall: hits / CASES.length, mrr: rr / CASES.length, rows }
}

const off = await measure(false)
const on = await measure(true)

console.log('query                                 dense-off  dense-on')
for (let index = 0; index < CASES.length; index += 1) {
  const a = off.rows[index].position ?? '-'
  const b = on.rows[index].position ?? '-'
  const mark = off.rows[index].position === on.rows[index].position ? '' : '  ← changed'
  console.log(`${CASES[index].query.padEnd(34)}   ${String(a).padStart(4)}      ${String(b).padStart(4)}${mark}`)
}

console.log('')
console.log(`recall@5  off ${off.recall.toFixed(3)}  on ${on.recall.toFixed(3)}  ${on.recall > off.recall ? 'UP' : on.recall < off.recall ? 'DOWN' : 'same'}`)
console.log(`MRR       off ${off.mrr.toFixed(3)}  on ${on.mrr.toFixed(3)}  ${on.mrr > off.mrr + 0.001 ? 'UP' : on.mrr < off.mrr - 0.001 ? 'DOWN' : 'same'}`)
console.log('')
console.log(on.recall >= off.recall && on.mrr >= off.mrr - 0.001
  ? 'verdict: the dense stage does not hurt these queries'
  : 'verdict: the dense stage HURTS these queries — the weight or the blend needs work')
