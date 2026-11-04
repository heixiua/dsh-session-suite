#!/usr/bin/env node
/**
 * Replay the explicit-write scan against real session logs and report what the
 * plugin would have stored — both before and after the source filter.
 *
 * Why this exists: the poisoning bug was invisible from the store alone. The
 * records said `source: 'explicit'`, which pointed at the instruction parser,
 * but nothing in the store said *which message* produced them. Replaying the
 * production regex over the durable logs is what produced the answer — 154
 * captures of "…" from `source.kind = runtime-context` against three captures
 * from genuine user messages.
 *
 * Run it after changing any pattern or guard. The "before" column must stay at
 * zero for placeholder captures.
 *
 * Usage:
 *   node tools/audit-explicit-captures.mjs
 *   node tools/audit-explicit-captures.mjs --verbose
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import zlib from 'node:zlib'
import { EXPLICIT_PATTERNS } from '../lib/memory-host.js'
import { isMeaningfulText, isUserAuthored } from '../lib/util.js'

const VERBOSE = process.argv.includes('--verbose')
const sessionsRoot = path.join(os.homedir(), '.dsh', 'sessions')

/** @param {string} dir @returns {string[]} every session log beneath it */
function findLogs(dir) {
  const out = []
  if (!fs.existsSync(dir)) return out
  for (const name of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, name.name)
    if (name.isDirectory()) out.push(...findLogs(full))
    else if (name.name.endsWith('.zstd') || name.name.endsWith('.jsonl')) out.push(full)
  }
  return out
}

/**
 * Apply the production patterns to one message, with or without the guards.
 *
 * @param {any} message step message
 * @param {boolean} guarded whether to apply the source and placeholder filters
 * @returns {string[]} captured values
 */
function capturesFrom(message, guarded) {
  if (guarded && !isUserAuthored(message)) return []
  // Historical behaviour: role is the only test.
  if (!guarded && message?.role !== 'user') return []
  const blocks = Array.isArray(message?.content) ? message.content : []
  const out = []
  for (const block of blocks) {
    const text = typeof block?.text === 'string' ? block.text : ''
    for (const { pattern } of EXPLICIT_PATTERNS) {
      pattern.lastIndex = 0
      for (const match of text.matchAll(pattern)) {
        const value = (match[1] ?? '').trim()
        if (!value) continue
        if (guarded && !isMeaningfulText(value)) continue
        out.push(value)
      }
    }
  }
  return out
}

const logs = findLogs(sessionsRoot)
const before = new Map()
const after = new Map()
let messages = 0

/** @param {Map<string, number>} map @param {string} key */
const bump = (map, key) => map.set(key, (map.get(key) ?? 0) + 1)

for (const file of logs) {
  let text
  try {
    text = file.endsWith('.zstd')
      ? zlib.zstdDecompressSync(fs.readFileSync(file)).toString('utf8')
      : fs.readFileSync(file, 'utf8')
  } catch {
    continue
  }
  for (const line of text.split('\n')) {
    if (!line) continue
    let event
    try {
      event = JSON.parse(line)
    } catch {
      continue
    }
    // `'user/message': UserMessage` — the event data IS the message, unlike
    // `assistant/message`, which wraps it in `.message`.
    const message = event?.type === 'user/message' ? event.data : event?.data?.message
    if (message?.role !== 'user') continue
    messages += 1
    const kind = message?.source?.kind ?? '(undefined)'
    for (const value of capturesFrom(message, false)) {
      bump(before, `${kind} | ${JSON.stringify(value.slice(0, 40))}`)
    }
    for (const value of capturesFrom(message, true)) {
      bump(after, `${kind} | ${JSON.stringify(value.slice(0, 40))}`)
    }
  }
}

/** @param {string} title @param {Map<string, number>} map */
function dump(title, map) {
  console.log(`\n${title}`)
  if (map.size === 0) {
    console.log('  (nothing)')
    return
  }
  const rows = [...map].sort((a, b) => b[1] - a[1])
  const shown = VERBOSE ? rows : rows.slice(0, 15)
  for (const [key, count] of shown) console.log(`  ${String(count).padStart(5)}x  ${key}`)
  if (shown.length < rows.length) console.log(`  ... and ${rows.length - shown.length} more distinct values`)
}

console.log(`scanned ${logs.length} session logs, ${messages} user-role messages`)
dump('WITHOUT the guards (the historical bug)', before)
dump('WITH the guards (current behaviour)', after)

const placeholdersBefore = [...before].filter(([key]) => /"…"|"\.\.\."|"⋯"/.test(key)).reduce((sum, [, n]) => sum + n, 0)
const placeholdersAfter = [...after].filter(([key]) => /"…"|"\.\.\."|"⋯"/.test(key)).reduce((sum, [, n]) => sum + n, 0)
console.log('')
console.log(`placeholder captures before the fix: ${placeholdersBefore}`)
console.log(`placeholder captures after the fix:  ${placeholdersAfter}`)
console.log(placeholdersAfter === 0 ? 'PASS no placeholder would be stored' : 'FAIL placeholders still reach the store')
process.exitCode = placeholdersAfter === 0 ? 0 : 1
