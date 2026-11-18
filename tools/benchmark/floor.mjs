/**
 * Measure the relevance floor on a labelled query set.
 *
 * For each relevant query: did an expected entry appear in the injected block?
 * For each junk query: how many entries were injected and at what magnitudes?
 *
 * Prints per-candidate (coverage, bm25) so a threshold can be derived from the
 * data instead of guessed. Does not mutate anything.
 */
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { MemoryEngine } from '../../lib/memory-engine.js'
import { buildRecallText } from '../../lib/memory-host.js'

const spec = JSON.parse(await fs.readFile('tools/benchmark/queries.floor.json', 'utf8'))
const root = path.join(os.homedir(), '.dsh', 'storages', 'dsh-session-suite')
const cwd = 'D:\\AI sandbox\\dsh-sandbox\\DSH Optimize'
const engine = new MemoryEngine({ root, log: () => {}, config: { wordRoute: false } })
const flatten = s => String(s ?? '').replace(/\s+/g, ' ').trim()

const live = await engine.list({ cwd })
const liveText = new Map(live.map(e => [e.id, flatten(e.text)]))
const resolve = want => {
  const ids = new Set()
  for (const frag of want) {
    for (const [id, text] of liveText) if (text.includes(flatten(frag))) ids.add(id)
  }
  return ids
}

const rows = []
for (const c of [...spec.cases.map(x => ({ ...x, kind: 'relevant' })), ...spec.junk.map(x => ({ ...x, kind: 'junk' }))]) {
  const expected = resolve(c.want)
  const sel = await engine.select({ cwd, query: c.q, limit: 6 })
  const text = await buildRecallText({ engine, cwd, question: c.q, config: {} })
  const injected = sel.items
  const hit = [...expected].some(id => injected.some(item => item.id === id))
  rows.push({
    kind: c.kind, q: c.q, expected: expected.size, injected: injected.length,
    hit, textChars: [...text].length,
    scores: injected.map(i => ({
      cov: Number((i.coverage ?? 0).toFixed(3)),
      bm: Number((i.bm25 ?? 0).toFixed(2)),
      expected: expected.has(i.id),
      topic: i.topic || '(none)',
    })),
  })
}

console.log('=== RELEVANT (want: hit=true and injected>0) ===')
for (const r of rows.filter(x => x.kind === 'relevant')) {
  console.log(`${r.hit ? 'HIT ' : 'MISS'} in=${String(r.injected).padStart(2)} chars=${String(r.textChars).padStart(4)}  ${r.q}`)
  for (const s of r.scores) console.log(`     cov=${String(s.cov).padEnd(5)} bm=${String(s.bm).padEnd(6)} ${s.expected ? '*' : ' '} ${s.topic}`)
}
console.log('\n=== JUNK (want: injected=0) ===')
for (const r of rows.filter(x => x.kind === 'junk')) {
  console.log(`in=${String(r.injected).padStart(2)} chars=${String(r.textChars).padStart(4)}  ${r.q}`)
  for (const s of r.scores) console.log(`     cov=${String(s.cov).padEnd(5)} bm=${String(s.bm).padEnd(6)} ${s.topic}`)
}

const rel = rows.filter(x => x.kind === 'relevant')
const junk = rows.filter(x => x.kind === 'junk')
console.log(`\n=== SUMMARY ===`)
console.log(`relevant hit rate: ${rel.filter(r => r.hit).length}/${rel.length}`)
console.log(`junk: ${junk.filter(r => r.injected === 0).length}/${junk.length} fully rejected`)
console.log(`junk mean injected: ${(junk.reduce((n, r) => n + r.injected, 0) / junk.length).toFixed(2)} entries, ${Math.round(junk.reduce((n, r) => n + r.textChars, 0) / junk.length)} chars`)
