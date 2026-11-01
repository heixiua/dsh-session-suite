/**
 * Prove that the memory tool can find the workspace it is running in.
 *
 * A cwd miss is silent and expensive: every workspace-scoped memory quietly
 * lands in the global store instead, so the per-project tab stays empty and
 * memories leak across projects. This checks the resolver against every shape
 * the harness actually hands an agent.
 *
 * Usage: node tools/selftest-resolve-cwd.mjs
 */

import assert from 'node:assert/strict'
import { resolveCwd } from '../lib/memory-host.js'

const CWD = 'D:\\AI sandbox\\dsh-sandbox\\DSH Optimize'
const checks = []

/** A minimal ctx exposing only the services a case needs. */
function fakeCtx(services = {}) {
  return {
    get: name => services[name],
    logger: { warn() {}, info() {}, error() {} },
    on() {},
    effect(fn) {
      const disposer = fn()
      return () => disposer?.()
    },
    parallel: async () => undefined,
  }
}

// 1. A session, or anything carrying the immutable header.
{
  assert.equal(resolveCwd(fakeCtx(), { header: { cwd: CWD } }), CWD)
  checks.push('session header resolves')
}

// 2. An agent exposing its session directly.
{
  assert.equal(resolveCwd(fakeCtx(), { session: { header: { cwd: CWD } } }), CWD)
  checks.push('agent.session.header.cwd resolves')
}

// 3. An agent nesting the agent one level down.
{
  assert.equal(resolveCwd(fakeCtx(), { agent: { session: { header: { cwd: CWD } } } }), CWD)
  checks.push('agent.agent.session.header.cwd resolves')
}

// 4. An agent that only exposes a sessionId, resolved through the session service.
{
  const ctx = fakeCtx({ sessions: { get: id => (id === 'session-1' ? { header: { cwd: CWD } } : undefined) } })
  assert.equal(resolveCwd(ctx, { sessionId: 'session-1' }), CWD)
  checks.push('sessionId resolves through the session service')
}

// 5. The same id, taken from the nested session object.
{
  const ctx = fakeCtx({ sessions: { get: id => (id === 'session-2' ? { header: { cwd: CWD } } : undefined) } })
  assert.equal(resolveCwd(ctx, { session: { id: 'session-2' } }), CWD)
  checks.push('session.id resolves through the session service')
}

// 6. Unknown owners return undefined rather than a guess. A wrong path here would
//    write a memory into the wrong project, which is worse than not writing one.
{
  assert.equal(resolveCwd(fakeCtx(), undefined), undefined)
  assert.equal(resolveCwd(fakeCtx(), {}), undefined)
  assert.equal(resolveCwd(fakeCtx({ sessions: { get: () => undefined } }), { sessionId: 'missing' }), undefined)
  checks.push('unknown owners resolve to undefined, never to a guess')
}

// 7. A broken session service must degrade, not throw: the memory tool is
//    registered before this runs, and a throw would take the whole tool down.
{
  const ctx = fakeCtx({
    sessions: {
      get() {
        throw new Error('store unavailable')
      },
    },
  })
  assert.equal(resolveCwd(ctx, { sessionId: 'session-1' }), undefined)
  checks.push('a throwing session service degrades to undefined')
}

// 8. An empty-string cwd is treated as unknown, so it never becomes a hash of "".
{
  assert.equal(resolveCwd(fakeCtx(), { header: { cwd: '' } }), undefined)
  checks.push('empty cwd is treated as unknown')
}

console.log(JSON.stringify({ ok: true, checks }, null, 2))
