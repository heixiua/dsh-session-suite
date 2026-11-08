/**
 * Verify the analyst's two load-bearing claims before I put them in a doc.
 *
 * Claim A: trae itself DID crash with the fallback throw (turns 113 and 140), so
 *          "trae is not in rootChain, therefore it is never touched" is false.
 * Claim B: every fallback throw is preceded by a failure whose code is in
 *          triggerCodes — i.e. the throw is deterministic, not flaky.
 */

import fs from 'node:fs'
import zlib from 'node:zlib'
import path from 'node:path'
import os from 'node:os'

const sessionsRoot = path.join(os.homedir(), '.dsh', 'sessions')
const TRIGGER = new Set(['AUTH', 'QUOTA', 'RATE_LIMIT', 'TIMEOUT', 'SERVER', 'TRANSPORT'])

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

const traeThrows = []
let throwCount = 0
let triggeredByCode = 0
let untriggeredThrow = 0
const codeHistogram = new Map()

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
      /* ignore */
    }
  }
  // Track the most recent retry code per turn, so a throw can be attributed.
  const lastCodeByTurn = new Map()
  for (const event of events) {
    const data = event.data ?? {}
    if (event.type === 'llm/retry') {
      const turn = data.turn
      const code = data.failure?.code ?? '?'
      if (typeof turn === 'number') lastCodeByTurn.set(turn, code)
      continue
    }
    const raw = JSON.stringify(data)
    if (!raw.includes('after step preparation fixed')) continue
    throwCount += 1
    const match = /proposed \\?"([^"\\]+)\\?" after step preparation fixed \\?"([^"\\]+)\\?"/.exec(raw)
    const proposed = match?.[1]
    const fixed = match?.[2]
    const turn = data.turn
    const code = typeof turn === 'number' ? lastCodeByTurn.get(turn) : undefined
    if (code) codeHistogram.set(code, (codeHistogram.get(code) ?? 0) + 1)
    if (code && TRIGGER.has(code)) triggeredByCode += 1
    else if (code) untriggeredThrow += 1
    if (fixed?.startsWith('trae/') && traeThrows.length < 8) {
      traeThrows.push({ turn, fixed, proposed, code })
    }
  }
}

console.log(`=== total throws: ${throwCount}`)
console.log(`  preceded by a triggerCodes failure: ${triggeredByCode}`)
console.log(`  preceded by a NON-trigger code:     ${untriggeredThrow}`)
console.log(`  (no failure recorded for that turn: ${throwCount - triggeredByCode - untriggeredThrow})`)
console.log('\n=== failure code that preceded each throw')
for (const [code, count] of [...codeHistogram].sort((a, b) => b[1] - a[1])) {
  console.log(`  ${String(count).padStart(4)}  ${code}${TRIGGER.has(code) ? '  [trigger]' : ''}`)
}

console.log(`\n=== throws where the FIXED route was trae (claim A): ${traeThrows.length} sample(s)`)
for (const row of traeThrows) {
  console.log(`  turn ${row.turn}: fixed=${row.fixed} proposed=${row.proposed} code=${row.code}`)
}
if (traeThrows.length === 0) console.log('  NONE — claim A is not supported by this log set')
