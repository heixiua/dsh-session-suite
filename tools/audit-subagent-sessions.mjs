/**
 * Inventory subagent sessions that carry no real work.
 *
 * "Invalid subagent conversation" means a session whose header says it is a
 * subagent child and whose log holds no actual exchange — a failed spawn, a
 * probe that died, a teammate that never ran. They are invisible in the sidebar
 * (subagents are filtered out) but they still occupy disk and still appear in
 * the session store, which is what the user asked to clean up.
 *
 * Dry run by default. Nothing is deleted without --apply, and the allowlist it
 * prints is what --apply would use.
 */

import fs from 'node:fs'
import zlib from 'node:zlib'
import path from 'node:path'
import os from 'node:os'

const APPLY = process.argv.includes('--apply')
const home = path.join(os.homedir(), '.dsh')
const sessionsRoot = path.join(home, 'sessions')

/** @param {string} dir @returns {string[]} */
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

const logs = findLogs(sessionsRoot)
console.log(`session logs: ${logs.length}`)

const rows = []
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
      /* ignore truncated tail */
    }
  }
  // The session header lives on the TOP LEVEL of the first `session` event, not
  // under `data.header` — reading the wrong place made the first run report
  // "subagent sessions: 0 of 31", which would have hidden every junk subagent.
  const sessionEvent = events.find(event => event?.type === 'session') ?? {}
  const header = sessionEvent
  const id = path.basename(path.dirname(file))
  const isSubagent = header.delegationDepth > 0 || header.origin === 'subagent'
  const userMessages = events.filter(event => {
    if (event?.type !== 'user/message') return false
    const kind = event.data?.source?.kind
    return kind === undefined || kind === 'user'
  })
  const assistantMessages = events.filter(event => event?.type === 'assistant/message')
  const toolCalls = events.filter(event => event?.type === 'tool/call')
  const turns = events.filter(event => event?.type === 'turn/end')
  const textBytes = text.length
  rows.push({
    id,
    file,
    isSubagent,
    depth: header.delegationDepth ?? 0,
    parent: header.parentSession ?? header.parentSessionId ?? null,
    title: header.title ?? '',
    events: events.length,
    turns: turns.length,
    userMessages: userMessages.length,
    assistantMessages: assistantMessages.length,
    toolCalls: toolCalls.length,
    bytes: textBytes,
  })
}

const subagents = rows.filter(row => row.isSubagent)
console.log(`subagent sessions: ${subagents.length} of ${rows.length}`)

// A subagent with no assistant message and no tool call did nothing at all.
// A subagent with no user-visible turn produced no exchange the parent could use.
const didNothing = subagents.filter(row => row.assistantMessages === 0 && row.toolCalls === 0)
const noTurn = subagents.filter(row => row.turns === 0 && !didNothing.includes(row))
const emptyish = subagents.filter(
  row => row.events <= 6 && row.assistantMessages === 0,
)

console.log(`\n=== did nothing at all (no assistant message, no tool call): ${didNothing.length}`)
for (const row of didNothing.slice(0, 20)) {
  console.log(`  ${row.id}  events=${row.events} bytes=${row.bytes} parent=${row.parent ?? '-'}`)
}
console.log(`\n=== no completed turn: ${noTurn.length}`)
for (const row of noTurn.slice(0, 20)) {
  console.log(`  ${row.id}  events=${row.events} user=${row.userMessages} asst=${row.assistantMessages} bytes=${row.bytes}`)
}
console.log(`\n=== ≤6 events and no assistant message: ${emptyish.length}`)
for (const row of emptyish.slice(0, 20)) {
  console.log(`  ${row.id}  events=${row.events} bytes=${row.bytes} parent=${row.parent ?? '-'}`)
}

const junk = [...new Set([...didNothing, ...emptyish].map(row => row.id))]
const totalBytes = rows
  .filter(row => junk.includes(row.id))
  .reduce((sum, row) => sum + row.bytes, 0)
console.log(`\n=== candidates: ${junk.length} subagent session(s), ${(totalBytes / 1024).toFixed(1)} KB of log text`)
console.log(JSON.stringify(junk, null, 1))

if (!APPLY) {
  console.log('\ndry run — nothing deleted. Re-run with --apply to remove the candidates above.')
  process.exit(0)
}

// Apply: remove the session directory only. Never touch the parent, never touch
// a subagent that did work.
const removed = []
const failed = []
for (const id of junk) {
  const dir = path.join(sessionsRoot, ...findPathFor(id))
  try {
    fs.rmSync(dir, { recursive: true, force: true })
    removed.push(id)
  } catch (error) {
    failed.push({ id, error: error.message })
  }
}

/** @param {string} id @returns {string[]} path segments under sessionsRoot */
function findPathFor(id) {
  for (const entry of fs.readdirSync(sessionsRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const candidate = path.join(sessionsRoot, entry.name, id)
    if (fs.existsSync(candidate)) return [entry.name, id]
  }
  return []
}

console.log(`\nremoved ${removed.length}, failed ${failed.length}`)
for (const row of failed) console.log(`  FAILED ${row.id}: ${row.error}`)
