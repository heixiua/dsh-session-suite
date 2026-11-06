/**
 * P2: two-stage retrieval — lexical candidates, then dense reranking.
 *
 * The engine already fuses two lexical routes with RRF, which recovers ordering
 * among memories that ARE reachable but cannot invent a match when no character
 * is shared (checkpoint vs 快照). A dense model fixes that; this test pins the
 * reranking contract without needing a model installed, because the arithmetic has
 * to be right before a 400MB download is worth doing.
 *
 * The rules that matter:
 *   1. no vectors → input order is returned untouched (degrade, never throw);
 *   2. a better semantic match moves up;
 *   3. lexical agreement is interpolated, not overwritten;
 *   4. a candidate whose embedding failed keeps its lexical standing instead of
 *      being deleted from the results;
 *   5. cosine is symmetric and scale-invariant.
 *
 * Usage: node tools/selftest-rerank.mjs
 */

import assert from 'node:assert/strict'
import fs from 'node:fs'
import { cosineSimilarity, rerankBySimilarity } from '../lib/retrieval.js'
import { DISABLED_PROVIDER, createEmbeddingProvider } from '../lib/embeddings.js'

const checks = []

// 1. Cosine basics: identical, orthogonal, opposite, degenerate.
{
  assert.equal(cosineSimilarity([1, 0, 0], [1, 0, 0]).toFixed(6), '1.000000')
  assert.equal(cosineSimilarity([1, 0], [0, 1]).toFixed(6), '0.000000')
  assert.equal(cosineSimilarity([1, 0], [-1, 0]).toFixed(6), '-1.000000')
  assert.equal(cosineSimilarity([], []), 0, 'empty vectors are not similar')
  assert.equal(cosineSimilarity([0, 0], [1, 1]), 0, 'a zero vector has no direction')
  checks.push('cosine handles identical, orthogonal, opposite, and degenerate vectors')
}

// 2. Scale invariance: embedding magnitude must not decide the ranking.
{
  const a = [1, 2, 3]
  const scaled = a.map(value => value * 1000)
  assert.equal(cosineSimilarity(a, scaled).toFixed(6), '1.000000', 'scaling must not change cosine')
  checks.push('cosine is scale-invariant')
}

// 3. No vectors at all: the exact input order survives, and nothing throws.
{
  const candidates = [{ id: 'a' }, { id: 'b' }, { id: 'c' }]
  const out = rerankBySimilarity(candidates, undefined, new Map())
  assert.deepEqual(out.map(item => item.id), ['a', 'b', 'c'])
  const out2 = rerankBySimilarity(candidates, [1, 0], new Map())
  assert.deepEqual(out2.map(item => item.id), ['a', 'b', 'c'], 'an empty vector map means no reranking')
  checks.push('missing vectors return the input order untouched')
}

// 4. A closer semantic match moves up.
{
  const candidates = [{ id: 'far' }, { id: 'near' }]
  const query = [1, 0]
  const vectors = new Map([
    ['far', [0, 1]],
    ['near', [1, 0]],
  ])
  const out = rerankBySimilarity(candidates, query, vectors)
  assert.deepEqual(out.map(item => item.id), ['near', 'far'], 'the closer vector must rank first')
  checks.push('a closer semantic match moves up')
}

// 5. Lexical agreement is interpolated, so a strong lexical hit with a weak dense
//    score is not simply thrown away.
{
  const candidates = [{ id: 'lexical' }, { id: 'dense' }]
  const query = [1, 0]
  const vectors = new Map([
    ['lexical', [0.2, 0.98]],
    ['dense', [1, 0]],
  ])
  const lexical = new Map([
    ['lexical', 1],
    ['dense', 0],
  ])
  // weight 0.5 → lexical: 0.5*1 + 0.5*0.2 = 0.6 ; dense: 0.5*0 + 0.5*1 = 0.5
  const out = rerankBySimilarity(candidates, query, vectors, { lexical, weight: 0.5 })
  assert.deepEqual(
    out.map(item => item.id),
    ['lexical', 'dense'],
    'a perfect lexical hit plus a modest dense score must still win',
  )
  checks.push('lexical agreement is interpolated, not overwritten')
}

// 6. High weight trusts the dense score fully.
{
  const candidates = [{ id: 'lexical' }, { id: 'dense' }]
  const query = [1, 0]
  const vectors = new Map([
    ['lexical', [0.2, 0.98]],
    ['dense', [1, 0]],
  ])
  const lexical = new Map([
    ['lexical', 1],
    ['dense', 0],
  ])
  const out = rerankBySimilarity(candidates, query, vectors, { lexical, weight: 1 })
  assert.deepEqual(out.map(item => item.id), ['dense', 'lexical'], 'weight 1 must follow the dense score')
  checks.push('weight 1 follows the dense score only')
}

// 7. A candidate with no vector keeps its lexical standing and stays present.
{
  const candidates = [{ id: 'has-vector' }, { id: 'no-vector' }]
  const query = [1, 0]
  const vectors = new Map([['has-vector', [0, 1]]])
  const lexical = new Map([
    ['has-vector', 0.1],
    ['no-vector', 0.9],
  ])
  const out = rerankBySimilarity(candidates, query, vectors, { lexical, weight: 0.5 })
  assert.equal(out.length, 2, 'a failed embedding must not delete the candidate')
  assert.deepEqual(out.map(item => item.id), ['no-vector', 'has-vector'], 'the un-embedded candidate keeps its prior')
  checks.push('a candidate with no vector keeps its lexical standing')
}

// 8. The reranker must not invent candidates: output length equals input length.
{
  const candidates = [{ id: 'a' }, { id: 'b' }, { id: 'c' }]
  const vectors = new Map([['a', [1, 0]], ['b', [0, 1]]])
  const out = rerankBySimilarity(candidates, [1, 0], vectors)
  assert.equal(out.length, candidates.length)
  assert.deepEqual(new Set(out.map(item => item.id)), new Set(['a', 'b', 'c']))
  checks.push('reranking reorders without adding or dropping candidates')
}

// 9. With no embedding configured, the provider is disabled and does nothing —
//    this is what makes the feature installable by default without a download.
{
  assert.equal(DISABLED_PROVIDER.available, false)
  assert.equal(await DISABLED_PROVIDER.embed('anything'), undefined)
  const fromEmpty = await createEmbeddingProvider({})
  assert.equal(fromEmpty.available, false, 'no config means no provider')
  const fromHalfConfig = await createEmbeddingProvider({ embedding: { enabled: true, provider: 'remote' } })
  assert.equal(fromHalfConfig.available, false, 'an incomplete remote config must not throw')
  checks.push('an unconfigured provider is disabled rather than throwing')
}

// 10. A model directory that does not exist yields the disabled provider instead
//     of attempting a download.
//
//     Asserted on the guard itself as well as on the outcome: deleting the
//     filesystem check still yields a disabled provider in this environment (the
//     transformers runtime is not installed either), so an outcome-only check
//     cannot see that mutation.
{
  const embeddingSource = fs.readFileSync('lib/embeddings.js', 'utf8')
  assert.equal(
    /if \(!fs\.existsSync\(modelDir\)\) return DISABLED_PROVIDER/.test(embeddingSource),
    true,
    'the provider must refuse a model directory that is not on disk',
  )
  const provider = await createEmbeddingProvider({
    root: 'D:/definitely/not/a/real/root',
    embedding: { enabled: true, provider: 'local', model: 'bge-base-zh-v1.5' },
  })
  assert.equal(provider.available, false, 'a missing model directory must not activate the provider')
  checks.push('a missing model directory does not activate the provider')
}

// 11. Nothing in this module may download a model implicitly.
//
//     The pipeline must be created so that transformers.js resolves it LOCALLY:
//     allowRemoteModels has to be switched off before construction, and the model id
//     passed to pipeline() must be the folder name while localModelPath holds the
//     parent. Passing an absolute path as the id defeats the join and makes the
//     runtime fetch from Hugging Face — measured as a CONNECT_TIMEOUT, which reads
//     like a network fault rather than the configuration bug it is.
{
  const embeddingSource = fs.readFileSync('lib/embeddings.js', 'utf8')
  assert.equal(
    /allowRemoteModels\s*=\s*false/.test(embeddingSource),
    true,
    'the provider must switch off remote fetching',
  )
  assert.equal(
    /localModelPath\s*=\s*parent/.test(embeddingSource),
    true,
    'localModelPath must be set to the parent directory',
  )
  assert.equal(
    /modelId\s*=\s*path\.basename\(modelDir\)/.test(embeddingSource),
    true,
    'the pipeline id must be the folder name, not an absolute path',
  )
  // The construction call must use the resolved id rather than the raw path.
  assert.equal(
    /transformers\.pipeline\(pipeline,\s*modelId\)/.test(embeddingSource),
    true,
    'the pipeline must be constructed with the locally-resolved id',
  )
  checks.push('no implicit download path exists')
}

console.log(checks.map((line, index) => `  ${index + 1}. ${line}`).join('\n'))
console.log(`\n${checks.length}/${checks.length} checks passed`)
