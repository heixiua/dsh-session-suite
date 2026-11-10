/**
 * Tests that an in-place rewind marker is never mistaken for a user prompt.
 *
 * WHY THIS EXISTS. The DSH log is append-only: rewinding does not delete
 * events, so `dsh-purge-community` rewinds by appending an EMPTY `user/message`
 * whose `surfaceOp` replaces a seq range, and the renderer hides what it
 * covered. That record carries `source.kind === 'user'` — it is authored as a
 * user turn — and `content: []`.
 *
 * Every seq-walking path in this bundle excluded non-user *sources* but never
 * checked whether a user message had any content, so with purge installed:
 *
 *   - "resend this turn" / "delete up to here" aimed one turn too late;
 *   - an export header claimed a user message the reader could not find;
 *   - `curateEvents` emitted an empty `### User` heading into the transcript.
 *
 * The fix is one predicate (`isUserPromptEvent` in lib/util.js) plus its use in
 * those four places. This file pins the predicate and the two visible outcomes.
 *
 * Usage: node tools/selftest-surface-shadow.mjs
 */

import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { SessionSuiteService } from '../lib/service.js'
import { curateEvents, projectMessages, renderMarkdown, summarize } from '../lib/share.js'
import { CheckpointStore } from '../lib/checkpoints.js'
import { hasConversationContent, isSurfaceShadow, isUserPromptEvent } from '../lib/util.js'

const checks = []
/**
 * @param {string} name check name
 * @param {() => void} body assertion body
 */
function check(name, body) {
  body()
  checks.push(name)
}

// --- the predicate ----------------------------------------------------------
check('purge rewind marker is detected by surfaceOp', () => {
  const marker = {
    type: 'user/message',
    seq: 90,
    data: { id: 'rewind-abc-3', role: 'user', source: { kind: 'user' }, content: [] },
    surfaceOp: { op: 'replace', startSeq: 20, endSeq: 60 },
  }
  assert.equal(isSurfaceShadow(marker), true)
  assert.equal(isUserPromptEvent(marker), false)
})

check('purge rewind marker is detected by its id prefix alone', () => {
  // Older builds wrote the id but no surfaceOp on the event object we read back.
  const marker = {
    type: 'user/message',
    seq: 91,
    data: { id: 'rewind-xyz', role: 'user', source: { kind: 'user' }, content: [] },
  }
  assert.equal(isSurfaceShadow(marker), true)
  assert.equal(isUserPromptEvent(marker), false)
})

check('an empty user message with no marker is still not a prompt', () => {
  const empty = { type: 'user/message', seq: 92, data: { id: 'm9', source: { kind: 'user' }, content: [] } }
  assert.equal(isSurfaceShadow(empty), false, 'no surfaceOp and no rewind id is not a shadow')
  assert.equal(hasConversationContent(empty), false)
  assert.equal(isUserPromptEvent(empty), false, 'but it carries nothing, so it is still not a prompt')
})

check('an image-only prompt still counts', () => {
  const imageOnly = {
    type: 'user/message',
    seq: 93,
    data: { source: { kind: 'user' }, content: [{ type: 'image', attachment: { attachmentId: 'a1' } }] },
  }
  assert.equal(isUserPromptEvent(imageOnly), true, 'a screenshot with no text is still a prompt')
})

check('harness sources are excluded', () => {
  const runtime = {
    type: 'user/message',
    seq: 94,
    data: { source: { kind: 'runtime-context' }, content: [{ type: 'text', text: 'cwd: D:\\ws' }] },
  }
  const compact = {
    type: 'user/message',
    seq: 95,
    data: { source: { kind: 'compact-checkpoint' }, content: [{ type: 'text', text: 'summary' }] },
    surfaceOp: { op: 'replace', startSeq: 1, endSeq: 88 },
  }
  assert.equal(isUserPromptEvent(runtime), false)
  assert.equal(isUserPromptEvent(compact), false)
})

// --- a realistic log: two turns, then a purge rewind over the first ----------
const EVENTS = [
  { type: 'turn/start', seq: 1, data: { turn: 1 } },
  { type: 'user/message', seq: 2, data: { id: 'm1', source: { kind: 'user' }, content: [{ type: 'text', text: '第一轮的问题' }] } },
  { type: 'assistant/message', seq: 3, data: { turn: 1, message: { id: 'a1', content: [{ type: 'text', text: '第一轮的回答' }] } } },
  { type: 'turn/end', seq: 4, data: { turn: 1 } },
  { type: 'turn/start', seq: 5, data: { turn: 2 } },
  { type: 'user/message', seq: 6, data: { id: 'm2', source: { kind: 'user' }, content: [{ type: 'text', text: '第二轮的问题' }] } },
  { type: 'assistant/message', seq: 7, data: { turn: 2, message: { id: 'a2', content: [{ type: 'text', text: '第二轮的回答' }] } } },
  { type: 'turn/end', seq: 8, data: { turn: 2 } },
  // purge's in-place rewind: hides seq 1..6 and re-arms the composer with m2's
  // text. The Host assigns the marker the NEXT turn number, which is what makes
  // the old `lastUserTurn` point at a turn that has no prompt at all.
  {
    type: 'user/message',
    seq: 9,
    data: { id: 'rewind-abc', role: 'user', source: { kind: 'user' }, turn: 3, content: [] },
    surfaceOp: { op: 'replace', startSeq: 1, endSeq: 6 },
    sourceEventSeqs: [1, 2, 3, 4, 5, 6],
  },
]

check('curateEvents drops the marker, not the prompts', () => {
  const curated = curateEvents(EVENTS)
  const prompts = curated.filter(event => event.type === 'user/message')
  assert.equal(prompts.length, 2, `expected the two real prompts, got ${prompts.length}`)
  assert.equal(prompts.some(event => event.seq === 9), false)
})

check('projectMessages produces no empty user entry', () => {
  const entries = projectMessages(curateEvents(EVENTS))
  const users = entries.filter(entry => entry.role === 'user')
  assert.equal(users.length, 2)
  assert.equal(users.some(entry => entry.text.trim() === ''), false)
})

check('the markdown export has no empty ### User heading', () => {
  const body = renderMarkdown({ sessionId: 's1', title: 'demo', events: curateEvents(EVENTS) })
  const headings = body.match(/^### User$/gm) ?? []
  assert.equal(headings.length, 2, `expected 2 user headings, got ${headings.length}`)
})

check('summarize counts prompts, not control records', () => {
  const stats = summarize(EVENTS)
  assert.equal(stats.messages, 2, `expected 2 user messages, got ${stats.messages}`)
})

// --- the service-level effect ------------------------------------------------
const root = await fs.mkdtemp(path.join(os.tmpdir(), 'shadow-'))
const store = new CheckpointStore({ root })

/**
 * @param {any[]} events durable events
 * @returns {any} ctx with a fake controller
 */
function ctxWith(events) {
  const forks = []
  return {
    get(name) {
      if (name === 'sessionController') {
        return {
          inspect: async sessionId => ({ meta: { id: sessionId, cwd: 'D:\\ws' }, events }),
          fork: async request => {
            forks.push(request)
            return { sessionId: 'forked-session' }
          },
          list: async () => ({ items: [{ sessionId: 'source-session', running: false }] }),
          prompt: async () => ({ accepted: true }),
        }
      }
      if (name === 'workspaceRegistry' || name === 'workspaceController') {
        return { archiveSession: async () => {}, unarchiveSession: async () => {} }
      }
      return undefined
    },
    emit() {},
    forks,
  }
}

const ctx = ctxWith(EVENTS)
const service = new SessionSuiteService({
  ctx,
  root,
  store,
  memory: {
    snapshot: async () => ({}),
    restore: async () => {},
    trimTo: async () => ({ removed: 0 }),
    copyTo: async () => ({ copied: 0 }),
  },
  log: () => {},
  config: {},
})

const preview = await service.previewResend({ sessionId: 'source-session' })
assert.equal(
  preview.turn,
  2,
  `resend must target turn 2 (the last real prompt), got turn ${preview.turn}`,
)
assert.equal(
  preview.prompt,
  '第二轮的问题',
  `resend must target the last real prompt, got ${JSON.stringify(preview.prompt)}`,
)
checks.push('previewResend targets the last real prompt, not the marker')

// The marker sits in a later turn with no text. Before the fix, `lastUserTurn`
// returned that turn, so the resend dialog said "turn 3 was not started by a
// prompt you sent" — pointing the user at a turn that does not exist.
assert.equal(preview.turn, 2, `expected turn 2, got turn ${preview.turn}`)
assert.equal(preview.prompt, '第二轮的问题')
checks.push('the empty marker turn is skipped when choosing the last prompt')

await fs.rm(root, { recursive: true, force: true })
console.log(JSON.stringify({ ok: true, checks: checks.length, names: checks }, null, 2))
