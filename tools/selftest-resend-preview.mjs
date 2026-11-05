/**
 * Tests for the resend preview and the signal argument.
 *
 * Two user-visible failures drove this:
 *   - opening the edit dialog forked a session (stage mode did real work), and
 *   - sending the edited prompt threw "Cannot read properties of undefined
 *     (reading 'throwIfAborted')" because the Host reads signal.throwIfAborted()
 *     and the second `prompt(request, signal)` argument was omitted.
 *
 * Usage: node tools/selftest-resend-preview.mjs
 */

import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { SessionSuiteService } from '../lib/service.js'
import { CheckpointStore } from '../lib/checkpoints.js'

const checks = []
const root = await fs.mkdtemp(path.join(os.tmpdir(), 'resend-preview-'))
const store = new CheckpointStore({ root })

const EVENTS = [
  { type: 'turn/start', seq: 1, data: { turn: 1 } },
  { type: 'user/message', seq: 2, data: { id: 'm1', turn: 1, source: { kind: 'user' }, content: [{ type: 'text', text: '第一个问题' }] } },
  { type: 'assistant/message', seq: 3, data: { turn: 1, message: { id: 'a1', content: [] } } },
  { type: 'turn/end', seq: 4, data: { turn: 1 } },
  { type: 'turn/start', seq: 5, data: { turn: 2 } },
  { type: 'user/message', seq: 6, data: { id: 'm2', turn: 2, source: { kind: 'user' }, content: [{ type: 'text', text: '你是什么模型？' }] } },
  { type: 'assistant/message', seq: 7, data: { turn: 2, message: { id: 'a2', content: [] } } },
  { type: 'turn/end', seq: 8, data: { turn: 2 } },
]

/** @param {any[]} events @returns {any} ctx recording Host calls */
function ctxWith(events) {
  const calls = { forks: [], prompts: [], archives: [] }
  return {
    get(name) {
      if (name === 'sessionController') {
        return {
          inspect: async sessionId => ({ meta: { id: sessionId, cwd: 'D:\\ws' }, events }),
          fork: async request => {
            calls.forks.push(request)
            return { sessionId: 'forked' }
          },
          create: async () => ({ sessionId: 'blank' }),
          list: async () => ({ items: [] }),
          prompt: async (request, signal) => {
            calls.prompts.push({ request, signal })
            // Mirror the Host: it dereferences signal.throwIfAborted().
            if (signal && typeof signal.throwIfAborted === 'function') signal.throwIfAborted()
            return { accepted: true }
          },
        }
      }
      if (name === 'workspaceRegistry' || name === 'workspaceController') {
        return {
          archiveSession: async id => calls.archives.push(id),
          unarchiveSession: async () => {},
        }
      }
      return undefined
    },
    emit() {},
    calls,
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

// 1. A preview returns the prompt text and turn.
{
  const ctx = ctxWith(EVENTS)
  const service = serviceWith(ctx)
  const result = await service.previewResend({ sessionId: 's' })
  assert.equal(result.turn, 2)
  assert.equal(result.prompt, '你是什么模型？')
  checks.push('preview returns the prompt text and turn')
}

// 2. The preview is a pure read: no fork, no archive, no prompt.
{
  const ctx = ctxWith(EVENTS)
  const service = serviceWith(ctx)
  await service.previewResend({ sessionId: 's' })
  assert.equal(ctx.calls.forks.length, 0, 'a preview must not fork')
  assert.equal(ctx.calls.prompts.length, 0, 'a preview must not send a prompt')
  assert.equal(ctx.calls.archives.length, 0, 'a preview must not archive')
  checks.push('a preview forks, sends, and archives nothing')
}

// 3. A preview can take an explicit turn or message id.
{
  const ctx = ctxWith(EVENTS)
  const service = serviceWith(ctx)
  assert.equal((await service.previewResend({ sessionId: 's', turn: 1 })).prompt, '第一个问题')
  assert.equal((await service.previewResend({ sessionId: 's', messageId: 'a1' })).prompt, '第一个问题')
  checks.push('a preview accepts an explicit turn or message id')
}

// 4. A session with no user prompt refuses the preview cleanly.
{
  const events = [
    { type: 'turn/start', seq: 1, data: { turn: 1 } },
    { type: 'user/message', seq: 2, data: { id: 'x', turn: 1, source: { kind: 'runtime-context' }, content: [{ type: 'text', text: '内部' }] } },
  ]
  const ctx = ctxWith(events)
  const service = serviceWith(ctx)
  await assert.rejects(() => service.previewResend({ sessionId: 's' }), /no prompt in this session/i)
  checks.push('a preview refuses a session with no user prompt')
}

// 5. The real resend passes a signal as the second argument — this is the
//    `throwIfAborted` crash. Assert the shape, not just the call count.
{
  const ctx = ctxWith(EVENTS)
  const service = serviceWith(ctx)
  await service.resendTurn({ sessionId: 's', turn: 2 })
  assert.equal(ctx.calls.prompts.length, 1)
  const call = ctx.calls.prompts[0]
  assert.equal(call.signal !== undefined, true, 'a signal must be passed as the second argument')
  assert.equal(typeof call.signal.throwIfAborted, 'function', 'the signal must support throwIfAborted')
  checks.push('the resend passes a signal that supports throwIfAborted')
}

// 6. The HTTP route exposes the preview without forking anything.
{
  const { createRoute } = await import('../lib/api.js')
  let seen
  const route = createRoute(
    {
      previewResend: async input => {
        seen = input
        return { turn: 2, prompt: '原文' }
      },
    },
    { log() {} },
  )
  const response = await route.fetch(
    new Request('http://localhost/api/session-suite', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'resendTurn.preview', sessionId: 's', turn: 2 }),
    }),
  )
  assert.equal(response.status, 200)
  assert.equal(seen.turn, 2)
  assert.deepEqual((await response.json()).data, { turn: 2, prompt: '原文' })
  checks.push('the route exposes the preview')
}

await fs.rm(root, { recursive: true, force: true })
console.log(checks.map((line, index) => `  ${index + 1}. ${line}`).join('\n'))
console.log(`\n${checks.length}/${checks.length} checks passed`)
