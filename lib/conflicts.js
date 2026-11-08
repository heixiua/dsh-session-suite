/**
 * Conflict detection: two memories about the same thing that cannot both be true.
 *
 * WHY A QUEUE INSTEAD OF AUTO-RESOLUTION. The library already converges a fact
 * that carries a `factKey` (lib/factkeys.js): same key, newest wins. The problem
 * is that most entries are written without a key — including every entry the
 * extractor produces — so a corrected belief is stored *next to* the belief it
 * corrects, and injection can carry both into the same prompt. Two memories
 * saying opposite things is worse than one stale memory: the model has to guess
 * which one the user settled on, and it picks by recency, which is a coin flip
 * with extra confidence.
 *
 * Picking the winner automatically is the tempting move and the wrong one.
 * "High similarity, opposite polarity" also matches a belief that has been
 * *retracted* (the user no longer holds it at all), a belief narrowed by a
 * condition, and a plan versus an observation. Those three need a human. So
 * detection is automatic and resolution is not: the pair goes to a queue, the
 * agent surfaces it, the user picks, and the engine supersedes the loser.
 *
 * THE SIGNAL. Lexical similarity puts a pair in the "talking about the same
 * thing" band; polarity tells whether they agree. `hasNegation` marks the
 * Chinese/English negation and prohibition cues. The rule is an XOR: exactly
 * one side negates or forbids. That is deliberate —
 *
 *   必须在轮次开始拍快照        vs  绝不在轮次开始拍快照      → conflict (XOR)
 *   不要用 workbuddy           vs  别用 workbuddy            → same stance, NOT flagged
 *   pnpm 会写 bundles          vs  pnpm 不会写 bundles       → conflict (XOR)
 *
 * requiring "exactly one" keeps agreement pairs (both forbid, both require) out
 * of the queue, which is what keeps the queue short enough to be worth opening.
 * The known miss: a contradiction expressed with different words and no
 * polarity (「窗口 128k」/「窗口 200k」). Numbers of different shape are a
 * separate detector; this one does not pretend to catch it.
 */

/** Negation and prohibition cues. Deliberately short: over-matching here
 *  produces queue noise, which costs attention on every open. */
const NEGATION =
  /(不|没|别|勿|毋|未|无|非|禁止|严禁|绝不|切勿|不可|不要|不用|不应|不得|never|don't|doesn't|cannot|can't|shouldn't|mustn't|avoid|instead of|rather than)/i

/**
 * Character-bigram shingles, identical to the engine's.
 *
 * Duplicated rather than imported because lib/memory-engine.js imports THIS file
 * (the conflict scan lives in maintain()); importing back would be a cycle. The
 * two must agree — a clause scored with different shingles than the pair would
 * be scored inconsistently against it.
 *
 * @param {string} text input
 * @returns {Set<string>} shingles
 */
function shinglesOf(text) {
  const normalized = String(text ?? '').toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, ' ')
  const out = new Set()
  for (const word of normalized.split(' ')) {
    if (!word) continue
    if (/^[\x00-\x7f]+$/.test(word)) {
      out.add(word)
      continue
    }
    const chars = [...word]
    if (chars.length === 1) out.add(chars[0])
    for (let index = 0; index + 1 < chars.length; index += 1) out.add(`${chars[index]}${chars[index + 1]}`)
  }
  return out
}

/**
 * @param {Set<string>} a first set
 * @param {Set<string>} b second set
 * @returns {number} Jaccard similarity 0..1
 */
function jaccard(a, b) {
  if (a.size === 0 || b.size === 0) return 0
  let shared = 0
  for (const item of a) if (b.has(item)) shared += 1
  return shared / (a.size + b.size - shared)
}

/** The same cues as removable phrases, longest first, so stripping 「不要」 does
 *  not leave the 「要」 that would otherwise read as a requirement. */
const NEGATION_PHRASES =
  /(禁止|严禁|绝不|切勿|不可|不要|不用|不应|不得|instead of|rather than|never|don't|doesn't|cannot|can't|shouldn't|mustn't|avoid|不|没|别|勿|毋|未|无|非)/gi

/** Assertion cues — a positive claim worth contradicting. */
const ASSERTION = /(必须|应当|应该|需要|可以|要用|就用|一律|总是|永远|always|must|should|only|use )/i

/**
 * The similarity window a conflict must fall in.
 *
 * The floor is the point where two entries clearly discuss one subject.
 *
 * THE CEILING IS NOT THE DUPLICATE THRESHOLD, and the first version was wrong
 * about this. The reasoning was: above `duplicateSimilarity` (0.82) the write
 * path has already reinforced one entry, so the pair cannot exist as two entries
 * — that is a dedup question, not a contradiction. Measured against the real
 * library, that premise was false twice over:
 *
 *   • two entries DO exist above 0.82, because a corrected belief used to land in
 *     the duplicate branch and be silently discarded (fixed in remember(): a
 *     near-duplicate with opposite polarity now inserts instead of reinforcing);
 *   • a real correction scores high. Flipping 必须→绝对不要 inside a 95-character
 *     rule scores 0.879 — over the old ceiling, so the pair was invisible to the
 *     scan while being exactly the contradiction it exists to catch.
 *
 * The ceiling now sits just under 1.0, above which the two texts are the same
 * memory with a punctuation difference and no stance change is meaningful.
 */
export const CONFLICT_BAND = { min: 0.4, max: 0.99 }

/**
 * Whether a text negates or forbids.
 *
 * @param {string} text memory text
 * @returns {boolean} true when a negation/prohibition cue is present
 */
export function hasNegation(text) {
  return NEGATION.test(String(text ?? ''))
}

/**
 * Whether a text makes a positive claim.
 *
 * @param {string} text memory text
 * @returns {boolean} true when an assertion cue is present
 */
export function hasAssertion(text) {
  return ASSERTION.test(String(text ?? ''))
}

/**
 * The stance a text takes: `negative`, `positive`, or `mixed`.
 *
 * A text that both requires something AND negates something is not necessarily
 * making a single polar claim. The regression that forced this: 「提交代码前必须
 * 运行 selftest 确认没有回归」 contains 必须 and 没有, and treating 没有 as a stance
 * made it "contradict" its sibling 「…必须运行 selftest 测试套件」, which then
 * excluded both from rule building and silently stopped the library from
 * abstracting anything.
 *
 * But `mixed` cannot simply bail out, because REAL memories are long and almost
 * always contain both kinds of cue — measured on this library, 29 of 64 active
 * entries are mixed. Bailing made the detector blind on exactly the entries that
 * matter. So the question is positional: a negation that comes AFTER the first
 * requirement is a subordinate clause ("do X and confirm nothing broke"); a
 * negation that comes BEFORE any requirement is the main clause ("never do X"),
 * with requirements appearing later as context.
 *
 * A text with no cue at all is `positive`: it makes a plain claim, and a plain
 * claim is what a prohibition contradicts.
 *
 * @param {string} text memory text
 * @returns {'negative'|'positive'|'mixed'} stance
 */
export function polarityOf(text) {
  const raw = String(text ?? '')
  const negated = hasNegation(raw)
  if (!negated) return 'positive'
  // Strip the negation cues before looking for a requirement, so 「不要用 X」 does
  // not read as "requires AND forbids" just because 要 survives the strip.
  const stripped = raw.replace(NEGATION_PHRASES, ' ')
  const asserted = ASSERTION.test(stripped)
  if (!asserted) return 'negative'
  // Both are present. Position decides which one is the main clause.
  const firstNegation = NEGATION.exec(raw)
  const firstAssertion = ASSERTION.exec(stripped)
  if (!firstNegation || !firstAssertion) return 'mixed'
  // `stripped` has the negation phrases replaced by spaces, so indexes do not
  // line up; compare in the ORIGINAL text instead.
  const originalAssertion = ASSERTION.exec(raw)
  if (!originalAssertion) return 'mixed'
  return firstNegation.index < originalAssertion.index ? 'negative' : 'mixed'
}

/**
 * Split a text into clauses.
 *
 * Whole-text polarity cannot work on real memories. Measured on this library:
 * 29 of 64 active entries contain BOTH requirement and negation cues, because a
 * real memory is several clauses long ("快照必须在 turn/end 拍…在轮次开始拍会导致
 * 回滚把本轮产出全删光"). Asking "does this text negate?" has no answer for a
 * text like that, and answering `mixed` made 20 of 45 constructed contradictions
 * invisible.
 *
 * The unit that carries a stance is the clause. Splitting on sentence and clause
 * punctuation and comparing clause-by-clause lets a change in ONE clause be
 * visible even when the surrounding text is unchanged.
 *
 * @param {string} text memory text
 * @returns {string[]} clauses, trimmed, empties dropped
 */
export function clauses(text) {
  return String(text ?? '')
    .split(/[。；;！!？?\n]+/)
    .map(part => part.trim())
    .filter(Boolean)
}

/**
 * Does a clause state a prohibition or a negation of its own?
 *
 * @param {string} clause one clause
 * @returns {'negative'|'positive'} stance
 */
function clausePolarity(clause) {
  return polarityOf(clause) === 'negative' ? 'negative' : 'positive'
}

/**
 * Do two texts disagree in a way the whole-text stance test misses?
 *
 * Walks the clauses of both sides, pairs them by similarity, and looks for a
 * pair that is about the same thing but takes opposite stances. This is what
 * catches a correction inside a long memory: the rest of the text is identical,
 * so the whole-text comparison sees one polarity per side and calls it agreement.
 *
 * @param {string} textA first text
 * @param {string} textB second text
 * @returns {{conflict: boolean, clauseA?: string, clauseB?: string}} verdict
 */
export function clauseConflict(textA, textB) {
  const listA = clauses(textA)
  const listB = clauses(textB)
  if (listA.length === 0 || listB.length === 0) return { conflict: false }
  for (const a of listA) {
    const shinglesA = shinglesOf(a)
    let bestMatch
    let bestScore = 0
    for (const b of listB) {
      const score = jaccard(shinglesA, shinglesOf(b))
      if (score > bestScore) {
        bestScore = score
        bestMatch = b
      }
    }
    // The clause must be about the SAME thing (otherwise any two clauses in the
    // same document would "conflict"), and take the opposite stance.
    if (!bestMatch || bestScore < 0.5) continue
    if (clausePolarity(a) !== clausePolarity(bestMatch)) {
      return { conflict: true, clauseA: a, clauseB: bestMatch }
    }
  }
  return { conflict: false }
}

/**
 * Decide whether two memories contradict each other.
 *
 * @param {{text?: string}} a first entry
 * @param {{text?: string}} b second entry
 * @param {number} similarity lexical similarity of the two texts, 0..1
 * @param {{min?: number, max?: number}} [band] similarity window override
 * @returns {{conflict: boolean, reason: string, similarity: number}} verdict
 */
export function detectConflict(a, b, similarity, band = CONFLICT_BAND) {
  const min = typeof band?.min === 'number' ? band.min : CONFLICT_BAND.min
  const max = typeof band?.max === 'number' ? band.max : CONFLICT_BAND.max
  const sim = Number(similarity) || 0
  if (!(sim >= min && sim < max)) {
    return {
      conflict: false,
      reason: sim < min ? 'below-topic-floor' : 'above-duplicate-threshold',
      similarity: sim,
    }
  }
  // Clause-level first: it is the only signal that survives a long memory, and a
  // correction inside an otherwise identical text is the most important case.
  const byClause = clauseConflict(a?.text, b?.text)
  if (byClause.conflict) {
    return { conflict: true, reason: 'opposite-polarity', similarity: sim, clauseA: byClause.clauseA, clauseB: byClause.clauseB }
  }
  const stanceA = polarityOf(a?.text)
  const stanceB = polarityOf(b?.text)
  // No clause disagrees. A text that both requires and negates is making two
  // claims, and the similarity score does not say which clause the match is
  // about — so a whole-text `mixed` verdict is not evidence of a contradiction.
  if (stanceA === 'mixed' || stanceB === 'mixed') {
    return { conflict: false, reason: 'subordinate-negation', similarity: sim }
  }
  if (stanceA === stanceB) {
    return {
      conflict: false,
      reason: stanceA === 'negative' ? 'both-negated' : 'neither-negated',
      similarity: sim,
    }
  }
  const negated = stanceA === 'negative' ? 'a' : 'b'
  const positiveText = negated === 'a' ? b?.text : a?.text
  // With one side negating, an explicit requirement on the other side makes the
  // opposition obvious ("必须 X" vs "不要 X"). A plain claim against a
  // prohibition is still worth a look, just weaker — flagged with a
  // lower-confidence reason so a caller can surface only the strong ones.
  return {
    conflict: true,
    reason: hasAssertion(positiveText) ? 'opposite-polarity' : 'polarity-mismatch',
    negated,
    similarity: sim,
  }
}

/**
 * A stable id for a pair, so a conflict is queued once however often the scan
 * runs. Order-insensitive: (a,b) and (b,a) are one conflict.
 *
 * @param {string} idA first entry id
 * @param {string} idB second entry id
 * @returns {string} pair key
 */
export function pairKey(idA, idB) {
  return [String(idA), String(idB)].sort().join('::')
}
