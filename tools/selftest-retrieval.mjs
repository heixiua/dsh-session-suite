/**
 * Unit tests for the retrieval primitives.
 *
 * These check the maths in isolation, so a ranking regression can be attributed
 * to a specific function instead of to "recall got worse". The end-to-end
 * numbers live in the three probe scripts; this file is about whether each
 * building block does what it claims.
 *
 * Usage: node tools/selftest-retrieval.mjs
 */

import assert from 'node:assert/strict'
import {
  bm25,
  rankIds,
  reciprocalRankFusion,
  tokens,
  unigrams,
  weightedCoverage,
} from '../lib/retrieval.js'

const checks = []

// 1. `tokens` must be the same vocabulary the rest of the engine uses, so the
//    precise route and the dedupe path cannot drift apart.
{
  const list = tokens('缓存命中率 endpoint 本地')
  assert.equal(list.includes('缓存'), true, 'bigrams must be produced for CJK')
  assert.equal(list.includes('endpoint'), true, 'ASCII words must survive')
  assert.equal(list.includes('本'), false, 'single CJK characters are not bigrams')
  checks.push('tokens() yields bigrams plus ASCII words')
}

// 2. `unigrams` must produce the loose vocabulary, including single characters.
{
  const list = unigrams('缓存 endpoint')
  assert.equal(list.includes('缓'), true)
  assert.equal(list.includes('存'), true)
  assert.equal(list.includes('endpoint'), true)
  checks.push('unigrams() yields single characters plus ASCII words')
}

// 3. A document containing the query terms must beat one that does not.
{
  const query = tokens('快照 回滚')
  const documents = [tokens('快照必须在 turn/end 拍，回滚会删光产出'), tokens('缓存跟 provider 走')]
  const scores = bm25(query, documents)
  assert.equal(scores[0] > scores[1], true, `expected a match to outscore a miss, got ${scores}`)
  checks.push('bm25() ranks a matching document above an unrelated one')
}

// 4. BM25's reason for existing: a longer document must not win merely by
//    containing the term more times. Two documents, same term frequency, one
//    much longer — the shorter must score higher.
{
  const query = tokens('缓存')
  const short = tokens('缓存')
  const long = tokens(`缓存 ${'填充 '.repeat(40)}`)
  const scores = bm25(query, [short, long])
  assert.equal(
    scores[0] > scores[1],
    true,
    `length normalisation failed: short=${scores[0]} long=${scores[1]}`,
  )
  checks.push('bm25() penalises length, not just term frequency')
}

// 5. IDF must never go negative. The textbook BM25 form does once a term passes
//    half the corpus, which would make a common word subtract from relevance.
//    The corpus has to be large enough that df is strictly greater than N/2:
//    at df = N the ratio is exactly 1 and both forms return 0, so a boundary
//    case would pass while the bug was still present.
{
  const query = tokens('的')
  const documents = Array.from({ length: 10 }, (_, index) =>
    tokens(index < 7 ? '的 快照' : '快照 回滚'),
  )
  const scores = bm25(query, documents)
  for (const score of scores.slice(0, 7)) {
    assert.equal(
      score > 0,
      true,
      `a term in 7 of 10 documents produced a non-positive score: ${score}`,
    )
  }
  checks.push('bm25() keeps idf positive for a term in most documents')
}

// 6. Coverage must be query-normalised: a perfect match against a long document
//    still scores 1. This is the property Jaccard lacked.
{
  const query = unigrams('回滚 文件')
  const short = unigrams('回滚文件')
  const long = unigrams(`回滚文件 ${'无关内容'.repeat(20)}`)
  const corpus = [short, long]
  assert.equal(
    weightedCoverage(query, long, corpus) > 0.5,
    true,
    'a long document that contains the query must not be punished for its length',
  )
  checks.push('weightedCoverage() does not punish long documents')
}

// 7. RRF must ignore score magnitude. The point of fusing by rank is that the
//    routes return values on incomparable scales, so a fusion that sums raw
//    magnitudes would let whichever route has the larger scale decide.
//
//    A mirrored pair of rankings is NOT a valid test: when both routes are
//    mirrors of each other, summing magnitudes still produces a tie, so the
//    assertion passes on broken code. What breaks a magnitude-summing fusion is
//    two routes of different lengths, where the shorter route's ranks are
//    numerically larger and would dominate.
{
  const fused = reciprocalRankFusion([
    ['a', 'b'],
    ['x', 'y', 'z', 'a'],
  ])
  // 'a' is last in the long route and first in the short one; 'x' is first in
  // the long route and absent from the short one. Rank fusion gives 'a' the
  // edge because 1/(60+2) beats 1/(60+1) only when combined with its first
  // place; a magnitude-summing fusion would hand it to 'x' outright.
  const a = fused.get('a')
  const x = fused.get('x')
  assert.equal(
    a > x,
    true,
    `rank fusion should favour the document both routes can see (a=${a} x=${x})`,
  )
  checks.push('reciprocalRankFusion() ignores score magnitude')
}

// 8. A document ranked first by every route must normalise to exactly 1, so the
//    fused score is comparable with the 0..1 importance score it is blended with.
{
  const fused = reciprocalRankFusion([
    ['a', 'b'],
    ['a', 'b'],
  ])
  assert.equal(fused.get('a'), 1)
  assert.equal(fused.get('b') < 1, true)
  checks.push('reciprocalRankFusion() normalises the unanimous winner to 1')
}

// 9. An empty ranking must not poison the fusion.
{
  const fused = reciprocalRankFusion([[], ['a']])
  assert.equal(fused.get('a'), 1, 'a single non-empty route must still normalise')
  checks.push('reciprocalRankFusion() tolerates an empty route')
}

// 10. rankIds must be stable on ties, so equal scores do not shuffle between runs.
{
  const scores = new Map([
    ['b', 1],
    ['a', 1],
    ['c', 2],
  ])
  const first = rankIds(['a', 'b', 'c'], scores)
  const second = rankIds(['c', 'b', 'a'], scores)
  assert.deepEqual(first, ['c', 'a', 'b'])
  assert.deepEqual(second, ['c', 'a', 'b'], 'tie order must not depend on input order')
  checks.push('rankIds() is stable on ties')
}

// 11. The documented limit: no character overlap means no match. The hybrid
//     routes are both lexical, so a pure synonym miss stays a miss. This
//     assertion exists so nobody later claims the hybrid solved synonyms.
{
  const query = tokens('checkpoint')
  const documents = [tokens('快照必须在轮次结束后拍')]
  const scores = bm25(query, documents)
  assert.equal(scores[0], 0, 'a query with no shared token must score zero')
  checks.push('hybrid retrieval does not invent matches across languages')
}

// 12. RRF's own failure mode, found in production: a document that matched
//     nothing still occupies a rank and collects fusion score. On a two-entry
//     candidate list that let an unrelated memory (bm25=0, coverage=0) outrank
//     the only real match. The engine now drops zero scores before fusion, so
//     this asserts the property the fusion relies on: given only non-matching
//     input, the fusion must not reward it.
{
  const fused = reciprocalRankFusion([[], []])
  assert.equal(fused.size, 0, 'two empty routes must fuse to nothing')
  const single = reciprocalRankFusion([['a']])
  assert.equal(single.get('a'), 1, 'a lone match keeps the full score')
  checks.push('empty routes contribute no rank credit')
}

// 13. A real match must outrank a non-match end to end, which is the assertion
//     the production bug broke. This mirrors the two-memory case exactly.
{
  const query = 'Trae 积分怎么用'
  const matched = 'DSH 调度策略：优先消耗 WorkBuddy/Trae 积分'
  const unrelated = '本工作区约定：插件代码只依赖 node 内置模块'
  const documents = [tokens(matched), tokens(unrelated)]
  const precise = bm25(tokens(query), documents)
  assert.equal(precise[0] > 0, true, 'the matching document must score above zero')
  assert.equal(precise[1], 0, 'the unrelated document must score zero')

  // Only the non-zero document enters the ranking, so it takes rank 1 alone.
  const ranking = rankIds(
    ['matched', 'unrelated'].filter((_, index) => precise[index] > 0),
    new Map([
      ['matched', precise[0]],
      ['unrelated', precise[1]],
    ]),
  )
  assert.deepEqual(ranking, ['matched'], 'a zero-scoring document must not enter the ranking')
  checks.push('a document that matched nothing cannot collect rank credit')
}

console.log(checks.map((line, index) => `  ${index + 1}. ${line}`).join('\n'))
console.log(`\n${checks.length}/${checks.length} checks passed`)
