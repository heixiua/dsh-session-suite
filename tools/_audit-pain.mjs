/**
 * Replay pain detection over real session logs.
 *
 * The point is not to prove the detector works on fixtures — the selftest does
 * that. It is to measure how often it fires on this machine's actual transcripts,
 * because a detector that writes a protected lesson on every turn is worse than
 * no detector at all: lesson entries are exempt from capacity eviction.
 *
 * Usage: node tools/_audit-pain.mjs [sessionsRoot]
 */

import fs from 'node:fs'
import zlib from 'node:zlib'
import path from 'node:path'
import os from 'node:os'
import { detectPain, distillLessons } from '../lib/pain.js'

const root = process.argv[2] ?? path.join(os.homedir(), '.dsh', 'sessions')

/** @param {string} dir @returns {string[]} session log files */
function findLogs(dir) {
  const out = []
  let entries = []
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return out
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) out.push(...findLogs(full))
    else if (entry.name === 'session.v4.jsonl.zstd') out.push(full)
  }
  return out
}

const logs = findLogs(root)
console.log(`session logs: ${logs.length}`)

let turns = 0
let painful = 0
let lessons = 0
const reasonCounts = {}
const themeCounts = new Map()
const samples = []

for (const file of logs) {
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
      /* a truncated final line is not worth failing over */
    }
  }
  const turnNumbers = [...new Set(events.filter(event => event?.type === 'turn/end' && typeof event.data?.turn === 'number').map(event => event.data.turn))]
  for (const turn of turnNumbers) {
    turns += 1
    const pain = detectPain(events, turn)
    if (!pain.painful) continue
    painful += 1
    for (const reason of pain.reasons) reasonCounts[reason] = (reasonCounts[reason] ?? 0) + 1
    const distilled = distillLessons(pain)
    lessons += distilled.length
    for (const lesson of distilled) themeCounts.set(lesson.theme, (themeCounts.get(lesson.theme) ?? 0) + 1)
    if (samples.length < 12) {
      samples.push({ file: path.basename(path.dirname(file)), turn, reasons: pain.reasons, lessons: distilled.map(lesson => lesson.text) })
    }
  }
}

console.log(`turns: ${turns}   painful: ${painful} (${turns ? ((painful / turns) * 100).toFixed(1) : '0'}%)   lessons distilled: ${lessons}`)
console.log('reasons:', JSON.stringify(reasonCounts))
console.log(`distinct themes: ${themeCounts.size}`)
const recurring = [...themeCounts].filter(([, count]) => count > 1).sort((a, b) => b[1] - a[1]).slice(0, 8)
if (recurring.length) {
  console.log('\nrecurring themes (these become recurrences, not new entries):')
  for (const [theme, count] of recurring) console.log(`  ${String(count).padStart(3)}x  ${theme}`)
}
console.log('\nsamples:')
for (const sample of samples) {
  console.log(`  ${sample.file} turn ${sample.turn} [${sample.reasons.join(',')}]`)
  for (const lesson of sample.lessons) console.log(`     ${lesson}`)
}
