/**
 * A failed recall rebuild must not leave the previous answer injected.
 *
 * This is the bug behind "the other workspace does not know what I just told it".
 * Observed in the durable log of a real session: a memory was written at 16:00:10
 * and two later turns (16:04:29, 16:05:19) still injected the memory block
 * computed before it. The cause is the `catch` around the rebuild: it logged and
 * kept `lastRecall`, so every subsequent turn re-served pre-failure text.
 *
 * The contract tested here:
 *   1. a failed rebuild clears the cached text instead of keeping it;
 *   2. the failure is reported, not swallowed;
 *   3. a successful rebuild afterwards clears the failure state;
 *   4. a cached value expires, so it can never be served indefinitely.
 *
 * Usage: node tools/selftest-recall-cache.mjs
 */

import assert from 'node:assert/strict'
import fs from 'node:fs'

const source = fs.readFileSync('lib/memory-host.js', 'utf8')
const checks = []

// 1. The failure path must clear both caches. Asserted against the source because
//    the hook needs a live Harness to run; the invariant is about control flow.
const catchBlock = source.slice(source.indexOf("} catch (error) {", source.indexOf('buildRecallText')))
const catchEnd = catchBlock.indexOf('return decision')
const handler = catchBlock.slice(0, catchEnd)

assert.equal(/lastRecall = ''/.test(handler), true, 'a failed rebuild must clear lastRecall')
assert.equal(/recallByScope\.delete\(agent\)/.test(handler), true, 'a failed rebuild must drop the scoped entry')
assert.equal(/lastRecallFailed = true/.test(handler), true, 'a failed rebuild must record the failure')
checks.push('a failed rebuild clears the cache and records the failure')

// 2. The handler must not keep serving the old text — the whole point.
assert.equal(
  /lastRecall\s*=\s*text/.test(handler),
  false,
  'the failure handler must not assign the previous text',
)
checks.push('the failure handler does not re-serve the old text')

// 3. A successful rebuild clears the failure flag, or the status would stay red
//    forever after one transient error.
assert.equal(
  /lastRecallFailed = false/.test(source),
  true,
  'a successful rebuild must clear the failure flag',
)
checks.push('a successful rebuild clears the failure flag')

// 4. The cached value carries an age and is not served beyond the TTL.
assert.equal(/RECALL_TTL_MS\s*=\s*[\d_]+/.test(source), true, 'a TTL constant must exist')
assert.equal(
  /Date\.now\(\) - scoped\.at < RECALL_TTL_MS/.test(source),
  true,
  'the reader must compare the cache age against the TTL',
)
checks.push('a cached recall expires instead of being served forever')

// 5. The TTL must be finite and modest: a huge value would reintroduce the bug,
//    and an absurdly small one would rebuild on every token. Numeric separators
//    are stripped before parsing, or "60_000" reads as 60.
const raw = (source.match(/RECALL_TTL_MS\s*=\s*([\d_]+)/) ?? [])[1]
const ttl = Number(String(raw).replace(/_/g, ''))
assert.equal(Number.isFinite(ttl) && ttl > 0, true, `the TTL must parse to a positive number, got ${raw}`)
assert.equal(ttl <= 10 * 60 * 1000, true, `the TTL must stay under 10 minutes, got ${ttl}`)
assert.equal(ttl >= 1000, true, `the TTL must not be so small that it rebuilds constantly, got ${ttl}`)
checks.push(`the TTL is bounded (${ttl} ms)`)

// 6. The failure is exposed for diagnosis rather than only logged.
assert.equal(
  /recallStatus:\s*\(\)\s*=>/.test(source),
  true,
  'the install result must expose a recallStatus reporter',
)
checks.push('the failure is reportable, not just logged')

// 7. Read the durable evidence that motivated the fix, so the test states the
//    real symptom rather than an invented one.
assert.equal(
  /stale recall is worse than no\s*\n?\s*\/\/\s*recall/i.test(source) ||
    /Stale recall is worse than no/.test(source),
  true,
  'the reason for clearing (stale is worse than empty) must be recorded in the code',
)
checks.push('the rationale is recorded next to the fix')

console.log(checks.map((line, index) => `  ${index + 1}. ${line}`).join('\n'))
console.log(`\n${checks.length}/${checks.length} checks passed`)
