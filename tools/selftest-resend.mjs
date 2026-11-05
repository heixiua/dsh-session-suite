/**
 * Tests for resending a turn's prompt in a fork.
 *
 * The behaviour that matters: retrying must produce a *fresh* conversation tail
 * (so the model is not asked to build on an answer the user rejected), must
 * leave the original session as a branch, and must not touch workspace files —
 * retrying a reply is a conversation operation, not a rollback.
 *
 * Usage: node tools/selftest-resend.mjs
 */

import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { SessionSuiteService } from '../lib/service.js'
import { CheckpointStore } from '../lib/checkpoints.js'

const checks = []
const root = await fs.mkdtemp(path.join(os.tmpdir(), 'resend-'))
const store = new CheckpointStore({ root })

/** Build a minimal event list: two turns, each with a user prompt and a reply. */
const EVENTS = [
  { type: 'turn/start', seq: 1, data: { turn: 1 } },
  { type: 'user/message', seq: 2, data: { id: 'm1', source: { kind: 'user' }, content: [{ type: 'text', text: '第一轮的问题' }] } },
  { type: 'assistant/message', seq: 3, data: { turn: 1, message: { id: 'a1', content: [{ type: 'text', text: '第一轮的回答' }] } } },
  { type: 'turn/end', seq: 4, data: { turn: 1, reason: { kind: 'completed' } } },
  { type: 'turn/start', seq: 5, data: { turn: 2 } },
  { type: 'user/message', seq: 6, data: { id: 'm2', source: { kind: 'user' }, content: [{ type: 'text', text: '第二轮的问题' }] } },
  { type: 'assistant/message', seq: 7, data: { turn: 2, message: { id: 'a2', content: [{ type: 'text', text: '第二轮的失败回答' }] } } },
  { type: 'turn/end', seq: 8, data: { turn: 2, reason: { kind: 'error', error: { message: 'boom', code: 'SERVER' } } } },
]

/**
 * @param {any[]} events durable events
 * @param {{ prompt?: (request: any) => Promise<any>, failPrompt?: boolean }} [options] behaviour
 * @returns {any} a ctx with a fake session controller
 */
function ctxWith(events, options = {}) {
  const forks = []
  const prompts = []
  return {
    get(name) {
      if (name === 'sessionController') {
        return {
          inspect: async sessionId => ({ meta: { id: sessionId, cwd: 'D:\\ws' }, events }),
          fork: async request => {
            forks.push(request)
            return { sessionId: 'forked-session' }
          },
          create: async () => ({ sessionId: 'blank-session' }),
          list: async () => ({ items: [{ sessionId: 'source-session', running: false }] }),
          prompt: async request => {
            if (options.failPrompt) throw new Error('host refused the prompt')
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
    forks,
    prompts,
  }
}

/**
 * @param {any} ctx plugin context
 * @returns {SessionSuiteService} service
 */
function serviceWith(ctx) {
  return new SessionSuiteService({
    ctx,
    root,
    store,
    memory: {
      trimTo: async () => ({ removed: 0, kept: 0 }),
      clone: async () => ({ copied: 0 }),
      purge: async () => {},
      list: async () => [],
    },
    log: () => {},
    config: {},
  })
}

// 1. Retrying turn 2 forks just before that turn's prompt and resends its text.
{
  const ctx = ctxWith(EVENTS)
  const service = serviceWith(ctx)
  const result = await service.resendTurn({ sessionId: 'source-session', turn: 2 })

  assert.equal(result.sent, true, 'retry must send the prompt')
  assert.equal(result.childId, 'forked-session')
  assert.equal(result.originalPrompt, '第二轮的问题', 'the original prompt must be recovered')
  assert.equal(result.prompt, '第二轮的问题', 'by default the same text is resent')
  assert.equal(ctx.prompts.length, 1, 'exactly one prompt must be admitted')
  assert.equal(ctx.prompts[0].content[0].text, '第二轮的问题')
  assert.equal(ctx.prompts[0].mode, 'queue')
  // The cut is the last conversation message before seq 6, which is seq 4
  // (turn 1's end is not a conversation message, so the last one is seq 3).
  assert.equal(ctx.forks.length, 1)
  assert.equal(ctx.forks[0].atSeq, 3, 'the fork must cut before the prompt')
  assert.equal(result.filesUntouched, true, 'retrying must never restore files')
  checks.push('retry forks before the prompt and resends its text')
}

// 2. Stage mode forks but does NOT send: the client puts the text in the
//    composer so the user can edit it first.
{
  const ctx = ctxWith(EVENTS)
  const service = serviceWith(ctx)
  const result = await service.resendTurn({ sessionId: 'source-session', turn: 2, mode: 'stage' })
  assert.equal(result.sent, false, 'stage must not send')
  assert.equal(ctx.prompts.length, 0, 'stage must not admit a prompt')
  assert.equal(ctx.forks.length, 1, 'stage still forks')
  assert.equal(result.prompt, '第二轮的问题', 'stage returns the text to edit')
  checks.push('stage mode forks without sending')
}

// 3. A replacement text overrides the original.
{
  const ctx = ctxWith(EVENTS)
  const service = serviceWith(ctx)
  const result = await service.resendTurn({
    sessionId: 'source-session',
    turn: 2,
    text: '  改过以后的问题  ',
  })
  assert.equal(result.prompt, '改过以后的问题', 'the replacement must be trimmed and used')
  assert.equal(ctx.prompts[0].content[0].text, '改过以后的问题')
  assert.equal(result.originalPrompt, '第二轮的问题', 'the original is still reported')
  checks.push('a replacement text overrides the original')
}

// 4. A turn that was not started by a user prompt cannot be resent. Sending
//    something on the user's behalf when they never typed it would be worse
//    than refusing.
{
  const events = [
    { type: 'turn/start', seq: 1, data: { turn: 1 } },
    { type: 'user/message', seq: 2, data: { id: 'x', source: { kind: 'runtime-context' }, content: [{ type: 'text', text: '内部管道' }] } },
    { type: 'turn/end', seq: 3, data: { turn: 1 } },
  ]
  const ctx = ctxWith(events)
  const service = serviceWith(ctx)
  await assert.rejects(
    () => service.resendTurn({ sessionId: 'source-session', turn: 1 }),
    /was not started by a prompt/i,
    'a turn started by harness plumbing must not be resent',
  )
  assert.equal(ctx.prompts.length, 0)
  assert.equal(ctx.forks.length, 0, 'a refusal must fork nothing')
  checks.push('a turn not started by the user is refused')
}

// 5. A turn number that does not exist is refused, and nothing is forked.
{
  const ctx = ctxWith(EVENTS)
  const service = serviceWith(ctx)
  await assert.rejects(() => service.resendTurn({ sessionId: 'source-session', turn: 99 }), /was not started/i)
  assert.equal(ctx.forks.length, 0)
  assert.equal(ctx.prompts.length, 0)
  checks.push('an unknown turn is refused without forking')
}

// 6. If the Host rejects the prompt, the failure surfaces rather than being
//    reported as a successful resend.
{
  const ctx = ctxWith(EVENTS, { failPrompt: true })
  const service = serviceWith(ctx)
  await assert.rejects(
    () => service.resendTurn({ sessionId: 'source-session', turn: 2 }),
    /host refused/i,
    'a rejected prompt must not look like a success',
  )
  checks.push('a rejected prompt surfaces as an error')
}

// 6b. A Host that *answers* with `accepted: false` must also surface as a
//     failure. This is the quieter rejection path: the call resolves, so a
//     caller that only awaits would report a successful resend for a prompt the
//     Host refused. Mutation testing is what exposed that this case was untested.
{
  const ctx = ctxWith(EVENTS)
  // Replace the controller's prompt with one that answers "not accepted".
  ctx.get = name =>
    name === 'sessionController'
      ? {
          inspect: async sessionId => ({ meta: { id: sessionId, cwd: 'D:\\ws' }, events: EVENTS }),
          fork: async () => ({ sessionId: 'forked-session' }),
          create: async () => ({ sessionId: 'blank-session' }),
          list: async () => ({ items: [] }),
          prompt: async () => ({ accepted: false }),
        }
      : name === 'workspaceRegistry' || name === 'workspaceController'
        ? { archiveSession: async () => {}, unarchiveSession: async () => {} }
        : undefined
  const service = serviceWith(ctx)
  await assert.rejects(
    () => service.resendTurn({ sessionId: 'source-session', turn: 2 }),
    /rejected the resent prompt/i,
    'an accepted:false answer must not look like a success',
  )
  checks.push('a prompt the Host answers as not-accepted surfaces as an error')
}

// 7. The HTTP route exposes both modes and forwards the turn number.
{
  const { createRoute } = await import('../lib/api.js')
  let seen
  const route = createRoute(
    {
      resendTurn: async input => {
        seen = input
        return { sent: true, prompt: 'x' }
      },
    },
    { log() {} },
  )
  const call = async body => {
    const response = await route.fetch(
      new Request('http://localhost/api/session-suite', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      }),
    )
    assert.equal(response.status, 200)
  }
  await call({ action: 'resendTurn', sessionId: 's', turn: 3 })
  assert.equal(seen.turn, 3)
  assert.equal(seen.mode, 'retry', 'retry is the default mode')
  await call({ action: 'resendTurn', sessionId: 's', turn: 3, mode: 'stage' })
  assert.equal(seen.mode, 'stage')
  checks.push('the route accepts retry and stage, defaulting to retry')
}

await fs.rm(root, { recursive: true, force: true })
console.log(checks.map((line, index) => `  ${index + 1}. ${line}`).join('\n'))
console.log(`\n${checks.length}/${checks.length} checks passed`)
