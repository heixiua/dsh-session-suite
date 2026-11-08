/**
 * P2b / P3 wiring check.
 *
 * The unit tests prove the logic and the API tests prove the route, but nothing
 * proves the pieces are CONNECTED: the settings page fetches the queue, the route
 * has a case for it, the tool has a branch, the engine has the method. A missing
 * link is silent — the panel simply renders nothing, which looks identical to
 * "no conflicts".
 *
 * This is a static check on purpose: it needs no Host, so it can run in CI and
 * catches a rename that only breaks one side.
 *
 * Usage: node tools/selftest-p2p3-wiring.mjs
 */

import assert from 'node:assert/strict'
import fs from 'node:fs'

const client = fs.readFileSync('client.js', 'utf8')
const api = fs.readFileSync('lib/api.js', 'utf8')
const host = fs.readFileSync('lib/memory-host.js', 'utf8')
const engine = fs.readFileSync('lib/memory-engine.js', 'utf8')
const index = fs.readFileSync('index.js', 'utf8')
const patch = fs.readFileSync('cordis.patch.yml', 'utf8')

const checks = []

// 1. P2b: every layer of the conflict queue exists and is reachable.
{
  const links = [
    ['engine: conflicts()', /async conflicts\(cwd\)/.test(engine)],
    ['engine: settleConflict()', /async settleConflict\(id, winnerId\)/.test(engine)],
    ['engine: the scan runs in maintain()', /#queueConflict\(\{ scope, workspaceKey: key, a, b, verdict \}\)/.test(engine)],
    ['api: action registered', /'longterm\.conflicts'/.test(api) && /'longterm\.resolve'/.test(api)],
    ['api: route case', /case 'longterm\.conflicts'/.test(api) && /case 'longterm\.resolve'/.test(api)],
    ['tool: conflicts branch', /args\.action === 'conflicts'/.test(host)],
    ['tool: resolve branch', /args\.action === 'resolve'/.test(host)],
    ['tool: winnerId in schema', /winnerId: \{/.test(host)],
    ['client: fetches the queue', /action: 'longterm\.conflicts'/.test(client)],
    ['client: can settle with a winner', /action: 'longterm\.resolve', id: item\.id, winnerId: side\.id/.test(client)],
    ['client: can keep both', /action: 'longterm\.resolve', id: item\.id \}/.test(client)],
    ['patch: scan switch documented', /conflictScan: true/.test(patch)],
  ]
  for (const [name, ok] of links) assert.equal(ok, true, `missing link: ${name}`)
  checks.push('P2b: engine → api → tool → client → patch are all connected')
}

// 2. P3: same, for pain distillation.
{
  const links = [
    ['pain module: detector', /export function detectPain/.test(fs.readFileSync('lib/pain.js', 'utf8'))],
    ['pain module: distiller', /export function distillLessons/.test(fs.readFileSync('lib/pain.js', 'utf8'))],
    ['host: imports pain', /from '\.\/pain\.js'/.test(host)],
    ['host: turn/end hook', /config\.painDistill !== false/.test(host) && /event\.type !== 'turn\/end'/.test(host)],
    ['host: writes through remember()', /lessonTheme: lesson\.theme/.test(host)],
    ['host: exposes status', /painStatus: \(\) =>/.test(host)],
    ['engine: lessonTheme is an identity', /entry\.lessonTheme === input\.lessonTheme/.test(engine)],
    ['engine: recurrence counter', /sameTheme\.recurrences = \(sameTheme\.recurrences \?\? 1\) \+ 1/.test(engine)],
    ['engine: lessons have their own ceiling', /maxDistilledLessons/.test(engine)],
    ['engine: lessons are never clustered', /!isLessonEntry\(entry\)/.test(engine)],
    ['index: status attached to the engine', /installed\.attachStatus\?\.\(installed\.engine\)/.test(index)],
    ['api: status carries pain', /service\.longTerm\.painStatus/.test(api)],
    ['client: shows the pain line', /memory\.painDistilled/.test(client)],
    ['patch: distill switch documented', /painDistill: true/.test(patch)],
  ]
  for (const [name, ok] of links) assert.equal(ok, true, `missing link: ${name}`)
  checks.push('P3: pain module → host hook → engine → status → client → patch are all connected')
}

// 3. The conflict queue must not be reachable while the engine is disabled — the
//    same guard every other longterm.* action has, and a misspelled action must
//    still be a loud error rather than "memory is disabled".
{
  assert.equal(/LONGTERM_ACTIONS\.has\(action\)/.test(api), true)
  // The guard must be a set lookup, not a prefix test — but the file's own
  // doc comment says so, so testing for the absence of the string would match the
  // comment. Test for the actual code shape instead.
  const guardCode = api
    .split('\n')
    .filter(line => !/^\s*\*|^\s*\/\//.test(line))
    .join('\n')
  assert.equal(/action\.startsWith\('longterm\.'\)/.test(guardCode), false, 'the disabled guard must stay an explicit set')
  checks.push('the new actions are covered by the existing disabled-engine guard')
}

// 4. Both features must be switchable off, and the switches must be documented
//    where the other knobs are — a feature that writes memories on its own needs
//    an off switch that is findable without reading source.
{
  assert.match(patch, /conflictScan: true/)
  assert.match(patch, /painDistill: true/)
  assert.match(patch, /maxDistilledLessons: 12/)
  assert.match(patch, /painRepeatThreshold: 3/)
  checks.push('both features have documented off switches and caps in the bundle patch')
}

console.log('')
for (const check of checks) console.log(`  ✓ ${check}`)
console.log(`\n${checks.length} wiring checks passed\n`)
