/**
 * Retrieval primitives, deliberately free of I/O and of the memory engine.
 *
 * The engine used to rank with a single lexical signal: bigram coverage weighted
 * by inverse document frequency. That works for precision but has one error
 * profile, and a single route cannot outvote itself. Chapter 3 of *深入理解
 * AI Agent* describes the standard remedy as hybrid retrieval: run several
 * routes with *different* blind spots, then fuse them by rank rather than by
 * score, because the scores live on incomparable scales (cosine 0..1 versus
 * BM25 0..50).
 *
 * The book's example fuses a dense route with a sparse one. We have no embedding
 * model on the recall path — recall runs offline and must stay offline — so this
 * module fuses two *lexical* routes chosen to fail differently:
 *
 *   - bigrams (two-character sequences): precise, but blind to any paraphrase
 *     that does not reproduce the exact pair, and blind to single characters.
 *   - unigrams (single characters plus ASCII words): loose, noisy, but it still
 *     finds a memory when only part of the query vocabulary overlaps.
 *
 * Fusing them is not a substitute for a dense route. It recovers ranking order
 * among memories that are already reachable, and it cannot invent a match where
 * no character is shared at all. That limit is documented rather than papered
 * over.
 */

/**
 * Tokenise into the bigram-plus-word vocabulary used for precise matching.
 *
 * Returns an array *with multiplicity*, because BM25 needs term frequency. The
 * set form is the same vocabulary deduplicated, so `new Set(tokens(text))` is
 * exactly the shingle set the rest of the engine already uses.
 *
 * @param {string} text input
 * @returns {string[]} tokens, duplicates preserved
 */
export function tokens(text) {
  const normalized = String(text ?? '').toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, ' ')
  const out = []
  for (const word of normalized.split(' ')) {
    if (!word) continue
    if (/^[\x00-\x7f]+$/.test(word)) {
      out.push(word)
      continue
    }
    const chars = [...word]
    if (chars.length === 1) out.push(chars[0])
    for (let index = 0; index + 1 < chars.length; index += 1) out.push(`${chars[index]}${chars[index + 1]}`)
  }
  return out
}

/**
 * Tokenise into the loose vocabulary: every single character, plus ASCII words.
 *
 * A CJK character carries far less meaning than a bigram, which is exactly the
 * point — this route tolerates a query that shares only part of a word, which
 * the bigram route cannot.
 *
 * @param {string} text input
 * @returns {string[]} tokens, duplicates preserved
 */
export function unigrams(text) {
  const normalized = String(text ?? '').toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, ' ')
  const out = []
  for (const word of normalized.split(' ')) {
    if (!word) continue
    if (/^[\x00-\x7f]+$/.test(word)) {
      out.push(word)
      continue
    }
    for (const char of word) out.push(char)
  }
  return out
}

/** @param {string[]} list @returns {Map<string, number>} term frequencies */
function termFrequency(list) {
  const out = new Map()
  for (const token of list) out.set(token, (out.get(token) ?? 0) + 1)
  return out
}

/**
 * Inverse document frequency, always positive.
 *
 * The textbook form `ln((N - df + 0.5) / (df + 0.5))` goes negative once a term
 * appears in more than half the documents, which would make a common word
 * *subtract* from relevance. Chapter 3 notes the same problem and recommends a
 * floor; wrapping the ratio in `ln(1 + ...)` is the floor, and it is what
 * production search engines actually ship.
 *
 * @param {number} total document count
 * @param {number} seen document frequency
 * @returns {number} idf, > 0
 */
function idf(total, seen) {
  return Math.log(1 + (total - seen + 0.5) / (seen + 0.5))
}

/**
 * BM25 relevance of every document to one query.
 *
 * BM25 is the correction the book describes for TF-IDF's two weaknesses: raw
 * term frequency grows without bound, and long documents win merely by being
 * long. `k1` makes repeated occurrences saturate; `b` normalises by length.
 *
 * @param {string[]} queryTokens query, with multiplicity
 * @param {string[][]} documentTokens one token list per document
 * @param {object} [options] tuning
 * @param {number} [options.k1] term-frequency saturation, default 1.5
 * @param {number} [options.b] length normalisation strength, default 0.75
 * @returns {number[]} one score per document, in input order
 */
export function bm25(queryTokens, documentTokens, options = {}) {
  const k1 = options.k1 ?? 1.5
  const b = options.b ?? 0.75
  const total = documentTokens.length
  if (total === 0) return []

  const frequencies = documentTokens.map(termFrequency)
  const lengths = documentTokens.map(list => list.length)
  const averageLength = lengths.reduce((sum, value) => sum + value, 0) / total || 1

  const seen = new Map()
  for (const frequency of frequencies) {
    for (const token of frequency.keys()) seen.set(token, (seen.get(token) ?? 0) + 1)
  }

  const queryFrequency = termFrequency(queryTokens)
  const scores = new Array(total).fill(0)

  for (let index = 0; index < total; index += 1) {
    const length = lengths[index]
    let score = 0
    for (const [token, queryCount] of queryFrequency) {
      const frequency = frequencies[index].get(token) ?? 0
      if (frequency === 0) continue
      const weight = idf(total, seen.get(token) ?? 0)
      const saturation = (frequency * (k1 + 1)) / (frequency + k1 * (1 - b + (b * length) / averageLength))
      score += weight * saturation * Math.min(queryCount, 3)
    }
    scores[index] = score
  }
  return scores
}

/**
 * IDF-weighted fraction of the query that a document accounts for.
 *
 * Coverage, not Jaccard: a memory may be far longer than the query, and being
 * long must not be a penalty when the question is "did it contain what I asked".
 * This is the loose route's scoring function; the precise route uses BM25.
 *
 * @param {string[]} queryTokens query, with multiplicity
 * @param {string[]} documentTokens document, with multiplicity
 * @param {string[][]} allDocumentTokens corpus, for document frequency
 * @returns {number} coverage 0..1
 */
export function weightedCoverage(queryTokens, documentTokens, allDocumentTokens) {
  const querySet = new Set(queryTokens)
  if (querySet.size === 0) return 0
  const documentSet = new Set(documentTokens)
  const total = allDocumentTokens.length || 1
  const seen = new Map()
  for (const list of allDocumentTokens) {
    for (const token of new Set(list)) seen.set(token, (seen.get(token) ?? 0) + 1)
  }
  let matched = 0
  let available = 0
  for (const token of querySet) {
    const weight = idf(total, seen.get(token) ?? 0)
    available += weight
    if (documentSet.has(token)) matched += weight
  }
  return available > 0 ? matched / available : 0
}

/**
 * Reciprocal Rank Fusion.
 *
 * Fusing by rank rather than by score is the whole point: BM25 returns values
 * spanning tens, coverage returns 0..1, and adding them would let whichever
 * route has the larger scale decide the outcome. RRF ignores the magnitudes and
 * keeps only the ordering, which is the part both routes agree is meaningful.
 *
 * @param {Array<Array<string | number>>} rankings each route's ids, best first
 * @param {number} [k] smoothing constant; 60 is the customary default
 * @returns {Map<string | number, number>} fused score, normalised to 0..1
 */
export function reciprocalRankFusion(rankings, k = 60) {
  const fused = new Map()
  const routes = rankings.filter(ranking => ranking.length > 0)
  for (const ranking of routes) {
    ranking.forEach((id, index) => {
      fused.set(id, (fused.get(id) ?? 0) + 1 / (k + index + 1))
    })
  }
  // Normalise so a document ranked first by every route scores 1, keeping the
  // fused signal comparable to the 0..1 importance score it is combined with.
  if (routes.length > 0) {
    const ceiling = routes.length / (k + 1)
    for (const [id, score] of fused) fused.set(id, score / ceiling)
  }
  return fused
}

/**
 * Order ids by a score map, best first, with a stable tiebreak.
 *
 * @param {Array<string | number>} ids candidates
 * @param {Map<string | number, number>} scores score per id
 * @returns {Array<string | number>} sorted ids
 */
export function rankIds(ids, scores) {
  return [...ids].sort((a, b) => (scores.get(b) ?? 0) - (scores.get(a) ?? 0) || String(a).localeCompare(String(b)))
}
