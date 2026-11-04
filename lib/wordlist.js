/**
 * Dictionary-backed word segmentation, deliberately free of I/O.
 *
 * The engine already has two lexical routes, bigrams and unigrams. Both are
 * character-level, which gives them one shared error profile: neither knows
 * where a word ends. `车` is a query term on its own, but the bigram and unigram
 * routes emit their pieces for `车站` as well, so a memory about 车站 answers a
 * question about 车. No amount of rank fusion between two routes that share a
 * blind spot can fix that.
 *
 * This module adds a third route that *does* know word boundaries: forward
 * maximum matching against a general-purpose Chinese word list (the jieba small
 * dictionary, MIT, stored at lib/data/jieba-dict.txt). It is a pure function
 * module — no file reads here, the caller loads the list once and passes it in —
 * so the recall path stays offline and testable.
 *
 * The route is deliberately not "better" than the others, just different, which
 * is the whole point of fusing by rank: it fails on out-of-vocabulary terms
 * (names, code identifiers, new slang) where the character routes still work.
 * Its failure mode and theirs do not overlap.
 */

/**
 * Safety bound on the longest candidate scored at each position, in UTF-16 code
 * units. The real bound is the longest word actually present (15 units in the
 * shipped dictionary), so this only exists to stop a pathological word list
 * from turning matching into quadratic work. It is above the shipped maximum on
 * purpose: a lower cap such as 8 would make every entry longer than 8
 * characters, e.g. 中华人民共和国全国人民代表大会, unmatchable.
 */
const MAX_WORD_LENGTH = 16

/** A chunk made only of ASCII is a word, exactly as lib/retrieval.js treats it. */
const ASCII_ONLY = /^[\x00-\x7f]+$/

/** Same normalisation as lib/retrieval.js's tokens(): lowercase, punctuation to space. */
const SEPARATORS = /[\s\p{P}\p{S}]+/gu

/**
 * Build the lookup structure the segmenter queries.
 *
 * Accepts an array of lines (what `readFileSync(...).split('\n')` gives) or the
 * whole text; blank lines are skipped, so a word list with a trailing newline or
 * a stray blank line is not a problem. Words are kept verbatim apart from
 * trimming — case folding happens at match time, because the dictionary is
 * Chinese and lowercasing 300k entries buys nothing.
 *
 * @param {string[] | string} lines word list, one word per line
 * @returns {{ words: Set<string>, size: number, longest: number, maxLength: number }} opaque word list
 */
export function loadWordList(lines) {
  const source = typeof lines === 'string' ? lines.split(/\r?\n/) : lines ?? []
  const words = new Set()
  let longest = 0
  for (const line of source) {
    if (line == null) continue
    const word = String(line).trim()
    if (!word || word.startsWith('#')) continue
    words.add(word)
    if (word.length > longest) longest = word.length
  }
  return Object.freeze({
    words,
    size: words.size,
    longest,
    maxLength: Math.min(longest || 1, MAX_WORD_LENGTH),
  })
}

/**
 * Whether a word list carries any words.
 *
 * Everything else in this module treats a null, undefined, empty or malformed
 * word list as "not loaded" and degrades instead of throwing: recall must never
 * fail because a data file is missing.
 *
 * @param {object} [wordlist] value returned by loadWordList()
 * @returns {boolean} true when segmentation can use a dictionary
 */
export function isLoaded(wordlist) {
  return Boolean(wordlist && wordlist.words instanceof Set && wordlist.words.size > 0)
}

/**
 * Number of words in a word list, 0 when it is absent or empty.
 *
 * @param {object} [wordlist] value returned by loadWordList()
 * @returns {number} entry count
 */
export function wordListSize(wordlist) {
  return isLoaded(wordlist) ? wordlist.size : 0
}

/** @param {string} char single code point @returns {boolean} true for ASCII */
function isAsciiChar(char) {
  return char.charCodeAt(0) < 0x80
}

/**
 * Forward maximum matching segmentation.
 *
 * At each position the longest candidate that is in the dictionary wins; when
 * nothing matches beyond the first character, that single character is emitted
 * and the scan moves on, so the function is total over any input. Longest rather
 * than shortest is what makes `车站` one token instead of `车` + `站`, which is
 * the cross-word mismatch this route exists to remove.
 *
 * ASCII runs inside mixed text are emitted as one word each, so `checkpoint快照`
 * yields `checkpoint` and the Chinese tokens rather than one letter per token.
 *
 * Degradation: with no word list loaded every CJK character becomes its own
 * token. That is deliberately *not* an empty result — the route then contributes
 * the same loose signal the unigram route already provides and simply adds
 * nothing new, which is safer for recall than silently returning nothing.
 *
 * @param {string} text input
 * @param {object} [wordlist] value returned by loadWordList()
 * @returns {string[]} tokens in order, duplicates preserved
 */
export function segment(text, wordlist) {
  const out = []
  const words = isLoaded(wordlist) ? wordlist.words : null
  const maxLength = words ? wordlist.maxLength : 1
  const normalized = String(text ?? '').toLowerCase().replace(SEPARATORS, ' ')

  for (const chunk of normalized.split(' ')) {
    if (!chunk) continue
    if (ASCII_ONLY.test(chunk)) {
      out.push(chunk)
      continue
    }
    const chars = [...chunk]
    let index = 0
    while (index < chars.length) {
      if (isAsciiChar(chars[index])) {
        let end = index + 1
        while (end < chars.length && isAsciiChar(chars[end])) end += 1
        out.push(chars.slice(index, end).join(''))
        index = end
        continue
      }
      if (!words) {
        out.push(chars[index])
        index += 1
        continue
      }
      const remaining = chars.length - index
      let length = Math.min(maxLength, remaining)
      let token = ''
      for (; length > 1; length -= 1) {
        const candidate = chars.slice(index, index + length).join('')
        if (words.has(candidate)) {
          token = candidate
          break
        }
      }
      if (!token) {
        token = chars[index]
        length = 1
      }
      out.push(token)
      index += length
    }
  }
  return out
}

/**
 * The token list the retrieval layer feeds to BM25.
 *
 * This is the same cut as `segment()`; the two names exist because the retrieval
 * code asks for "tokens" while the segmentation itself is the primitive. Either
 * can be used, but this one is the documented entry point: it mirrors
 * lib/retrieval.js's `tokens()` / `unigrams()` shape, and it keeps duplicates
 * because BM25 consumes term frequency rather than a set.
 *
 * @param {string} text input
 * @param {object} [wordlist] value returned by loadWordList()
 * @returns {string[]} tokens in order, duplicates preserved
 */
export function wordTokens(text, wordlist) {
  return segment(text, wordlist)
}
