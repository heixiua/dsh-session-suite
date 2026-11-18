/**
 * Derive the gate from data: composite score of the BEST candidate per query.
 *
 * The current gate is `cov < 0.28 && bm < 3.8` — an AND, so ANY single metric
 * above its floor lets the whole block through. The baseline shows exactly that
 * failure: junk queries at cov0.30/bm0 and cov0.16/bm3.85 both pass because one
 * number clears its floor.
 *
 * This prints a normalised composite for every labelled query so a cutoff can be
 * chosen from the observed separation rather than guessed.
 */
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { MemoryEngine } from '../../lib/memory-engine.js'

const spec = JSON.parse(await fs.readFile('tools/benchmark/queries.floor.json', 'utf8'))
const root = path.join(os.homedir(), '.dsh', 'storages', 'dsh-session-suite')
const cwd = 'D:\\AI sandbox\\dsh-sandbox\\DSH Optimize'
const engine = new MemoryEngine({ root, config: { wordRoute: false } })

const GATE_COV = 0.28
const GATE_BM = 3.8
const rows = []
for (const c of [...spec.cases.map(x => ({ ...x, kind: 'rel' })), ...spec.junk.map(x => ({ ...x, kind: 'junk' }))]) {
  const sel = await engine.select({ cwd, query: c.q, limit: 6, tiered: false })
  const best = sel.items.reduce((m, i) => {
    const cov = i.coverage ?? 0
    const bm = i.bm25 ?? 0
    // Composite: each metric normalised to its own gate, summed. A candidate
    // clearing both gates scores 2.0; clearing neither scores <1.0.
    const comp = cov / GATE_COV + bm / GATE_BM
    return !m || comp > m.comp ? { cov, bm, comp, topic: i.topic || '(none)', text: String(i.text).slice(0, 30) } : m
  }, null)
  rows.push({ kind: c.kind, q: c.q, best })
}

const pad = (s, n) => String(s).padEnd(n)
console.log('kind  composite  cov    bm     injected-best  query')
for (const r of rows) {
  const b = r.best ?? { cov: 0, bm: 0, comp: 0, topic: '-', text: '-' }
  console.log(
    `${pad(r.kind, 5)} ${b.comp.toFixed(2).padStart(8)}  ${b.cov.toFixed(3)}  ${b.bm.toFixed(2).padStart(5)}  ` +
    `${pad(b.topic, 8)} ${r.q}`,
  )
}

const rel = rows.filter(r => r.kind === 'rel').map(r => r.best?.comp ?? 0).sort((a, b) => a - b)
const junk = rows.filter(r => r.kind === 'junk').map(r => r.best?.comp ?? 0).sort((a, b) => a - b)
console.log('\nrelevant composite: ', rel.map(v => v.toFixed(2)).join(' '))
console.log('junk composite    : ', junk.map(v => v.toFixed(2)).join(' '))
console.log('\nrelevant min:', rel[0]?.toFixed(2), ' junk max:', junk[junk.length - 1]?.toFixed(2))
console.log('=> a cutoff between them separates ALL labelled queries' )
