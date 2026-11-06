/**
 * Prove the local embedding provider loads the model and produces usable vectors.
 *
 * Run through createLocalProvider — the same function the plugin uses — so what is
 * verified here is the shipped code path, not a parallel one. The transformers
 * module is loaded from the DSH profile (where the plugin runs) and injected, because
 * an ESM import from this repository would not resolve there.
 *
 * Usage: node tools/probe-embedding.mjs
 */

import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { createLocalProvider } from '../lib/embeddings.js'
import { cosineSimilarity } from '../lib/retrieval.js'

const MODEL_DIR = 'D:\\AI agent cache\\dsh\\models\\bge-base-zh-v1.5'
const PROFILE = 'D:\\AI agent cache\\dsh\\profiles\\desktop'

const runtimeEntry = pathToFileURL(
  path.join(PROFILE, 'node_modules', '@xenova', 'transformers', 'src', 'transformers.js'),
).href

console.log('model dir :', MODEL_DIR)
console.log('runtime   :', runtimeEntry.replace('file:///', ''))

console.log('loading pipeline (first run reads 98 MB of weights)…')
const started = Date.now()
const runtime = await import(runtimeEntry)
const provider = await createLocalProvider({ modelDir: MODEL_DIR, runtime })
console.log(`provider available: ${provider.available}  (${Date.now() - started} ms)`)

if (!provider.available) {
  console.log('FAILED to activate the provider — see lib/embeddings.js for why it degrades')
  process.exit(1)
}

const query = await provider.embed('checkpoint 怎么回滚')
console.log(`query vector: ${query?.length ?? 0} dimensions`)
if (!query || query.length < 100) {
  console.log('FAILED: the model produced no usable vector')
  process.exit(1)
}

const cases = [
  ['paraphrase', 'checkpoint 怎么回滚', '快照必须在每轮结束时拍摄才能回滚'],
  ['same topic', '记忆为什么排错序', '检索要用查询覆盖率而不是对称相似度'],
  ['unrelated', 'checkpoint 怎么回滚', '今天天气怎么样'],
]

const scores = new Map()
for (const [label, question, document] of cases) {
  const questionVector = await provider.embed(question)
  const documentVector = await provider.embed(document)
  const score = cosineSimilarity(questionVector, documentVector)
  scores.set(label, score)
  console.log(`\n  ${label}`)
  console.log(`    query: ${question}`)
  console.log(`    doc  : ${document.slice(0, 44)}`)
  console.log(`    cosine: ${score.toFixed(4)}`)
}

console.log('\n=== verdict ===')
console.log(`paraphrase ${scores.get('paraphrase').toFixed(3)} vs unrelated ${scores.get('unrelated').toFixed(3)}`)
const separated = scores.get('paraphrase') > scores.get('unrelated')
console.log(
  separated
    ? 'OK — the dense route scores a paraphrase above unrelated text'
    : 'FAIL — the dense route does not separate them',
)
process.exit(separated ? 0 : 1)
