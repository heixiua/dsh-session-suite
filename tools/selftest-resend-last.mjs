/**
 * Tests for the "no turn named" fallback.
 *
 * The chat row hands the client a `TurnLocation`, whose shape is not a stable
 * contract — reading `typeof props.turn === 'number'` never matched, so the
 * button rendered nothing at all. The fix moves resolution into the Host: when
 * no turn is named, resend the most recent turn a user prompt started.
 *
 * Usage: node tools/selftest-resend-last.mjs
 */

import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { SessionSuiteService } from '../lib/service.js'
import { CheckpointStore } from '../lib/checkpoints.js'

const checks = []
const root = await fs.mkdtemp(path.join(os.tmpdir(), 'resend-last-'))
const store = new CheckpointStore({ root })

/** Two user-started turns, then a turn started by a goal round (no prompt). */
const EVENTS = [
  { type: 'turn/start', seq: 1, data: { turn: 1 } },
  { type: 'user/message', seq: 2, data: { id: 'm1', turn: 1, source: { kind: 'user' }, content: [{ type: 'text', text: '第一个问题' }] } },
  { type: 'assistant/message', seq: 3, data: { turn: 1, message: { id: 'a1', content: [] } } },
  { type: 'turn/end', seq: 4, data: { turn: 1 } },
  { type: 'turn/start', seq: 5, data: { turn: 2 } },
  { type: 'user/message', seq: 6, data: { id: 'm2', turn: 2, source: { kind: 'user' }, content: [{ type: 'text', text: '第二个问题' }] } },
  { type: 'assistant/message', seq: 7, data: { turn: 2, message: { id: 'a2', content: [] } } },
  { type: 'turn/end', seq: 8, data: { turn: 2 } },
  { type: 'turn/start', seq: 9, data: { turn: 3 } },
  { type: 'user/message', seq: 10, data: { id: 'g1', turn: 3, source: { kind: 'runtime-context' }, content: [{ type: 'text', text: '目标轮次' }] } },
  { type: 'assistant/message', seq: 11, data: { turn: 3, message: { id: 'a3', content: [] } } },
  { type: 'turn/end', seq: 12, data: { turn: 3 } },
]

/** @param {any[]} events @returns {any} a ctx with a fake controller */
function ctxWith(events) {
  const prompts = []
  const forks = []
  return {
    get(name) {
      if (name === 'sessionController') {
        return {
          inspect: async sessionId => ({ meta: { id: sessionId, cwd: 'D:\\ws' }, events }),
          fork: async request => {
            forks.push(request)
            return { sessionId: 'forked' }
          },
          create: async () => ({ sessionId: 'blank' }),
          list: async () => ({ items: [] }),
          prompt: async request => {
            prompts.push(request)
            return { accepted: true }
          },
        }
      }
      if (name === 'workspaceRegistry' || name === 'workspaceController') {
        return { archiveSession: async () => {}, unarchiveSession: async () => {} }
      }
      return undefined
    },
    emit() {},
    prompts,
    forks,
  }
}

/** @param {any} ctx @returns {SessionSuiteService} service */
function serviceWith(ctx) {
  return new SessionSuiteService({
    ctx,
    root,
    store,
    memory: { trimTo: async () => ({ removed: 0, kept: 0 }), clone: async () => ({ copied: 0 }), purge: async () => {}, list: async () => [] },
    log: () => {},
    config: {},
  })
}

// 1. With no turn named, the latest user-started turn is used. Turn 3 was
//    started by a goal round, so it must be skipped: there is nothing to edit.
{
  const ctx = ctxWith(EVENTS)
  const service = serviceWith(ctx)
  const result = await service.resendTurn({ sessionId: 's' })
  assert.equal(result.turn, 2, `expected turn 2, got ${result.turn}`)
  assert.equal(result.originalPrompt, '第二个问题')
  assert.equal(ctx.prompts.length, 1, 'the latest user prompt must be resent')
  checks.push('with no turn named, the latest user-started turn is used')
}

// 2. An explicit turn still wins over the fallback.
{
  const ctx = ctxWith(EVENTS)
  const service = serviceWith(ctx)
  const result = await service.resendTurn({ sessionId: 's', turn: 1 })
  assert.equal(result.turn, 1)
  assert.equal(result.originalPrompt, '第一个问题')
  checks.push('an explicit turn is still honoured')
}

// 3. A session with no user prompt at all is refused rather than resending
//    something the user never wrote.
{
  const events = [
    { type: 'turn/start', seq: 1, data: { turn: 1 } },
    { type: 'user/message', seq: 2, data: { id: 'x', turn: 1, source: { kind: 'runtime-context' }, content: [{ type: 'text', text: '内部' }] } },
    { type: 'turn/end', seq: 3, data: { turn: 1 } },
  ]
  const ctx = ctxWith(events)
  const service = serviceWith(ctx)
  await assert.rejects(
    () => service.resendTurn({ sessionId: 's' }),
    /no prompt in this session/i,
    'a session with no user prompt must be refused',
  )
  assert.equal(ctx.prompts.length, 0)
  assert.equal(ctx.forks.length, 0, 'a refusal must fork nothing')
  checks.push('a session with no user prompt is refused')
}

// 4. A message id is still accepted and wins over the fallback.
{
  const ctx = ctxWith(EVENTS)
  const service = serviceWith(ctx)
  const result = await service.resendTurn({ sessionId: 's', messageId: 'a1' })
  assert.equal(result.turn, 1, 'a message id must resolve to its own turn')
  checks.push('a message id still resolves to its own turn')
}

await fs.rm(root, { recursive: true, force: true })
console.log(checks.map((line, index) => `  ${index + 1}. ${line}`).join('\n'))
console.log(`\n${checks.length}/${checks.length} checks passed`)
