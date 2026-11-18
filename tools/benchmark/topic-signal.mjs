/**
 * Does the TOPIC of a recalled entry separate relevant from junk?
 *
 * Candidate test: a query about "今晚吃什么" (food) should not pull in entries
 * whose topic is `记忆`/`git`/`插件`. If topic consistency is a clean signal, a
 * floor can use it instead of fighting with coverage/bm25 magnitudes.
 *
 * Reads the labelled set and prints, for every injected entry, the query's
 * matched topics vs the entry's topic.
 */
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { MemoryEngine } from '../../lib/memory-engine.js'

const spec = JSON.parse(await fs.readFile('tools/benchmark/queries.floor.json', 'utf8'))
const root = path.join(os.homedir(), '.dsh', 'storages', 'dsh-session-suite')
const cwd = 'D:\\AI sandbox\\dsh-sandbox\\DSH Optimize'
const engine = new MemoryEngine({ root, config: { wordRoute: false } })

// The query's topic is inferable with the same vocabulary the entries use.
const { inferTopic } = await import('../../lib/tiers.js')

for (const c of [...spec.cases, ...spec.junk]) {
  const qt = inferTopic(c.q) || '(none)'
  const sel = await engine.select({ cwd, query: c.q, limit: 6 })
  const entryTopics = sel.items.map(i => i.topic || '(none)')
  const overlap = entryTopics.filter(t => t === qt).length
  console.log(
    `${(c.want.length ? 'rel' : 'junk').padEnd(4)} qtopic=${qt.padEnd(8)} injected=${String(sel.items.length).padStart(2)} same-topic=${overlap}  ${c.q}`,
  )
  console.log(`       entry topics: ${entryTopics.join(', ') || '-'}`)
}
