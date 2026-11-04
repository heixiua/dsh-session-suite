/**
 * Fetch the jieba small dictionary and store it as a bare word list.
 *
 * Upstream ships `extra_dict/dict.txt.small` as three whitespace-separated
 * columns per line: word, frequency, part-of-speech. The retrieval route only
 * needs the word itself, so the other two columns are dropped here, once, and
 * never parsed on the recall path (recall runs offline and must stay offline).
 *
 * The upstream file is MIT-licensed (https://github.com/fxsjy/jieba); only the
 * word column is redistributed, in lib/data/jieba-dict.txt.
 *
 * Usage:
 *   node tools/fetch-jieba-dict.mjs            # skip when the output exists
 *   node tools/fetch-jieba-dict.mjs --force    # re-download and overwrite
 */

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const SOURCE = 'https://raw.githubusercontent.com/fxsjy/jieba/master/extra_dict/dict.txt.small'
const HERE = path.dirname(fileURLToPath(import.meta.url))
const OUTPUT = path.join(HERE, '..', 'lib', 'data', 'jieba-dict.txt')

// Sanity floor: dict.txt.small is ~300k entries. A much smaller file means the
// request returned an error page or a truncated body, which must not be written
// over a good word list.
const MIN_ENTRIES = 100000

const force = process.argv.includes('--force') || process.argv.includes('--overwrite')

/** Count the entries already on disk, or -1 when the file is absent. */
function existingEntries() {
  try {
    const text = fs.readFileSync(OUTPUT, 'utf8')
    return text.split('\n').filter(line => line.trim()).length
  } catch {
    return -1
  }
}

if (!force) {
  const existing = existingEntries()
  if (existing >= 0) {
    console.log(`lib/data/jieba-dict.txt already exists with ${existing} entries (use --force to re-download)`)
    process.exit(0)
  }
}

console.log(`fetching ${SOURCE}`)
const response = await fetch(SOURCE)
if (!response.ok) throw new Error(`GET ${SOURCE} -> ${response.status} ${response.statusText}`)
const body = await response.text()

const seen = new Set()
const words = []
for (const line of body.split('\n')) {
  const trimmed = line.trim()
  if (!trimmed || trimmed.startsWith('#')) continue
  // Columns 2 and 3 (frequency, part-of-speech) are dropped here.
  const word = trimmed.split(/\s+/)[0]
  if (!word || seen.has(word)) continue
  seen.add(word)
  words.push(word)
}

if (words.length < MIN_ENTRIES) {
  throw new Error(
    `refusing to write: parsed only ${words.length} entries, expected at least ${MIN_ENTRIES}. ` +
      'The upstream file may have moved or the response was truncated.',
  )
}

fs.mkdirSync(path.dirname(OUTPUT), { recursive: true })
// UTF-8 without BOM, one word per line, \n endings.
fs.writeFileSync(OUTPUT, `${words.join('\n')}\n`, 'utf8')

const bytes = fs.statSync(OUTPUT).size
console.log(`wrote ${OUTPUT}`)
console.log(`entries: ${words.length}`)
console.log(`bytes: ${bytes}`)
