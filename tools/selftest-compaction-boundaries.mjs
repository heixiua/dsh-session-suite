/**
 * Does the plugin's boundary math still work once a session has been compacted?
 *
 * Compaction is append-only: it writes a `compaction/summary` event and then a
 * synthetic `user/message` whose `source.kind` is `compact-checkpoint` and whose
 * `surfaceOp` replaces the summarized range. The raw events stay in the log, so
 * any code that scans raw events must skip both of those nodes — otherwise a
 * summary looks like a user prompt and the cut point lands in the wrong place.
 *
 * This exercises the real helpers through `SessionSuiteService.truncateConversation`
 * and `deleteMessage` against a synthetic log containing a compaction.
 *
 * Usage: node tools/selftest-compaction-boundaries.mjs
 */

import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { CheckpointStore } from '../lib/checkpoints.js'
import { MemoryLedger } from '../lib/memory.js'
import { SessionSuiteService } from '../lib/service.js'

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dss-compact-'))
const cwd = path.join(root, 'workspace')
await fs.mkdir(cwd, { recursive: true })

/** A three-turn session that was compacted after turn 2. */
function compactedLog() {
  const events = [
    { seq: 1, type: 'turn/start', data: { turn: 1 } },
    { seq: 2, type: 'user/message', data: { id: 'u1', role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'q1' }] } },
    { seq: 3, type: 'assistant/message', data: { turn: 1, step: 1, message: { id: 'a1', role: 'assistant', content: [{ type: 'text', text: 'r1' }] } } },
    { seq: 4, type: 'turn/end', data: { turn: 1 } },
    { seq: 5, type: 'turn/start', data: { turn: 2 } },
    { seq: 6, type: 'user/message', data: { id: 'u2', role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'q2' }] } },
    { seq: 7, type: 'assistant/message', data: { turn: 2, step: 1, message: { id: 'a2', role: 'assistant', content: [{ type: 'text', text: 'r2' }] } } },
    { seq: 8, type: 'turn/end', data: { turn: 2 } },
    // --- compaction of turns 1-2 ---
    { seq: 9, type: 'compaction/summary', data: { compactionId: 'c1', summary: 'SUMMARY', shadowedRange: { start: 1, end: 8 }, shadowedSeqs: [1, 2, 3, 4, 5, 6, 7, 8], shadowedTokenCount: 900 } },
    {
      seq: 10,
      type: 'user/message',
      data: {
        id: 'checkpoint-1',
        role: 'user',
        source: { kind: 'compact-checkpoint', compactionId: 'c1' },
        content: [{ type: 'text', text: 'SUMMARY' }],
        surfaceOp: { op: 'replace', startSeq: 1, endSeq: 8 },
      },
    },
    // --- turn 3 continues on the compacted surface ---
    { seq: 11, type: 'turn/start', data: { turn: 3 } },
    { seq: 12, type: 'user/message', data: { id: 'u3', role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'q3' }] } },
    { seq: 13, type: 'assistant/message', data: { turn: 3, step: 1, message: { id: 'a3', role: 'assistant', content: [{ type: 'text', text: 'r3' }] } } },
    { seq: 14, type: 'turn/end', data: { turn: 3 } },
  ]
  return events
}

const forks = []
const service = new SessionSuiteService({
  ctx: {
    get: name =>
      name === 'sessionController'
        ? {
            inspect: async () => ({ meta: { id: 's1', cwd }, events: compactedLog(), title: 't' }),
            fork: async ({ atSeq }) => {
              forks.push(atSeq)
              return { sessionId: `child-${forks.length}` }
            },
            create: async () => ({ sessionId: 'fresh' }),
            list: async () => ({ items: [] }),
          }
        : undefined,
  },
  root,
  store: new CheckpointStore({ root, log: () => {} }),
  memory: new MemoryLedger({ root }),
  log: () => {},
  config: {},
})

const checks = []

// 1. Deleting the LAST turn must keep through the real prompt of turn 2 (seq 6),
//    never through the synthetic checkpoint at seq 10.
await service.deleteMessage({ sessionId: 's1', messageId: 'a3' })
const cutForLastTurn = forks.at(-1)
assert.ok(cutForLastTurn !== undefined, 'deleteMessage forked')
assert.ok(
  cutForLastTurn < 10,
  `cut must land before the synthetic checkpoint, got ${cutForLastTurn}`,
)
checks.push(`delete of turn 3 cut at seq ${cutForLastTurn} (before checkpoint 10)`)

// 2. Deleting turn 2 must cut before its prompt (seq 6), not before the summary.
await service.deleteMessage({ sessionId: 's1', messageId: 'a2' })
const cutForTurn2 = forks.at(-1)
assert.ok(cutForTurn2 !== undefined, 'deleteMessage forked for turn 2')
assert.ok(cutForTurn2 < 6, `cut must be before q2 (seq 6), got ${cutForTurn2}`)
checks.push(`delete of turn 2 cut at seq ${cutForTurn2} (before q2 at 6)`)

// 3. A segment delete starting at the checkpoint must not treat the summary as a prompt.
await service.deleteSegment({ sessionId: 's1', startSeq: 10 })
const cutForSegment = forks.at(-1)
assert.ok(cutForSegment !== undefined, 'deleteSegment forked')
assert.ok(
  cutForSegment < 10,
  `segment cut must skip the synthetic checkpoint, got ${cutForSegment}`,
)
checks.push(`segment from seq 10 cut at seq ${cutForSegment} (skipped the summary node)`)

console.log(
  JSON.stringify({ ok: true, checks, forks, root }, null, 2),
)
