/**
 * Final pre-release audit of P2b + P3 against the LIVE library (read-only).
 *
 * Answers the four questions a release has to be able to answer:
 *   1. does the conflict scan fire on the real store, and if not, why not;
 *   2. does the correction fix hold on real entries (no swallowed corrections);
 *   3. how often does pain distillation fire on real transcripts;
 *   4. is any of it going to write into the library behind the user's back?
 *
 * Read-only: it never calls remember(), settleConflict() or maintain().
 *
 * Usage: node tools/_audit-p2p3.mjs
 */

import fs from 'node:fs'
import zlib from 'node:zlib'
import path from 'node:path'
import os from 'node:os'
import { MemoryEngine, shingles, similarity } from '../lib/memory-engine.js'
import { CONFLICT_BAND, detectConflict } from '../lib/conflicts.js'
import { detectPain, distillLessons } from '../lib/pain.js'

const store = path.join(os.homedir(), '.dsh', 'storages', 'dsh-session-suite')
const cwd = 'D:\\AI sandbox\\dsh-sandbox\\DSH Optimize'
const engine = new MemoryEngine({ root: store, config: {} })

console.log('=== 1. conflict scan on the live store (read-only)')
const entries = (await engine.list({ cwd })).filter(
  row => !row.archived && !row.supersededBy && !row.summary && String(row.text).trim(),
)
console.log(`active entries: ${entries.length}`)
let pairsInBand = 0
let flagged = 0
for (let i = 0; i < entries.length; i += 1) {
  for (let j = i + 1; j < entries.length; j += 1) {
    const sim = similarity(shingles(entries[i].text), shingles(entries[j].text))
    if (sim < CONFLICT_BAND.min || sim >= CONFLICT_BAND.max) continue
    pairsInBand += 1
    if (detectConflict(entries[i], entries[j], sim).conflict) flagged += 1
  }
}
console.log(`pairs inside the band: ${pairsInBand}   flagged as conflicts: ${flagged}`)
console.log(
  pairsInBand === 0
    ? '  -> the library has no two entries close enough to contradict each other yet.'
    : '  -> see flagged pairs above.',
)
const queued = await engine.conflicts(cwd).catch(() => [])
console.log(`queued conflicts on disk: ${queued.length}`)

console.log('\n=== 2. would a one-clause correction be stored now?')
const samples = entries.filter(row => String(row.text).length > 70).slice(0, 6)
let wouldSwallow = 0
for (const entry of samples) {
  const flipped = String(entry.text).replace(/必须|应当|应该|需要|可以|不要|禁止|不能/, match =>
    match === '必须' || match === '应当' || match === '应该' || match === '需要' || match === '可以' ? '绝对不要' : '必须',
  )
  if (flipped === entry.text) continue
  const sim = similarity(shingles(entry.text), shingles(flipped))
  const duplicateThreshold = 0.82
  const above = sim >= duplicateThreshold
  const detected = detectConflict(entry, { text: flipped }, sim).conflict
  if (above && !detected) wouldSwallow += 1
  console.log(
    `  sim=${sim.toFixed(3)} aboveDupThreshold=${above} detected=${detected} | ${String(entry.text).slice(0, 60)}`,
  )
}
console.log(`  corrections that would still be swallowed: ${wouldSwallow}`)

console.log('\n=== 3. pain distillation on real transcripts')
const sessionsRoot = path.join(os.homedir(), '.dsh', 'sessions')

/** @param {string} dir @returns {string[]} logs */
function findLogs(dir) {
  const out = []
  let items = []
  try {
    items = fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return out
  }
  for (const item of items) {
    const full = path.join(dir, item.name)
    if (item.isDirectory()) out.push(...findLogs(full))
    else if (item.name === 'session.v4.jsonl.zstd') out.push(full)
  }
  return out
}

let turns = 0
let painful = 0
let lessons = 0
const reasons = {}
const themes = new Map()
for (const file of findLogs(sessionsRoot)) {
  let text
  try {
    text = zlib.zstdDecompressSync(fs.readFileSync(file)).toString('utf8')
  } catch {
    continue
  }
  const events = []
  for (const line of text.split('\n')) {
    if (!line) continue
    try {
      events.push(JSON.parse(line))
    } catch {
      /* ignore a truncated tail */
    }
  }
  const turnNumbers = [...new Set(events.filter(e => e?.type === 'turn/end').map(e => e.data.turn))]
  for (const turn of turnNumbers) {
    turns += 1
    const pain = detectPain(events, turn)
    if (!pain.painful) continue
    painful += 1
    for (const reason of pain.reasons) reasons[reason] = (reasons[reason] ?? 0) + 1
    for (const lesson of distillLessons(pain)) {
      lessons += 1
      themes.set(lesson.theme, (themes.get(lesson.theme) ?? 0) + 1)
    }
  }
}
console.log(`turns: ${turns}   painful: ${painful} (${turns ? ((painful / turns) * 100).toFixed(1) : '0'}%)`)
console.log(`lessons that would be written: ${lessons}`)
console.log(`distinct themes: ${themes.size}   (the rest become recurrences, not new entries)`)
console.log('reasons:', JSON.stringify(reasons))
const repeat = [...themes].filter(([, count]) => count > 1).sort((a, b) => b[1] - a[1]).slice(0, 5)
if (repeat.length) {
  console.log('top recurring themes:')
  for (const [theme, count] of repeat) console.log(`  ${String(count).padStart(3)}x  ${theme}`)
}
console.log(`\nagainst maxDistilledLessons=12 per store: ${lessons > 12 ? 'cap will engage (expected, archives the least-recurring)' : 'under the cap'}`)

console.log('\n=== 4. nothing was written by this audit')
console.log('read-only: no remember(), no maintain(), no settleConflict() was called.')
