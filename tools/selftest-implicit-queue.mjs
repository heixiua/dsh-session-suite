/**
 * The implicit-candidate queue is REMOVED (0.9.0).
 *
 * Seven attempts drove it from a Cordis event, then a pre-step hook, then an agent-scoped
 * poll. None produced a single candidate. Reading dsh-fish-memory's source settled why:
 * that plugin has no such pipeline at all — the model writes memories by calling a
 * `remember` tool, and its tool description is the entire extraction policy.
 *
 * This bundle now does the same. The queue, its UI panel, and the settle/accept flow are
 * gone; what remains is the tool. This test pins that, so a future reader cannot mistake
 * leftover code for a working feature.
 *
 * Usage: node tools/selftest-implicit-queue.mjs
 */

import assert from 'node:assert/strict'
import fs from 'node:fs'

const host = fs.readFileSync('lib/memory-host.js', 'utf8')
const client = fs.readFileSync('client.js', 'utf8')
const api = fs.readFileSync('lib/api.js', 'utf8')
const checks = []

// 1. No background extraction is wired to any per-turn hook.
{
  assert.equal(
    /void extractAfterTurn\(\{/.test(host),
    false,
    'nothing may call extractAfterTurn per turn',
  )
  assert.equal(
    /extractionTrace\.eventsSeen = \(extractionTrace\.eventsSeen \?\? 0\) \+ 1/.test(host),
    false,
    'the dead event-driven counter increment must be gone',
  )
  assert.equal(
    /agent\/turn-stopping/.test(host.replace(/^\s*\/\/.*$/gm, '')),
    false,
    'no agent-scoped turn hook (the trigger that never fired)',
  )
  checks.push('no background extraction pipeline')
}

// 2. The mechanism that DOES work is present: a tool the model calls.
{
  assert.equal(/name: 'memory'/.test(host), true, 'the memory tool must be registered')
  assert.equal(
    /description: \[/.test(host),
    true,
    'the tool description must be a multi-line policy, not a one-liner',
  )
  // The three rules that were missing and that make implicit capture work:
  for (const rule of ['ONE memory = ONE fact', 'WHEN NOT TO', 'Do NOT say "I noted that"']) {
    assert.equal(host.includes(rule), true, `the description must state "${rule}"`)
  }
  checks.push('the model-facing tool carries the extraction policy')
}

// 3. The review panel is gone from the UI, and its request is no longer sent.
{
  assert.equal(
    /const pendingBlock = null/.test(client),
    true,
    'the suggested-memories panel must be disabled',
  )
  assert.equal(
    /memory\.pendingTitle/.test(client),
    true,
    'the locale key may stay (harmless), but the panel must not render it',
  )
  assert.equal(
    /action: 'longterm\.pending'/.test(client),
    false,
    'the page must not request a queue that no longer exists',
  )
  checks.push('the review panel and its request are removed')
}

// 4. The API still answers a pending request rather than crashing.
//
//    The action remains in LONGTERM_ACTIONS and is routed; the engine simply returns an
//    empty list. Removing the route would make an old Client build 404.
{
  assert.equal(/case 'longterm\.pending'/.test(api), true, 'the route must still exist for old clients')
  checks.push('the pending route still answers')
}

console.log(checks.map((line, index) => `  ${index + 1}. ${line}`).join('\n'))
console.log(`\n${checks.length}/${checks.length} checks passed`)
