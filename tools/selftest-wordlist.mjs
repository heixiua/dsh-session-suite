/**
 * Unit tests for the dictionary-backed segmentation route.
 *
 * The route exists to fix one specific ranking error: the character-level routes
 * cannot see word boundaries, so a memory about 车站 answers a question about 车.
 * The core regression check below pins that exact case, and the rest pin the
 * smaller claims the route makes about degradation, ASCII text and speed.
 *
 * Usage: node tools/selftest-wordlist.mjs
 */

import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { unigrams, tokens } from '../lib/retrieval.js'
import { isLoaded, loadWordList, segment, wordListSize, wordTokens } from '../lib/wordlist.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const DICT_PATH = path.join(HERE, '..', 'lib', 'data', 'jieba-dict.txt')
const DICT_TEXT = fs.readFileSync(DICT_PATH, 'utf8')
const DICT = loadWordList(DICT_TEXT)
let passed = 0

/** Run a call and return the thrown error instead of propagating it. */
function capture(fn) {
  try {
    return { value: fn() }
  } catch (error) {
    return { error }
  }
}

/** Print the check line and count it. */
function ok(description) {
  passed += 1
  console.log(`  ok  ${description}`)
}

// 1. loadWordList builds the structure, tolerates blank lines and comments, and
//    accepts either an array of lines or the whole text.
{
  const fromLines = loadWordList(['车', '车站', '', '  ', '# comment'])
  assert.equal(isLoaded(fromLines), true)
  assert.equal(wordListSize(fromLines), 2)
  const fromText = loadWordList('车\r\n车站\n')
  assert.equal(wordListSize(fromText), 2, 'a string input must be split on newlines')
  assert.equal(isLoaded(null), false)
  assert.equal(isLoaded(undefined), false)
  assert.equal(isLoaded(loadWordList([])), false, 'an empty word list is not loaded')
  assert.equal(wordListSize(null), 0)
  ok('loadWordList() builds a queryable word list and reports its state')
}

// 2. Longest match: the longest dictionary word at a position must win, so the
//    cut is not just "every character in the list".
{
  const list = loadWordList(['车', '车站', '车站台'])
  assert.deepEqual(segment('车站台', list), ['车站台'], 'the 3-word must beat the 2-word and the 1-word')
  assert.deepEqual(segment('车站', list), ['车站'])
  assert.deepEqual(segment('车', list), ['车'])
  ok('segment() prefers the longest dictionary match')
}

// 3. Out-of-vocabulary characters fall back to single characters, so the scan
//    always advances and never loses text.
{
  const list = loadWordList(['缓存'])
  assert.deepEqual(segment('缓存宕机', list), ['缓存', '宕', '机'])
  assert.equal(segment('缓存宕机', list).join(''), '缓存宕机', 'segmentation must be lossless')
  ok('segment() falls back to single characters for out-of-vocabulary text')
}

// 4. THE CORE REGRESSION. A document about 车站 must not answer a query about
//    车. The loose unigram route does contain 车 for 车站 — that is the bug this
//    route removes — so the assertion contrasts the two routes explicitly.
{
  const document = wordTokens('车站', DICT)
  assert.deepEqual(document, ['车站'], 'the real dictionary must cut 车站 as one word')
  assert.equal(document.includes('车'), false, 'wordTokens(车站) must not contain 车')
  assert.equal(document.includes('站'), false, 'wordTokens(车站) must not contain 站')
  assert.equal(
    unigrams('车站').includes('车'),
    true,
    'the unigram route is expected to contain 车; that is the mismatch being fixed',
  )
  ok('wordTokens(车站) excludes 车, unlike the loose unigram route')
}

// 5. No word list must mean degraded output, never an exception: recall has to
//    survive a missing or unreadable dictionary file.
{
  for (const call of [
    () => segment('车站', null),
    () => segment('车站', undefined),
    () => segment('checkpoint 快照', undefined),
    () => segment('', null),
    () => segment(null, null),
    () => wordTokens('车站', null),
  ]) {
    const { error } = capture(call)
    assert.equal(error, undefined, `a call without a word list threw: ${error && error.message}`)
  }
  assert.deepEqual(segment('车站', null), ['车', '站'], 'without a dictionary every character is its own token')
  assert.deepEqual(segment('checkpoint 快照', null), ['checkpoint', '快', '照'], 'ASCII words survive degradation')
  ok('an unloaded word list degrades to single characters without throwing')
}

// 6. ASCII and mixed text: English words stay whole, including when they run
//    into Chinese with no space between them.
{
  const mixed = wordTokens('checkpoint 快照', DICT)
  assert.equal(mixed.includes('checkpoint'), true)
  assert.equal(mixed.includes('快照'), true)
  assert.deepEqual(wordTokens('CheckPoint', DICT), ['checkpoint'], 'ASCII is lowercased')
  assert.deepEqual(segment('checkpoint快照', DICT), ['checkpoint', '快照'], 'no-space mixed text must not split letters')
  ok('wordTokens() keeps ASCII words whole in mixed text')
}

// 7. Normalisation must match lib/retrieval.js, or the same text would produce a
//    different vocabulary per route and fusion would compare unlike tokens.
{
  const text = 'turn/end，缓存 v2.1'
  assert.deepEqual(wordTokens(text, DICT), ['turn', 'end', '缓存', 'v2', '1'])
  assert.deepEqual(wordTokens(text, DICT), tokens(text), 'the ASCII side must match retrieval.js tokens()')
  assert.equal(wordTokens('缓存。', DICT).includes('。'), false, 'punctuation must not become a token')
  ok('wordTokens() normalises punctuation and digits like retrieval.js tokens()')
}

// 8. Duplicates must survive, because BM25 consumes term frequency rather than a
//    set of unique terms.
{
  const list = wordTokens('缓存缓存 endpoint endpoint', DICT)
  assert.equal(list.filter(token => token === '缓存').length, 2)
  assert.equal(list.filter(token => token === 'endpoint').length, 2)
  ok('wordTokens() preserves duplicate tokens for term frequency')
}

// 9. Long text must not degrade: the maximum-match loop is bounded by the
//    longest dictionary word, so a 10k-character document stays linear.
{
  const unit = '快照必须在轮次结束后拍摄，回滚会删除该轮次的产出，缓存跟随 provider 走。'
  const text = unit.repeat(Math.ceil(10000 / unit.length)).slice(0, 10000)
  const started = performance.now()
  const list = segment(text, DICT)
  const elapsed = performance.now() - started
  assert.equal(list.length > 1000, true, `expected a real segmentation, got ${list.length} tokens`)
  assert.equal(elapsed < 500, true, `10k characters took ${elapsed.toFixed(0)}ms, budget is 500ms`)
  ok(`10k-character segmentation stays under budget (${elapsed.toFixed(0)}ms)`)
}

// 10. The shipped dictionary must actually be there and be the full word list,
//     not a stub: the fetch script writes one bare word per line, no BOM.
{
  assert.equal(fs.existsSync(DICT_PATH), true, `missing ${DICT_PATH}, run node tools/fetch-jieba-dict.mjs`)
  const lines = DICT_TEXT.split('\n').filter(line => line.trim())
  assert.equal(lines.length > 100000, true, `dictionary has only ${lines.length} entries`)
  assert.equal(DICT_TEXT.charCodeAt(0) === 0xfeff, false, 'dictionary must be UTF-8 without BOM')
  assert.equal(DICT_TEXT.includes('\r'), false, 'dictionary must use \\n line endings')
  assert.equal(lines.filter(line => /\s/.test(line)).length, 0, 'dictionary must hold one bare word per line')
  assert.equal(DICT_TEXT.includes('车站'), true, 'the dictionary must contain the regression word')
  ok(`the shipped dictionary holds ${lines.length} entries, UTF-8 without BOM`)
}

// 11. The candidate length bound must come from the dictionary, not a hard cap of
//     8: the shipped list has 15-character entries and they must still match.
{
  const long = '中华人民共和国全国人民代表大会'
  assert.equal(DICT.longest >= long.length, true, `expected a word of ${long.length}+ characters`)
  assert.equal(DICT.maxLength > 8, true, 'the bound must be above 8 or long entries become unmatchable')
  assert.deepEqual(segment(long, DICT), [long], 'a 15-character dictionary word must match as one token')
  ok('the match bound is taken from the dictionary and long entries still match')
}

console.log(`\n${passed}/${passed} checks passed`)
